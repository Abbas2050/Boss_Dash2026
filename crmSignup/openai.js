import { createHash } from "crypto";
import { sendTimeoutSignal } from "./sendTimeout.js";
import { isTransientHttpStatus } from "./transientHttp.js";

/** The pixel id goes on the query string as `pid`; the key goes in a header. */
export const OPENAI_EVENTS_URL = "https://bzr.openai.com/v1/events";

/**
 * The thirteen names OpenAI's taxonomy allows, and the one data family each
 * requires.
 *
 * This table is the whole of why it exists: `data.type` is the data FAMILY, not
 * the event name, and a mismatched pair is rejected -- so the family is never
 * written beside an event name anywhere, it is looked up from this one table
 * (openaiDataType). A stage map that carried its own `type` column would be a
 * second opinion, and the two could disagree without anything noticing until
 * OpenAI refused the event.
 *
 * All thirteen are listed although we use three, so that adding a stage is a
 * lookup rather than a reading of the documentation again.
 */
export const OPENAI_EVENT_FAMILIES = {
  app_installed: "customer_action",
  app_opened: "customer_action",
  appointment_scheduled: "customer_action",
  lead_created: "customer_action",
  registration_completed: "customer_action",
  checkout_started: "contents",
  contents_viewed: "contents",
  items_added: "contents",
  order_created: "contents",
  page_viewed: "contents",
  subscription_created: "plan_enrollment",
  trial_started: "plan_enrollment",
  custom: "custom",
};

/**
 * One OpenAI event per funnel stage. `registered` is mapped but not sent -- see
 * decideOpenaiSkip. The mapping stays complete so that lifting the gate is one
 * change rather than two, exactly as META_EVENT_NAMES does it.
 *
 * `verified` and `live_account` have no event in the taxonomy at all: there is
 * no verification event and no account-opened event, and the only route for
 * either is `custom` carrying a `custom_event_name`. They are not approximated
 * by a built-in name that means something else.
 *
 * `appointment_scheduled` exists in the taxonomy and is deliberately absent
 * here: there is no such CRM stage and no FXBO rule for one, so it would be a
 * conversion nothing could ever fire.
 */
export const OPENAI_EVENTS = {
  // Blocked upstream rather than here: no FXBO trigger for a lead exists yet.
  // Nothing in this module needs changing when one appears.
  lead: { name: "lead_created" },
  registered: { name: "registration_completed" },
  verified: { name: "custom", customEventName: "client_verified" },
  live_account: { name: "custom", customEventName: "live_account_opened" },
  // Carries the deposit's amount and currency since 2026-10-19, in the
  // `contents` family's own fields -- see openaiAmountFields. Both are optional
  // here, unlike Meta, where their absence makes the event disappear; they are
  // sent anyway so the two platforms report the same deposit as the same money.
  first_deposit: { name: "order_created" },
};

const text = (v) => String(v ?? "").trim();

/**
 * The stage's event, or null.
 *
 * `Object.hasOwn` rather than a plain index, because a stage of `__proto__`
 * indexes to Object.prototype -- a truthy object that would be read as a
 * mapping and sent as `event_name: undefined` with no family at all.
 */
export function openaiEventFor(stage) {
  const key = String(stage ?? "");
  return Object.hasOwn(OPENAI_EVENTS, key) ? OPENAI_EVENTS[key] : null;
}

/** The one place an event name becomes a `data.type`. Empty for a name that is
 *  not in the taxonomy, which buildOpenaiPayload refuses to build rather than
 *  sending a family OpenAI would reject. */
export function openaiDataType(eventName) {
  const key = String(eventName ?? "");
  return Object.hasOwn(OPENAI_EVENT_FAMILIES, key) ? OPENAI_EVENT_FAMILIES[key] : "";
}

