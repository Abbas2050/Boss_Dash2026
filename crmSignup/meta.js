import { createHash } from "crypto";
import { sendTimeoutSignal } from "./sendTimeout.js";
import { isTransientHttpStatus } from "./transientHttp.js";
// The one allowlist of currencies this service will report, imported rather
// than re-tested here: one authority used in two places, not a second opinion.
// It costs no dependency -- depositValue.js imports only the two leaf modules
// above, so nothing new reaches the send path (and nothing from the treasury
// side's googleapis or rate feed, which live in wallet/pspClients.js).
import { isoCurrency } from "./depositValue.js";

export const GRAPH_HOST = "https://graph.facebook.com";

/**
 * One Meta event per funnel stage. `registered` is mapped but not sent -- see
 * decideMetaSkip. The mapping stays complete so that lifting the gate is one
 * change rather than two.
 *
 * **`verified` and `live_account` are renamed here on 2026-10-19, superseding
 * the 13 October choice of `Client_Verified` and `TradingAccountOpened`.** Meta
 * answered `200` with `events_received: 1` for all seven events this service
 * has ever sent and then discarded every one of them. Read against the live
 * dataset over 16-19 October, which spans every send we have made: our side
 * records seven sent and seven 200s, and Meta's side for the same window holds
 * PageView, Initiate checkout and Complete registration -- standard names,
 * every one of them arriving -- and none of ours. No diagnostic was raised for
 * either name either, so Meta never said why.
 *
 * **The experiment that rename set up has now run, and settled it: only a
 * STANDARD Meta event name is ever visible (2026-10-20).** One client was sent
 * through all three stages within four minutes, same payload shape, same
 * integration, the only difference being the name. Meta's event list for that
 * day holds `Submit Application` and `Purchase`, both via Conversions API, and
 * does not hold `ApprovedApplication`. The custom one is not lost in transit:
 * `connect.facebook.net/signals/config/<dataset_id>` lists it under
 * `unverifiedEventNames`, beside `TradingAccountOpened` and `Client_Verified`.
 * Meta receives a custom name, files it as an unverified custom event, and an
 * unverified custom event never surfaces.
 *
 * So the rule is custom-vs-standard, and nothing else. It is NOT the financial
 * wording the event-blocking gate text describes -- `ApprovedApplication`
 * carries no financial term and was filed exactly like `TradingAccountOpened`.
 * It is not `custom_data`, not core setup discarding payloads, and not the
 * domain. Every one of those was a live theory and every one was wrong.
 *
 * `verified` therefore moves to `StartTrial` (2026-10-20, user's call) -- a
 * standard name, and the funnel position fits: the account exists and is
 * active, but nothing has been paid yet. Anything not on Meta's list of 17
 * standard events is invisible here, so a future stage must take a standard
 * name, never a descriptive one.
 *
 * `Purchase` was failing for its own named reason -- no value -- which is fixed,
 * and its arrival on 20 October is the proof: Meta's diagnostic said a Purchase
 * without value "can't be received", and this one was. The readable labels
 * operators want in Ads Manager come back as Custom Conversions built on these
 * standard names; see README, "What each stage sends".
 */
