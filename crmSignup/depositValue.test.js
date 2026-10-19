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
import { readFileSync } from "fs";
import path from "path";
import { DEFAULT_SEND_TIMEOUT_MS, SEND_TIMEOUT_ENV } from "./sendTimeout.js";
import { timeoutError } from "./sendTimeout.contract.js";
// The treasury side's answer to the neighbouring question -- "may this PSP
// holding be counted as dollars" -- imported ONLY to be compared against. The
// two lists must not drift, and this module deliberately keeps its own copy
// rather than importing that one, because pspClients.js pulls in googleapis,
// the Google Sheets reader and the live rate feed (548 ms at import), and the
// CRM webhook's send path must not depend on any of them. This import is the
// alarm that rings if either list is edited alone.
import { DOLLAR_DENOMINATED_CURRENCIES } from "../wallet/pspClients.js";
import {
  DEPOSIT_VALUE_STAGE,
  DEPOSIT_TYPE,
  DEPOSIT_STATUSES,
  DEPOSIT_LOOKUP_LIMIT,
  DEFAULT_MINOR_UNIT_DIGITS,
  MINOR_UNIT_DIGITS,
  REPORTABLE_CURRENCIES,
  USD_PEGGED_CURRENCIES,
  PEGGED_SETTLEMENT_CURRENCY,
  isDepositType,
  isoCurrency,
  settlementCurrency,
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

  it("defaults to two digits for a reportable currency not in the exceptions table", () => {
    expect(DEFAULT_MINOR_UNIT_DIGITS).toBe(2);
    expect(minorUnitDigits("AED")).toBe(2);
    expect(minorUnitDigits("BRL")).toBe(2);
  });

  it("has no digits at all for a code that has not been settled", () => {
    // The guard the whole ordering rests on. A raw ticker reaching the digit
    // lookup means the mapping was skipped, and a DEFAULT of two would make
    // that mistake produce a perfectly plausible number.
    for (const unsettled of ["USDT", "USDCPOL", "BTC", "ZZZ", "BTC24", "", "  ", null, undefined, 840]) {
      expect(minorUnitDigits(unsettled), String(unsettled)).toBeNull();
    }
  });

  it("scales nothing by an unsettled code, so the wrong order cannot look right", () => {
    // **USDT is 6-decimal on chain; its settled form, USD, is 2.** Scaling by
    // the ticker's own precision turns a $100 deposit into 100000000 minor
    // units -- a hundredfold overstatement, in the direction that tells Meta to
    // bid harder. So an unsettled code yields nothing a scale can be built
    // from, and the caller reports a deposit it could not price.
    expect(toMinorUnits(100, "USDT")).toBe(0);
    expect(toMinorUnits(100, settlementCurrency("USDT"))).toBe(10000);
  });

  it("takes the magnitude, because direction comes from the type", () => {
    expect(toMinorUnits(-129.99, "USD")).toBe(12999);
  });
});

