import { sendTimeoutSignal } from "./sendTimeout.js";
import { isTransientHttpStatus } from "./transientHttp.js";

/**
 * The deposit amount, fetched from FXBO, for the one conversion that cannot be
 * sent without it.
 *
 * **Meta does not reject a `Purchase` with no value -- it DISCARDS it.** The
 * Graph API answers 200 with `events_received: 1`, the row records `sent`, and
 * the conversion never exists in the dataset. Events Manager says so under
 * diagnostic `s2s_invalid_purchase_event_actions`, raised on 16 October, the
 * day our first conversions went out: three deposits sent, none in the dataset.
 *
 * That supersedes the 13 October decision to send no value (spec section 4).
 * That decision traded return-on-ad-spend measurement for dropping this REST
 * call. The trade is no longer on offer: without the amount there is no event
 * at all, so the call is a precondition of the send rather than an enrichment
 * of it.
 *
 * **This is FXBO, not the trading backend.** `api.skylinkscapital.com` is a
 * different system with a different credential (`BACKEND_API_KEY`, exchanged
 * for a bearer by `wallet/backendToken.js`). FXBO is reached at
 * `REST_PROXY_TARGET` with `API_TOKEN`, exactly as `server.js`'s `/rest` proxy
 * and `reports/reportShared.js` already reach it. Confusing the two sends the
 * wrong secret to the wrong company.
 */

/**
 * The one stage that has a deposit to look up.
 *
 * A constant rather than a literal in the worker because it is also the whole
 * of the cost control: this is the only outbound call in the module that is not
 * to a destination, and it must stay on the first-deposit path, which is a few
 * events a day.
 */
export const DEPOSIT_VALUE_STAGE = "first_deposit";

/**
 * Only money that actually arrived.
 *
 * A pending or declined deposit is not a conversion, and reporting one as a
 * purchase would bid real money against a transaction that never settled. The
 * reports read the same word from `SUMMARY_TX_STATUSES`, defaulted to
 * `approved`; this one is not configurable, because a status list that could be
 * widened by an environment variable could book a declined deposit as revenue.
 */
export const DEPOSIT_STATUSES = ["approved"];

/**
 * FXBO's own word for external client money arriving.
 *
 * The real vocabulary was printed by the first live weekly send and is written
 * down in `reports/summaryCore.js`: `credit`, `deposit`, `ib transfer to
 * account`, `ib transfer to account out`, `ib withdrawal`, `transfer in`,
 * `transfer out`, `withdrawal`. Only `deposit` is a client putting money in --
 * `transfer in` is the client moving their own money between their own
 * accounts, and `credit` is a bonus rather than cash.
 *
 * That table is deliberately not imported: `summaryCore.js` pulls in
 * `reportShared.js`, and with it the chart renderer and the mail transport, for
 * a one-word comparison. The duplication is one literal, and the test below
 * pins every type the live send printed so a new one is found here too.
 */
export const DEPOSIT_TYPE = "deposit";

/** How many of a client's transactions to read. A client whose FIRST deposit
 *  has just fired has almost no history, and the filter is applied upstream
 *  anyway; this only bounds the answer if FXBO ignores the filter. */
export const DEPOSIT_LOOKUP_LIMIT = 50;

const text = (v) => String(v ?? "").trim();

export function isDepositType(type) {
  return text(type).toLowerCase() === DEPOSIT_TYPE;
}

/**
 * ISO 4217 does not give every currency two decimal places, and assuming it
 * does is a hundredfold error rather than a rounding one: JPY 1,500 sent as
 * 150000 minor units tells ChatGPT Ads the deposit was a hundred times its real
 * size, and nothing downstream would query it.
 *
 * Listed here are the currencies whose minor unit is not 1/100. A reportable
 * currency absent from this table uses two digits, which is the overwhelming
 * majority -- including the USD almost every deposit here arrives in.
 *
 * **This table is kept short on purpose, and `REPORTABLE_CURRENCIES` carries
 * the length instead.** A typo in the long allowlist costs a refused deposit,
 * named in the row; a typo in THIS one silently misreports a real deposit by a
 * factor of ten or a hundred. So the risky table is the one small enough to
 * read in a glance.
 */