/**
 * The stage whose conversion belongs to the website pixel, not to us.
 *
 * 2026-10-14, user's call, and the same decision taken the same day for Meta's
 * CompleteRegistration, for the same reason. OpenAI merges a browser event and
 * a server event into one conversion only when the pixel id, the event name AND
 * the id all match -- the pixel's `event_id` must equal our `id`. The pixel's id
 * exists only in the page; ours comes from FXBO, which has no field that could
 * carry the browser's value across. Sending both with different ids double
 * counts, so one owner per stage, and for the registration stage the owner is
 * the browser.
 *
 * The cost, stated rather than hidden: that conversion is only ever as complete
 * as a browser pixel, so registrations from ad-blocked or tracking-restricted
 * browsers are unattributed for that step. Every other stage is server-side,
 * which is why they stay here.
 *
 * Its own constant rather than an import from meta.js: the two destinations
 * reached the same conclusion independently, and lifting one gate must not
 * silently lift the other.
 */
export const PIXEL_OWNED_STAGE = "registered";

/**
 * `received_at` as an integer Unix timestamp in MILLISECONDS, or null when the
 * value is not a time at all.
 *
 * **This is deliberately not worker.js's `eventTimeSeconds`, and the two must
 * never become one helper.** Meta's `event_time` is in seconds and that helper
 * divides by 1000; OpenAI's `timestamp_ms` is in milliseconds and divides by
 * nothing. The two fields are built from the same column on the same row, a
 * factor of 1000 puts the event in 1970, and the symptom would not be an error
 * -- it would be OpenAI refusing every event for falling outside the window
 * below. So there is no division in this function at all, which is the one form
 * of the rule a reader can check at a glance.
 *
 * One parse, read by the two callers that must not disagree: the window test in
 * decideOpenaiSkip and the `timestamp_ms` buildOpenaiPayload emits. A row judged
 * inside the window and then stamped from a second, differently written reading
 * of the same column would be two opinions about one instant.
 */
export function openaiTimestampMs(receivedAt) {
  if (receivedAt === null || receivedAt === undefined || receivedAt === "") return null;
  const ms =
    receivedAt instanceof Date
      ? receivedAt.getTime()
      : typeof receivedAt === "number"
        ? receivedAt
        : Date.parse(String(receivedAt));
  // NaN is what an invalid Date and an unparseable string both produce, and NaN
  // in `timestamp_ms` serialises to null: a required field present and empty,
  // which is the one shape worse than a missing one.
  if (!Number.isFinite(ms)) return null;
  // An integer because the field is documented as one. Truncated rather than
  // rounded, so a fractional millisecond can never move the instant forward past
  // the future bound below.
  return Math.trunc(ms);
}

/**
 * OpenAI's own bound, verbatim: "The timestamp must be within the last 7 days
 * and no more than 10 minutes in the future."
 *
 * This is a hard constraint on an architecture that retries from database
 * columns. `POST /api/crm-events/requeue` exists to retry old failures, so a row
 * resent after a week would otherwise produce a request certain to be rejected,
 * and the only alternative -- re-stamping the event with the current time -- is
 * not available: it would claim the conversion happened today, and the row's
 * whole purpose is to say when it actually happened (spec section 7a).
 */
export const OPENAI_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The other half of the same sentence. `received_at` is written by us on
 *  arrival, so this trips only on a badly skewed server clock -- which is
 *  exactly the case where sending anyway buys a rejection and a spent retry
 *  budget in place of a reason an operator can read. */
export const OPENAI_MAX_EVENT_SKEW_MS = 10 * 60 * 1000;

