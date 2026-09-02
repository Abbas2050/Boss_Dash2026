// @vitest-environment node
//
// Same reason as pspClients.test.js: the suite default is jsdom, whose
// AbortSignal has no .timeout(), and cryptoRates.js calls AbortSignal.timeout()
// on every request.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getUsdRates, resetUsdRateCache, probeUsdRateSources } from "./cryptoRates.js";

// The cache is module-level and deliberately outlives callers (walletMonitor
// builds fresh clients every poll), so each test has to start from empty or
// they leak into each other.
beforeEach(() => {
  resetUsdRateCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

// ── The two sources, as they actually answer on the wire ──────────────────
//
// Every stub below is written per-source rather than per-call, because the
// whole point of the fallback is that the two sources can be in different
// states at the same time: Binance blocked while Coinbase answers is not a
// hypothetical, it is the production bug this file exists to pin down.

function hostOf(url) {
  return new URL(String(url)).hostname.includes("binance") ? "binance" : "coinbase";
}

function codeOf(url) {
  const parsed = new URL(String(url));
  if (parsed.hostname.includes("binance")) {
    return (parsed.searchParams.get("symbol") ?? "").replace(/USDT$/, "");
  }
  // /v2/prices/ETH-USD/spot
  return (parsed.pathname.split("/")[3] ?? "").replace(/-USD$/, "");
}

const binancePrice = (price) => ({ ok: true, status: 200, json: async () => ({ symbol: "X", price }) });
// What Binance actually answers for a pair it does not list.
const binanceUnlisted = () => ({ ok: false, status: 400, json: async () => ({ code: -1121, msg: "Invalid symbol." }) });
const coinbaseSpot = (amount) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: { base: "ETH", currency: "USD", amount } }),
});
const coinbaseUnlisted = () => ({
  ok: false,
  status: 404,
  json: async () => ({ errors: [{ id: "not_found", message: "Invalid base currency" }] }),
});
// 451 Unavailable For Legal Reasons: what Binance returns to a restricted-region
// IP, which is what this US-hosted server has.
const refused = (status) => ({ ok: false, status, json: async () => ({}) });

// Binance answers from `prices`, Coinbase says it does not list the product.
// That keeps every pre-fallback assertion in this file testing exactly what it
// used to test: a rate that arrives arrives from the primary.
function stubPrices(prices) {
  global.fetch = vi.fn().mockImplementation((url) => {
    const code = codeOf(url);
    if (hostOf(url) === "coinbase") return Promise.resolve(coinbaseUnlisted());
    if (!(code in prices)) return Promise.resolve(binanceUnlisted());
    return Promise.resolve(binancePrice(prices[code]));
  });
}

function stubBySource({ binance, coinbase }) {
  global.fetch = vi.fn().mockImplementation((url) => (hostOf(url) === "binance" ? binance(url) : coinbase(url)));
}

function urlsFor(source) {
  return global.fetch.mock.calls.map(([url]) => String(url)).filter((url) => hostOf(url) === source);
}

describe("getUsdRates()", () => {
  it("returns a USD rate for a listed code", async () => {
    stubPrices({ ETH: "2367.12000000" });
    await expect(getUsdRates(["ETH"])).resolves.toEqual({ ETH: 2367.12 });
  });

  it("asks Binance for the code with USDT appended", async () => {
    stubPrices({ ETH: "2367.12" });
    await getUsdRates(["ETH"]);
    expect(String(global.fetch.mock.calls[0][0])).toContain("symbol=ETHUSDT");
  });

  it("omits a code no source lists, rather than reporting it as zero", async () => {
    // Absence is the contract. A 0 would multiply a real holding down to
    // nothing and present that as a priced figure.
    stubPrices({ ETH: "2367.12" });
    const rates = await getUsdRates(["ETH", "WUSDX"]);
    expect(rates).toEqual({ ETH: 2367.12 });
    expect("WUSDX" in rates).toBe(false);
  });

  it("does not let one code's failure cost the others their price", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      // BTC fails at BOTH sources; ETH is priced by the primary.
      if (codeOf(url) === "BTC") return Promise.reject(new Error("socket hang up"));
      if (hostOf(url) === "coinbase") return Promise.resolve(coinbaseUnlisted());
      return Promise.resolve(binancePrice("2367.12"));
    });
    await expect(getUsdRates(["BTC", "ETH"])).resolves.toEqual({ ETH: 2367.12 });
  });

  it("resolves rather than throwing when every request fails", async () => {
    // pspClients catches too, but this must not be the only thing standing
    // between a 429 and a treasury total.
    global.fetch = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    await expect(getUsdRates(["ETH"])).resolves.toEqual({});
  });

  it("makes no request at all for an empty code list", async () => {
    global.fetch = vi.fn();
    await expect(getUsdRates([])).resolves.toEqual({});
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("treats an unparseable price as no rate", async () => {
    stubBySource({
      binance: () => Promise.resolve(binancePrice("")),
      coinbase: () => Promise.resolve(coinbaseSpot("")),
    });
    await expect(getUsdRates(["ETH"])).resolves.toEqual({});
  });
});

