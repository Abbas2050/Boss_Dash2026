import { PLACEHOLDER_NOT_SUBSTITUTED } from "./fxboPlaceholder.js";

export const WEBHOOK_STALE_HOURS = 72;
export const WEBHOOK_REJECTION_WINDOW_DAYS = 7;
export const WEBHOOK_LOG_RETENTION = 500;
export const WEBHOOK_PAYLOAD_MAX_CHARS = 2000;

const trunc = (value, max) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
};

/**
 * Shape one inbound-webhook log row.
 * `error` is a reason code for BOTH rejected and skipped outcomes, and is null
 * only for a successful send.
 */
export function buildWebhookLogEntry({ outcome, httpStatus, error, applicationId, applicantEmail, envelopeId, payload } = {}) {
  let serialised = "";
  try {
    serialised = JSON.stringify(payload ?? {});
  } catch {
    serialised = '{"unserialisable":true}';
  }
  const email = trunc(applicantEmail, 255);
  return {
    outcome: String(outcome || "rejected"),
    httpStatus: Number(httpStatus) || 0,
    error: outcome === "sent" ? null : (trunc(error, 100) ?? null),
    applicationId: trunc(applicationId, 255),
    applicantEmail: email ? email.toLowerCase() : null,
    envelopeId: trunc(envelopeId, 255),
    payload: String(serialised).slice(0, WEBHOOK_PAYLOAD_MAX_CHARS),
  };
}

/**
 * Health of the inbound webhook, derived from recent log rows.
 * An absent signal is reported as stale — never as healthy.
 */
export function summariseWebhookHealth(rows, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const parsed = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ ...r, ts: Date.parse(String(r?.received_at ?? "")) }))
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => b.ts - a.ts);

  if (!parsed.length) {
    return {
      lastReceivedAt: null,
      lastOutcome: null,
      lastError: null,
      ageHours: null,
      stale: true,
      rejected7d: 0,
      placeholderTests7d: 0,
    };
  }

  const newest = parsed[0];
  const ageHours = (nowMs - newest.ts) / 3_600_000;
  const windowStart = nowMs - WEBHOOK_REJECTION_WINDOW_DAYS * 24 * 3_600_000;
  const inWindow = parsed.filter((r) => r.ts >= windowStart);
  const isPlaceholderTest = (r) => String(r.error) === PLACEHOLDER_NOT_SUBSTITUTED;

  return {
    lastReceivedAt: new Date(newest.ts).toISOString(),
    lastOutcome: String(newest.outcome || ""),
    // The reason code of the newest row, so a reader can tell WHY the last call
    // ended the way it did without opening the log — specifically, whether the
    // last "rejected" was somebody pressing FXBO's Test webhook button.
    lastError: newest.error == null ? null : String(newest.error),
    ageHours,
    stale: ageHours > WEBHOOK_STALE_HOURS,
    // A test press is a rejection in the HTTP sense but not a fault, so it is
    // counted separately. Rolling it into rejected7d made the panel read as
    // though the rule were failing when nothing was wrong with it.
    rejected7d: inWindow.filter((r) => String(r.outcome) === "rejected" && !isPlaceholderTest(r)).length,
    placeholderTests7d: inWindow.filter(isPlaceholderTest).length,
  };
}
