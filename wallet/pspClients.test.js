// @vitest-environment node
//
// The suite's default environment is jsdom (vite.config.ts), whose
// AbortSignal has no .timeout() -- and both clients' real request code
// calls AbortSignal.timeout(). Node's AbortSignal has it, so run this file
// under the node environment instead, the same way auth/routeCoverage.test.js
// already does for its own reason.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  LetKnowPayClient,
  BitpaceClient,
  valueDollarBalances,
  applyUsdRates,
  LETKNOWPAY_DISCOVERY_CANDIDATES,
} from "./pspClients.js";

// The rate feed is stubbed at the module boundary rather than through
// global.fetch, because the fetch stubs in this file already answer the
// PROVIDER's URLs. Letting a Binance call fall through to those would make
// every rate assertion depend on what a LetKnow Pay fixture happens to look
// like when parsed as a ticker response -- true today by accident, and
// unreadable the day it stops being true. cryptoRates.test.js exercises the
// real HTTP path.
const rateFeed = vi.hoisted(() => ({ getUsdRates: vi.fn() }));
vi.mock("./cryptoRates.js", () => rateFeed);

// Default: no rates available. That is deliberately the pre-existing
// behaviour, so every assertion in this file that predates pricing keeps
// testing what it always tested.
beforeEach(() => {
  rateFeed.getUsdRates.mockReset();
  rateFeed.getUsdRates.mockResolvedValue({});
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Two things are under test here.
//
// 1. getRawBalances() must hand back the provider's response completely
//    unmodified -- not filtered to one currency, not restructured. That is
//    what lets the psp-debug route show the real body alongside what we
//    derive from it.
//
// 2. deriveBalance() must sum every DOLLAR-PEGGED currency the provider
//    reports, and must NAME every non-zero holding it could not value. The
//    fixtures below are the real production responses captured 2026-09-02.
//    Reading a single currency key off the LetKnow Pay body -- what this code
//    used to do -- reported $0.01 for an account holding $184.46 in dollars
//    plus an ETH balance we have no rate for.

describe("LetKnowPayClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  // The exact production response. 23 currency codes, 21 of them zero, bare
  // amounts and no USD value anywhere -- no usdEstimate, no rate, no total.
  const productionRaw = {
    result: "success",
    timestamp: 1788341469,
    balances: {
      ADA: "0.000000",
      BCH: "0.00000000",
      BTC: "0.00000000",
      DASH: "0.00000000",
      ETH: "0.00288773",
      EUR: "0.00",
      LTC: "0.00000000",
      PAX: "0.00000000",
      TUSD: "0.00000000",
      USD: "130.95",
      USDC: "53.498525",
      USDCAVAX: "0.000000",
      USDCBASE: "0.000000",
      USDCPOL: "0.000000",
      USDCSOL: "0.001932",
      USDT: "0.000000",
      USDTAVAX: "0.000000",
      USDTBEP20: "0.000000000000000000",
      USDTPOL: "0.000000",
      USDTSOL: "0.000000",
      USDTTRC20: "0.006487",
      XRP: "0.000000",
      ZEC: "0.000000",
    },
  };

  function stubFetch(raw) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => raw,
    });
  }

  it("getRawBalances() returns the provider response completely untouched", async () => {
    stubFetch(productionRaw);
    const result = await new LetKnowPayClient().getRawBalances();
    expect(result).toEqual(productionRaw);
  });

  it("getBalance() sums every dollar-pegged currency, not just USDTTRC20", async () => {
    stubFetch(productionRaw);
    const result = await new LetKnowPayClient().getBalance();
    // 130.95 (USD) + 53.498525 (USDC) + 0.001932 (USDCSOL) + 0.006487 (USDTTRC20).
    expect(result.balance).toBe(184.456944);
    // The understatement this replaces reported the USDTTRC20 line alone,
    // which the report rendered as "$0.01".
    expect(result.balance).not.toBe(0.006487);
  });

  it("getBalance() reports the ETH it could not value instead of dropping it", async () => {
    stubFetch(productionRaw);
    const result = await new LetKnowPayClient().getBalance();
    expect(result.unvalued).toEqual([{ currency: "ETH", amount: 0.00288773 }]);
  });

  it("getBalance() lists every non-zero holding in currencies, including the unvalued ETH", async () => {
    stubFetch(productionRaw);
    const result = await new LetKnowPayClient().getBalance();
    expect(result.currencies).toEqual({
      ETH: 0.00288773,
      USD: 130.95,
      USDC: 53.498525,
      USDCSOL: 0.001932,
      USDTTRC20: 0.006487,
    });
  });

  it("getBalance() says nothing about the zero currencies, in either list", async () => {
    stubFetch(productionRaw);
    const result = await new LetKnowPayClient().getBalance();
    // A zero holding is neither money nor a problem. Listing 18 of them as
    // "could not be valued" would bury the one line (ETH) that is.
    expect(Object.keys(result.currencies)).not.toContain("BTC");
    expect(Object.keys(result.currencies)).not.toContain("EUR");
    expect(result.unvalued.map((u) => u.currency)).not.toContain("BTC");
    expect(result.unvalued.map((u) => u.currency)).not.toContain("EUR");
  });

  it("getBalance() throws when the API reports a non-success result, same as before", async () => {
    stubFetch({ result: "error", error_message: "bad signature" });
    await expect(new LetKnowPayClient().getBalance()).rejects.toThrow(/bad signature/);
  });
});