// ── The fallback ──────────────────────────────────────────────────────────
//
// Binance answers HTTP 451 Unavailable For Legal Reasons to IPs in restricted
// regions, and this app is US-hosted. With Binance as the only source that is
// indistinguishable from "this coin has no market", and the visible cost was a
// LetKnow Pay row reading $184.46 against the provider's own $191.27.

describe("the source chain", () => {
  it("prices the code from Coinbase when Binance answers 451", async () => {
    stubBySource({
      binance: () => Promise.resolve(refused(451)),
      coinbase: () => Promise.resolve(coinbaseSpot("2358.31")),
    });

    await expect(getUsdRates(["ETH"])).resolves.toEqual({ ETH: 2358.31 });
  });

  it("does not ask Coinbase at all when Binance answered", async () => {
    // The fallback is insurance, not a second opinion. Asking both every time
    // would double a public API's traffic for a number we already have.
    stubBySource({
      binance: () => Promise.resolve(binancePrice("2367.12")),
      coinbase: () => Promise.resolve(coinbaseSpot("2358.31")),
    });

    await expect(getUsdRates(["ETH"])).resolves.toEqual({ ETH: 2367.12 });
    expect(urlsFor("coinbase")).toEqual([]);
  });

  it("leaves the code absent, without throwing, when both sources fail", async () => {
    stubBySource({
      binance: () => Promise.resolve(refused(451)),
      coinbase: () => Promise.resolve(refused(503)),
    });

    await expect(getUsdRates(["ETH"])).resolves.toEqual({});
  });

  it("parses Coinbase's string amount into a number", async () => {
    // Coinbase sends "2358.31", a string. Handing that straight through would
    // reach applyUsdRates(), fail its Number.isFinite guard, and leave the
    // holding unvalued for a reason nobody would ever guess from the output.
    stubBySource({
      binance: () => Promise.resolve(refused(451)),
      coinbase: () => Promise.resolve(coinbaseSpot("2358.31")),
    });

    const rates = await getUsdRates(["ETH"]);
    expect(typeof rates.ETH).toBe("number");
    expect(rates.ETH).toBe(2358.31);
  });

  it("asks Coinbase for the code as a -USD spot product", async () => {
    stubBySource({
      binance: () => Promise.resolve(refused(451)),
      coinbase: () => Promise.resolve(coinbaseSpot("2358.31")),
    });

    await getUsdRates(["ETH"]);
    expect(urlsFor("coinbase")[0]).toContain("/v2/prices/ETH-USD/spot");
  });

  it("stays inside roughly double the single-source timeout when the primary hangs", async () => {
    // Both timeouts are whole seconds, and a test that spent eight real ones
    // proving it would be a tax on every suite run. So scale every timeout the
    // module asks for by 1/100 and measure in those same scaled units: what is
    // under test is the SHAPE of the budget -- two sources' worth, not four --
    // not the literal millisecond count.
    const SCALE = 100;
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => realTimeout(Math.max(1, Math.round(ms / SCALE))));

    // A source that never answers and only ever stops when aborted.
    global.fetch = vi.fn().mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      }),
    );

    const startedAt = Date.now();
    await expect(getUsdRates(["ETH"])).resolves.toEqual({});
    const elapsed = Date.now() - startedAt;

    const scaledSingleTimeout = 4000 / SCALE;
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(scaledSingleTimeout);
    expect(elapsed).toBeLessThan(scaledSingleTimeout * 6);
  });
});

