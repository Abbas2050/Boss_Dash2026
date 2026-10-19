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
 * Listed here are the currencies whose minor unit is not 1/100. Everything
 * absent uses two digits, which is the right default and the overwhelming
 * majority -- including the USD almost every deposit here arrives in.
 */
export const MINOR_UNIT_DIGITS = new Map([
  ["BIF", 0], ["CLP", 0], ["DJF", 0], ["GNF", 0], ["ISK", 0], ["JPY", 0],
  ["KMF", 0], ["KRW", 0], ["PYG", 0], ["RWF", 0], ["UGX", 0], ["VND", 0],
  ["VUV", 0], ["XAF", 0], ["XOF", 0], ["XPF", 0],
  ["BHD", 3], ["IQD", 3], ["JOD", 3], ["KWD", 3], ["LYD", 3], ["OMR", 3],
  ["TND", 3],
]);

export const DEFAULT_MINOR_UNIT_DIGITS = 2;

export function minorUnitDigits(currency) {
  const code = text(currency).toUpperCase();
  return MINOR_UNIT_DIGITS.has(code) ? MINOR_UNIT_DIGITS.get(code) : DEFAULT_MINOR_UNIT_DIGITS;
}

/**
 * An ISO 4217 alphabetic code, uppercased, or "".
 *
 * Three ASCII letters and nothing else. Meta documents `currency` as an ISO
 * code and silently ignores a value it cannot read, which would put us back
 * where this change started -- an accepted request and no conversion. So a code
 * we cannot vouch for stops the send with a reason instead.
 *
 * The consequence worth knowing: a deposit booked in something that is not an
 * ISO code -- a stablecoin ticker, say -- has no sendable value, and its row
 * settles `failed` naming the code rather than converting. That is the visible
 * failure, which is the point.
 */
export function isoCurrency(value) {
  const code = text(value).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

/**
 * The amount as an integer in the currency's minor unit: $129.99 is 12999.
 *
 * `Math.round`, never a truncation: 129.99 * 100 is 12998.999999999998 in
 * binary floating point, and cutting it would under-report every other deposit
 * by a cent. This is the ONE place a currency's minor-unit digits are applied,
 * so the decimal and the integer cannot be scaled by two different opinions.
 */
export function toMinorUnits(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.abs(n) * 10 ** minorUnitDigits(currency));
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

    const currency = isoCurrency(row?.[currencyKey]);
    if (!currency) {
      return {
        failure: {
          detail: `${currencyKey} ${JSON.stringify(text(row?.[currencyKey]))} is not a three-letter ISO currency code`,
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
