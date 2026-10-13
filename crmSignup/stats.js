import { STAGES, maskEmail, maskPhone } from "./normalise.js";

/** Matches docusign/webhookLog.js, which calls the same silence the same way. */
export const STALE_HOURS = 72;

const STATUSES = ["pending", "sent", "skipped", "retrying", "failed", "rejected", "invalid"];

const DESTINATIONS = [
  ["meta", "meta_status", "meta_detail", "meta_attempts"],
  ["whatsapp", "whatsapp_status", "whatsapp_detail", "whatsapp_attempts"],
  ["brevo", "brevo_status", "brevo_detail", "brevo_attempts"],
];

function zeroCounts() {
  return Object.fromEntries(STATUSES.map((k) => [k, 0]));
}

/** A timestamp as epoch milliseconds, or null when it will not parse. */
function toMillis(value) {
  if (value === null || value === undefined || value === "") return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/** The newest received_at among the rows, as a Date, or null when there is none. */
export function newestReceivedAt(rows) {
  let newest = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = toMillis(r?.received_at);
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest === null ? null : new Date(newest);
}

/**
 * How many events a row stands for: one for a row of the table, n for a row of
 * the grouped count. Anything that is not a positive number counts as nothing.
 */
function weightOf(row) {
  const n = Number(row?.n ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Health, funnel and per-destination counters.
 *
 * `rows` is either table rows (one event each) or grouped counts carrying `n`.
 * Health comes from `latestReceivedAt` when the caller passes one -- the newest
 * event in the whole table, read independently of the window -- and otherwise
 * from the newest row given.
 *
 * Health is the one that earns its place: a broken FXBO rule raises no error
 * anywhere, it simply stops calling. An empty table therefore reports STALE,
 * never healthy -- silence must not read as calm.
 */
export function summariseCrmEvents(rows, { now = new Date(), staleHours = STALE_HOURS, latestReceivedAt } = {}) {
  const list = Array.isArray(rows) ? rows : [];

  const newest = toMillis(latestReceivedAt === undefined ? newestReceivedAt(list) : latestReceivedAt);
  const ageHours = newest === null ? null : (now.getTime() - newest) / 3_600_000;

  const funnel = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  for (const r of list) {
    const stage = String(r?.stage ?? "");
    if (Object.hasOwn(funnel, stage)) funnel[stage] += weightOf(r);
  }

  const destinations = Object.fromEntries(DESTINATIONS.map(([name]) => [name, zeroCounts()]));
  for (const r of list) {
    for (const [name, statusColumn] of DESTINATIONS) {
      const status = String(r?.[statusColumn] ?? "");
      if (Object.hasOwn(destinations[name], status)) destinations[name][status] += weightOf(r);
    }
  }

  return {
    health: {
      lastReceivedAt: newest === null ? null : new Date(newest).toISOString(),
      ageHours,
      stale: newest === null || ageHours > staleHours,
    },
    funnel,
    destinations,
  };
}

/** One row for the table, with the two PII fields masked. */
export function toTableRow(row = {}) {
  const view = {
    id: row.id,
    receivedAt: row.received_at,
    stage: String(row.stage ?? ""),
    crmClientId: String(row.crm_client_id ?? ""),
    name: [row.first_name, row.last_name].filter(Boolean).join(" "),
    email: maskEmail(row.email),
    phone: maskPhone(row.phone),
    recordType: String(row.record_type ?? ""),
    source: String(row.source ?? ""),
  };

  for (const [name, statusColumn, detailColumn, attemptsColumn] of DESTINATIONS) {
    view[name] = {
      status: String(row[statusColumn] ?? ""),
      detail: row[detailColumn] ?? null,
      attempts: Number(row[attemptsColumn]) || 0,
    };
  }

  return view;
}