describe("the 60-second cache", () => {
  // walletMonitor polls often and this is an unauthenticated public API. The
  // TRON client has the same module-level cache for the same reason, added
  // after per-poll requests earned HTTP 429s that surfaced as $0.00 rows.
  it("serves a second call inside the window without a second fetch", async () => {
    stubPrices({ ETH: "2367.12" });

    const first = await getUsdRates(["ETH"]);
    const second = await getUsdRates(["ETH"]);

    expect(second).toEqual(first);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("remembers that a code is unlisted, so it is not re-asked every poll", async () => {
    stubPrices({});
    await getUsdRates(["WUSDX"]);
    await getUsdRates(["WUSDX"]);
    // Both sources answered "no such market" on the first call and neither was
    // asked again: two requests in total, not two per poll.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache a transient failure as if it were an answer", async () => {
    // A 429 or a timeout is upstream trouble, not "this coin has no market".
    // Caching it would stretch a few seconds of trouble into a full minute of
    // a holding silently dropping out of the total.
    let binanceCalls = 0;
    stubBySource({
      binance: () => {
        binanceCalls += 1;
        return binanceCalls === 1 ? Promise.reject(new Error("429")) : Promise.resolve(binancePrice("2367.12"));
      },
      coinbase: () => Promise.resolve(refused(503)),
    });

    await expect(getUsdRates(["ETH"])).resolves.toEqual({});
    await expect(getUsdRates(["ETH"])).resolves.toEqual({ ETH: 2367.12 });
    // binance, coinbase, then binance again -- the second poll re-asked
    // instead of serving a remembered "unpriced".
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not cache a 451 the way it caches Binance's -1121", async () => {
    // The distinction the whole cache turns on. -1121 is Binance ANSWERING
    // ("no such market"), and stays true for the window. A 451 is Binance
    // refusing to answer this server's IP -- an infrastructure fact about us,
    // not a fact about the coin -- so it must be retried on the next cycle,
    // because the day it stops the holding has to come straight back.
    let coinbaseCalls = 0;
    stubBySource({
      binance: () => Promise.resolve(refused(451)),
      coinbase: () => {
        coinbaseCalls += 1;
        return coinbaseCalls === 1 ? Promise.resolve(refused(503)) : Promise.resolve(coinbaseSpot("2358.31"));
      },
    });

    await expect(getUsdRates(["ETH"])).resolves.toEqual({});
    await expect(getUsdRates(["ETH"])).resolves.toEqual({ ETH: 2358.31 });
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("fetches each distinct code once, not once per duplicate", async () => {
    stubPrices({ ETH: "2367.12" });
    await getUsdRates(["ETH", "eth", " ETH "]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ── The diagnostic ────────────────────────────────────────────────────────
//
// Until this existed, nothing anywhere recorded WHY a code went unpriced, and
// a 451 was indistinguishable from "no such market" in every output we had.

describe("probeUsdRateSources()", () => {
  it("reports each source's HTTP status and which one supplied the rate", async () => {
    stubBySource({
      binance: () => Promise.resolve(refused(451)),
      coinbase: () => Promise.resolve(coinbaseSpot("2358.31")),
    });

    const report = await probeUsdRateSources(["ETH"]);

    expect(report.sourceOrder).toEqual(["binance", "coinbase"]);
    expect(report.codes).toEqual([
      {
        code: "ETH",
        rate: 2358.31,
        pricedBy: "coinbase",
        attempts: [
          { source: "binance", status: 451, error: null },
          { source: "coinbase", status: 200, error: null },
        ],
      },
    ]);
  });

  it("names the error text when a source did not answer at all", async () => {
    stubBySource({
      binance: () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.binance.com")),
      coinbase: () => Promise.resolve(refused(503)),
    });

    const [entry] = (await probeUsdRateSources(["ETH"])).codes;

    expect(entry.pricedBy).toBe(null);
    expect(entry.rate).toBe(null);
    expect(entry.attempts[0]).toEqual({
      source: "binance",
      status: null,
      error: "getaddrinfo ENOTFOUND api.binance.com",
    });
    expect(entry.attempts[1].status).toBe(503);
  });

  it("neither reads nor seeds the production cache", async () => {
    // A diagnostic that answered from a minute-old cache would report the
    // wrong thing, and one that seeded the cache would change the very
    // behaviour it was called to observe.
    stubPrices({ ETH: "2367.12" });

    await probeUsdRateSources(["ETH"]);
    await getUsdRates(["ETH"]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