// The /api/wallet/psp-debug discovery step (server.js), added to find whether
// LetKnow Pay's API exposes the converted USD total/rate their own merchant
// dashboard shows ("Total balance report -- 191.22 USD -- ..."), which
// get_balances itself never returns. See the LETKNOWPAY_DISCOVERY_CANDIDATES
// comment in pspClients.js for why we probe instead of inventing a rate.
describe("LetKnowPayClient discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it("LETKNOWPAY_DISCOVERY_CANDIDATES is exactly the specified read-only candidates, no others", () => {
    // Locks the list down to precisely what was asked for: six new method
    // names plus the existing get_balances call sent with the two JSON
    // bodies, in case conversion is already available as a parameter. Any
    // addition to this list has to change this test, which is the point --
    // nothing that looks like it could create/send/withdraw/transfer/exchange
    // money belongs here.
    expect(LETKNOWPAY_DISCOVERY_CANDIDATES).toEqual([
      { method: "get_rates", body: "" },
      { method: "get_exchange_rates", body: "" },
      { method: "get_balance_report", body: "" },
      { method: "get_balances_report", body: "" },
      { method: "get_total_balance", body: "" },
      { method: "get_balances_usd", body: "" },
      { method: "get_balances", body: JSON.stringify({ currency: "USD" }) },
      { method: "get_balances", body: JSON.stringify({ convert_to: "USD" }) },
    ]);
  });

  it("discoverMethods() sends each candidate as a POST to /api/2/<method> with the same signed headers get_balances uses", async () => {
    const seen = [];
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      seen.push({ url: String(url), opts });
      return Promise.resolve({ status: 200, text: async () => JSON.stringify({ ok: true }) });
    });

    const client = new LetKnowPayClient();
    await client.discoverMethods([{ method: "get_rates", body: "" }]);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://pay.letknow.com/api/2/get_rates");
    expect(seen[0].opts.method).toBe("POST");
    // Same header names the working get_balances request uses -- not a
    // separately invented auth shape.
    expect(Object.keys(seen[0].opts.headers).sort()).toEqual(
      ["C-Request-Nonce", "C-Request-Signature", "C-Shop-Id", "Content-Type"].sort(),
    );
  });

  it("discoverMethods() reports a throwing candidate as a failure entry, without aborting the others", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes("/get_rates")) {
        // Simulates a hung/network-failed candidate -- exactly the case the
        // per-candidate try/catch in discoverMethods() exists for.
        return Promise.reject(new Error("network unreachable"));
      }
      return Promise.resolve({
        status: 404,
        text: async () => JSON.stringify({ error: "unknown method" }),
      });
    });

    const client = new LetKnowPayClient();
    const results = await client.discoverMethods([
      { method: "get_rates", body: "" },
      { method: "get_total_balance", body: "" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ method: "get_rates", status: null, body: "network unreachable" });
    // The failing candidate must not have stopped the second one from running.
    expect(results[1]).toEqual({ method: "get_total_balance", status: 404, body: { error: "unknown method" } });
  });

  it("discoverMethods() reports the HTTP status and body for a candidate that isn't valid JSON", async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 500, text: async () => "Internal Server Error" });
    const client = new LetKnowPayClient();
    const results = await client.discoverMethods([{ method: "get_exchange_rates", body: "" }]);
    expect(results).toEqual([{ method: "get_exchange_rates", status: 500, body: "Internal Server Error" }]);
  });
});

