import { randomUUID } from "crypto";
import { maskEmail, maskPhone } from "./normalise.js";
import { buildMetaPayload, sendMetaEvent, decideMetaSkip } from "./meta.js";
import {
  decideWhatsappSkip,
  buildWhatsappPayload,
  sendWhatsappTemplate,
  parseSkipSources,
} from "./whatsapp.js";
import { decideBrevoSkip, buildBrevoContact, upsertBrevoContact } from "./brevo.js";
import {
  claimDueEvents,
  updateMetaStatus,
  updateWhatsappStatus,
  updateBrevoStatus,
  scrubSignupEvent,
  deleteInvalidSignupEvents,
  scrubStaleSignupEvents,
} from "./store.js";

const SETTLED = new Set(["sent", "skipped", "rejected", "failed", "invalid"]);

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
// worker left off by CRM_EVENTS_WORKER_ENABLED, or a row whose three claims
// split between two overlapped workers so neither saw all three settle. Thirty
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

// Each action's attempt budget. WhatsApp's is configurable (WA_MAX_ATTEMPTS) and
// travels in config. Each is read in two places -- before the request and after
// it -- so Meta's and Brevo's live here rather than as a literal in both.
const META_MAX_ATTEMPTS = 3;
const BREVO_MAX_ATTEMPTS = 3;

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
    recordType: str(row.record_type) || "lead",
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

async function runMetaStep(row, fields, deps, begin) {
  const { config, sendMeta, now, logger } = deps;

  // One decision for both reasons a Meta send is not ours to make: no token, or
  // a stage the website pixel owns. A skip spends no attempt and sets no clock.
  const skip = decideMetaSkip({ stage: fields.stage, accessToken: config.metaAccessToken });
  if (skip) {
    return { status: "skipped", detail: skip.reason, attempts: Number(row.meta_attempts) || 0, nextAttemptAt: null };
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

  const skip = decideWhatsappSkip({
    stage: fields.stage,
    apiKey: config.waApiKey,
    recordType: fields.recordType,
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

  const skip = decideBrevoSkip({ stage: fields.stage, apiKey: config.brevoApiKey });
  if (skip) {
    return {
      status: "skipped",
      detail: skip.reason,
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

  return { ...plan, detail: outcome.detail };
}

/**
 * Whether an action's own retry clock is still in the future.
 *
 * claimDueEvents selects a row when ANY of its three actions is due, so without
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
 * One row, three actions, independently.
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
  const result = { meta: null, whatsapp: null, brevo: null };

  // A scrubbed row has no name, no email and no phone left. Building a payload
  // from it would hand Brevo a contact with no address and DoubleTick a welcome
  // template with no name in it, and both would be accepted -- that is the point:
  // nothing downstream would complain. claimDueEvents selects only
  // `pending`/`retrying` and the scrub only runs once all three have settled, so
  // no row should ever arrive here scrubbed. That is the reason this is a guard
  // and not an assumption: whatever later makes a scrubbed row claimable, it
  // sends nothing and writes nothing.
  if (row?.scrubbed_at) {
    deps.logger?.warn?.(`[crm-events] row ${row.id} is scrubbed; nothing is sent from it`);
    return result;
  }

  const steps = [
    ["meta", "meta_status", "meta_attempts", "meta_next_attempt_at", runMetaStep, deps.saveMeta, META_MAX_ATTEMPTS],
    ["whatsapp", "whatsapp_status", "whatsapp_attempts", "whatsapp_next_attempt_at", runWhatsappStep, deps.saveWhatsapp, deps.config.waMaxAttempts],
    ["brevo", "brevo_status", "brevo_attempts", "brevo_next_attempt_at", runBrevoStep, deps.saveBrevo, BREVO_MAX_ATTEMPTS],
  ];

  for (const [key, statusColumn, attemptsColumn, clockColumn, run, save, maxAttempts] of steps) {
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
      result[key] = await run(row, fields, deps, begin);
    } catch (error) {
      // Another sweeper got there first. Nothing was sent and nothing may be
      // written: a status from here would overwrite the owner's, and this is not
      // a failure to retry or to record.
      if (error?.code === CLAIM_LOST) {
        deps.logger.warn?.(`[crm-events] ${key} left to the sweeper that claimed row ${row.id}`);
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

  // All three settled, so nothing downstream needs the client's name, email or
  // phone again, and the row goes on holding the statistics it was kept for.
  //
  // The status read is the step's own outcome when it ran this pass, and the
  // column it was found with otherwise -- which covers both reasons a step runs
  // nothing: one already settled reports the settled status it was skipped for,
  // and one still on its clock or lost to another sweeper's claim reports the
  // `pending`/`retrying` it was found with, so neither is mistaken for settled.
  // A row whose claims split between two workers therefore scrubs from neither,
  // and waits for the backstop. That is the trade for never scrubbing a row
  // another worker is still sending from.
  const statusOf = ([key, statusColumn]) => (result[key] ? str(result[key].status) : str(row[statusColumn]));
  if (steps.map(statusOf).every((status) => SETTLED.has(status))) {
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
    skipSources: parseSkipSources(process.env.SKIP_SOURCES),
  };
}

function liveDeps() {
  return {
    config: liveConfig(),
    sendMeta: (args) => sendMetaEvent(args),
    sendWhatsapp: ({ apiKey, payload }) => sendWhatsappTemplate({ apiKey, payload }),
    upsertBrevo: ({ apiKey, contact }) => upsertBrevoContact({ apiKey, contact }),
    saveMeta: updateMetaStatus,
    saveWhatsapp: updateWhatsappStatus,
    saveBrevo: updateBrevoStatus,
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
