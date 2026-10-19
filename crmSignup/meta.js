import { createHash } from "crypto";
import { sendTimeoutSignal } from "./sendTimeout.js";
import { isTransientHttpStatus } from "./transientHttp.js";

export const GRAPH_HOST = "https://graph.facebook.com";

/** One Meta event per funnel stage. `registered` is mapped but not sent -- see
 *  decideMetaSkip. The mapping stays complete so that lifting the gate is one
 *  change rather than two. */
export const META_EVENT_NAMES = {
  lead: "Lead",
  registered: "CompleteRegistration",
  verified: "Client_Verified",
  live_account: "TradingAccountOpened",
  first_deposit: "Purchase",
};

const text = (v) => String(v ?? "").trim();

/**
 * The stage whose conversion belongs to the website pixel, not to us.
 *
 * 2026-10-14, user's call: the WordPress plugin keeps firing the
 * CompleteRegistration pixel event on the signup page, so sending the same
 * event from here would book one registration as two conversions and inflate
 * every cost-per-acquisition Meta reports.
 *
 * The usual answer -- fire both and let Meta deduplicate -- needs the browser's
 * `event_id` carried through to the server, and nothing in the path can do
 * that: the pixel's id lives in the page, while ours arrives from FXBO, which
 * has no field holding it. So one owner per stage, and for this stage the owner
 * is the pixel.
 *
 * The cost, stated rather than hidden: CompleteRegistration is only ever as
 * complete as a browser pixel, so signups from ad-blocked or tracking-restricted
 * browsers go unattributed for that step. The other four stages are server-side
 * and unaffected, which is why they stay here.
 */
export const PIXEL_OWNED_STAGE = "registered";

/**
 * Whether this event is ours to send, and if not, why not.
 *
 * The configuration reason is checked first on purpose: with no token, both
 * reasons are true for `registered`, and "meta not configured" is the one an
 * operator can act on. Reading a missing token as a design choice is how a
 * dead integration looks deliberate in the settings tab.
 */
export function decideMetaSkip({ stage, accessToken }) {
  if (!text(accessToken)) return { reason: "meta not configured" };
  if (stage === PIXEL_OWNED_STAGE) return { reason: `${PIXEL_OWNED_STAGE} is owned by the website pixel` };
  return null;
}

/** Meta requires exactly these three values on a CRM event. */
const ACTION_SOURCE = "system_generated";
const EVENT_SOURCE = "crm";
const LEAD_EVENT_SOURCE = "FXBackOffice";

// Transient Graph API conditions. Meta returns these with an unreliable
// HTTP status -- commonly 400 -- so the code is what decides, not the status.
//   1   unknown/transient, Meta's guidance is to retry
//   2   service temporarily unavailable
//   4   application-level rate limit
//   17  user-level rate limit
//   32  page-level rate limit
//   341 application limit reached, documented as temporary and retryable
//   613 custom-level rate limit
// 368 (temporary policy block) is left out: it will not clear on a retry.
const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Meta hashes the NORMALISED value on its side, so we must normalise before
 * hashing or the digests can never meet. Empty in, empty out -- sha256("") is
 * a perfectly valid digest that would be sent as though it were an address.
 */
export function hashEmail(email) {
  const v = String(email ?? "").trim().toLowerCase();
  return v ? sha256(v) : "";
}

export function hashPhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits ? sha256(digits) : "";
}

/**
 * Meta's `value` and `currency`, or NEITHER of them.
 *
 * **Meta requires both or neither, and a `Purchase` carrying one of them is the
 * same defect as a `Purchase` carrying none.** Diagnostic
 * `s2s_invalid_purchase_event_actions`, raised 2026-10-16, is explicit: "All
 * purchase events must contain a value parameter and a currency parameter."
 * Meta still answers 200 with `events_received: 1` and then discards the event,
 * so the row would read `sent` for a conversion that does not exist.
 *
 * So the pair is attached by one function that can only ever return both or
 * neither. Attaching them from two `if`s at the call site is what makes the
 * half-filled version constructible, and nothing downstream would complain
 * about it.
 *
 * **`valueDecimal`, not `amountMinor`.** Meta's `value` is a decimal in the
 * major unit: $129.99 is `129.99`. ChatGPT Ads wants the same deposit as the
 * integer `12999`. `depositValue.js` carries both under names that say which is
 * which, because the two are a hundred apart and either would be accepted here
 * without comment.
 *
 * The three-letter test is the last-ditch half of "both or neither", **not the
 * authority on which currencies exist**. That is `settlementCurrency` in
 * `depositValue.js`, which holds an allowlist, because a shape test cannot tell
 * `BRL` from `BTC` and every major crypto ticker is three letters. Nothing but
 * a settled code should reach here; this only makes sure a blank one takes the
 * value with it.
 */
export function metaValueFields(depositValue) {
  const currency = String(depositValue?.currency ?? "").trim().toUpperCase();
  const value = Number(depositValue?.valueDecimal);
  if (!/^[A-Z]{3}$/.test(currency)) return {};
  if (!Number.isFinite(value) || !(value > 0)) return {};
  return { value, currency };
}