export const MINOR_UNIT_DIGITS = new Map([
  ["BIF", 0], ["CLP", 0], ["DJF", 0], ["GNF", 0], ["ISK", 0], ["JPY", 0],
  ["KMF", 0], ["KRW", 0], ["PYG", 0], ["RWF", 0], ["UGX", 0], ["VND", 0],
  ["VUV", 0], ["XAF", 0], ["XOF", 0], ["XPF", 0],
  ["BHD", 3], ["IQD", 3], ["JOD", 3], ["KWD", 3], ["LYD", 3], ["OMR", 3],
  ["TND", 3],
]);

export const DEFAULT_MINOR_UNIT_DIGITS = 2;

/**
 * The minor-unit digits of a **settled** currency, or `null` for a code that
 * has not been through `settlementCurrency`.
 *
 * **Null rather than the default, and that is the guard the whole ordering
 * rests on.** The digits must be read from the currency the deposit is
 * REPORTED in, never from the ticker it arrived as. USDT is 6-decimal on chain
 * and its settled form, USD, is 2 -- so a $100 USDT deposit scaled by the raw
 * ticker's precision is 100000000 minor units, a hundredfold overstatement, in
 * the direction that tells Meta to bid harder. Returning
 * `DEFAULT_MINOR_UNIT_DIGITS` for an unsettled code would make that mistake
 * produce a perfectly plausible number today and a wrong one the day anybody
 * writes a real precision down.
 *
 * So an unsettled code yields nothing a scale can be built from, and both
 * callers below turn that into a deposit we could not price -- visible -- rather
 * than a number nobody can check.
 *
 * A reportable currency this table has never seen is a different thing and
 * still gets the two-digit default: that is the overwhelming majority,
 * including the USD almost every deposit here arrives in.
 */
export function minorUnitDigits(currency) {
  const code = isoCurrency(currency);
  if (!code) return null;
  return MINOR_UNIT_DIGITS.has(code) ? MINOR_UNIT_DIGITS.get(code) : DEFAULT_MINOR_UNIT_DIGITS;
}

/**
 * The USD-pegged stablecoins, and nothing else.
 *
 * **A hard-coded constant, deliberately not configurable.** The same reasoning
 * as `DEPOSIT_STATUSES`, only sharper: an environment variable that let someone
 * add `BTC` to this list would report a 0.4 BTC deposit as $0.40 of revenue,
 * and it would be one typo away at all times. There is no variable, no merge
 * with anything from `process.env`, and the test asserts the membership exactly
 * so a coin added here has to be added on purpose.
 *
 * **Every entry is 1:1 by construction, which is why there is no rate anywhere
 * in this file.** The amount is carried across unchanged and only the code is
 * rewritten. A pegged token is issued against a dollar; valuing it at par is a
 * statement about its issuance, not an exchange-rate lookup.
 *
 * **The peg is an assumption, and it is accepted rather than implicit.** If any
 * of these depegs materially, this quietly misreports deposit value -- there is
 * nothing in the code that would notice, because there is no rate to disagree
 * with. At a stablecoin's ordinary drift (fractions of a cent) that error is far
 * below anything an ad platform optimises on, and `wallet/cryptoRates.js`
 * already accepts exactly the same error for exactly the same reason on the
 * treasury side. A sustained depeg is an operational event somebody would know
 * about; the fix then is to remove the coin from this list, which makes its
 * deposits `failed` and visible rather than silently mispriced.
 *
 * **Non-pegged crypto is deliberately absent and must stay absent.** BTC, ETH,
 * XRP, LTC and the rest need a live rate we do not have here, and a wrong rate
 * does not produce a slightly-off conversion -- it hands Meta a bid signal wrong
 * by orders of magnitude, which is worse than the conversion we lose by sending
 * nothing. Those codes keep the behaviour below: a permanent `failed` naming the
 * code.
 *
 * **Enumerated, never pattern-matched.** `code.includes("USD")` is the tempting
 * shortcut and is wrong -- it would value any future ticker containing those
 * three letters at par, whatever it actually is. `wallet/pspClients.js` has that
 * warning written on the same list for the same reason.
 *
 * The membership is the dollar-pegged half of `DOLLAR_DENOMINATED_CURRENCIES` in
 * `wallet/pspClients.js`, which answers the neighbouring question "may this PSP
 * holding be counted as dollars in the treasury total". The chain suffixes are
 * not decoration: those are the codes Bitpace and LetKnow Pay actually settle
 * Tether and USD Coin under. It is a second copy rather than an import, because
 * that module pulls in `googleapis`, the Google Sheets reader and the live rate
 * feed, and the CRM webhook's send path must not depend on any of them. **The
 * duplication is the alarm:** `depositValue.test.js` asserts this set is a
 * subset of that one, so the two cannot drift apart without a test saying so.
 */