/**
 * Whether this event is ours to send, and if not, why not.
 *
 * The two configuration reasons come first on purpose, and in that order. With
 * no key, every reason below is also true for `registered`, and "openai not
 * configured" is the one an operator can act on; reading a missing key as a
 * design choice is how a dead integration looks deliberate in the settings tab.
 * This is the ordering decideBrevoSkip, decideMetaSkip and decideWhatsappSkip
 * all use.
 *
 * The pixel id is a skip rather than a failure (spec section 9): without it
 * there is no URL to post to, so nothing was attempted and nothing refused. It
 * is named separately from the key because the two live on different lines of
 * .env and "not configured" alone would not say which to look at.
 *
 * The taxonomy reason is a guard, not a decision: a stage with no mapping would
 * build an event with no name and no family, and a family mismatch is the one
 * failure OpenAI rejects outright. Recording it as a skip keeps the reason in
 * the row instead of in OpenAI's rejection text.
 *
 * **The three time reasons come last, after every reason that is a permanent
 * fact about the stage.** `registered` is never ours at any age, and a stage
 * outside the taxonomy is unsendable however fresh it is, so neither should be
 * reported as a row that merely arrived too long ago -- the age is the one
 * reason here that would read differently tomorrow. This is also the only reason
 * the resend action can produce on a row that was otherwise perfectly sendable,
 * so it has to name the window rather than say "not applicable" (spec 7a).
 *
 * `now` is the caller's clock, as planRetry already takes it, so a test and the
 * worker's injected clock are the same thing; absent or unusable, it is the real
 * one, because a skewed-clock guard that silently stopped guarding would be
 * worse than none.
 */