export function buildMetaPayload({ stage, email, phone, fbc, eventTimeSeconds, eventId, testEventCode, depositValue }) {
  const user_data = {};

  const em = hashEmail(email);
  if (em) user_data.em = [em];

  const ph = hashPhone(phone);
  if (ph) user_data.ph = [ph];

  // Passed through verbatim: it was frozen at this client's first event, and
  // recomputing it per stage hands Meta a different click identity each time.
  const click = String(fbc ?? "").trim();
  if (click) user_data.fbc = click;

  // The two CRM constants, plus the deposit's value and currency on the one
  // stage that has them (2026-10-19, superseding the 13 October decision to
  // send neither -- metaValueFields says why there is no third option).
  // Every other stage passes no depositValue and carries no pair.
  const custom_data = {
    event_source: EVENT_SOURCE,
    lead_event_source: LEAD_EVENT_SOURCE,
    ...metaValueFields(depositValue),
  };

  const event = {
    action_source: ACTION_SOURCE,
    custom_data,
    event_name: META_EVENT_NAMES[stage],
    event_time: Number(eventTimeSeconds),
    user_data,
  };

  // Meta dedupes on event_id plus event_name. The caller derives it from the
  // client and stage, so a retry of the same funnel event carries the same id.
  const id = String(eventId ?? "").trim();
  if (id) event.event_id = id;

  const payload = { data: [event] };

  const code = String(testEventCode ?? "").trim();
  if (code) payload.test_event_code = code;

  return payload;
}

export function classifyMetaOutcome({ transportError, httpStatus: rawStatus, body, bodyTimedOut } = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const httpStatus = Number(rawStatus) || 0;
  const reason = String(body?.error?.message ?? "").slice(0, 200);
  // With no reason to give, say why: an operator reading a row that was retried
  // and then failed should know we never saw Meta's reason, not that we ignored it.
  const detail = reason
    ? `http ${httpStatus} ${reason}`
    : bodyTimedOut
      ? `http ${httpStatus} body timed out`
      : `http ${httpStatus}`;

  // The Graph code decides, whatever status carries it: Meta throttles with a 400.
  if (TRANSIENT_GRAPH_CODES.has(Number(body?.error?.code))) {
    return { status: "failed", retryable: true, detail };
  }

  // The rule all three senders share, written once in transientHttp.js.
  if (isTransientHttpStatus(httpStatus)) {
    return { status: "failed", retryable: true, detail };
  }

  // Meta puts its throttle codes in the body, so a non-2xx whose body timed out is
  // a throttle (retryable) or a bad parameter (permanent) and nothing tells which.
  // The costs are lopsided: retrying a real rejection wastes a few calls and fails
  // the same way, while not retrying a throttle silently drops a conversion. And
  // event_id means a retry cannot double-count.
  const isSuccess = httpStatus >= 200 && httpStatus < 300;
  if (bodyTimedOut && !isSuccess) {
    return { status: "failed", retryable: true, detail };
  }

  if (isSuccess) {
    // Meta's success body always carries the count. Without one, a proxy answered
    // instead of Meta: the outcome is unknown, and event_id makes a retry safe.
    // An explicit zero is Meta saying so, and a retry would hear the same thing.
    const received = Number(body?.events_received);
    if (received >= 1) {
      return { status: "sent", retryable: false, detail: `http ${httpStatus}` };
    }
    const noCount = body?.events_received == null || Number.isNaN(received);
    const reported = noCount ? "no events_received" : `events_received=${received}`;
    // No count at all is a proxy answering for Meta: an unknown outcome, so
    // retryable, and `failed` is the word planRetry writes once the budget is
    // spent anyway. An explicit zero is Meta itself refusing the event, which is
    // `rejected` -- the same word WhatsApp uses, so a destination card can tell
    // "the provider refused this" from "we gave up after three tries".
    return {
      status: noCount ? "failed" : "rejected",
      retryable: noCount,
      detail: `http ${httpStatus} ${reported}`,
    };
  }

  // A bad parameter, a dead token, a dataset that refuses the event: identical
  // on a retry, and Meta's refusal rather than our giving up.
  return { status: "rejected", retryable: false, detail };
}

/** Never throws, and never puts the access token in its result. */
export async function sendMetaEvent({
  fetchImpl = fetch,
  datasetId,
  apiVersion = "v26.0",
  accessToken,
  payload,
}) {
  const url = `${GRAPH_HOST}/${apiVersion}/${datasetId}/events?access_token=${encodeURIComponent(
    String(accessToken ?? "")
  )}`;

  // A fetch error may echo the request URL, which carries the token in raw and
  // encoded form. Neither may reach the detail, because the detail is logged.
  const token = String(accessToken ?? "");
  // Encoded before raw: a token containing % has a raw form that sits inside its
  // encoded form (%25 inside %2525), so the raw pass must never run first.
  const secrets = [encodeURIComponent(token), token].filter(Boolean);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Bounded: a stall aborts with a TimeoutError, which lands in the catch below.
      signal: sendTimeoutSignal(),
    });
  } catch (transportError) {
    let message = String(transportError?.message || transportError);
    // Structural first: whatever follows access_token= is the token, in whatever
    // form the URL class re-serialised it. The literals then catch a bare quoted value.
    message = message.replace(/access_token=[^&\s]*/gi, "access_token=[redacted]");
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    return classifyMetaOutcome({ transportError: { message } });
  }

  let body = null;
  let bodyTimedOut = false;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
    // The timeout signal covers reading the body as well as the headers.
    bodyTimedOut = error?.name === "TimeoutError";
  }

  return classifyMetaOutcome({ httpStatus: response?.status, body, bodyTimedOut });
}
