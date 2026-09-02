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
import { LetKnowPayClient, BitpaceClient } from "./pspClients.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression guard for the getRawBalances() refactor (see pspClients.js):
// getBalance() used to build+parse the request inline, then pick one
// currency straight out of the parsed body. It now calls getRawBalances()
// (the request) and ClientClass.deriveBalance() (the pick) as two separate
// steps. These tests prove that split produced no behavior change: given the
// exact same provider response, getBalance() must still derive the exact
// same { balance, currencies } it always did, and getRawBalances() must hand
// back that response completely unmodified -- not filtered to one currency,
// not restructured.

describe("LetKnowPayClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  // The real provider returns every currency the shop holds -- this is a
  // shape close to the live discrepancy this route exists to investigate:
  // five currencies, only one of which (USDTTRC20) getBalance() has ever
  // surfaced to the Closing Balance Report.
  const multiCurrencyRaw = {
    result: "success",
    balances: {
      USD: "130.95",
      USDC: "53.50",
      ETH: "0.0029",
      USDTTRC20: "0.006487",
      "USDC-SOL": "0.001932",
    },
  };

  function stubFetch(raw) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => raw,
    });
  }

  it("getRawBalances() returns the provider response completely untouched", async () => {
    stubFetch(multiCurrencyRaw);
    const result = await new LetKnowPayClient().getRawBalances();
    expect(result).toEqual(multiCurrencyRaw);
  });

  it("getBalance() still derives the USDTTRC20-only figure it always has, from the same raw response", async () => {
    stubFetch(multiCurrencyRaw);
    const result = await new LetKnowPayClient().getBalance();
    expect(result).toEqual({
      balance: 0.006487,
      currencies: { USDTTRC20: 0.006487 },
    });
  });

  it("getBalance() throws when the API reports a non-success result, same as before the refactor", async () => {
    stubFetch({ result: "error", error_message: "bad signature" });
    await expect(new LetKnowPayClient().getBalance()).rejects.toThrow(/bad signature/);
  });
});

describe("BitpaceClient", () => {
  // getBalance()/getRawBalances() go through _getAuthToken(), which caches
  // the token to storage/bitpace_token.json on disk (pre-existing behavior,
  // unrelated to this refactor). Point the cache file at a throwaway path per
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

  const arrayShapedRaw = {
    data: [
      { currency: "USDT", balance: "42.5" },
      { currency: "USDC", balance: "10" },
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
    stubFetch(arrayShapedRaw);
    const client = freshClient();
    tempFiles.push(client._tokenCacheFile);
    const result = await client.getRawBalances();
    expect(result).toEqual(arrayShapedRaw);
  });

  it("getBalance() still derives the USDT-only figure it always has, from the same raw response", async () => {
    stubFetch(arrayShapedRaw);
    const client = freshClient();
    tempFiles.push(client._tokenCacheFile);
    const result = await client.getBalance();
    expect(result).toEqual({ balance: 42.5, currencies: { USDT: 42.5 } });
  });

  it("getBalance() derives the same figure from the balances-object response shape", async () => {
    stubFetch({ balances: { USDT: "7.25", BTC: "0.001" } });
    const client = freshClient();
    tempFiles.push(client._tokenCacheFile);
    const result = await client.getBalance();
    expect(result).toEqual({ balance: 7.25, currencies: { USDT: 7.25 } });
  });
});