describe("BitpaceClient", () => {
  // getBalance()/getRawBalances() go through _getAuthToken(), which caches
  // the token to storage/bitpace_token.json on disk (pre-existing behavior,
  // unrelated to this fix). Point the cache file at a throwaway path per
  // test run so these tests can't read a stale token left by a real server
  // run and skip the auth call, and so they never touch the real cache file.
  function freshClient() {
    const client = new BitpaceClient();
    client._tokenCacheFile = path.join(__dirname, `../storage/.test-bitpace-token-${Date.now()}-${Math.random()}.json`);
    client._token = null;
    client._tokenExpiry = 0;
    return client;
  }

  const tempFiles = [];

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
    for (const f of tempFiles.splice(0)) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  });

  // The exact production response. Note the shape: an ARRAY of
  // { currency, balance } records, not LetKnow Pay's object map.
  const productionRaw = {
    code: "00",
    status: "APPROVED",
    data: [
      { currency: "EUR", balance: 0 },
      { currency: "USDT", balance: 0.437722 },
    ],
  };

  function stubFetch(balanceBody) {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes("/auth/token")) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { token: "test-token" } }) });
      }
      return Promise.resolve({ ok: true, text: async () => JSON.stringify(balanceBody) });
    });
  }

  it("getRawBalances() returns the provider response completely untouched", async () => {
    stubFetch(productionRaw);
    const client = freshClient();
    tempFiles.push(client._tokenCacheFile);
    const result = await client.getRawBalances();
    expect(result).toEqual(productionRaw);
  });

  it("getBalance() sums the dollar-pegged holdings and reports nothing unvalued", async () => {
    stubFetch(productionRaw);
    const client = freshClient();
    tempFiles.push(client._tokenCacheFile);
    const result = await client.getBalance();
    // Today this account holds only USDT plus a zero EUR, so summing happens
    // to give the same number the old single-key read did. That is a
    // coincidence; the next test is what makes it stay right.
    expect(result).toEqual({
      balance: 0.437722,
      currencies: { USDT: 0.437722 },
      unvalued: [],
      valued: [],
    });
  });

  it("getBalance() picks up a USDC balance the day one appears, instead of reading USDT alone", async () => {
    stubFetch({
      code: "00",
      status: "APPROVED",
      data: [
        { currency: "EUR", balance: 0 },
        { currency: "USDT", balance: 0.437722 },
        { currency: "USDC", balance: 250 },
      ],
    });
    const client = freshClient();
    tempFiles.push(client._tokenCacheFile);
    const result = await client.getBalance();
    expect(result.balance).toBe(250.437722);
    expect(result.unvalued).toEqual([]);
  });

  it("getBalance() applies the same rule to the balances-object response shape", async () => {
    stubFetch({ balances: { USDT: "7.25", BTC: "0.001" } });
    const client = freshClient();
    tempFiles.push(client._tokenCacheFile);
    const result = await client.getBalance();
    expect(result).toEqual({
      balance: 7.25,
      currencies: { USDT: 7.25, BTC: 0.001 },
      unvalued: [{ currency: "BTC", amount: 0.001 }],
      valued: [],
    });
  });
});