export const META_EVENT_NAMES = {
  lead: "Lead",
  registered: "CompleteRegistration",
  verified: "StartTrial",
  live_account: "SubmitApplication",
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
 * `fn` and `ln`, which share one rule: Meta documents last name as "the same
 * requirements as First Name", so this is one helper rather than two copies of
 * it that could drift apart.
 *
 * **Not email's lowercase-and-trim.** Meta's rule for a name is "Lowercase only
 * with no punctuation" (Customer information parameters), and the punctuation
 * half is the part a copied email helper would quietly miss: `o'brien` and
 * `obrien` are two unrelated digests, so every hyphenated or apostrophied name
 * would simply never match, with nothing to see on either side.
 *
 * **Accents are lowercased, never folded.** Meta's own worked example is
 * `Valéry` -> `valéry`, hashed with the accent. Stripping it to `valery` is the
 * same mismatch in the other direction, which is why this removes punctuation
 * and nothing else and leaves every letter, Roman or not, alone.
 *
 * Internal spaces survive, collapsed to one. A space is not punctuation and
 * Meta's rule does not mention it, so "Mary Ann" stays two words; collapsing a
 * run is worth doing only because FXBO's name fields are free text.
 *
 * Empty in, empty out, for the reason hashEmail gives -- and it bites harder
 * here. FXBO sends no last name for a fair number of leads, so `sha256("")`
 * would be sent as this client's surname, identically for every one of them:
 * one shared fake identity rather than a missing field.
 */
export function hashName(name) {
  const v = String(name ?? "")
    .toLowerCase()
    // "Lowercase only with no punctuation" -- the whole of the difference from
    // the email rule, and the reason this is not that function.
    .replace(/\p{P}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return v ? sha256(v) : "";
}

/**
 * `external_id`, which is an IDENTIFIER and must not be normalised like a name.
 *
 * Meta specifies no normalisation for it at all. The only rule it states is
 * consistency -- "if you send a browser Pixel event with external_id set to
 * 123, your Conversions API event for that same user should also have
 * external_id set to 123" -- because this value is matched against our own
 * other sends of the same id, not against anything in Meta's profile data.
 *
 * So it is hashed as the CRM holds it, trimmed and nothing more. Lowercasing it
 * or running it through hashName would be a silent corruption: an FXBO client
 * id is digits today, but one carrying a letter or a dash would be hashed into
 * a digest no other channel sending that same id could reproduce, and matching
 * would stop with no error anywhere -- the failure mode this whole file is
 * written around.
 */
export function hashExternalId(externalId) {
  const v = String(externalId ?? "").trim();
  return v ? sha256(v) : "";
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
 * **The currency is checked against the allowlist, not against a three-letter
 * shape.** `/^[A-Z]{3}$/` is the gate that already let `BTC` through once on
 * this branch: every major crypto ticker is exactly three letters, `BRL` sits
 * beside `BTC` and `ETB` beside `ETH`, and Meta then silently ignores a
 * currency it cannot read -- the same discard this whole change exists to
 * remove. Nothing but a settled code should reach here today, but that is a
 * property of today's wiring rather than of this function, and the shape test
 * sat one call site away from making the same mistake again.
 *
 * **`isoCurrency`, never `settlementCurrency`.** This refuses an unsettled code
 * rather than settling one: by the time a value arrives here its amount has
 * already been scaled to some currency's minor unit, so mapping `USDT` to `USD`
 * at this point would relabel a number without rescaling it. Settlement happens
 * once, at the one door in `depositValue.js`.
 */
export function metaValueFields(depositValue) {
  const currency = isoCurrency(depositValue?.currency);
  const value = Number(depositValue?.valueDecimal);
  if (!currency) return {};
  if (!Number.isFinite(value) || !(value > 0)) return {};
  return { value, currency };
}

export function buildMetaPayload({
  stage,
  email,
  phone,
  firstName,
  lastName,
  crmClientId,
  fbc,
  eventTimeSeconds,
  eventId,
  testEventCode,
  depositValue,
}) {
  const user_data = {};

  const em = hashEmail(email);
  if (em) user_data.em = [em];

  const ph = hashPhone(phone);
  if (ph) user_data.ph = [ph];

  // The three parameters Meta's Event Match Quality panel names as the gains
  // available on this dataset (2026-10-20): external_id at a claimed ~28%
  // uplift, first and last name at ~15% each. They are the only recommended
  // ones we can supply truthfully -- see the note below the block for the four
  // the panel also recommends and we deliberately do not send.
  //
  // Single-element arrays because Meta's type for all three is `string or
  // list<string>`, so the array is correct and the choice is that user_data
  // then reads one way throughout. `fbc` below is the exception for a reason
  // rather than by habit: its type is `string`, and only that.
  const externalId = hashExternalId(crmClientId);
  if (externalId) user_data.external_id = [externalId];

  const fn = hashName(firstName);
  if (fn) user_data.fn = [fn];

  const ln = hashName(lastName);
  if (ln) user_data.ln = [ln];

  // **No `client_ip_address`, no `user_agent`, no `referrer_url`, no
  // `event_source_url` -- however plainly Meta's panel recommends the first
  // two, and whoever reads that prompt next.**
  //
  // Meta's own server-side parameter-builder library fills them by
  // reconstructing them from the incoming HTTP request, and that is precisely
  // why they cannot be filled here: our incoming request is FXBO's webhook from
  // an Azure server, not the client's browser. We would be sending FXBO's
  // server IP and FXBO's user agent as the customer's own, identically for
  // every client and every event -- one uniform fake identity, which degrades
  // matching while the panel's coverage figure reports an improvement. Every
  // stage this service sends (`verified`, `live_account`, `first_deposit`) is a
  // back-office state change with no browser involved at all, so there is no
  // real value to reach for.
  //
  // `fbp` is out for a different reason: it is a browser cookie our server
  // never sees, so it would have to be invented, and sending it needs a website
  // change first. Date of birth, city, region, postcode and country are out
  // because FXBO does not send them and we do not store them.

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
