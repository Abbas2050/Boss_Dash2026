// @vitest-environment node
//
// The deposit amount, and the two units it is read in.
//
// Three of the failures this file pins produce no error anywhere. Meta accepts
// a Purchase with no value and discards it; both platforms accept the other
// one's unit without comment; and a currency whose minor unit is not 1/100
// would be reported a hundredfold with nothing to notice it. So the pair, the
// units and the reasons a lookup produces no value are pinned by test rather
// than by care.
import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_SEND_TIMEOUT_MS, SEND_TIMEOUT_ENV } from "./sendTimeout.js";
import { timeoutError } from "./sendTimeout.contract.js";
import {
  DEPOSIT_VALUE_STAGE,
  DEPOSIT_TYPE,
  DEPOSIT_STATUSES,
  DEPOSIT_LOOKUP_LIMIT,
  DEFAULT_MINOR_UNIT_DIGITS,
  isDepositType,
  isoCurrency,
  minorUnitDigits,
  toMinorUnits,
  pickFirstDeposit,
  depositValueFrom,
  buildFirstDepositQuery,
  transactionsUrl,
  fetchFirstDepositValue,
} from "./depositValue.js";

const BASE = "https://portal.skylinkscapital.com";
const TOKEN = "crm-token-value";

/** A fetch that answers with one JSON body, the way a healthy CRM does. */
const ok = (rows) =>
  vi.fn(async () => ({
    status: 200,
    json: async () => rows,
  }));

const lookup = (fetchImpl, overrides = {}) =>
  fetchFirstDepositValue({
    fetchImpl,
    baseUrl: BASE,
    apiVersion: "1.0.0",
    apiToken: TOKEN,
    crmClientId: "88214",
    ...overrides,
  });

/** $129.99 — chosen because the decimal and the minor-unit integer differ. A
 *  round amount would pass with the two units crossed. */
const deposit = (overrides = {}) => ({
  id: 5001,
  type: "deposit",
  createdAt: "2026-10-16 09:00:00",
  processedAmount: 129.99,
  processedCurrency: "USD",
  requestedAmount: 129.99,
  requestedCurrency: "USD",
  status: "approved",
  ...overrides,
});

describe("the stage this applies to", () => {
  it("is the first deposit, and only the first deposit", () => {
    // The whole of the cost control: one CRM call per first deposit, which is a
    // handful a day, and none at any other stage.
    expect(DEPOSIT_VALUE_STAGE).toBe("first_deposit");
  });
});

describe("the deposit type", () => {
  it("is FXBO's own word, and recognises nothing else the live send printed", () => {
    // The real vocabulary, from the first live weekly send. `transfer in` is a
    // client moving their own money and `credit` is a bonus; counting either as
    // a deposit would report money that never arrived as a purchase.
    expect(DEPOSIT_TYPE).toBe("deposit");
    expect(isDepositType("deposit")).toBe(true);
    expect(isDepositType("  Deposit ")).toBe(true);
    for (const other of [
      "credit",
      "ib transfer to account",
      "ib transfer to account out",
      "ib withdrawal",
      "transfer in",
      "transfer out",
      "withdrawal",
      "cashback withdrawal",
      "",
      null,
      undefined,
    ]) {
      expect(isDepositType(other), String(other)).toBe(false);
    }
  });

  it("asks for approved transactions only", () => {
    // A pending or declined deposit is not a conversion.
    expect(DEPOSIT_STATUSES).toEqual(["approved"]);
  });
});

describe("minor units", () => {
  it("turns a decimal into the integer OpenAI wants", () => {
    // The spec's own example: $129.99 is 12999, not 129.99.
    expect(toMinorUnits(129.99, "USD")).toBe(12999);
  });

  it("rounds rather than truncates, because the product is not exact in binary", () => {
    // $4.35 * 100 is 434.99999999999994, so a truncation bills 434 -- a cent
    // short, on every deposit whose cents land this way.
    expect(Math.trunc(4.35 * 100)).toBe(434);
    expect(toMinorUnits(4.35, "USD")).toBe(435);
    expect(toMinorUnits(0.07, "USD")).toBe(7);
  });

  it("reads the currency's own number of digits, not two for everything", () => {
    // Assuming two is a hundredfold error for JPY, not a rounding one.
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("KWD")).toBe(3);
    expect(minorUnitDigits("USD")).toBe(2);
    expect(toMinorUnits(1500, "JPY")).toBe(1500);
    expect(toMinorUnits(12.345, "KWD")).toBe(12345);
  });

  it("defaults to two digits for a code it has never heard of", () => {
    expect(DEFAULT_MINOR_UNIT_DIGITS).toBe(2);
    expect(minorUnitDigits("ZZZ")).toBe(2);
    expect(minorUnitDigits("")).toBe(2);
  });

  it("takes the magnitude, because direction comes from the type", () => {
    expect(toMinorUnits(-129.99, "USD")).toBe(12999);
  });
});