export const USD_PEGGED_CURRENCIES = new Set([
  // Tether, across every chain the providers settle it on.
  "USDT",
  "USDTTRC20",
  "USDTBEP20",
  "USDTPOL",
  "USDTSOL",
  "USDTAVAX",
  // USD Coin, likewise.
  "USDC",
  "USDCSOL",
  "USDCPOL",
  "USDCBASE",
  "USDCAVAX",
  // Paxos Standard and TrueUSD, the two other dollar-pegged tokens these
  // accounts have ever been able to hold.
  "PAX",
  "TUSD",
]);

/** What a USD-pegged code settles as. One constant, so the 1:1 claim and the
 *  reported code cannot come apart. */
export const PEGGED_SETTLEMENT_CURRENCY = "USD";

/**
 * The currency codes we are willing to report a deposit in.
 *
 * **An allowlist rather than a `/^[A-Z]{3}$/` shape test, and that is the whole
 * point of it.** A three-letter shape test cannot tell `BRL` from `BTC`: every
 * major non-pegged crypto ticker is exactly three letters -- BTC, ETH, XRP,
 * LTC, ADA, SOL, TRX, BNB -- so a shape test accepts a 0.4 BTC deposit, calls
 * it `value: 0.4, currency: "BTC"`, and reports a five-figure deposit as forty
 * cents of revenue. `wallet/pspClients.js` has this same warning on its own
 * dollar allowlist: a code the list has never seen is not a currency, it is
 * something this module cannot value.
 *
 * ISO 4217 alphabetic codes for circulating currencies. Deliberately NOT
 * included:
 *
 * - **Crypto of any kind.** Pegged stablecoins come in through
 *   `USD_PEGGED_CURRENCIES` and settle as `USD`; everything else needs a live
 *   rate this module does not have. `BTC` is not an ISO code in any case -- the
 *   unofficial one is `XBT`, which is also absent.
 * - **Fund and index units** (`BOV`, `CHE`, `CHW`, `COU`, `MXV`, `USN`, `UYI`,
 *   `UYW`, `CLF`, `XDR`, `XSU`, `XUA`, `XBA`-`XBD`). Nobody deposits in one.
 * - **Precious metals** (`XAU`, `XAG`, `XPT`, `XPD`) and the reserved codes
 *   `XXX` and `XTS`, for the same reason plus the rate problem above.
 *
 * **An omission here costs a visible `failed` naming the code, and is a
 * one-line fix.** That is the direction this is built to fail in: the other way
 * round sends Meta a number nobody can check. A handful of recently retired
 * codes (`HRK`, `SLL`, `ZWL`) are kept because a historical transaction row can
 * still carry one.
 */
