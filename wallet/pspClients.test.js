// @vitest-environment node
//
// The suite's default environment is jsdom (vite.config.ts), whose
// AbortSignal has no .timeout() -- and both clients' real request code
// calls AbortSignal.timeout(). Node's AbortSignal has it, so run this file
// under the node environment instead, the same way auth/routeCoverage.test.js
// already does for its own reason.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LetKnowPayClient, BitpaceClient, valueDollarBalances } from "./pspClients.js";

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