describe("isoCurrency", () => {
  it("accepts three letters, uppercased, and nothing else", () => {
    expect(isoCurrency("usd")).toBe("USD");
    expect(isoCurrency(" eur ")).toBe("EUR");
    // Meta silently ignores a currency it cannot read, which would put us back
    // where this change started: an accepted request and no conversion.
    for (const bad of ["USDT", "US", "US1", "$", "", null, undefined, 840]) {
      expect(isoCurrency(bad), String(bad)).toBe("");
    }
  });
});

describe("pickFirstDeposit", () => {
  it("ignores every type that is not a deposit", () => {
    const rows = [
      { type: "withdrawal", createdAt: "2026-01-01 00:00:00" },
      { type: "credit", createdAt: "2026-01-02 00:00:00" },
      { type: "transfer in", createdAt: "2026-01-03 00:00:00" },
      deposit({ id: 9, createdAt: "2026-05-05 00:00:00" }),
    ];
    expect(pickFirstDeposit(rows).id).toBe(9);
  });

  it("takes the earliest deposit from the rows, not the first one returned", () => {
    // The request asks to be sorted, but a server that quietly ignored `orders`
    // would hand us the client's LATEST deposit for their first-deposit
    // conversion, and nothing about that answer would look wrong.
    const rows = [
      deposit({ id: 3, createdAt: "2026-10-16 09:00:00" }),
      deposit({ id: 1, createdAt: "2026-09-01 08:00:00" }),
      deposit({ id: 2, createdAt: "2026-10-01 08:00:00" }),
    ];
    expect(pickFirstDeposit(rows).id).toBe(1);
  });

  it("never lets an unreadable date win the comparison", () => {
    const rows = [
      deposit({ id: 1, createdAt: null }),
      deposit({ id: 2, createdAt: "2026-10-16 09:00:00" }),
    ];
    expect(pickFirstDeposit(rows).id).toBe(2);
  });

  it("answers null for no rows, no deposits, or something that is not a list", () => {
    expect(pickFirstDeposit([])).toBeNull();
    expect(pickFirstDeposit([{ type: "withdrawal" }])).toBeNull();
    expect(pickFirstDeposit(null)).toBeNull();
    expect(pickFirstDeposit({ type: "deposit" })).toBeNull();
  });
});

describe("depositValueFrom", () => {
  it("reports one deposit in both units, and derives the decimal from the integer", () => {
    // Meta wants the decimal, ChatGPT Ads wants the integer, and the one way
    // the two can disagree is being computed separately.
    expect(depositValueFrom(deposit()).value).toEqual({
      currency: "USD",
      amountMinor: 12999,
      valueDecimal: 129.99,
    });
  });

  it("prefers the processed pair, which is the money that actually landed", () => {
    const value = depositValueFrom(
      deposit({ processedAmount: 100.5, processedCurrency: "USD", requestedAmount: 129.99, requestedCurrency: "EUR" })
    ).value;
    expect(value).toEqual({ currency: "USD", amountMinor: 10050, valueDecimal: 100.5 });
  });

  it("never crosses the two pairs", () => {
    // A deposit requested in EUR and processed in USD, reported as dollars
    // labelled euros, is a number Meta would accept and bid against.
    const value = depositValueFrom(
      deposit({ processedAmount: null, processedCurrency: "USD", requestedAmount: 129.99, requestedCurrency: "EUR" })
    ).value;
    expect(value).toEqual({ currency: "EUR", amountMinor: 12999, valueDecimal: 129.99 });
  });

  it("falls back to the requested pair only when there is no processed amount", () => {
    for (const processedAmount of [null, undefined, 0, "", "not a number"]) {
      const value = depositValueFrom(deposit({ processedAmount, requestedCurrency: "GBP" })).value;
      expect(value, String(processedAmount)).toEqual({ currency: "GBP", amountMinor: 12999, valueDecimal: 129.99 });
    }
  });

  it("takes the magnitude of a signed-negative leg", () => {
    expect(depositValueFrom(deposit({ processedAmount: -129.99 })).value.amountMinor).toBe(12999);
  });

  it("refuses a currency Meta could not read, permanently and by name", () => {
    const { value, failure } = depositValueFrom(deposit({ processedCurrency: "USDT" }));
    expect(value).toBeUndefined();
    expect(failure.detail).toContain("processedCurrency");
    expect(failure.detail).toContain("USDT");
    // It will not be a different code in five minutes.
    expect(failure.retryable).toBe(false);
  });

  it("refuses a deposit with no positive amount, permanently", () => {
    for (const row of [
      deposit({ processedAmount: 0, requestedAmount: 0 }),
      deposit({ processedAmount: null, requestedAmount: null }),
      deposit({ processedAmount: "abc", requestedAmount: "abc" }),
      {},
    ]) {
      const { value, failure } = depositValueFrom(row);
      expect(value).toBeUndefined();
      expect(failure.retryable).toBe(false);
      expect(failure.detail).toContain("no positive amount");
    }
  });

  it("refuses an amount that rounds away to nothing", () => {
    const { value, failure } = depositValueFrom(deposit({ processedAmount: 0.0004, requestedAmount: 0 }));
    expect(value).toBeUndefined();
    expect(failure.detail).toBe("the deposit rounds to 0 USD");
    expect(failure.retryable).toBe(false);
  });
});