export const REPORTABLE_CURRENCIES = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD",
  "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK",
  "DJF", "DKK", "DOP", "DZD",
  "EGP", "ERN", "ETB", "EUR",
  "FJD", "FKP",
  "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD",
  "HKD", "HNL", "HRK", "HTG", "HUF",
  "IDR", "ILS", "INR", "IQD", "IRR", "ISK",
  "JMD", "JOD", "JPY",
  "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT",
  "LAK", "LBP", "LKR", "LRD", "LSL", "LYD",
  "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR",
  "MWK", "MXN", "MYR", "MZN",
  "NAD", "NGN", "NIO", "NOK", "NPR", "NZD",
  "OMR",
  "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG",
  "QAR",
  "RON", "RSD", "RUB", "RWF",
  "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS",
  "SRD", "SSP", "STN", "SVC", "SYP", "SZL",
  "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS",
  "UAH", "UGX", "USD", "UYU", "UZS",
  "VES", "VND", "VUV",
  "WST",
  "XAF", "XCD", "XOF", "XPF",
  "YER",
  "ZAR", "ZMW", "ZWG", "ZWL",
]);

/**
 * A reportable currency code, uppercased, or "".
 *
 * Meta documents `currency` as an ISO code and silently ignores a value it
 * cannot read, which would put us back where this change started -- an accepted
 * request and no conversion. So a code we cannot vouch for stops the send with
 * a reason instead.
 *
 * This is the membership test alone. The stablecoin peg is
 * `settlementCurrency`'s job, one step earlier, which is why `USDT` is "" here.
 */
export function isoCurrency(value) {
  const code = text(value).toUpperCase();
  return REPORTABLE_CURRENCIES.has(code) ? code : "";
}

/**
 * The ISO code a deposit is REPORTED in, or "".
 *
 * **This is the only door into the rest of this module**, and everything
 * downstream -- the minor-unit digits, the integer, the decimal, the code sent
 * to both platforms -- is built from what it returns and never from the raw
 * value again. That is what keeps the mapping and the scaling in the right
 * order; `minorUnitDigits` refuses an unsettled code so that getting it wrong
 * is loud rather than plausible.
 *
 * A USD-pegged stablecoin settles as USD at par. Anything else has to be a
 * reportable currency already, or it is not one this can report.
 *
 * The consequence worth knowing: a deposit booked in non-pegged crypto -- BTC,
 * ETH -- has no sendable value, and its row settles `failed` naming the code
 * rather than converting at a rate we would have to invent. That is the visible
 * failure, which is the point.
 */
export function settlementCurrency(value) {
  const code = text(value).toUpperCase();
  if (USD_PEGGED_CURRENCIES.has(code)) return PEGGED_SETTLEMENT_CURRENCY;
  return isoCurrency(code);
}

/**
 * The amount as an integer in the settled currency's minor unit: $129.99 is
 * 12999.
 *
 * `Math.round`, never a truncation: 129.99 * 100 is 12998.999999999998 in
 * binary floating point, and cutting it would under-report every other deposit
 * by a cent.
 *
 * `currency` must already be settled. An unsettled code has no digits (see
 * `minorUnitDigits`) and yields 0 here, which the caller reports as a deposit it
 * could not price -- never as a number scaled by the wrong precision.
 */
export function toMinorUnits(amount, currency) {
  const digits = minorUnitDigits(currency);
  if (digits === null) return 0;
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.abs(n) * 10 ** digits);
}

/** When a transaction happened, for ordering. A row whose date cannot be read
 *  must never win "earliest" by accident, so it sorts last rather than first. */