// The valuation rule itself, exercised directly. Both clients route through
// it, but the cases that matter most -- an unknown ticker, an unparseable
// amount -- are clearer stated here than through two different wire shapes.
describe("valueDollarBalances()", () => {
  it("excludes an unknown ticker with a non-zero balance from the sum and names it", () => {
    const result = valueDollarBalances({ USD: "100", WUSDX: "500" });
    // A substring match on "USD" would have valued WUSDX at par and reported
    // $600 of money that may not exist. An unknown code is not a dollar.
    expect(result.balance).toBe(100);
    expect(result.unvalued).toEqual([{ currency: "WUSDX", amount: 500 }]);
  });

  it("says nothing at all about an unknown ticker whose balance is zero", () => {
    const result = valueDollarBalances({ USD: "100", DOGE: "0.00000000" });
    expect(result.balance).toBe(100);
    expect(result.unvalued).toEqual([]);
    expect(Object.keys(result.currencies)).not.toContain("DOGE");
  });

  it("treats an unparseable amount as unvaluable, not as zero", () => {
    // `parseFloat(x) || 0` would report this as a confident 0.00 -- a
    // treasury figure quietly losing a term while still looking complete.
    const result = valueDollarBalances({ USD: "100", USDC: "n/a" });
    expect(result.balance).toBe(100);
    expect(result.unvalued).toEqual([{ currency: "USDC", amount: "n/a" }]);
  });

  it("keeps an unparseable holding visible in the currencies breakdown too", () => {
    const result = valueDollarBalances({ USDC: "n/a" });
    expect(result.currencies).toEqual({ USDC: "n/a" });
  });

  it("values every member of the allowlisted stablecoin families at par", () => {
    const result = valueDollarBalances({
      USD: 1, USDT: 1, USDTTRC20: 1, USDTBEP20: 1, USDTPOL: 1, USDTSOL: 1,
      USDTAVAX: 1, USDC: 1, USDCSOL: 1, USDCPOL: 1, USDCBASE: 1, USDCAVAX: 1,
      PAX: 1, TUSD: 1,
    });
    expect(result.balance).toBe(14);
    expect(result.unvalued).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// Pricing the holdings the provider will not price
// ─────────────────────────────────────────────────────────
//
// LetKnow Pay's screen reads $191.24 while ours reads $184.46; the whole gap
// is 0.00288773 ETH their API hands back as a bare amount with no rate and no
// conversion endpoint (see LETKNOWPAY_DISCOVERY_CANDIDATES -- every one of
// those method names 404s). So we price it from Binance.
//
// The tests that matter most in here are not the happy-path ones. They are the
// ones that pin what happens when the rate feed does NOT answer, because the
// failure mode this change could introduce -- a price API hiccup zeroing a
// balance, or taking a whole PSP down with it -- would cost far more than the
// $6.84 it recovers.
describe("crypto holdings priced from a live rate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  // Same production body as the LetKnowPayClient suite above: $184.456944 of
  // dollar-pegged holdings plus the one ETH line.
  const productionRaw = {
    result: "success",
    balances: {
      ETH: "0.00288773",
      USD: "130.95",
      USDC: "53.498525",
      USDCSOL: "0.001932",
      USDTTRC20: "0.006487",
      BTC: "0.00000000",
    },
  };

  const DOLLARS_ONLY = 184.456944;

  function stubFetch(raw) {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => raw });
  }

  it("adds the ETH to the balance and records the rate it used", async () => {
    rateFeed.getUsdRates.mockResolvedValue({ ETH: 2367.12 });
    stubFetch(productionRaw);

    const result = await new LetKnowPayClient().getBalance();

    expect(result.balance).toBe(DOLLARS_ONLY + 0.00288773 * 2367.12);
    expect(result.unvalued).toEqual([]);
    expect(result.valued).toEqual([
      { currency: "ETH", amount: 0.00288773, rate: 2367.12, usd: 0.00288773 * 2367.12 },
    ]);
    // The point of the exercise: the row stops reading ~$7 short of the
    // provider's own screen.
    expect(result.balance).toBeCloseTo(191.29, 2);
  });

  // The bug in one assertion. The live production response above sums to
  // $184.456944 of dollar-pegged holdings, LetKnow's own merchant screen said
  // $191.27, and the entire gap was one ETH line sitting in `unvalued` because
  // the only price source we had was answering our US-hosted IP with HTTP 451.
  // With a rate feed that actually reaches a source, the row reconciles.
  it("reaches LetKnow Pay's own $191.27 once the ETH is priced", async () => {
    rateFeed.getUsdRates.mockResolvedValue({ ETH: 2358.31 });
    stubFetch(productionRaw);

    const result = await new LetKnowPayClient().getBalance();

    // Precision 1 is |diff| < 0.05, which is the tolerance this module has
    // always admitted to: LetKnow marks the stablecoins to market and we hold
    // them at par, so the last couple of cents are not ours to reproduce.
    expect(result.balance).toBeCloseTo(191.27, 1);
    expect(result.unvalued).toEqual([]);
    expect(result.valued).toEqual([
      { currency: "ETH", amount: 0.00288773, rate: 2358.31, usd: 0.00288773 * 2358.31 },
    ]);
  });

  it("asks only about the holdings it could not already value", async () => {
    rateFeed.getUsdRates.mockResolvedValue({ ETH: 2367.12 });
    stubFetch(productionRaw);

    await new LetKnowPayClient().getBalance();

    // Not USD/USDC/USDTTRC20 (already dollars, and asking would invite a rate
    // that disagrees with the 1:1 allowlist), and not the zero BTC.
    expect(rateFeed.getUsdRates).toHaveBeenCalledWith(["ETH"]);
  });

  // THE degradation test. If the rate feed is down, rate-limited, or slow, the
  // report must be byte-for-byte what it was before this feature existed --
  // not a zeroed holding, not a lost dollar balance, not a failed PSP.
  it("leaves the pre-pricing behaviour completely untouched when the rate lookup fails", async () => {
    rateFeed.getUsdRates.mockRejectedValue(new Error("Binance HTTP 429"));
    stubFetch(productionRaw);

    const result = await new LetKnowPayClient().getBalance();

    // The exact figure, not "not null": the dollar balances that resolved are
    // all still there, to the cent.
    expect(result.balance).toBe(DOLLARS_ONLY);
    expect(result.unvalued).toEqual([{ currency: "ETH", amount: 0.00288773 }]);
    expect(result.valued).toEqual([]);
    expect(result.currencies).toEqual({
      ETH: 0.00288773,
      USD: 130.95,
      USDC: 53.498525,
      USDCSOL: 0.001932,
      USDTTRC20: 0.006487,
    });
  });

  it("does not turn a rate failure into a failed PSP", async () => {
    rateFeed.getUsdRates.mockRejectedValue(new Error("fetch failed"));
    stubFetch(productionRaw);

    // walletMonitor reports `status: 'error'` and a $0 balance for anything
    // that throws out of getBalance(). A price feed outage must not reach it.
    await expect(new LetKnowPayClient().getBalance()).resolves.toBeTruthy();
  });

  it("values a listed ticker while leaving an unlisted one alone in the same response", async () => {
    // Binance lists ETHUSDT; it does not list whatever WUSDX is, so that code
    // is simply absent from the rate map -- not present as a zero.
    rateFeed.getUsdRates.mockResolvedValue({ ETH: 2000 });
    stubFetch({ result: "success", balances: { USD: "100", ETH: "0.5", WUSDX: "500" } });

    const result = await new LetKnowPayClient().getBalance();

    expect(result.balance).toBe(1100);
    expect(result.valued).toEqual([{ currency: "ETH", amount: 0.5, rate: 2000, usd: 1000 }]);
    expect(result.unvalued).toEqual([{ currency: "WUSDX", amount: 500 }]);
  });

  it("prices Bitpace's unvalued holdings by the same rule", async () => {
    rateFeed.getUsdRates.mockResolvedValue({ BTC: 64000 });
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes("/auth/token")) {
        return Promise.resolve({ ok: true, json: async () => ({ data: { token: "t" } }) });
      }
      return Promise.resolve({ ok: true, text: async () => JSON.stringify({ balances: { USDT: "7.25", BTC: "0.001" } }) });
    });

    const result = await new BitpaceClient().getBalance();

    expect(result.balance).toBe(7.25 + 64);
    expect(result.valued).toEqual([{ currency: "BTC", amount: 0.001, rate: 64000, usd: 64 }]);
    expect(result.unvalued).toEqual([]);
  });
});