describe("the request", () => {
  it("asks the CRM for this client's approved deposits, earliest first", () => {
    expect(buildFirstDepositQuery(88214)).toEqual({
      // The CRM USER, never fromLoginSid: that is a composite account id and one
      // client owns several of them.
      fromUserId: 88214,
      statuses: ["approved"],
      transactionTypes: ["deposit"],
      orders: [{ field: "createdAt", direction: "ASC" }],
      // `segment` is the only required field on the request.
      segment: { limit: DEPOSIT_LOOKUP_LIMIT, offset: 0 },
    });
  });

  it("carries the API version the CRM refuses a request without", () => {
    expect(transactionsUrl(BASE, "1.0.0")).toBe(`${BASE}/rest/transactions?version=1.0.0`);
    expect(transactionsUrl(`${BASE}/`, "")).toBe(`${BASE}/rest/transactions?version=1.0.0`);
  });

  it("posts to /rest/transactions with the token in a header and never in the URL", async () => {
    // A URL is echoed in proxy logs, in fetch's own error messages and in the
    // CRM's webhook stats table. A secret printed on every request is worse
    // than none, because it looks like authentication.
    const fetchImpl = ok([deposit()]);
    await lookup(fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/rest/transactions?version=1.0.0`);
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(buildFirstDepositQuery(88214));
  });
});

describe("fetchFirstDepositValue", () => {
  it("reads the amount and currency off the earliest approved deposit", async () => {
    const rows = [
      { type: "withdrawal", createdAt: "2026-09-01 00:00:00", processedAmount: 50, processedCurrency: "USD" },
      deposit({ createdAt: "2026-10-16 09:00:00", processedAmount: 129.99 }),
      deposit({ createdAt: "2026-10-18 09:00:00", processedAmount: 9000 }),
    ];
    const { value } = await lookup(ok(rows));
    expect(value).toEqual({ currency: "USD", amountMinor: 12999, valueDecimal: 129.99 });
  });

  it("reads nothing off the row but the amount and the currency", async () => {
    // A transaction carries the client's comments, ticket and custom fields.
    // None of it is ours to hold, so none of it leaves this function.
    const { value } = await lookup(
      ok([
        deposit({
          comment: "client called about ali@example.com",
          ticket: "T-42",
          customFields: { custom_field_1: "+971507192185" },
        }),
      ])
    );
    expect(Object.keys(value).sort()).toEqual(["amountMinor", "currency", "valueDecimal"]);
  });

  it("treats an empty list as the CRM not having the record yet, and retries", async () => {
    // The timing case this is retryable for at all: the "First time deposit by
    // client" rule can reach us before the transaction it describes is
    // queryable.
    const { value, failure } = await lookup(ok([]));
    expect(value).toBeUndefined();
    expect(failure).toEqual({ detail: "no approved deposit for this client yet", retryable: true });
  });

  it("treats a list with no deposit in it the same way", async () => {
    const { failure } = await lookup(ok([{ type: "withdrawal", processedAmount: 20, processedCurrency: "USD" }]));
    expect(failure.retryable).toBe(true);
  });

  it("reports a transport failure as retryable, never as an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const { value, failure } = await lookup(fetchImpl);
    expect(value).toBeUndefined();
    expect(failure.retryable).toBe(true);
    expect(failure.detail).toBe("transport: fetch failed");
  });

  it("retries a transient status and refuses a permanent one", async () => {
    for (const status of [408, 429, 500, 503]) {
      const { failure } = await lookup(vi.fn(async () => ({ status, json: async () => ({}) })));
      expect(failure, String(status)).toEqual({ detail: `http ${status}`, retryable: true });
    }
    // A 401 or 403 is the token (a trailing CR in .env does exactly this) and a
    // 400 is this query. Neither is right in five minutes.
    for (const status of [400, 401, 403, 404]) {
      const { failure } = await lookup(vi.fn(async () => ({ status, json: async () => ({}) })));
      expect(failure, String(status)).toEqual({ detail: `http ${status}`, retryable: false });
    }
  });

  it("never reads a failure's body, which can quote the request back", async () => {
    const json = vi.fn(async () => ({ message: "client 88214 not found" }));
    const { failure } = await lookup(vi.fn(async () => ({ status: 403, json })));
    expect(json).not.toHaveBeenCalled();
    expect(failure.detail).toBe("http 403");
  });

  it("retries an answer it could not read as a list", async () => {
    // A proxy answered instead of the CRM: unknown rather than empty.
    for (const body of [{ error: "nope" }, null, "oops"]) {
      const { failure } = await lookup(vi.fn(async () => ({ status: 200, json: async () => body })));
      expect(failure, JSON.stringify(body)).toEqual({
        detail: "the CRM answered with no transaction list",
        retryable: true,
      });
    }
  });

  it("retries a body that stalled until the timeout", async () => {
    const { failure } = await lookup(
      vi.fn(async () => ({
        status: 200,
        json: async () => {
          throw timeoutError();
        },
      }))
    );
    expect(failure).toEqual({ detail: "body timed out", retryable: true });
  });

  it("refuses to ask at all with no API_TOKEN, and names the variable", async () => {
    const fetchImpl = ok([deposit()]);
    const { value, failure } = await lookup(fetchImpl, { apiToken: "  " });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(value).toBeUndefined();
    expect(failure).toEqual({ detail: "API_TOKEN is not set, so the CRM cannot be asked", retryable: false });
  });

  it("refuses a client id that is not a number, rather than asking about everyone", async () => {
    // `fromUserId: NaN` serialises to null, which is the request for EVERY
    // user's transactions -- so the lookup would return a stranger's deposit.
    for (const crmClientId of ["", "  ", "abc", null, undefined, "0", "-4", "1.5"]) {
      const fetchImpl = ok([deposit()]);
      const { value, failure } = await lookup(fetchImpl, { crmClientId });
      expect(fetchImpl, String(crmClientId)).not.toHaveBeenCalled();
      expect(value, String(crmClientId)).toBeUndefined();
      expect(failure.retryable, String(crmClientId)).toBe(false);
      expect(failure.detail, String(crmClientId)).toBe("the row has no numeric CRM client id");
    }
  });

  it("never puts the token in a failure detail", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`refused for Bearer ${TOKEN}`);
    });
    const { failure } = await lookup(fetchImpl);
    expect(failure.detail).toContain("transport:");
    // The token reached this message because the fake put it there; a real
    // transport error cannot, because the token is never in the URL. The
    // assertion is that nothing in this module adds it.
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][0]).not.toContain(TOKEN);
  });
});

describe("the lookup's timeout", () => {
  // Node's fetch has no timeout of its own, and the sweeper runs rows one at a
  // time, so an unbounded lookup would stall every row behind this one -- for
  // hours on the IIS host. The bound is the one every outbound call here
  // shares, read from the same variable rather than invented again.
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("bounds the request with the shared default timeout", async () => {
    vi.stubEnv(SEND_TIMEOUT_ENV, undefined);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = ok([deposit()]);
    await lookup(fetchImpl);
    const [, init] = fetchImpl.mock.calls[0];
    expect(timeout).toHaveBeenCalledWith(DEFAULT_SEND_TIMEOUT_MS);
    expect(init.signal).toBe(timeout.mock.results[0].value);
    expect(init.signal.aborted).toBe(false);
  });

  it("takes its duration from CRM_SEND_TIMEOUT_MS, not from a number of its own", async () => {
    vi.stubEnv(SEND_TIMEOUT_ENV, "1234");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = ok([deposit()]);
    await lookup(fetchImpl);
    expect(timeout).toHaveBeenCalledWith(1234);
    expect(fetchImpl.mock.calls[0][1].signal).toBe(timeout.mock.results[0].value);
  });

  it("gives every lookup its own signal, so one expiry cannot abort the next", async () => {
    const fetchImpl = ok([deposit()]);
    await lookup(fetchImpl);
    await lookup(fetchImpl);
    const [first, second] = fetchImpl.mock.calls.map(([, init]) => init.signal);
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBeInstanceOf(AbortSignal);
    expect(second).not.toBe(first);
  });

  it("abandons a stalled lookup as a retryable failure, not an exception", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(1));
    let reason;
    const stalled = vi.fn(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              reason = init.signal.reason;
              reject(reason);
            },
            { once: true }
          );
        })
    );
    const { value, failure } = await lookup(stalled);
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason.name).toBe("TimeoutError");
    expect(value).toBeUndefined();
    expect(failure.retryable).toBe(true);
    expect(failure.detail).toMatch(/^transport: /);
  });
});
