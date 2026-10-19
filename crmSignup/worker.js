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
// worker left off by CRM_EVENTS_WORKER_ENABLED, or a row whose four claims
// split between two overlapped workers so neither saw all four settle. Thirty
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
 * What the row says when the request was a validation rather than a send.
 *
 * `validate_only: true` returns a 2xx and records NOTHING on OpenAI's side --
 * the documentation is explicit that such a request does not appear in event
 * monitoring. So the outcome is a genuine `sent` (the exchange did succeed) for
 * a conversion that provably does not exist, and without this the destination
 * card and the overview would report it as real.
 *
 * It goes in the DETAIL and not in the status, deliberately. The status is the
 * one word four destinations share: SETTLED, SCRUBBABLE and REQUEUEABLE are all
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
 * Whether an action's own retry clock is still in the future.
 *
 * claimDueEvents selects a row when ANY of its four actions is due, so without
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
 * The outcome write, retried once when what it records is a send.
 *
 * A send that succeeded and could not be recorded is the one write failure that
 * costs a client a second message: the row stays `retrying` with its clock due,
 * and the next sweep sends again. One dropped connection is enough, and no
 * second process is needed for it. Anything else is left to fail on the first
 * attempt -- repeating it only delays a row that has not been sent anyway.
 */
async function saveOutcome(save, id, outcome, logger) {
  try {
    return await save(id, outcome);
  } catch (error) {
    if (outcome?.status !== "sent") throw error;
    logger?.warn?.(
      `[crm-events] could not record a completed send, retrying the write: ${error?.message || String(error)}`
    );
    return save(id, outcome);
  }
}

/**
 * One row, four actions, independently.
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
  const result = { meta: null, whatsapp: null, brevo: null, openai: null };
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
  if (row?.scrubbed_at) {
    deps.logger?.warn?.(`[crm-events] row ${row.id} is scrubbed; nothing is sent from it`);
    return result;
  }

  // **One lookup per row per pass, asked for only by a step that will use it.**
  //
  // Lazy: a step decides its skip first, so a row whose Meta and ChatGPT Ads
  // steps are both skipped or already settled costs no CRM call at all, and no
  // stage but the first deposit ever reaches this. Memoised: the two
  // destinations that do send share one answer rather than asking FXBO the same
  // question twice for one deposit. The promise is cached, not the result, so
  // the second caller awaits the first call instead of starting a second.
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
  // precondition (see scrubbableClause in store.js), which reads all four
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
  // An action another worker claimed is the exception, and the reason this is no
  // longer decided by our copy alone: our column for it is stale by definition,
  // and its owner is settling it. During an overlapped IIS recycle two workers
  // split the claims between them, and while each read its own stale copy NEITHER
  // ever saw all four settled -- so neither scrubbed, and the row waited the full
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

function liveDeps() {
  return {
    config: liveConfig(),
    sendMeta: (args) => sendMetaEvent(args),
    sendWhatsapp: ({ apiKey, payload }) => sendWhatsappTemplate({ apiKey, payload }),
    upsertBrevo: ({ apiKey, contact }) => upsertBrevoContact({ apiKey, contact }),
    sendOpenai: ({ eventsUrl, pixelId, apiKey, payload }) =>
      sendOpenaiEvent({ eventsUrl, pixelId, apiKey, payload }),
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