// The rate application itself, exercised directly. The wire shapes above prove
// it is wired in; these prove what it does with the awkward inputs.
describe("applyUsdRates()", () => {
  it("never prices a zero holding, and never lists one as valued", () => {
    const result = applyUsdRates(
      { balance: 100, currencies: {}, unvalued: [{ currency: "ETH", amount: 0 }] },
      { ETH: 2367.12 },
    );
    expect(result.balance).toBe(100);
    expect(result.valued).toEqual([]);
    // It was not priced, so it is not "included" -- it stays exactly where the
    // dollar valuation left it rather than quietly disappearing.
    expect(result.unvalued).toEqual([{ currency: "ETH", amount: 0 }]);
  });

  it("leaves an unparseable amount unvalued even when a rate exists for its code", () => {
    // valueDollarBalances deliberately keeps the provider's raw string here.
    // Multiplying "n/a" by a rate would produce NaN and poison the total.
    const result = applyUsdRates(
      { balance: 100, currencies: {}, unvalued: [{ currency: "ETH", amount: "n/a" }] },
      { ETH: 2367.12 },
    );
    expect(result.balance).toBe(100);
    expect(result.unvalued).toEqual([{ currency: "ETH", amount: "n/a" }]);
    expect(result.valued).toEqual([]);
  });

  it("refuses a zero or negative rate rather than multiplying a holding away", () => {
    const zeroed = applyUsdRates(
      { balance: 100, currencies: {}, unvalued: [{ currency: "ETH", amount: 2 }] },
      { ETH: 0 },
    );
    expect(zeroed.balance).toBe(100);
    expect(zeroed.unvalued).toEqual([{ currency: "ETH", amount: 2 }]);
  });

  it("returns an empty rate map's input unchanged, which is the failure path", () => {
    const before = { balance: 184.456944, currencies: { ETH: 0.00288773 }, unvalued: [{ currency: "ETH", amount: 0.00288773 }] };
    const after = applyUsdRates(before, {});
    expect(after.balance).toBe(184.456944);
    expect(after.unvalued).toEqual(before.unvalued);
    expect(after.valued).toEqual([]);
  });
});