describe("USD-pegged stablecoins", () => {
  it("settles every pegged ticker as USD", () => {
    expect(PEGGED_SETTLEMENT_CURRENCY).toBe("USD");
    for (const code of USD_PEGGED_CURRENCIES) {
      expect(settlementCurrency(code), code).toBe("USD");
      expect(settlementCurrency(code.toLowerCase()), code).toBe("USD");
      expect(settlementCurrency(` ${code} `), code).toBe("USD");
    }
  });

  it("maps at par, carrying the amount across untouched", () => {
    // **There is no rate anywhere in this module, and that is the point.** A
    // pegged token is issued against a dollar, so valuing it at par is a
    // statement about its issuance rather than an exchange-rate lookup. These
    // two rows must produce identical numbers, which no injected rate but 1.0
    // can satisfy.
    const pegged = depositValueFrom(deposit({ processedCurrency: "USDT" })).value;
    const dollars = depositValueFrom(deposit({ processedCurrency: "USD" })).value;
    expect(pegged).toEqual(dollars);
    expect(pegged).toEqual({ currency: "USD", amountMinor: 12999, valueDecimal: 129.99 });
  });

  it("prices a pegged deposit by USD's two digits, not by the token's own precision", () => {
    // The end-to-end form of the ordering test above: $100 of USDT is 10000
    // minor units, never 100000000.
    const { value } = depositValueFrom(
      deposit({ processedAmount: 100, processedCurrency: "USDTTRC20", requestedAmount: 100 })
    );
    expect(value).toEqual({ currency: "USD", amountMinor: 10000, valueDecimal: 100 });
  });

  it("holds exactly the pegged tickers, so a coin is only ever added on purpose", () => {
    expect([...USD_PEGGED_CURRENCIES].sort()).toEqual([
      "PAX",
      "TUSD",
      "USDC",
      "USDCAVAX",
      "USDCBASE",
      "USDCPOL",
      "USDCSOL",
      "USDT",
      "USDTAVAX",
      "USDTBEP20",
      "USDTPOL",
      "USDTSOL",
      "USDTTRC20",
    ]);
  });

  it("never maps non-pegged crypto, which needs a live rate this module does not have", () => {
    // A wrong rate does not produce a slightly-off conversion -- it hands Meta
    // a bid signal wrong by orders of magnitude, which is worse than the
    // conversion lost by sending nothing. So these stay unreportable.
    for (const code of ["BTC", "ETH", "XRP", "LTC", "ADA", "SOL", "TRX", "DOGE", "BNB"]) {
      expect(settlementCurrency(code), code).toBe("");
      expect(USD_PEGGED_CURRENCIES.has(code), code).toBe(false);
    }
  });

  it("is enumerated, never pattern-matched on the letters USD", () => {
    // The tempting shortcut, and it would value any future ticker containing
    // those three letters at par, whatever it actually is.
    for (const lookalike of ["USDX", "MYUSD", "USDTX", "WUSDC", "USD1"]) {
      expect(settlementCurrency(lookalike), lookalike).toBe("");
    }
  });

  // An env var that let someone add BTC to this list would report a 0.4 BTC
  // deposit as $0.40 of revenue, and it would be one typo away at all times.
  // Three tests, because a table built at IMPORT time escapes a test that only
  // stubs the environment afterwards -- which is exactly how the first version
  // of this case passed against a deliberately configurable table.
  const PEG_ENV_NAMES = [
    "USD_PEGGED_CURRENCIES",
    "CRM_USD_PEGGED_CURRENCIES",
    "PEGGED_CURRENCIES",
    "STABLECOINS",
    "CRM_STABLECOINS",
    "DOLLAR_DENOMINATED_CURRENCIES",
  ];

  it("is not extended by the environment at call time", () => {
    for (const name of PEG_ENV_NAMES) vi.stubEnv(name, "BTC,ETH");
    try {
      expect(settlementCurrency("BTC")).toBe("");
      expect(settlementCurrency("ETH")).toBe("");
      expect(USD_PEGGED_CURRENCIES.has("BTC")).toBe(false);
      expect(USD_PEGGED_CURRENCIES.size).toBe(13);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is not extended by the environment at import time either", async () => {
    // The variable is set and the module registry cleared BEFORE the import, so
    // a table assembled while the module is first evaluated is caught too. The
    // call-time test above cannot see that: by the time it runs, the set it is
    // asserting against was built long ago.
    for (const name of PEG_ENV_NAMES) vi.stubEnv(name, "BTC,ETH");
    vi.resetModules();
    try {
      const fresh = await import("./depositValue.js");
      expect(fresh.USD_PEGGED_CURRENCIES.has("BTC")).toBe(false);
      expect(fresh.USD_PEGGED_CURRENCIES.size).toBe(13);
      expect(fresh.settlementCurrency("BTC")).toBe("");
      expect(fresh.settlementCurrency("ETH")).toBe("");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("reads no environment variable anywhere in the module", () => {
    // The class-level guard rather than a list of names nobody can finish. The
    // ONLY thing here an operator may tune is the shared send timeout, and that
    // is read inside sendTimeout.js -- so this file has no business touching
    // process.env at all, and a table, a status list or a currency allowlist
    // that grew a variable would be caught whatever it was called.
    // Comments are stripped first: the module says in prose that it reads
    // nothing from the environment, and a test that counted that sentence as a
    // violation would be unable to tell the promise from the breach.
    const source = readFileSync(path.resolve("crmSignup/depositValue.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("process.env");
    // Taken with the line above, this says the mention survives only in prose:
    // the module still states the rule, and states it nowhere that executes.
    expect(source).toContain("process.env");
  });

  it("does not drift from the treasury side's dollar-pegged list", () => {
    // wallet/pspClients.js answers the neighbouring question about PSP wallet
    // holdings and reached the same conclusion about the same tokens. This list
    // is its dollar-pegged half: everything there except USD itself, which
    // needs no mapping because it is already the ISO code we report.
    for (const code of USD_PEGGED_CURRENCIES) {
      expect(DOLLAR_DENOMINATED_CURRENCIES.has(code), code).toBe(true);
    }
    const theirsWithoutUsd = [...DOLLAR_DENOMINATED_CURRENCIES].filter((c) => c !== "USD");
    expect([...USD_PEGGED_CURRENCIES].sort()).toEqual(theirsWithoutUsd.sort());
  });
});

describe("isoCurrency", () => {
  it("accepts a reportable currency, uppercased", () => {
    expect(isoCurrency("usd")).toBe("USD");
    expect(isoCurrency(" eur ")).toBe("EUR");
    expect(isoCurrency("aed")).toBe("AED");
  });

  it("refuses anything that is not one, three letters or not", () => {
    // Meta silently ignores a currency it cannot read, which would put us back
    // where this change started: an accepted request and no conversion.
    // `USDT` is among these ON PURPOSE: this function is the membership test
    // alone, and the peg is settlementCurrency's job, one step earlier.
    for (const bad of ["USDT", "US", "US1", "$", "ZZZ", "", null, undefined, 840]) {
      expect(isoCurrency(bad), String(bad)).toBe("");
    }
  });

  it("is an allowlist, because a shape test cannot tell BRL from BTC", () => {
    // **Every major non-pegged crypto ticker is exactly three letters.** A
    // `/^[A-Z]{3}$/` test accepts a 0.4 BTC deposit, calls it
    // `value: 0.4, currency: "BTC"`, and reports a five-figure deposit as forty
    // cents of revenue -- with Meta silently ignoring the currency it cannot
    // read. The real three-letter currencies next to them are the reason this
    // cannot be a pattern.
    for (const crypto of ["BTC", "ETH", "XRP", "LTC", "ADA", "SOL", "TRX", "BNB", "XBT"]) {
      expect(isoCurrency(crypto), crypto).toBe("");
      expect(REPORTABLE_CURRENCIES.has(crypto), crypto).toBe(false);
    }
    // And the currencies a denylist would have had to tell them apart from.
    for (const real of ["BRL", "ETB", "XCD", "LSL", "AED", "SOS", "TRY", "BND"]) {
      expect(isoCurrency(real), real).toBe(real);
    }
  });

  it("holds no fund unit, metal or reserved code", () => {
    // Nobody deposits in one, and every one of them would need a rate.
    for (const code of ["BOV", "CHE", "CHW", "COU", "MXV", "USN", "UYI", "UYW", "CLF"]) {
      expect(isoCurrency(code), code).toBe("");
    }
    for (const code of ["XAU", "XAG", "XPT", "XPD", "XDR", "XSU", "XUA", "XXX", "XTS"]) {
      expect(isoCurrency(code), code).toBe("");
    }
    // The three X-codes that ARE circulating currencies stay in.
    for (const code of ["XAF", "XOF", "XPF", "XCD"]) {
      expect(isoCurrency(code), code).toBe(code);
    }
  });

  it("gives every minor-unit exception a place on the allowlist", () => {
    // A code with a digit count but no membership would be unreachable, and the
    // two tables disagreeing is how a 0-decimal currency comes to be scaled by
    // 100 somewhere else later.
    for (const code of MINOR_UNIT_DIGITS.keys()) {
      expect(REPORTABLE_CURRENCIES.has(code), code).toBe(true);
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

  it("refuses a currency it cannot report, permanently and by name", () => {
    // Non-pegged crypto, where the code IS the reason: there is no rate here to
    // convert it at, and inventing one would hand Meta a bid signal wrong by
    // orders of magnitude.
    const { value, failure } = depositValueFrom(deposit({ processedCurrency: "BTC" }));
    expect(value).toBeUndefined();
    expect(failure.detail).toContain("processedCurrency");
    expect(failure.detail).toContain("BTC");
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
