// @vitest-environment node
//
// Same reason as pspClients.test.js: the suite default is jsdom, whose
// AbortSignal has no .timeout(), and cryptoRates.js calls AbortSignal.timeout()
// on every request.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getUsdRates, resetUsdRateCache } from "./cryptoRates.js";

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

function stubPrices(prices) {
  global.fetch = vi.fn().mockImplementation((url) => {
    const symbol = new URL(String(url)).searchParams.get("symbol");
    const code = symbol.replace(/USDT$/, "");
    if (!(code in prices)) {
      // What Binance actually answers for a pair it does not list.
      return Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({ code: -1121, msg: "Invalid symbol." }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ symbol, price: prices[code] }) });
  });
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

  it("omits a code Binance does not list, rather than reporting it as zero", async () => {
    // Absence is the contract. A 0 would multiply a real holding down to
    // nothing and present that as a priced figure.
    stubPrices({ ETH: "2367.12" });
    const rates = await getUsdRates(["ETH", "WUSDX"]);
    expect(rates).toEqual({ ETH: 2367.12 });
    expect("WUSDX" in rates).toBe(false);
  });

  it("does not let one code's failure cost the others their price", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes("BTCUSDT")) return Promise.reject(new Error("socket hang up"));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ price: "2367.12" }) });
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
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ price: "" }) });
    await expect(getUsdRates(["ETH"])).resolves.toEqual({});
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
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a transient failure as if it were an answer", async () => {
    // A 429 or a timeout is upstream trouble, not "this coin has no market".
    // Caching it would stretch a few seconds of trouble into a full minute of
    // a holding silently dropping out of the total.
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ price: "2367.12" }),
    });

    await expect(getUsdRates(["ETH"])).resolves.toEqual({});
    await expect(getUsdRates(["ETH"])).resolves.toEqual({ ETH: 2367.12 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches each distinct code once, not once per duplicate", async () => {
    stubPrices({ ETH: "2367.12" });
    await getUsdRates(["ETH", "eth", " ETH "]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
