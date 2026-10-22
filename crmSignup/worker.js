import { randomUUID } from "crypto";
import { maskEmail, maskPhone } from "./normalise.js";
import { buildMetaPayload, sendMetaEvent, decideMetaSkip } from "./meta.js";
import {
  decideWhatsappSkip,
  buildWhatsappPayload,
  sendWhatsappTemplate,
  parseSkipSources,
} from "./whatsapp.js";
import {
  decideBrevoSkip,
  decideBrevoListIdFailure,
  buildBrevoContact,
  upsertBrevoContact,
} from "./brevo.js";
import {
  decideOpenaiSkip,
  buildOpenaiPayload,
  sendOpenaiEvent,
  OPENAI_EVENTS_URL,
} from "./openai.js";
import {
  decideGoogleSkip,
  decideGoogleValueFailure,
  buildGoogleIngest,
  resolveGoogleConversionAction,
  ingestGoogleConversion,
  retrieveGoogleRequestStatus,
  resolveTimezoneOffset,
  googleConfirmDelayMinutes,
  GOOGLE_CONFIRM_MAX_ATTEMPTS,
  GOOGLE_CONFIRM_WINDOW_MINUTES,
  GOOGLE_ADS_API_HOST,
  GOOGLE_ADS_API_VERSION,
  GOOGLE_OAUTH_TOKEN_URL,
  DATA_MANAGER_API_HOST,
} from "./googleAds.js";
// The one inbound lookup in this module. Everything else here talks to a
// destination; this asks FXBO what the deposit was worth, because Meta discards
// a Purchase that does not say.
import { DEPOSIT_VALUE_STAGE, fetchFirstDepositValue } from "./depositValue.js";
// Two sets, two questions, and reading one for the other is silent in opposite
// directions (settled.js spells both out). SETTLED is "do not attempt this
// action again"; SCRUBBABLE is "this row is safe to forget".
import { SETTLED, SCRUBBABLE } from "./settled.js";
import {
  claimDueEvents,
  updateMetaStatus,
  updateWhatsappStatus,
  updateBrevoStatus,
  updateOpenaiStatus,
  updateGoogleStatus,
  scrubSignupEvent,
  deleteInvalidSignupEvents,
  scrubStaleSignupEvents,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// How long an all-`invalid` row is kept before the whole row goes. These never
// sent anything and never will -- an unparseable payload or an FXBO "Test
// webhook" press -- and they are the rows CUTOVER step 5 reads, so they keep
// everything, raw_payload included, for exactly this long. Seven days is the
// user's number; it is not configurable, because a window nobody chose is a
// window nobody can be held to.
const INVALID_RETENTION_DAYS = 7;

// How long a row that never settles may keep its client data. The settle path
// scrubs about a minute after signup; this catches what it never reaches -- a
// worker left off by CRM_EVENTS_WORKER_ENABLED, or a row whose five claims
// split between two overlapped workers so neither saw all five settle. Thirty
// days is the user's number, and for the same reason not an env var.
const UNSCRUBBED_BACKSTOP_DAYS = 30;

// Retention is hourly work and the sweep runs every 60 seconds, so the sweep
// remembers when it last ran one. Deliberately a remembered instant rather than
// a second timer: a timer dies with the IIS worker, and a retention pass that
// silently stopped running is the failure the backstop above exists to catch, so
// it must not depend on the same thing. Starting at 0 means the first sweep after
// a recycle runs one, which is the right direction to fail in.
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let lastRetentionAt = 0;

// Each action's attempt budget. WhatsApp's and OpenAI's are configurable
// (WA_MAX_ATTEMPTS, OPENAI_MAX_ATTEMPTS) and therefore travel in config, beside
// every other value an operator sets; a constant here would be a second opinion
// the environment could not overrule. Each is read in two places -- before the
// request and after it -- so Meta's and Brevo's live here rather than as a
// literal in both.
const META_MAX_ATTEMPTS = 3;
const BREVO_MAX_ATTEMPTS = 3;

/**
 * Google's INGEST budget, fixed at three like Meta's and Brevo's rather than
 * configurable. Nothing about this phase argues for an operator's number: unlike
 * OpenAI there is no 7-day window for a budget to race, and unlike WhatsApp
 * there is no message a retry could duplicate -- the `transactionId` is what
 * makes a repeated ingest the same conversion.
 *
 * **It is NOT the budget the confirmation phase gets, and the difference is
 * roughly eightfold.** See googleMaxAttemptsFor.
 */
const GOOGLE_INGEST_MAX_ATTEMPTS = 3;

/**
 * Which of Google's two budgets this row is spending, read off the one thing
 * that says which phase it is in.
 *
 * **The two phases count separately, and one shared number could not serve
 * both.** An ingest is a single HTTP request to a live endpoint: three attempts
 * five minutes apart is the right shape, and a failure after that is a failure.
 * A confirmation is a wait for Google's own asynchronous processing, which
 * Google says "may take up to 24 hours" -- so it needs 25 polls on Google's own
 * backoff (GOOGLE_CONFIRM_MAX_ATTEMPTS, computed from their published
 * schedule). Give the ingest 26 and a broken endpoint is hammered for a day;
 * give the confirmation 3 and every conversion is abandoned after two hours,
 * unconfirmed, while Google was still working on it.
 *
 * So `google_attempts` means "attempts at the phase this row is in", and the
 * ingest's own outcome resets it to 0 as it writes the request id (see
 * runGoogleStep). The detail is what carries the phase to a reader.
 *
 * Read in two places that must agree: here, for the pre-request claim written by
 * `begin`, and inside the step for the outcome. One function rather than the
 * same ternary twice.
 */
function googleMaxAttemptsFor(row) {
  return str(row?.google_request_id) ? GOOGLE_CONFIRM_MAX_ATTEMPTS : GOOGLE_INGEST_MAX_ATTEMPTS;
}

/**
 * What the row says when the request was a validation rather than a send.
 *
 * `validate_only: true` returns a 2xx and records NOTHING on OpenAI's side --
 * the documentation is explicit that such a request does not appear in event
 * monitoring. So the outcome is a genuine `sent` (the exchange did succeed) for
 * a conversion that provably does not exist, and without this the destination
 * card and the overview would report it as real.
 *
 * It goes in the DETAIL and not in the status, deliberately. The status is the
 * one word five destinations share: SETTLED, SCRUBBABLE and REQUEUEABLE are all
 * built from that vocabulary, settled.js refuses a list that drifts, and the
 * claim, the scrub precondition, the backstop and the resend each name those
 * words in SQL. A fifth word for one destination would have to be added to every
 * one of them, and a status missing from SETTLED is re-sent for ever while one
 * missing from SCRUBBABLE never scrubs. The detail is already the column the tab
 * prints under the status, and already carries exactly this kind of distinction
 * -- the backstop's "not attempted" tells a scrub apart from a refusal the same
 * way.
 *
 * It is written at the step because that is where the flag is known: the sender
 * is handed a payload that already carries `validate_only`, and the classifier
 * sees only an HTTP exchange.
 */
export const OPENAI_VALIDATE_ONLY_DETAIL = "validate_only: nothing was recorded by OpenAI";

/**
 * The same note for Google, and the same hazard.
 *
 * `validateOnly: true` returns a 200 with no `results` at all and records
 * nothing in the account, so the row settles exactly as a real upload does --
 * which means a genuine conversion passing through while the flag is on is
 * recorded `sent` and can never be resent: the resend only reaches `failed` and
 * `rejected`. Hence the detail, on every outcome, so the row says what actually
 * happened rather than leaving it to whoever remembers what .env held that day.
 *
 * Its own constant rather than one shared with OpenAI's: they are different
 * sentences about different providers, and one destination's flag being on says
 * nothing about the other's.
 */
export const GOOGLE_VALIDATE_ONLY_DETAIL = "validate_only: nothing was recorded by Google Ads";

/**
 * What the row says between the ingest and Google's answer.
 *
 * **This is the whole of the second phase, as far as a person reading the tab is
 * concerned.** The status is `retrying`, which is one of the five words the
 * vocabulary allows and the only honest one available: the conversion has been
 * accepted and NOT confirmed, nothing else will be learned until Google answers,
 * and the row must stay claimable so that the answer is actually asked for.
 * `sent` would be the lie this change exists to remove, and a sixth word is
 * refused by settled.js and would have to be added to the claim, the scrub
 * precondition, the backstop and the resend -- where one omission re-sends for
 * ever and another never scrubs.
 *
 * The request id is in the sentence because the column holding it is not in the
 * tab's select list, and it is the one thing a person needs to ask Google about
 * this conversion by hand. Note that `redactDetail` masks any run of eight or
 * more digits as a phone number, so an all-numeric request id reads masked here
 * -- the column is the authority, and it is not masked.
 */
export const googleAwaitingDetail = (requestId, polls) =>
  `awaiting Google's confirmation of request ${requestId} (poll ${polls} of ${GOOGLE_CONFIRM_MAX_ATTEMPTS})`;

// What the row says while a request is in the air. The outcome replaces it the
// moment it is known, so a person reads this only if the process died first.
const IN_FLIGHT_DETAIL = "send started; outcome not recorded";

// The `code` on the error `begin` throws when its claiming UPDATE matched no
// row. Not a failure of this step: another sweeper owns the action and is
// sending it, so this one must write nothing at all (see processSignupEvent).
const CLAIM_LOST = "CRM_EVENT_CLAIM_LOST";

/**
 * What to write after one attempt.
 *
 * `attempts` is incremented here. processSignupEvent writes the result of a
 * retryable plan BEFORE each request goes out (see `begin` there), and the
 * outcome's plan after it, both from the same count. A crash mid-send therefore
 * costs one attempt instead of retrying forever.
 */
export function planRetry({
  attempts = 0,
  maxAttempts = 3,
  retryable = false,
  finalStatus = "failed",
  now = new Date(),
  delayMinutes = 5,
}) {
  const used = Number(attempts) + 1;
  if (!retryable) return { status: finalStatus, attempts: used, nextAttemptAt: null };
  if (used >= Number(maxAttempts)) return { status: "failed", attempts: used, nextAttemptAt: null };
  return {
    status: "retrying",
    attempts: used,
    nextAttemptAt: new Date(now.getTime() + Number(delayMinutes) * 60_000),
  };
}

const str = (v) => String(v ?? "").trim();

export function rowToFields(row = {}) {
  return {
    stage: str(row.stage),
    crmClientId: str(row.crm_client_id),
    firstName: str(row.first_name),
    middleName: str(row.middle_name),
    lastName: str(row.last_name),
    email: str(row.email),
    phone: str(row.phone),
    // A statistic since 2026-10-14: no destination is gated on it any more.
    // Kept here so the settings tab and anything else reading fields sees the
    // same shape the row has.
    recordType: str(row.record_type) || "lead",
    // The raw `%client_is_lead%` literal, which Brevo's gate reads rather than
    // `recordType` -- the two are not each other's negation (decideBrevoSkip
    // says why). It survives the scrub, so a requeued row still has it.
    isLeadRaw: str(row.is_lead_raw),
    marketingConsent: Boolean(Number(row.marketing_consent)),
    isIb: Boolean(Number(row.is_ib)),
    entity: str(row.entity),
    source: str(row.source),
    language: str(row.language),
    utmSource: str(row.utm_source),
    utmMedium: str(row.utm_medium),
    utmCampaign: str(row.utm_campaign),
    referer: str(row.referer),
    fullLink: str(row.full_link),
  };
}

const eventTimeSeconds = (row) => Math.floor(new Date(row.received_at).getTime() / 1000);

/**
 * The one shape a step reads a failed deposit lookup through.
 *
 * Anything that is not a `value` is a send that did not happen, and it must not
 * be able to read as one. So the default here is a failure rather than a pass:
 * a lookup that answered in a shape nobody planned for stops the send instead
 * of letting a valueless `Purchase` through, which is precisely the bug being
 * fixed.
 *
 * Retryable unless the lookup said otherwise, for the same reason: FXBO lagging
 * its own webhook by a few seconds is far commoner than a permanent refusal,
 * and the attempt budget bounds the wait either way.
 */
function depositLookupFailure(looked) {
  const detail = str(looked?.failure?.detail) || "the deposit amount could not be looked up";
  return { detail: `deposit lookup: ${detail}`, retryable: looked?.failure?.retryable !== false };
}

async function runMetaStep(row, fields, deps, begin, depositValue) {
  const { config, sendMeta, now, logger } = deps;

  // One decision for both reasons a Meta send is not ours to make: no token, or
  // a stage the website pixel owns. A skip spends no attempt and sets no clock.
  const skip = decideMetaSkip({ stage: fields.stage, accessToken: config.metaAccessToken });
  if (skip) {
    return { status: "skipped", detail: skip.reason, attempts: Number(row.meta_attempts) || 0, nextAttemptAt: null };
  }

  // **Meta DISCARDS a Purchase that carries no value.** It answers 200 with
  // `events_received: 1`, we record `sent`, and the conversion never exists --
  // diagnostic s2s_invalid_purchase_event_actions, raised 2026-10-16, with
  // three deposits sent and none in the dataset to prove it. So the amount is
  // not an enrichment of this send, it is a precondition of it, and a lookup
  // that found nothing has to stop the send rather than thin it out.
  //
  // Sent anyway, the row would read `sent` for an event Meta threw away, which
  // is the exact failure this change exists to remove.
  let deposit = null;
  if (fields.stage === DEPOSIT_VALUE_STAGE) {
    const looked = await depositValue();
    if (!looked?.value) {
      const failure = depositLookupFailure(looked);
      // Before the claim and before any request, like decideBrevoListIdFailure:
      // nothing is sent, so there is nothing for a second sweeper to collide
      // with. Unlike that case it still spends an attempt and sets a clock when
      // the cause may clear -- the deposit webhook can beat FXBO's own
      // transaction record into existence, and three attempts five minutes
      // apart is what bounds the waiting before the row settles `failed`.
      const plan = planRetry({
        attempts: Number(row.meta_attempts) || 0,
        maxAttempts: META_MAX_ATTEMPTS,
        retryable: failure.retryable,
        finalStatus: "failed",
        now: now(),
      });
      // The row id, not the client: a lookup failure is about the CRM or the
      // configuration, and there is no client data in the detail either.
      logger.warn?.(`[crm-events] meta ${plan.status} for row ${row.id}: ${failure.detail}`);
      return { ...plan, detail: failure.detail };
    }
    deposit = looked.value;
  }

  const payload = buildMetaPayload({
    stage: fields.stage,
    email: fields.email,
    phone: fields.phone,
    // The three Event Match Quality parameters added 2026-10-20. The names are
    // scrubbed about a minute after signup, which is safe here and only here:
    // the scrub runs after every destination has settled, and a row that is
    // somehow claimed once scrubbed is refused at the top of this function
    // before any payload is built. Were it not, the columns are NULL rather
    // than a placeholder, so buildMetaPayload would omit the keys rather than
    // hash something uniform.
    firstName: fields.firstName,
    lastName: fields.lastName,
    // The same id event_id is built from below, which is what makes our
    // external_id consistent across everything we send for this client --
    // Meta's one stated rule for the parameter.
    crmClientId: fields.crmClientId,
    // Verbatim from the row: frozen at this client's first event.
    fbc: str(row.fbc),
    eventTimeSeconds: eventTimeSeconds(row),
    // One id per real funnel event, identical on every retry of it. Meta
    // deduplicates server events sharing an event_id and event_name, which is
    // what stops a lost response booking the conversion twice.
    eventId: `${fields.crmClientId}:${fields.stage}`,
    testEventCode: config.metaTestEventCode,
    // Null at every stage but the first deposit, and buildMetaPayload then
    // carries neither half of the pair.
    depositValue: deposit,
  });

  await begin();
  const outcome = await sendMeta({
    datasetId: config.metaDatasetId,
    apiVersion: config.metaApiVersion,
    accessToken: config.metaAccessToken,
    payload,
  });

  const plan = planRetry({
    attempts: Number(row.meta_attempts) || 0,
    maxAttempts: META_MAX_ATTEMPTS,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
  });

  if (plan.status !== "sent") {
    logger.warn?.(`[crm-events] meta ${plan.status} for ${maskEmail(fields.email)}: ${outcome.detail}`);
  }

  return { ...plan, detail: outcome.detail };
}

async function runWhatsappStep(row, fields, deps, begin) {
  const { config, sendWhatsapp, newMessageId, now, logger } = deps;

  // No record type: a lead gets the same welcome as a client (2026-10-14,
  // user's call), so the only facts about the client left here are the phone
  // format and SKIP_SOURCES.
  const skip = decideWhatsappSkip({
    stage: fields.stage,
    apiKey: config.waApiKey,
    source: fields.source,
    phone: fields.phone,
    skipSources: config.skipSources,
  });

  if (skip) {
    return {
      status: "skipped",
      detail: skip.reason,
      messageId: null,
      attempts: Number(row.whatsapp_attempts) || 0,
      nextAttemptAt: null,
    };
  }

  const payload = buildWhatsappPayload({
    templateName: config.waTemplateName,
    language: config.waTemplateLanguage,
    firstName: fields.firstName,
    bodyParam: config.waTemplateBodyParam,
    buttonUrl: config.waTemplateButtonUrl,
    from: config.waFromNumber,
    to: fields.phone,
    // Frozen on the row at insert, NOT regenerated per attempt: a send times
    // out after 10 seconds, and a timeout does not mean the message was not
    // delivered, so a fresh id on a retry would be a second welcome.
    messageId: str(row.whatsapp_request_id) || newMessageId(),
  });

  await begin();
  const outcome = await sendWhatsapp({ apiKey: config.waApiKey, payload });

  const plan = planRetry({
    attempts: Number(row.whatsapp_attempts) || 0,
    maxAttempts: config.waMaxAttempts,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
  });

  if (plan.status !== "sent") {
    logger.warn?.(`[crm-events] whatsapp ${plan.status} for ${maskPhone(fields.phone)}: ${outcome.detail}`);
  }

  return { ...plan, detail: outcome.detail, messageId: outcome.messageId };
}

async function runBrevoStep(row, fields, deps, begin) {
  const { config, upsertBrevo, now, logger } = deps;

  // The raw literal, not `fields.recordType`: the gate is a positive lead test
  // so that an unrecognised value adds a contact rather than emptying the list.
  const skip = decideBrevoSkip({
    stage: fields.stage,
    apiKey: config.brevoApiKey,
    isLeadRaw: fields.isLeadRaw,
  });
  if (skip) {
    return {
      status: "skipped",
      detail: skip.reason,
      // No request, so no contact and no id. Explicitly null on every path out
      // of this step: the writer COALESCEs, so a null never erases an id a
      // previous send recorded, and `undefined` would read as the same null
      // without anyone having decided it.
      contactId: null,
      attempts: Number(row.brevo_attempts) || 0,
      nextAttemptAt: null,
    };
  }

  // Before the payload and before the claim, because the point is that no request
  // is made: an unusable BREVO_LIST_ID used to create the contact in no list
  // while the row recorded `sent`, and the shortfall only showed up in a campaign
  // weeks later. Terminal, so no attempt is spent and no clock is set -- the
  // variable will not be right in five minutes. The row keeps its client data
  // (`failed` is not scrubbable), which is what the resend will need.
  const badListId = decideBrevoListIdFailure({ listId: config.brevoListId });
  if (badListId) {
    // No client data in this line: the problem is entirely in the environment.
    logger.warn?.(`[crm-events] brevo ${badListId.status} for row ${row.id}: ${badListId.detail}`);
    return {
      status: badListId.status,
      detail: badListId.detail,
      contactId: null,
      attempts: Number(row.brevo_attempts) || 0,
      nextAttemptAt: null,
    };
  }

  const contact = buildBrevoContact(fields, { listId: config.brevoListId });
  await begin();
  const outcome = await upsertBrevo({ apiKey: config.brevoApiKey, contact });

  const plan = planRetry({
    attempts: Number(row.brevo_attempts) || 0,
    maxAttempts: BREVO_MAX_ATTEMPTS,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
  });

  if (plan.status !== "sent") {
    logger.warn?.(`[crm-events] brevo ${plan.status} for ${maskEmail(fields.email)}: ${outcome.detail}`);
  }

  // The id travels with the plan, and `plan` cannot carry it: planRetry knows
  // about attempts and clocks, not about what the provider said. A 2xx that
  // returned no id is still a send (the contact was an update, not a create) and
  // the detail says so, so this is null on a success as often as not.
  return { ...plan, detail: outcome.detail, contactId: outcome.contactId ?? null };
}

async function runOpenaiStep(row, fields, deps, begin, depositValue) {
  const { config, sendOpenai, now, logger } = deps;
  const attempts = Number(row.openai_attempts) || 0;

  // **`receivedAt` and `now`, never eventTimeSeconds(row).** That helper divides
  // by 1000 for Meta, whose `event_time` is in seconds; OpenAI's `timestamp_ms`
  // is in milliseconds, so feeding it here would stamp every event in 1970 --
  // and the symptom would not be an error anywhere, it would be OpenAI refusing
  // the event for falling outside its own 7-day window, with nothing in the row
  // to say why. openaiTimestampMs is the one parse, and both of these calls read
  // it, so the row judged inside the window is the row stamped with that instant.
  const receivedAt = row.received_at;
  const skip = decideOpenaiSkip({
    stage: fields.stage,
    apiKey: config.openaiApiKey,
    pixelId: config.openaiPixelId,
    receivedAt,
    // The sweeper's clock, so a test and the worker agree about what "now" is.
    now: now(),
  });
  if (skip) {
    return { status: "skipped", detail: skip.reason, attempts, nextAttemptAt: null };
  }

  // **The same gate as Meta's, for a different reason, and this one was a
  // choice.** `amount` is optional to OpenAI: an `order_created` with no amount
  // is received and counted, simply worth nothing. So sending it unpriced was
  // available here and is not available on Meta.
  //
  // It is refused anyway. OpenAI deduplicates on the event `id`, which is
  // `<client>:<stage>` and identical on every retry and every resend -- so an
  // unpriced conversion sent now is the FINAL word on that deposit's value,
  // and no later send can correct it. That buys a conversion whose revenue is
  // permanently zero, on the one row where Meta's own conversion is being held
  // back for the same missing number, and leaves the two platforms reporting
  // the same deposit as different money with nothing saying why.
  //
  // `retrying` and then `failed` is the honest alternative: visible on the
  // destination card, requeueable by an operator once FXBO answers, and bounded
  // by the same attempt budget. The cost, recorded rather than hidden: an FXBO
  // outage lasting longer than the budget now costs ChatGPT Ads the conversion
  // outright where it used to cost only the amount -- and `failed` is resendable
  // for as long as OpenAI's own 7-day window allows, which is what makes that
  // the recoverable direction.
  let deposit = null;
  if (fields.stage === DEPOSIT_VALUE_STAGE) {
    const looked = await depositValue();
    if (!looked?.value) {
      const failure = depositLookupFailure(looked);
      const plan = planRetry({
        attempts,
        maxAttempts: config.openaiMaxAttempts,
        retryable: failure.retryable,
        finalStatus: "failed",
        now: now(),
      });
      logger.warn?.(`[crm-events] openai ${plan.status} for row ${row.id}: ${failure.detail}`);
      return { ...plan, detail: failure.detail };
    }
    deposit = looked.value;
  }

  const payload = buildOpenaiPayload({
    stage: fields.stage,
    crmClientId: fields.crmClientId,
    email: fields.email,
    phone: fields.phone,
    // Verbatim from the row: frozen at this client's first event, and the only
    // copy there is once full_link has been scrubbed.
    oppref: str(row.oppref),
    receivedAt,
    validateOnly: config.openaiValidateOnly,
    // The minor-unit integer half of the same lookup Meta's decimal came from.
    // openaiAmountFields reads `amountMinor` and Meta's metaValueFields reads
    // `valueDecimal`, so neither can pick up the other's number.
    depositValue: deposit,
  });

  // **A null payload is not posted.** `JSON.stringify(null)` is the string
  // "null", which is a perfectly well-formed request body carrying no event at
  // all, and OpenAI's answer to it is not documented. Unreachable today -- a
  // client id is required at intake and every other reason is already a skip
  // above -- so this is a backstop, and it records `invalid`: the same word the
  // insert itself writes for a payload that could never be sent, and the one
  // status no resend will pick up, because nothing an operator fixes would make
  // the payload constructible.
  if (!payload) {
    logger.warn?.(`[crm-events] openai payload could not be built for row ${row.id}; nothing is sent`);
    return { status: "invalid", detail: "no sendable payload could be built", attempts, nextAttemptAt: null };
  }

  await begin();
  const outcome = await sendOpenai({
    eventsUrl: config.openaiEventsUrl,
    pixelId: config.openaiPixelId,
    apiKey: config.openaiApiKey,
    payload,
  });

  const plan = planRetry({
    attempts,
    maxAttempts: config.openaiMaxAttempts,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
  });

  // On every outcome, not only on a success: a validation that was refused was
  // still only a validation, and reading `rejected` without it would send
  // somebody looking for an event OpenAI never had.
  const detail = config.openaiValidateOnly
    ? `${OPENAI_VALIDATE_ONLY_DETAIL}; ${outcome.detail}`
    : outcome.detail;

  if (plan.status !== "sent") {
    logger.warn?.(`[crm-events] openai ${plan.status} for ${maskEmail(fields.email)}: ${detail}`);
  }

  return { ...plan, detail };
}

/**
 * The confirmation phase: one poll, and whatever Google now says.
 *
 * **Reached before every other decision in the Google step, and the order is the
 * point.** A conversion that has been ingested is past the stage where any of
 * them applies: re-running decideGoogleSkip could record `skipped` for a
 * conversion Google is holding (a refresh token pulled during an incident would
 * do it), re-resolving the conversion action asks Google a question the answer
 * to no longer affects, and re-looking-up the deposit would spend an FXBO call
 * on a number already on the wire. None of them can change the outcome, and two
 * of them can overwrite it with a word that is false.
 *
 * The claim is taken, exactly as the ingest takes it. A poll is a write to the
 * row, and two overlapped workers both writing the outcome of the same poll is
 * the race `begin` exists for -- the loser writes nothing rather than landing a
 * stale answer on top of the winner's.
 *
 * `planRetry` does the rest, on the confirm phase's own budget and Google's own
 * backoff: `SUCCESS` and `FAILED` are not retryable, so they settle as `sent`
 * and `rejected` immediately; `PROCESSING` is, so it books the next poll. The
 * budget is what guarantees the row settles at all -- after 25 polls spanning
 * Google's stated 24 hours, planRetry writes `failed`.
 *
 * `failed` after 24 hours of `PROCESSING` does NOT mean Google refused the
 * conversion, and the detail has to say so: it may still land, and nothing here
 * will ever learn that it did. It is `failed` because that is the vocabulary's
 * word for "nothing further will be attempted", and because `failed` is what the
 * resend control can reach -- a deliberate re-ingest carries the same
 * `transactionId`, so Google treats it as the same conversion.
 */
async function runGoogleConfirmStep(row, deps, begin, requestId) {
  const { config, confirmGoogle, now, logger } = deps;
  const attempts = Number(row.google_attempts) || 0;

  await begin();
  const outcome = await confirmGoogle({ config, requestId });

  const plan = planRetry({
    attempts,
    maxAttempts: GOOGLE_CONFIRM_MAX_ATTEMPTS,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
    // Google's published schedule, continued from where the ingest left it: the
    // ingest set the first 30-minute wait, so the poll that has just happened is
    // number `attempts + 1` and the next wait is the one that follows it.
    delayMinutes: googleConfirmDelayMinutes(attempts + 1),
  });

  // Three sentences, each only when it is true: what Google said, where in the
  // schedule this is, and -- on the one outcome that is easy to misread -- that
  // running out of polls is not a refusal.
  const detail =
    plan.status === "retrying"
      ? `${googleAwaitingDetail(requestId, plan.attempts)}; ${outcome.detail}`
      : plan.status === "failed" && outcome.retryable
        ? `unconfirmed after ${GOOGLE_CONFIRM_MAX_ATTEMPTS} polls over ${GOOGLE_CONFIRM_WINDOW_MINUTES / 60}h; ` +
          `Google may still record it, and nothing here will learn that it did: ${outcome.detail}`
        : outcome.detail;

  if (plan.status !== "sent") {
    // The row id and not the client: a confirmation says nothing about a person,
    // and there is no client data in the detail either.
    logger.warn?.(`[crm-events] google ${plan.status} for row ${row.id}: ${detail}`);
  }

  // No `requestId` in the result, deliberately. The writer COALESCEs it, so
  // passing nothing keeps the id that is already in the column -- and there is
  // nothing new to say about it. Re-sending the same value would work and would
  // be one more place for it to be sent wrongly.
  return { ...plan, detail };
}

async function runGoogleStep(row, fields, deps, begin, depositValue) {
  const { config, sendGoogle, resolveGoogleAction, now, logger } = deps;
  const attempts = Number(row.google_attempts) || 0;

  // **PHASE TWO FIRST.** A request id in the column means a conversion was
  // accepted by `events:ingest` and has not been confirmed, so the only thing
  // left to do for this row is ask what became of it -- and in particular NOT
  // ingest it again, which would be a second conversion. The column is the whole
  // of that discrimination (store.js says why it is cut rather than nulled, and
  // why the writer COALESCEs it).
  const awaiting = str(row.google_request_id);
  if (awaiting) return runGoogleConfirmStep(row, deps, begin, awaiting);

  // One decision for every reason this ingest is not ours to make: nothing
  // configured, a stage the GTM container owns, a stage with no conversion
  // action, or -- the commonest -- a client who arrived without a gclid. A skip
  // spends no attempt and sets no clock.
  const skip = decideGoogleSkip({
    stage: fields.stage,
    refreshToken: config.googleRefreshToken,
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    customerId: config.googleCustomerId,
    // Verbatim from the row: frozen at this client's first event, and the only
    // copy there is once full_link has been scrubbed. Google has no identifier
    // to fall back on, so this is the difference between an attributed
    // conversion and no conversion at all.
    gclid: str(row.gclid),
  });
  if (skip) {
    return { status: "skipped", detail: skip.reason, attempts, nextAttemptAt: null };
  }

  // The same gate Meta's and ChatGPT Ads' steps apply, for the reason OpenAI's
  // gives: Google accepts a conversion with no value, and `transactionId` makes
  // this conversion unique per action for ever -- so an unpriced ingest now is
  // the final word on that deposit's worth and no later send can correct it. A
  // visible `failed`, requeueable once FXBO answers, is the recoverable
  // direction.
  let deposit = null;
  if (fields.stage === DEPOSIT_VALUE_STAGE) {
    const looked = await depositValue();
    if (!looked?.value) {
      const failure = depositLookupFailure(looked);
      const plan = planRetry({
        attempts,
        maxAttempts: GOOGLE_INGEST_MAX_ATTEMPTS,
        retryable: failure.retryable,
        finalStatus: "failed",
        now: now(),
      });
      logger.warn?.(`[crm-events] google ${plan.status} for row ${row.id}: ${failure.detail}`);
      return { ...plan, detail: failure.detail };
    }
    deposit = looked.value;
  }

  // A deposit that was found but cannot be stated in money Google reads. Before
  // the claim and before any request, like decideBrevoListIdFailure: nothing is
  // ingested, so there is nothing for a second sweeper to collide with. It
  // spends no attempt and sets no clock either -- a currency Google cannot read
  // will not be readable in five minutes -- and the detail names the code.
  const unpriceable = decideGoogleValueFailure({ stage: fields.stage, depositValue: deposit });
  if (unpriceable) {
    // The row id, not the client: the problem is the deposit's currency, and
    // there is no client data in the detail either.
    logger.warn?.(`[crm-events] google ${unpriceable.status} for row ${row.id}: ${unpriceable.detail}`);
    return { status: unpriceable.status, detail: unpriceable.detail, attempts, nextAttemptAt: null };
  }

  // **The conversion action is resolved by NAME, and the ingest cannot be built
  // without the NUMERIC ID it resolves to.** Still a Google Ads API call, and
  // still before the claim for the same reason the deposit lookup is: no
  // conversion has been ingested, so there is nothing another sweeper could
  // duplicate. It spends an attempt and sets a clock when the cause may clear,
  // because a failure here is as often a 5xx or an expired refresh token as it
  // is a misconfigured account.
  //
  // What it must never do is settle `sent`. The ways to get this wrong are all
  // silent, and the move to an asynchronous API made them quieter: a hardcoded
  // id ingests into whatever action now holds it, an omitted
  // `productDestinationId` is a conversion Google files against nothing, and a
  // resource name where the id belongs is a well-formed string that would be
  // accepted with a 200 and refused a day later as an error count naming no
  // row. So this is a failure with the action's name in it, every time.
  const resolved = await resolveGoogleAction({ config, stage: fields.stage, now: now() });
  if (!resolved?.conversionActionId) {
    const retryable = resolved?.failure?.retryable !== false;
    const detail = str(resolved?.failure?.detail) || "the conversion action could not be resolved";
    const plan = planRetry({
      attempts,
      maxAttempts: GOOGLE_INGEST_MAX_ATTEMPTS,
      retryable,
      finalStatus: "failed",
      now: now(),
    });
    logger.warn?.(`[crm-events] google ${plan.status} for row ${row.id}: ${detail}`);
    return { ...plan, detail };
  }

  const payload = buildGoogleIngest({
    stage: fields.stage,
    crmClientId: fields.crmClientId,
    gclid: str(row.gclid),
    // The NUMERIC id, which is what `productDestinationId` takes. The resolver
    // returns nothing else now, so there is no resource name here to pass by
    // mistake -- and buildGoogleIngest refuses a value that is not all digits
    // anyway, because that mistake would be accepted with a 200.
    conversionActionId: resolved.conversionActionId,
    // The operating account, in the body rather than in the URL.
    customerId: config.googleCustomerId,
    // The manager account, when there is one: `login-customer-id` has no header
    // to travel in on this API, so it becomes `destinations[].loginAccount`.
    loginCustomerId: config.googleLoginCustomerId,
    // The row's own instant, written in the ACCOUNT's zone rather than the
    // server's. googleEventTimestamp says what that does and does NOT decide now
    // -- a Timestamp is an instant, so the offset labels it rather than moving
    // it.
    receivedAt: row.received_at,
    offset: config.googleTimezoneOffset,
    // The DECIMAL half of the same lookup OpenAI took the minor-unit integer
    // from. googleValueFields reads `valueDecimal` and openaiAmountFields reads
    // `amountMinor`, so neither can pick up the other's number -- a $54.49
    // deposit reported as $5,449 is what that mistake looks like here.
    depositValue: deposit,
    validateOnly: config.googleValidateOnly,
  });

  // **A null payload is not posted.** Unreachable today -- every reason is
  // already a skip or a failure above -- so this is the backstop, and it records
  // `invalid`: the one status no resend picks up, because nothing an operator
  // fixes would make the payload constructible.
  if (!payload) {
    logger.warn?.(`[crm-events] google payload could not be built for row ${row.id}; nothing is ingested`);
    return { status: "invalid", detail: "no sendable payload could be built", attempts, nextAttemptAt: null };
  }

  await begin();
  const outcome = await sendGoogle({ config, payload, gclid: str(row.gclid) });

  // **An accepted ingest does NOT go through planRetry, and that is the shape of
  // the whole change.** A 200 from `events:ingest` means "accepted for
  // asynchronous processing"; the conversion has been handed over successfully
  // and is now waiting, which is neither a send to settle nor an attempt to
  // retry. So the row is written by hand: `retrying`, because the conversion is
  // unconfirmed and the row must stay claimable to go and ask; the request id,
  // because without it the next sweep would ingest the conversion again; and the
  // attempt count reset to 0, because the budget from here on is the confirm
  // phase's 25 polls and not the ingest's 3 (googleMaxAttemptsFor).
  //
  // The clock is Google's own first wait of 30 minutes. `begin` has already
  // written a five-minute one for crash safety, which this replaces within
  // milliseconds; a process that died in between would poll 25 minutes early,
  // be told `PROCESSING`, and re-clock itself properly. One wasted request
  // against a window of 100,000 a day.
  if (outcome.requestId) {
    const first = {
      status: "retrying",
      attempts: 0,
      nextAttemptAt: new Date(now().getTime() + googleConfirmDelayMinutes(0) * 60_000),
      requestId: outcome.requestId,
      detail: `${googleAwaitingDetail(outcome.requestId, 0)}; ${outcome.detail}`,
    };
    // Logged at warn like every other non-`sent` outcome, because this is the
    // state a conversion now spends up to a day in and an operator reading the
    // log should see it start rather than infer it. The row id, not the client:
    // there is no client data in the detail.
    logger.warn?.(`[crm-events] google accepted for row ${row.id}: ${first.detail}`);
    return first;
  }

  const plan = planRetry({
    attempts,
    maxAttempts: GOOGLE_INGEST_MAX_ATTEMPTS,
    retryable: outcome.retryable,
    finalStatus: outcome.status,
    now: now(),
  });

  // On every outcome, not only on a success: a validation that was refused was
  // still only a validation, and reading `rejected` without this would send
  // somebody looking in Google Ads for a conversion that was never offered. It
  // is also the only path on which an ingest reads `sent` at all -- a validated
  // request is not executed, so there is no request to confirm.
  const detail = config.googleValidateOnly
    ? `${GOOGLE_VALIDATE_ONLY_DETAIL}; ${outcome.detail}`
    : outcome.detail;

  if (plan.status !== "sent") {
    logger.warn?.(`[crm-events] google ${plan.status} for ${maskEmail(fields.email)}: ${detail}`);
  }

  return { ...plan, detail };
}

/**
 * Whether an action's own retry clock is still in the future.
 *
 * claimDueEvents selects a row when ANY of its five actions is due, so without
 * this a waiting action is run early whenever a sibling comes due -- and one whose
 * request is still in the air (see `begin`) is sent a second time. "Due" is
 * `<= now`, the same test the sweeper applies in SQL.
 *
 * A missing clock is due, and so is one that cannot be read: new Date(null) is the
 * epoch and new Date(undefined) or new Date("junk") is NaN, and neither is greater
 * than now. Waiting for ever on a value that will never arrive is worse than an
 * early retry, so the comparison is left to fail open rather than guarded.
 */
function isWaiting(clock, now) {
  return new Date(clock).getTime() > now.getTime();
}

/**
 * The outcome write, retried once when what it records is something that has
 * already left the building.
 *
 * A send that succeeded and could not be recorded is the one write failure that
 * costs a client a second message: the row stays `retrying` with its clock due,
 * and the next sweep sends again. One dropped connection is enough, and no
 * second process is needed for it. Anything else is left to fail on the first
 * attempt -- repeating it only delays a row that has not been sent anyway.
 *
 * **`requestId` counts as a send for this purpose, and has to.** Google's
 * accepted ingest writes `retrying` rather than `sent`, because a 200 from
 * `events:ingest` is an acceptance and not a delivery -- but the conversion HAS
 * been handed over, and that write is the only thing that records the request id
 * the outcome will be confirmed by. Lost, the row reads as never ingested, the
 * next sweep ingests the conversion a second time, and the first request becomes
 * one nothing will ever ask about. Keyed on the id rather than on the
 * destination so that whatever is handed over next gets the same protection.
 */
async function saveOutcome(save, id, outcome, logger) {
  try {
    return await save(id, outcome);
  } catch (error) {
    if (outcome?.status !== "sent" && !str(outcome?.requestId)) throw error;
    logger?.warn?.(
      `[crm-events] could not record a completed send, retrying the write: ${error?.message || String(error)}`
    );
    return save(id, outcome);
  }
}

/**
 * One row, five actions, independently.
 *
 * Each action has its own status, attempt count and clock in the row, and its own
 * budget. A settled one is never touched again, and one still waiting on its
 * clock is left for the sweep that finds it due.
 *
 * A step that throws becomes a retryable stored status and the others still run.
 * A write to the store that fails is NOT caught, deliberately: when the row cannot
 * be written, nothing further is sent for it, because a send that cannot be
 * recorded is a send the next sweep repeats.
 *
 * A step whose claim is lost is the one case that records nothing: the action
 * belongs to the sweeper that claimed it, and it is left alone rather than
 * retried or marked failed.
 */
export async function processSignupEvent(row, deps) {
  const fields = rowToFields(row);
  const result = { meta: null, whatsapp: null, brevo: null, openai: null, google: null };
  // The actions another worker took off us during this pass. Not an outcome and
  // never written anywhere: it is only read by the scrub decision below, which
  // must not read our stale column for an action somebody else is settling.
  const claimedElsewhere = new Set();

  // A scrubbed row has no name, no email and no phone left. Building a payload
  // from it would hand Brevo a contact with no address and DoubleTick a welcome
  // template with no name in it, and both would be accepted -- that is the point:
  // nothing downstream would complain. claimDueEvents selects only
  // `pending`/`retrying` and the scrub only runs once every destination is `sent` or
  // `skipped`, so no row should ever arrive here scrubbed. That is the reason this is a guard
  // and not an assumption: whatever later makes a scrubbed row claimable, it
  // sends nothing and writes nothing.
  // **Settling, not just returning, because returning deadlocked the queue.**
  // Adding the Google Ads column on 2026-10-22 defaulted every existing row's
  // `google_status` to `pending`, which made 31 already-scrubbed rows claimable
  // again. They are the OLDEST by `received_at`, claimDueEvents takes the 25
  // oldest, and the early return wrote nothing -- so the same 25 were re-claimed
  // every sweep for ever and no row received after them was ever reached. Every
  // destination on every new signup sat `pending`: no WhatsApp welcome, no Brevo
  // contact, no conversion anywhere. The guard above was right that such a row
  // must send nothing; it was wrong that it could also write nothing.
  //
  // So each still-unsettled action is settled `skipped`, which is final and
  // takes the row out of the claim query for good. `skipped` and not `failed`
  // because nothing was attempted and nothing is recoverable: the client data a
  // send would need was deleted by the scrub, deliberately, and will not return.
  if (row?.scrubbed_at) {
    deps.logger?.warn?.(`[crm-events] row ${row.id} is scrubbed; settling its unsent actions`);
    const detail = "row was scrubbed before this destination existed; nothing to send";
    const settle = [
      ["meta", row.meta_status, deps.saveMeta],
      ["whatsapp", row.whatsapp_status, deps.saveWhatsapp],
      ["brevo", row.brevo_status, deps.saveBrevo],
      ["openai", row.openai_status, deps.saveOpenai],
      ["google", row.google_status, deps.saveGoogle],
    ];
    for (const [action, status, save] of settle) {
      if (status !== "pending" && status !== "retrying") continue;
      // Claimed by another worker during this pass: it is settling the action,
      // and writing over it here would race with the outcome it is recording.
      if (claimedElsewhere.has(action)) continue;
      await save?.(row.id, { status: "skipped", detail, attempts: Number(row[`${action}_attempts`]) || 0 });
      result[action] = { status: "skipped", detail };
    }
    return result;
  }

  // **One lookup per row per pass, asked for only by a step that will use it.**
  //
  // Lazy: a step decides its skip first, so a row whose Meta, ChatGPT Ads and
  // Google Ads steps are all skipped or already settled costs no CRM call at
  // all, and no stage but the first deposit ever reaches this. Memoised: the
  // three destinations that do send share one answer rather than asking FXBO
  // the same question three times for one deposit -- which also means they
  // cannot disagree about what the deposit was worth. The promise is cached, not
  // the result, so a later caller awaits the first call instead of starting
  // another.
  //
  // This is the only outbound call in the module that is not to a destination,
  // which is why its cost is bounded here rather than left to the callers.
  let depositLookup = null;
  const depositValue = () => {
    if (!depositLookup) {
      depositLookup = Promise.resolve()
        .then(() => deps.lookupDepositValue({ config: deps.config, crmClientId: fields.crmClientId }))
        // fetchFirstDepositValue is documented as never throwing; this is the
        // backstop for a dep that does. A lookup that threw must read as a
        // lookup that failed, never as a step that found no value to send --
        // and it must not take the worker or the other destinations down with
        // it, which is what a rejected promise awaited in two steps would do.
        .catch((error) => ({
          failure: { detail: `threw: ${error?.message || String(error)}`, retryable: true },
        }));
    }
    return depositLookup;
  };

  const steps = [
    ["meta", "meta_status", "meta_attempts", "meta_next_attempt_at", runMetaStep, deps.saveMeta, META_MAX_ATTEMPTS],
    ["whatsapp", "whatsapp_status", "whatsapp_attempts", "whatsapp_next_attempt_at", runWhatsappStep, deps.saveWhatsapp, deps.config.waMaxAttempts],
    ["brevo", "brevo_status", "brevo_attempts", "brevo_next_attempt_at", runBrevoStep, deps.saveBrevo, BREVO_MAX_ATTEMPTS],
    ["openai", "openai_status", "openai_attempts", "openai_next_attempt_at", runOpenaiStep, deps.saveOpenai, deps.config.openaiMaxAttempts],
    // Google's budget is the only one read off the row rather than fixed per
    // destination, because this destination has two phases and they are an order
    // of magnitude apart (googleMaxAttemptsFor). It is read here for `begin`'s
    // pre-request claim and again inside the step for the outcome, from the one
    // function, so the claim cannot write `failed` on a poll the step still
    // considers budgeted.
    ["google", "google_status", "google_attempts", "google_next_attempt_at", runGoogleStep, deps.saveGoogle, googleMaxAttemptsFor(row)],
  ];

  for (const [key, statusColumn, attemptsColumn, clockColumn, run, save, maxAttempts] of steps) {
    // SETTLED, not SCRUBBABLE: this is "is this action still mine to attempt",
    // and a `rejected` or `failed` one is finished with even though the row it
    // sits on is not safe to forget. Read SCRUBBABLE here and every refused
    // action would be claimed again -- a second WhatsApp welcome, which is the
    // one message with nothing deduplicating it.
    if (SETTLED.has(str(row[statusColumn]))) continue;
    if (isWaiting(row[clockColumn], deps.now())) continue;

    const attempts = Number(row[attemptsColumn]) || 0;

    // Written before the request goes out, as a retryable plan: the attempt is
    // spent and the clock is set five minutes out, so a process that dies inside
    // the request leaves the row due later with one attempt gone, rather than due
    // again at the very next sweep with the count unchanged. On the final attempt
    // the same plan reads `failed`, so a crash there is not retried at all. A step
    // that sends nothing (a skip) never calls it and spends nothing. The outcome
    // replaces this, computed from the same count.
    //
    // It is also the claim: the write carries the moment it claims for, and the
    // store only applies it while the action is still unsent and its clock is
    // due. claimDueEvents takes no lock, and an overlapped IIS recycle runs two
    // workers whose `sweeping` flags know nothing of each other, so this is the
    // one thing standing between that overlap and a second WhatsApp welcome --
    // Meta has event_id and Brevo's upsert is idempotent, WhatsApp has neither.
    const begin = async () => {
      const claimed = await save(
        row.id,
        {
          ...planRetry({ attempts, maxAttempts, retryable: true, now: deps.now() }),
          detail: IN_FLIGHT_DETAIL,
        },
        deps.now()
      );
      // Strictly 0, which is the store reporting that it matched no row. A store
      // that does not report a count at all returns null, and a count we were
      // never given must not read as a lost claim: that would stop every send.
      if (claimed === 0) throw Object.assign(new Error(`${key} is claimed elsewhere`), { code: CLAIM_LOST });
    };

    try {
      result[key] = await run(row, fields, deps, begin, depositValue);
    } catch (error) {
      // Another sweeper got there first. Nothing was sent and nothing may be
      // written: a status from here would overwrite the owner's, and this is not
      // a failure to retry or to record.
      if (error?.code === CLAIM_LOST) {
        deps.logger.warn?.(`[crm-events] ${key} left to the sweeper that claimed row ${row.id}`);
        claimedElsewhere.add(key);
        continue;
      }
      deps.logger.error?.(`[crm-events] ${key} step threw: ${error?.message || String(error)}`);
      result[key] = {
        ...planRetry({ attempts, maxAttempts, retryable: true, now: deps.now() }),
        detail: "step threw",
        messageId: null,
      };
    }
    // No claim moment: this row's action is ours, and the outcome has to land on
    // whatever the claim left in the status column.
    await saveOutcome(save, row.id, result[key], deps.logger);
  }

  // Every destination succeeded or was deliberately skipped, so nothing
  // downstream needs the client's name, email or phone again and the row goes on
  // holding the statistics it was kept for.
  //
  // SCRUBBABLE, not SETTLED, and the difference is the whole point of this
  // decision (2026-10-14, user's call). A `failed` or `rejected` destination is
  // settled -- nothing will attempt it again -- but the row is NOT safe to
  // forget: the name, email and phone are what the resend needs once the cause is
  // fixed, and a misconfigured destination (an unusable BREVO_LIST_ID, say) fails
  // every row that way. Scrubbing on SETTLED made those clients permanently
  // unrecoverable. The thirty-day backstop still takes such a row, so nothing
  // nobody ever fixes becomes a permanent store of client data.
  //
  // This decides only WHETHER TO TRY, which is why the common case still issues
  // exactly one statement; what makes trying safe is the statement's own
  // precondition (see scrubbableClause in store.js), which reads all five
  // statuses off the row as the table holds it.
  //
  // An action's status is read from its own place: the step's own outcome when it
  // ran this pass, the column it was found with otherwise. That covers the two
  // reasons a step runs nothing -- one already settled reports the settled status
  // it was skipped for, and one still waiting on its clock reports the
  // `pending`/`retrying` it was found with, so a row with a send still ahead of
  // it is not read as finished. A status that is settled but not scrubbable
  // (`rejected`, `failed`, `invalid`) reads as not-scrubbable from either place,
  // which is what keeps the row's data for the resend.
  //
  // **A conversion awaiting Google's confirmation holds the row here, and that
  // is deliberate and has a cost worth naming.** Such an action is `retrying`,
  // which is in neither set, so the existing predicate already refuses to scrub
  // it -- no change was needed for that, which is most of the reason the
  // confirmation phase holds `retrying` rather than inventing a word. The cost
  // is that the scrub, which normally runs about a minute after signup, waits up
  // to 24 hours on the rows Google is still processing: the stages that reach
  // Google at all, and of those only the ones carrying a gclid, which is a small
  // fraction of signups. Those rows hold their name, email and phone for that
  // long instead of a minute, and the thirty-day backstop still bounds them.
  //
  // It could be otherwise. The poll needs only `google_request_id`, which is not
  // client data and is not on the scrub list, so scrubbing a row mid-confirmation
  // would lose nothing the confirmation needs. What stands in the way is the
  // scrubbed-row guard at the top of this function, which settles every unsettled
  // action `skipped` -- it would record `skipped` for a conversion Google had
  // actually accepted. Changing that guard is how the queue was starved on
  // 2026-10-22, so the retention cost is taken instead and written down here.
  //
  // An action another worker claimed is the exception, and the reason this is no
  // longer decided by our copy alone: our column for it is stale by definition,
  // and its owner is settling it. During an overlapped IIS recycle two workers
  // split the claims between them, and while each read its own stale copy NEITHER
  // ever saw all five settled -- so neither scrubbed, and the row waited the full
  // thirty days for the backstop in exactly the case the policy asks to reduce to
  // a minute. Both attempt it now: the earlier attempt finds the other's actions
  // still `retrying` in the table and matches nothing, and whichever worker
  // finishes last scrubs.
  const scrubbableHere = ([key, statusColumn]) =>
    claimedElsewhere.has(key) || SCRUBBABLE.has(result[key] ? str(result[key].status) : str(row[statusColumn]));
  if (steps.every(scrubbableHere)) {
    // Not caught. A scrub that cannot be written leaves the row for the 30-day
    // backstop, and sweepOnce logs the row -- swallowing it here would hide a
    // scrub that never happens behind a month of silence.
    await deps.scrub(row.id, deps.now());
  }

  return result;
}

/**
 * The two retention passes, at most once an hour however often the sweep runs.
 *
 * Deleting runs first. An all-`invalid` row reaching seven days is gone before
 * the thirty-day backstop could scrub it instead, which is what keeps seven days
 * the window that governs those rows -- a scrubbed invalid row would have lost
 * the `raw_payload` CUTOVER step 5 reads while still sitting in the table.
 *
 * A failure is logged and not rethrown: retention is housekeeping, and a sweep
 * that delivered three welcomes must not report itself as failed because a DELETE
 * timed out. The next hour tries again.
 */
async function runRetentionIfDue(deps, now) {
  if (now.getTime() - lastRetentionAt < RETENTION_INTERVAL_MS) return;
  // Stamped before the work, not after: a pass that throws every time must not
  // retry at every sweep for ever.
  lastRetentionAt = now.getTime();
  try {
    const deleted = await deps.deleteInvalid(new Date(now.getTime() - INVALID_RETENTION_DAYS * DAY_MS));
    const scrubbed = await deps.scrubStale(new Date(now.getTime() - UNSCRUBBED_BACKSTOP_DAYS * DAY_MS), now);
    if (deleted || scrubbed) {
      console.log(
        `[crm-events] retention: ${deleted} invalid rows deleted after ${INVALID_RETENTION_DAYS} days, ` +
          `${scrubbed} unscrubbed rows scrubbed after ${UNSCRUBBED_BACKSTOP_DAYS}`
      );
    }
  } catch (error) {
    console.error(`[crm-events] retention pass failed: ${error?.message || String(error)}`);
  }
}

function liveConfig() {
  return {
    metaDatasetId: process.env.META_DATASET_ID || "692517170017822",
    metaApiVersion: process.env.META_API_VERSION || "v26.0",
    metaAccessToken: process.env.META_CAPI_ACCESS_TOKEN || "",
    metaTestEventCode: process.env.META_TEST_EVENT_CODE || "",
    waApiKey: process.env.WA_API_KEY || "",
    waTemplateName: process.env.WA_TEMPLATE_NAME || "registration_client_v3",
    waTemplateLanguage: process.env.WA_TEMPLATE_LANGUAGE || "en",
    waTemplateBodyParam: process.env.WA_TEMPLATE_BODY_PARAM || "https://skylinkscapital.com/en/login/",
    waTemplateButtonUrl: process.env.WA_TEMPLATE_BUTTON_URL || "https://skylinkscapital.com/en/login/",
    waFromNumber: process.env.WA_FROM_NUMBER || "+971507192185",
    waMaxAttempts: Math.max(1, Number(process.env.WA_MAX_ATTEMPTS || 3) || 3),
    brevoApiKey: process.env.BREVO_API_KEY || "",
    brevoListId: process.env.BREVO_LIST_ID || "",
    // OPENAI_CONVERSIONS_API_KEY, and never OPENAI_API_KEY: that one belongs to
    // the LLM agent in agent/llmAgent.js and has nothing to do with ChatGPT Ads.
    // Reading it here would send the wrong secret to a different company's
    // endpoint on every event.
    openaiApiKey: process.env.OPENAI_CONVERSIONS_API_KEY || "",
    openaiPixelId: process.env.OPENAI_PIXEL_ID || "",
    openaiEventsUrl: process.env.OPENAI_EVENTS_URL || OPENAI_EVENTS_URL,
    // Only the literal "true", any case, turns validation on -- the inverse of
    // CRM_EVENTS_WORKER_ENABLED's "only the literal false", and for the matching
    // reason: this flag silently stops every conversion being recorded, so a
    // stray `1`, `yes` or `on` left in .env must not be what does that.
    openaiValidateOnly: String(process.env.OPENAI_VALIDATE_ONLY || "").toLowerCase() === "true",
    openaiMaxAttempts: Math.max(1, Number(process.env.OPENAI_MAX_ATTEMPTS || 3) || 3),
    // Google Ads. The refresh token is the credential the uploads cannot be
    // made without, so its absence is what "this destination is not set up"
    // means (decideGoogleSkip). It is minted once by
    // scripts/google-ads-refresh-token.mjs and survives indefinitely only
    // because the OAuth consent screen is published; left in "Testing" it
    // expires weekly and every conversion settles `failed` at the exchange.
    googleRefreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN || "",
    googleClientId: process.env.GOOGLE_ADS_CLIENT_ID || "",
    googleClientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET || "",
    googleCustomerId: process.env.GOOGLE_ADS_CUSTOMER_ID || "",
    // Required only when reaching the customer THROUGH a manager account, so
    // blank is the normal value and the header is then omitted entirely.
    // Still read, and now read for TWO things: the `login-customer-id` header on
    // the conversion-action lookup (a Google Ads API call, which still takes
    // headers) and `destinations[].loginAccount` on the Data Manager ingest,
    // which takes none. Blank is the normal value, and both are then omitted.
    googleLoginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "",
    // GOOGLE_ADS_DEVELOPER_TOKEN is deliberately NOT read any more. The Google
    // Ads API has ignored developer tokens since the 2026-09-09 sunset and says
    // it will start rejecting them; the Data Manager API documents no such
    // header and says not to set request headers on an ingest at all. A value
    // read here would be a value that could only be sent somewhere it is
    // unwelcome -- see decideGoogleSkip.
    //
    // A version in the URL that Google sunsets about a year after releasing it,
    // so it is movable with a restart rather than a deploy. The ONE call still
    // made to the Google Ads API is the conversion-action lookup, so this now
    // governs that and nothing else.
    googleApiVersion: String(process.env.GOOGLE_ADS_API_VERSION || GOOGLE_ADS_API_VERSION).trim(),
    googleApiHost: String(process.env.GOOGLE_ADS_API_HOST || GOOGLE_ADS_API_HOST).trim(),
    googleTokenUrl: String(process.env.GOOGLE_ADS_TOKEN_URL || GOOGLE_OAUTH_TOKEN_URL).trim(),
    // Where the conversions themselves go. Its own variable because it is its
    // own API on its own host, and a single GOOGLE_ADS_API_HOST pointing at both
    // would be one value for two services. No version variable beside it --
    // DATA_MANAGER_API_VERSION says why there is nothing yet to move.
    googleDataManagerHost: String(process.env.GOOGLE_DATA_MANAGER_HOST || DATA_MANAGER_API_HOST).trim(),
    // The account's own zone, +04:00, unless an operator moves it. Anything
    // unusable falls back to the account's with a warning rather than stopping
    // the ingests -- resolveTimezoneOffset says why that is the right direction
    // for this one value and not for a key. It is presentational now:
    // googleEventTimestamp says why a Timestamp's offset cannot move a
    // conversion between days the way `conversionDateTime`'s could.
    googleTimezoneOffset: resolveTimezoneOffset(process.env.GOOGLE_ADS_TIMEZONE_OFFSET),
    // Only the literal "true", any case, exactly as OPENAI_VALIDATE_ONLY: this
    // flag stops every conversion being recorded while the row still settles,
    // so a stray `1`, `yes` or `on` left in .env must not be what does that.
    googleValidateOnly: String(process.env.GOOGLE_ADS_VALIDATE_ONLY || "").toLowerCase() === "true",
    skipSources: parseSkipSources(process.env.SKIP_SOURCES),
    // FXBO, for the first-deposit amount. The same three variables and the same
    // default origin that server.js's /rest proxy and reports/reportShared.js
    // already read -- not a fourth opinion about where the CRM is.
    //
    // **Not api.skylinkscapital.com.** That is the trading backend, it takes a
    // bearer exchanged from BACKEND_API_KEY, and sending this token there (or
    // that one here) authenticates to neither.
    //
    // Trimmed, all three: a .env edited on Windows leaves a trailing CR on the
    // value, and the CRM answers a token with one on it with a 403 that says
    // nothing about whitespace. server.js carries the same note.
    crmRestBase: String(process.env.REST_PROXY_TARGET || "https://portal.skylinkscapital.com").trim(),
    crmApiVersion: String(process.env.API_VERSION || process.env.VITE_API_VERSION || "1.0.0").trim(),
    // The VITE_ name is a legacy fallback only, exactly as server.js keeps it:
    // Vite compiles anything VITE_-prefixed into the browser bundle, which is
    // why the unprefixed name is the one to set.
    crmApiToken: String(process.env.API_TOKEN || process.env.VITE_API_TOKEN || "").trim(),
  };
}

/**
 * The Google credentials and endpoints, named once for the three calls that take
 * them.
 *
 * Written out here rather than passed as `config` so that googleAds.js takes
 * flat arguments like every other sender, and so this file is the only place
 * that knows a `googleCustomerId` is a `customerId`. A mapping written twice
 * is a mapping that can be written differently twice -- and sending the manager
 * id as the customer id reports to the wrong account without an error.
 *
 * One object for two APIs: `apiHost`/`apiVersion`/`customerId` are the Google
 * Ads lookup's and `dataManagerHost` is the ingest's and the status retrieval's.
 * Each function names the arguments it wants and ignores the rest, which is
 * cheaper than three near-identical mappings of the same credentials -- the
 * credentials genuinely are the same, because one refresh token serves both
 * scopes.
 *
 * No developer token: this module no longer holds one (see decideGoogleSkip).
 */
function googleCall(config) {
  return {
    apiHost: config.googleApiHost,
    apiVersion: config.googleApiVersion,
    dataManagerHost: config.googleDataManagerHost,
    customerId: config.googleCustomerId,
    loginCustomerId: config.googleLoginCustomerId,
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    refreshToken: config.googleRefreshToken,
    tokenUrl: config.googleTokenUrl,
  };
}

function liveDeps() {
  return {
    config: liveConfig(),
    sendMeta: (args) => sendMetaEvent(args),
    sendWhatsapp: ({ apiKey, payload }) => sendWhatsappTemplate({ apiKey, payload }),
    upsertBrevo: ({ apiKey, contact }) => upsertBrevoContact({ apiKey, contact }),
    sendOpenai: ({ eventsUrl, pixelId, apiKey, payload }) =>
      sendOpenaiEvent({ eventsUrl, pixelId, apiKey, payload }),
    // THREE deps for Google where the others have one, and each is a separate
    // round trip for a separate reason:
    //
    //   resolveGoogleAction -- the conversion action's numeric id, from its
    //   name, on the Google Ads API. Before the claim, so a name that does not
    //   resolve costs no claim and ingests nothing. Cached per process.
    //
    //   sendGoogle -- the ingest, on the Data Manager API. After the claim. Its
    //   200 is an acceptance, not a delivery.
    //
    //   confirmGoogle -- what became of that acceptance, up to 24 hours later.
    //   Its own dep rather than a flag on sendGoogle so that a test can answer
    //   the two phases differently, which is the only way the interesting cases
    //   here can be exercised at all.
    //
    // All three read the same process-wide access token cache, so the common
    // case is one HTTP request per call and not two.
    resolveGoogleAction: ({ config, stage, now }) =>
      resolveGoogleConversionAction({ ...googleCall(config), stage, now }),
    sendGoogle: ({ config, payload, gclid }) =>
      ingestGoogleConversion({ ...googleCall(config), payload, gclid }),
    confirmGoogle: ({ config, requestId }) =>
      retrieveGoogleRequestStatus({ ...googleCall(config), requestId }),
    // Injected like the senders so a test can answer it without a network, and
    // so the one case that matters -- the lookup finding nothing -- can be
    // exercised rather than argued about.
    lookupDepositValue: ({ config, crmClientId }) =>
      fetchFirstDepositValue({
        baseUrl: config.crmRestBase,
        apiVersion: config.crmApiVersion,
        apiToken: config.crmApiToken,
        crmClientId,
      }),
    saveMeta: updateMetaStatus,
    saveWhatsapp: updateWhatsappStatus,
    saveBrevo: updateBrevoStatus,
    saveOpenai: updateOpenaiStatus,
    saveGoogle: updateGoogleStatus,
    scrub: scrubSignupEvent,
    deleteInvalid: deleteInvalidSignupEvents,
    scrubStale: scrubStaleSignupEvents,
    newMessageId: () => randomUUID(),
    now: () => new Date(),
    logger: console,
  };
}

let sweeping = false;

/**
 * Whether the worker may send anything at all.
 *
 * Only the literal "false", any case, turns it off: `0` and `off` leave it on,
 * which is what .env.example and the runbook say. Read on every sweep rather
 * than once where the timer starts, because kickCrmEventsWorker comes straight
 * to sweepOnce on every webhook -- so a flag read only at startup stopped the
 * timer and nothing else, and there was no safe way to pause sending during an
 * incident: removing a provider key stores `skipped`, which is final and never
 * resent, and stopping the app pool answers the webhook 503 until FXBO has
 * spent its twelve retries.
 */
function workerEnabled(env = process.env) {
  return String(env.CRM_EVENTS_WORKER_ENABLED || "true").toLowerCase() !== "false";
}

export async function sweepOnce() {
  // Rows accumulate untouched while this is off -- their clocks are columns, not
  // timers, so the first sweep after it is turned back on catches them all up.
  if (!workerEnabled()) return { disabled: true };
  if (sweeping) return { skipped: true };
  sweeping = true;
  try {
    const rows = await claimDueEvents(25, new Date());
    const deps = liveDeps();
    for (const row of rows) {
      try {
        await processSignupEvent(row, deps);
      } catch (error) {
        console.error(`[crm-events] row ${row?.id} failed: ${error?.message || String(error)}`);
      }
    }
    // After the rows, so a row that settled on this very sweep was already
    // scrubbed by the settle path and the backstop has nothing to do for it.
    await runRetentionIfDue(deps, new Date());
    return { processed: rows.length };
  } finally {
    sweeping = false;
  }
}

/** Fire and forget, right after the 200, so the welcome is not a minute late. */
export function kickCrmEventsWorker() {
  setImmediate(() => {
    sweepOnce().catch((e) => console.error("[crm-events] kick failed:", e?.message || String(e)));
  });
}

/**
 * The safety net, following startDocusignReconcileScheduler.
 *
 * setInterval rather than node-cron on purpose: the clock that matters lives in
 * the next_attempt_at columns, so a recycle costs at most one interval.
 */
export function startCrmEventsWorker() {
  // The same flag sweepOnce reads, so the log line and the sends agree.
  if (!workerEnabled()) {
    console.log("[crm-events] worker disabled by CRM_EVENTS_WORKER_ENABLED=false");
    return null;
  }
  const intervalSeconds = Math.max(30, Number(process.env.CRM_EVENTS_WORKER_INTERVAL_SECONDS || 60) || 60);
  const timer = setInterval(() => {
    sweepOnce().catch((e) => console.error("[crm-events] sweep failed:", e?.message || String(e)));
  }, intervalSeconds * 1000);
  console.log(`[crm-events] worker started (interval=${intervalSeconds}s)`);
  return { stop: () => clearInterval(timer), intervalSeconds };
}