function createdAtMs(row) {
  const ms = Date.parse(text(row?.createdAt));
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * The client's earliest approved deposit, or null.
 *
 * The earliest is chosen HERE rather than trusted from the request's `orders`.
 * The sort is asked for as well, but a server that quietly ignored it would
 * hand us the client's latest deposit for their first-deposit conversion, and
 * nothing about that answer would look wrong. Reading it off the rows costs a
 * comparison over a handful of them.
 */
export function pickFirstDeposit(rows) {
  const deposits = (Array.isArray(rows) ? rows : []).filter((row) => isDepositType(row?.type));
  if (!deposits.length) return null;
  // `<` and not `<=`, so rows sharing an instant keep the order FXBO returned.
  return deposits.reduce((earliest, row) => (createdAtMs(row) < createdAtMs(earliest) ? row : earliest));
}

// The two amount/currency pairs a transaction carries, in preference order.
// **Each pair travels together and is never crossed.** A deposit requested in
// EUR and processed in USD would otherwise be reported as dollars labelled
// euros -- a number Meta would accept and bid against.
const AMOUNT_PAIRS = [
  ["processedAmount", "processedCurrency"],
  ["requestedAmount", "requestedCurrency"],
];

/**
 * One transaction row to the three numbers the two destinations need, or a
 * reason there are none.
 *
 * `processedAmount` first: it is the money that actually landed, and
 * `reports/summaryCore.js` prefers it for the same reason. The requested pair
 * is the fallback for a PSP that reports only what was asked for.
 *
 * **The decimal is derived from the integer, not read a second time from the
 * row.** Meta wants a decimal and ChatGPT Ads wants an integer in the minor
 * unit, and the one way those two can disagree is being computed separately.
 * One rounding, one scale, two views of it.
 */
export function depositValueFrom(row) {
  for (const [amountKey, currencyKey] of AMOUNT_PAIRS) {
    const raw = Number(row?.[amountKey]);
    // Direction comes from the transaction type, never from the sign: the CRM
    // books some legs signed-negative, and summaryCore.js takes magnitudes here
    // for exactly that reason.
    const amount = Number.isFinite(raw) ? Math.abs(raw) : 0;
    if (!(amount > 0)) continue;

    // **Settled first, and the raw value is never read again below.** A pegged
    // stablecoin becomes USD here, so the digits, the integer and the decimal
    // are all built from USD's two places rather than from the ticker's own
    // precision. Reversing those two steps is the hundredfold error
    // minorUnitDigits exists to make loud.
    const currency = settlementCurrency(row?.[currencyKey]);
    if (!currency) {
      return {
        failure: {
          // Names the code, because for non-pegged crypto the code IS the
          // reason: there is no rate here to convert it at.
          detail: `${currencyKey} ${JSON.stringify(text(row?.[currencyKey]))} is not a reportable currency`,
          // It will not be a different code in five minutes.
          retryable: false,
        },
      };
    }

    const amountMinor = toMinorUnits(amount, currency);
    if (!(amountMinor > 0)) {
      return { failure: { detail: `the deposit rounds to 0 ${currency}`, retryable: false } };
    }

    return {
      value: {
        currency,
        amountMinor,
        valueDecimal: amountMinor / 10 ** minorUnitDigits(currency),
      },
    };
  }

  return { failure: { detail: "the deposit carries no positive amount", retryable: false } };
}

/**
 * The search body for "this client's deposits".
 *
 * `fromUserId` is the CRM user, which is what `crm_client_id` holds -- FXBO's
 * `%client_id_without_link%`. It is NOT `fromLoginSid`, which is a composite
 * account id ("2-154439"): one client owns several of those, so keying on it
 * would read one person as several (`reports/summaryCore.js` has the same note
 * for the same reason).
 *
 * `segment` is the only required field on the request.
 */
export function buildFirstDepositQuery(crmClientId) {
  return {
    fromUserId: Number(crmClientId),
    statuses: [...DEPOSIT_STATUSES],
    transactionTypes: [DEPOSIT_TYPE],
    orders: [{ field: "createdAt", direction: "ASC" }],
    segment: { limit: DEPOSIT_LOOKUP_LIMIT, offset: 0 },
  };
}

/** FXBO's client id is an integer. A row whose id is not one has no client to
 *  ask about, and `fromUserId: NaN` serialises to null -- which is the request
 *  for EVERY user's transactions, not none of them. */
function clientUserId(crmClientId) {
  const id = Number(text(crmClientId));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function transactionsUrl(baseUrl, apiVersion) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  // The token goes in a header and never here: a URL is echoed in proxy logs,
  // in fetch's own error messages, and in the CRM's webhook stats table.
  return `${base}/rest/transactions?version=${encodeURIComponent(text(apiVersion) || "1.0.0")}`;
}

/**
 * The client's first deposit value, or why there is none.
 *
 * **Never throws, and never puts the token in its result.** Answers either
 * `{ value }` or `{ failure: { detail, retryable } }`, and the caller must
 * treat anything that is not a `value` as a send that did not happen.
 *
 * `retryable` separates the two reasons there is no value, which are not the
 * same problem:
 *
 * - **Not yet.** FXBO's transaction record can lag the webhook that announced
 *   it by seconds, and the CRM can be briefly unreachable. Retrying is right,
 *   and the step's attempt budget -- three attempts, five minutes apart --
 *   bounds the wait at ten minutes before the row settles `failed`.
 * - **Not ever.** A missing `API_TOKEN`, a client id that is not a number, a
 *   4xx that is not a throttle, an amount of zero, a currency nobody can read.
 *   None of these is different in five minutes, so spending the budget on them
 *   only delays the `failed` an operator has to act on anyway -- the same
 *   reasoning `decideBrevoListIdFailure` applies to an unusable list id.
 */
export async function fetchFirstDepositValue({
  fetchImpl = fetch,
  baseUrl,
  apiVersion,
  apiToken,
  crmClientId,
} = {}) {
  const token = text(apiToken);
  if (!token) {
    // Names the variable, never a value. server.js warns about the same thing
    // at startup, so this detail should already have company in the log.
    return { failure: { detail: "API_TOKEN is not set, so the CRM cannot be asked", retryable: false } };
  }

  const userId = clientUserId(crmClientId);
  if (userId === null) {
    return { failure: { detail: "the row has no numeric CRM client id", retryable: false } };
  }

  let response;
  try {
    response = await fetchImpl(transactionsUrl(baseUrl, apiVersion), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildFirstDepositQuery(userId)),
      // The same bound every outbound send here is held to. Node's fetch has no
      // timeout of its own, and the sweeper runs rows one at a time, so an
      // unbounded lookup would stall every row behind this one.
      signal: sendTimeoutSignal(),
    });
  } catch (transportError) {
    return {
      failure: {
        detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
        retryable: true,
      },
    };
  }

  const status = Number(response?.status) || 0;
  if (!(status >= 200 && status < 300)) {
    return {
      failure: {
        // No body is read on a failure: the CRM quotes the request back in some
        // errors, and the request names a client. The status is the diagnostic.
        detail: `http ${status}`,
        // 408, 429 and every 5xx, the rule all four senders share. A 401 or 403
        // is the token, a 400 is this query, and neither clears on a retry.
        retryable: isTransientHttpStatus(status),
      },
    };
  }

  let rows;
  try {
    rows = await response.json();
  } catch (error) {
    return {
      failure: {
        detail: error?.name === "TimeoutError" ? "body timed out" : "the CRM answered with no readable body",
        retryable: true,
      },
    };
  }

  if (!Array.isArray(rows)) {
    // A proxy answered instead of the CRM: the outcome is unknown rather than
    // empty, and an unknown one is worth asking again.
    return { failure: { detail: "the CRM answered with no transaction list", retryable: true } };
  }

  const deposit = pickFirstDeposit(rows);
  if (!deposit) {
    // The timing case, and the reason this is retryable at all: the
    // "First time deposit by client" rule can reach us before the transaction
    // it describes is queryable.
    return { failure: { detail: "no approved deposit for this client yet", retryable: true } };
  }

  // Only the amount and the currency are taken off the row. A transaction
  // carries the client's own comments, tickets and custom fields, and none of
  // that is ours to store or log.
  return depositValueFrom(deposit);
}