export function decideOpenaiSkip({ stage, apiKey, pixelId, receivedAt, now } = {}) {
  if (!text(apiKey)) return { reason: "openai not configured" };
  if (!text(pixelId)) return { reason: "openai pixel id not configured" };
  if (stage === PIXEL_OWNED_STAGE) return { reason: `${PIXEL_OWNED_STAGE} is owned by the website pixel` };
  if (!openaiEventFor(stage)) return { reason: "stage not in the OpenAI taxonomy" };

  const eventMs = openaiTimestampMs(receivedAt);
  // `timestamp_ms` is required, so a row with no readable time has no sendable
  // event at all. Named separately from the window: "outside the last 7 days"
  // would send an operator looking at a date that does not exist.
  if (eventMs === null) return { reason: "received_at is not a usable timestamp" };

  const nowMs = openaiTimestampMs(now) ?? Date.now();
  if (nowMs - eventMs > OPENAI_MAX_EVENT_AGE_MS) {
    return { reason: "received_at is outside OpenAI's window: older than 7 days" };
  }
  if (eventMs - nowMs > OPENAI_MAX_EVENT_SKEW_MS) {
    return { reason: "received_at is outside OpenAI's window: more than 10 minutes in the future" };
  }

  return null;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Trim, lowercase, hash.
 *
 * **Identical to Meta's `hashEmail` today, and deliberately a second copy.**
 * The rule genuinely is the same rule (spec section 2), so sharing Meta's
 * helper would work -- and that is the hazard: a change to Meta's
 * normalisation would travel here silently and break matching with no error
 * anywhere. The duplication is the alarm. openai.test.js asserts the two
 * produce the same digest, so a divergence on either side fails a test and a
 * person decides which rule changed, rather than one inheriting the other.
 *
 * Empty in, empty out: sha256("") is a perfectly valid digest that would be
 * sent as though it were an address, and would only lower match quality.
 */
export function hashEmail(email) {
  const v = String(email ?? "").trim().toLowerCase();
  return v ? sha256(v) : "";
}

// Exactly the characters OpenAI documents removing -- whitespace, parentheses,
// periods and hyphens -- and NOT "every non-digit". A value with anything else
// in it (an extension, a letter) is not a number OpenAI would have hashed on its
// side either, so it falls out at the range test below instead of being quietly
// turned into digits that match nothing.
const PHONE_PUNCTUATION_RE = /[\s().-]/g;

/** OpenAI's own range, and the same 8-15 digits PHONE_RE already enforces. */
const OPENAI_PHONE_RE = /^\d{8,15}$/;

/**
 * **OpenAI's phone rule, which is not Meta's, and the difference is invisible
 * today.**
 *
 * OpenAI keeps the country code, removes the punctuation above, and removes a
 * leading `+` AND leading zeroes. Meta's `hashPhone` strips every non-digit and
 * KEEPS leading zeroes.
 *
 * For every phone this service can currently send, the two produce an identical
 * hash. `PHONE_RE` is /^\+[1-9]\d{7,14}$/, so a stored phone always begins with
 * a plus followed by a non-zero digit: there are never leading zeroes to strip,
 * and the regex already enforces 8-15 digits. So calling Meta's function here
 * would pass every realistic test, work against live data, and silently break
 * matching the day `PHONE_RE` is loosened -- a `0097150...` would be hashed
 * with its zeroes and never match again, with no error anywhere.
 *
 * Hence this is OpenAI's rule written on its own terms rather than an import,
 * and openai.test.js pins it with a phone that HAS leading zeroes, so the
 * difference is actually exercised rather than assumed.
 */
export function hashPhone(phone) {
  const cleaned = String(phone ?? "").replace(PHONE_PUNCTUATION_RE, "");
  // The plus goes before the zeroes: "+0044..." has both, and stripping the
  // zeroes first would leave the plus sitting in front of them.
  const unplussed = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
  const national = unplussed.replace(/^0+/, "");
  // Outside 8-15 digits there is nothing OpenAI could have hashed to meet us, so
  // the digest would be noise in a match field. Empty in, empty out.
  return OPENAI_PHONE_RE.test(national) ? sha256(national) : "";
}

/**
 * `<crm_client_id>:<stage>` -- the CRM record, so every retry of one funnel
 * event carries the same id and OpenAI counts one conversion rather than two.
 * The same scheme as Meta's `event_id`, and for the stages we own there is no
 * browser event to coordinate it with (see PIXEL_OWNED_STAGE).
 *
 * With no client id there is no identity, and an id of ":verified" would not
 * merely lose the deduplication -- it would be the SAME id for every such
 * client, merging different people's conversions into one. Omitting the id costs
 * only the deduplication of a retry, which is the smaller harm by far, so it is
 * omitted rather than shared.
 */
export function openaiEventId({ crmClientId, stage } = {}) {
  const client = text(crmClientId);
  const s = text(stage);
  if (!client || !s) return "";
  return `${client}:${s}`;
}

/**
 * **`offline`, not `web` (2026-10-14, user's call).**
 *
 * The brief said `web` with `source_url` set to the register page, but that
 * described the registration event -- which the website pixel owns and we do not
 * send (see PIXEL_OWNED_STAGE). The stages we do send happen inside the CRM:
 * no browser, no page, nobody on a URL. `offline` is what they are, and it is
 * the counterpart of the `system_generated` meta.js already sends for these very
 * same events.
 *
 * **This is also why no `source_url` appears anywhere in this module.** The
 * reference requires one only for web events, i.e. when `action_source` is
 * `web`, so there is nothing to invent -- and a plausible register-page URL on
 * an event no browser produced would be a fact we made up and then reported.
 *
 * One value for every stage, so a constant rather than a column on the mapping.
 * The one caveat, recorded for whoever adds a stage: `app_installed` and
 * `app_opened` MUST be `mobile_app`, and no CRM stage maps to either today.
 */
const ACTION_SOURCE = "offline";

/** The one data family whose events describe money. `amount` and `currency`
 *  belong to it and to no other: `data.type` chooses the family, and the family
 *  decides which fields the event may carry. Taken from the one table that
 *  already owns that mapping rather than from a stage list beside it. */
const MONEY_FAMILY = "contents";

/**
 * OpenAI's `amount` and `currency`, or NEITHER of them.
 *
 * **`amountMinor`, not `valueDecimal`, and that is the whole reason this is a
 * function and not two lines at the call site.** OpenAI's `amount` is an
 * INTEGER IN THE CURRENCY'S MINOR UNIT -- $129.99 is `12999` -- while Meta's
 * `value` is the decimal `129.99` for the same deposit. The two differ by a
 * factor of a hundred for most currencies and by one or a thousand for the
 * rest, and **both platforms would accept either number without a word**: the
 * only symptom of a swap is a deposit reported as a hundred times, or a
 * hundredth of, what it was, in somebody else's dashboard.
 *
 * So the unit is carried by the field name, `Number.isInteger` refuses a
 * decimal that reached here by mistake, and `openai.test.js` pins the pair with
 * a value where the two forms genuinely differ. A test using a round number
 * would pass with the units crossed.
 *
 * `currency` is required whenever `amount` is present, so the pair is attached
 * together or not at all -- the same rule Meta states outright, honoured here
 * before OpenAI has to.
 *
 * As in `metaValueFields`, the three-letter test here is the last-ditch half of
 * that rule and **not the authority on which currencies exist**: that is
 * `settlementCurrency` in `depositValue.js`, which holds an allowlist because a
 * shape test cannot tell `BRL` from `BTC`.
 */
export function openaiAmountFields(depositValue) {
  const currency = String(depositValue?.currency ?? "").trim().toUpperCase();
  const amount = Number(depositValue?.amountMinor);
  if (!/^[A-Z]{3}$/.test(currency)) return {};
  if (!Number.isInteger(amount) || !(amount > 0)) return {};
  return { amount, currency };
}

/**
 * One event, shaped as the batch of one that it is.
 *
 * **`{ events: [ ... ] }` with exactly one element, deliberately.** Up to 1,000
 * are allowed, but "if one event in the batch fails, the full batch fails" and
 * there is no per-event error reporting, so batching would let one malformed row
 * destroy a whole sweep's worth of conversions without telling us which one.
 *
 * `validate_only` is a REQUEST field and sits beside `events`, not inside the
 * event. It is omitted rather than sent as false, and a validated request does
 * not appear in event monitoring -- so a clean validation is not evidence that
 * anything landed (spec section 2).
 *
 * **Returns null rather than a payload that is invalid by construction**, which
 * is every case where a REQUIRED field has no value to carry: a stage with no
 * mapping or no family, a client with no id, a row with no readable time. The
 * gate above already refuses the first of those, and this is the second half of
 * that one test rather than a separate opinion -- "no payload" is a louder way
 * to get it wrong than a malformed one. What it does NOT judge is whether a
 * readable time is one OpenAI will accept: the window is a decision about a row,
 * and decideOpenaiSkip makes it, with a reason that lands in the row.
 */
export function buildOpenaiPayload({
  stage,
  crmClientId,
  email,
  phone,
  oppref,
  receivedAt,
  validateOnly,
  depositValue,
} = {}) {
  const mapped = openaiEventFor(stage);
  if (!mapped) return null;

  const type = openaiDataType(mapped.name);
  if (!type) return null;

  // Required, and refused here rather than attached behind an `if`. openaiEventId
  // is empty for a client with no id ON PURPOSE: ":verified" would be the same id
  // for every such client and would merge different people's conversions into
  // one. A required field behind a condition means a payload can be built that
  // OpenAI must reject, so the invalid one is made unconstructable instead.
  const id = openaiEventId({ crmClientId, stage });
  if (!id) return null;

  // Required, and in MILLISECONDS -- openaiTimestampMs says why that sentence is
  // written there and not reused from the Meta step. Without it every event is
  // rejected, so a row whose received_at is not a time has no event, rather than
  // one carrying a null in a required field.
  const timestampMs = openaiTimestampMs(receivedAt);
  if (timestampMs === null) return null;

  // Hashed identifiers only: no names and no external ids (2026-10-14, user's
  // call). This matches what Meta already receives, and it is what lets OpenAI
  // attribute a conversion whose `oppref` is missing.
  const user = {};

  const em = hashEmail(email);
  if (em) user.emails_sha256 = [em];

  const ph = hashPhone(phone);
  if (ph) user.phone_numbers_sha256 = [ph];

  // The event object's own fields, in the reference's order. **The event name
  // goes in `type`: there is no `event_name` field on an OpenAI event at all,
  // and the documentation uses that phrase only when describing the dedupe key.
  // `data.type` is the data FAMILY and is a different field that happens to
  // share a name** -- which is precisely why the family is looked up from one
  // table rather than written beside the name.
  // `amount` and `currency` sit INSIDE `data`, beside the family that admits
  // them. The reference's event-level field list is quoted in full in the
  // ChatGPT Ads design (section 2) and neither field appears in it, so `data`
  // is where the family's own payload goes -- inferred from that table rather
  // than read from a line of documentation that says so. Recorded as an
  // inference in the spec, because it is the one thing here nobody verified.
  const data = { type };
  if (type === MONEY_FAMILY) Object.assign(data, openaiAmountFields(depositValue));

  const event = {
    id,
    type: mapped.name,
    timestamp_ms: timestampMs,
    data,
    action_source: ACTION_SOURCE,
    user,
  };

  // Required for a custom event and meaningless on a built-in one, so it is
  // carried by the mapping rather than by the caller: 1-64 characters of
  // lowercase letters, numbers, underscores or dashes, not reusing a built-in
  // name. A custom event without one is rejected.
  if (mapped.customEventName) event.custom_event_name = mapped.customEventName;

  // Passed through verbatim: OpenAI's click identifier, frozen in its own column
  // at this client's first event because `full_link` is scrubbed a minute later
  // and the first deposit arrives weeks afterwards on a row whose own
  // `full_link` is empty. Unlike `fbc` it is sent raw -- no wrapper, no
  // timestamp -- so there is nothing to recompute and nothing to get wrong here
  // except dropping it. Absent is normal: the event is still sent, simply
  // unattributed (spec section 5).
  const click = text(oppref);
  if (click) event.oppref = click;

  const payload = { events: [event] };
  if (validateOnly) payload.validate_only = true;

  return payload;
}

/**
 * What OpenAI's body says went wrong, or null.
 *
 * **The response shape is not documented anywhere** (spec section 2), so this
 * asks "is there an error key at all" rather than matching a shape we were
 * never told. A body we only half understand has to fail toward refusing the
 * event, because a 2xx is not proof and because one bad event fails the whole
 * request -- so an error reported in the body of a 200 is OpenAI refusing this
 * event, with nothing in the status to say so.
 *
 * An explicit null, false or empty error is not an error: a body that carries
 * `"error": null` is saying there was none.
 */
export function readOpenaiError(body) {
  if (!body || typeof body !== "object") return null;

  const candidates = [body.error, ...(Array.isArray(body.errors) ? body.errors : [])];
  const first = candidates.find((c) => c !== null && c !== undefined && c !== false && c !== "");
  if (first === undefined) return null;

  const message =
    typeof first === "string"
      ? first
      : first && typeof first === "object"
        ? [first.code, first.message || first.detail || first.type || first.reason].filter(Boolean).join(": ")
        : String(first);

  return { message: String(message ?? "").slice(0, 200) };
}

export function classifyOpenaiOutcome({
  transportError,
  httpStatus: rawStatus,
  body,
  bodyTimedOut,
  bodyUnreadable,
} = {}) {
  if (transportError) {
    return {
      status: "failed",
      retryable: true,
      detail: `transport: ${String(transportError?.message || transportError).slice(0, 200)}`,
    };
  }

  const httpStatus = Number(rawStatus) || 0;
  const error = readOpenaiError(body);
  // An error with no message still has to say something, or a row reads as
  // though we never looked.
  const reported = error ? error.message || "error reported with no message" : "";
  // bodyTimedOut before bodyUnreadable: a timeout IS an unreadable body, and
  // "the body never arrived" is the more useful of the two things to be told.
  const unread = bodyTimedOut ? "body timed out" : bodyUnreadable ? "unreadable body" : "";
  const withDetail = (suffix) => (suffix ? `http ${httpStatus} ${suffix}` : `http ${httpStatus}`);

  // The rule all four senders share, written once in transientHttp.js. Unlike
  // Meta there is no body code to consult: OpenAI documents no error codes and
  // no rate limit, so the status is the whole of what decides (spec section 8).
  if (isTransientHttpStatus(httpStatus)) {
    return { status: "failed", retryable: true, detail: withDetail(reported || unread) };
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    if (error) {
      // OpenAI refusing the event while answering 200. `rejected`, not
      // `failed`: see the comment on the permanent branch below.
      return { status: "rejected", retryable: false, detail: withDetail(reported) };
    }

    // **A 2xx whose body we could not read is a send.** This is NOT how Meta
    // treats one, and the difference is the point: Meta's success body always
    // carries `events_received`, so its absence means a proxy answered instead
    // of Meta and the outcome is genuinely unknown. OpenAI's response shape is
    // not documented at all, so an empty, non-JSON or 204 body is the API
    // behaving as documented -- which is to say, as nothing. Calling that
    // unknown would make every event of a perfectly healthy integration spend
    // its whole retry budget and settle `failed`.
    //
    // So the HTTP exchange is taken at its word and the detail records that we
    // never read a body, because a 200 is not proof either way and the real
    // confirmation is the ChatGPT Ads event stream (spec section 11).
    return { status: "sent", retryable: false, detail: withDetail(unread) };
  }

  // Everything else is permanent: a mismatched `data.type`, a
  // `custom_event_name` reusing a built-in name, a key that does not belong to
  // the pixel's ad account, a dead key. All identical on a retry.
  //
  // `rejected`, not `failed`: planRetry writes `failed` the moment a retryable
  // outcome runs out of attempts, so with one word for both, a key paired with
  // the wrong ad account would read on the destination card exactly like a
  // transport outage. This is the vocabulary the other three senders settled on.
  //
  // A non-2xx whose body never arrived is permanent here too, which is where
  // this parts company with Meta again: Meta carries its throttle codes in the
  // body, so an unreadable 400 might be a throttle and is retried. OpenAI puts
  // nothing in the body that could change the verdict, so there is nothing an
  // unreadable one might have said.
  return { status: "rejected", retryable: false, detail: withDetail(reported || unread) };
}

/** Never throws, and never puts the API key in its result. */
export async function sendOpenaiEvent({
  fetchImpl = fetch,
  eventsUrl = OPENAI_EVENTS_URL,
  pixelId,
  apiKey,
  payload,
}) {
  // The pixel id is not a secret -- it is in the conversion setup screen and in
  // the website's own pixel -- so it is the only thing on the query string.
  const url = `${eventsUrl}?pid=${encodeURIComponent(String(pixelId ?? ""))}`;

  // The structural half of keeping the key out of the log is that it travels in
  // a header and never in the URL, so no part of a request line can carry it
  // anywhere. What remains is an error message that quoted the header back at
  // us, and the detail is both logged and stored.
  const key = String(apiKey ?? "");
  // Encoded before raw: a key containing % has a raw form that sits inside its
  // encoded form (%25 inside %2525), so the raw pass must never run first.
  const secrets = [encodeURIComponent(key), key].filter(Boolean);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      // Bounded: a stall aborts with a TimeoutError, which lands in the catch below.
      signal: sendTimeoutSignal(),
    });
  } catch (transportError) {
    // A thrown falsy value is still a transport failure, not something that
    // falls through, and not the string "undefined" either.
    let message = String(transportError?.message || transportError || "unknown");
    // Structural first: whatever follows "Bearer " is the key, in whatever form
    // the thrower wrote it. The literals then catch a bare quoted value.
    message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    return classifyOpenaiOutcome({ transportError: { message } });
  }

  let body = null;
  let bodyTimedOut = false;
  let bodyUnreadable = false;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
    bodyUnreadable = true;
    // The timeout signal covers reading the body as well as the headers.
    bodyTimedOut = error?.name === "TimeoutError";
  }

  return classifyOpenaiOutcome({ httpStatus: response?.status, body, bodyTimedOut, bodyUnreadable });
}
