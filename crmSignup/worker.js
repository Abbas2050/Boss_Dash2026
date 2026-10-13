import { randomUUID } from "crypto";
import { maskEmail, maskPhone } from "./normalise.js";
import { buildMetaPayload, sendMetaEvent } from "./meta.js";
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
} from "./store.js";

const SETTLED = new Set(["sent", "skipped", "rejected", "failed", "invalid"]);

// Each action's attempt budget. WhatsApp's is configurable (WA_MAX_ATTEMPTS) and
// travels in config. Each is read in two places -- before the request and after
// it -- so Meta's and Brevo's live here rather than as a literal in both.
const META_MAX_ATTEMPTS = 3;
const BREVO_MAX_ATTEMPTS = 3;

// What the row says while a request is in the air. The outcome replaces it the
// moment it is known, so a person reads this only if the process died first.
const IN_FLIGHT_DETAIL = "send started; outcome not recorded";

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

  if (!str(config.metaAccessToken)) {
    return { status: "skipped", detail: "meta not configured", attempts: Number(row.meta_attempts) || 0, nextAttemptAt: null };
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
 */
export async function processSignupEvent(row, deps) {
  const fields = rowToFields(row);
  const result = { meta: null, whatsapp: null, brevo: null };

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
    const begin = () =>
      save(row.id, {
        ...planRetry({ attempts, maxAttempts, retryable: true, now: deps.now() }),
        detail: IN_FLIGHT_DETAIL,
      });

    try {
      result[key] = await run(row, fields, deps, begin);
    } catch (error) {
      deps.logger.error?.(`[crm-events] ${key} step threw: ${error?.message || String(error)}`);
      result[key] = {
        ...planRetry({ attempts, maxAttempts, retryable: true, now: deps.now() }),
        detail: "step threw",
        messageId: null,
      };
    }
    await save(row.id, result[key]);
  }

  return result;
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
    newMessageId: () => randomUUID(),
    now: () => new Date(),
    logger: console,
  };
}

let sweeping = false;

export async function sweepOnce() {
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
  const enabled = String(process.env.CRM_EVENTS_WORKER_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
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
