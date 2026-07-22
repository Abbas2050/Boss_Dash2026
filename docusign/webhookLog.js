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
    return { lastReceivedAt: null, lastOutcome: null, ageHours: null, stale: true, rejected7d: 0 };
  }

  const newest = parsed[0];
  const ageHours = (nowMs - newest.ts) / 3_600_000;
  const windowStart = nowMs - WEBHOOK_REJECTION_WINDOW_DAYS * 24 * 3_600_000;

  return {
    lastReceivedAt: new Date(newest.ts).toISOString(),
    lastOutcome: String(newest.outcome || ""),
    ageHours,
    stale: ageHours > WEBHOOK_STALE_HOURS,
    rejected7d: parsed.filter((r) => r.ts >= windowStart && String(r.outcome) === "rejected").length,
  };
}
