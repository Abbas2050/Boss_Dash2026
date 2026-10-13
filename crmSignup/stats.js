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

/**
 * Health, funnel and per-destination counters from a window of rows.
 *
 * Health is the one that earns its place: a broken FXBO rule raises no error
 * anywhere, it simply stops calling. An empty window therefore reports STALE,
 * never healthy -- silence must not read as calm.
 */
export function summariseCrmEvents(rows, { now = new Date(), staleHours = STALE_HOURS } = {}) {
  const list = Array.isArray(rows) ? rows : [];

  const times = list
    .map((r) => Date.parse(String(r?.received_at ?? "")))
    .filter((t) => Number.isFinite(t));

  const newest = times.length ? Math.max(...times) : null;
  const ageHours = newest === null ? null : (now.getTime() - newest) / 3_600_000;

  const funnel = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  for (const r of list) {
    const stage = String(r?.stage ?? "");
    if (stage in funnel) funnel[stage] += 1;
  }

  const destinations = Object.fromEntries(DESTINATIONS.map(([name]) => [name, zeroCounts()]));
  for (const r of list) {
    for (const [name, statusColumn] of DESTINATIONS) {
      const status = String(r?.[statusColumn] ?? "");
      if (status in destinations[name]) destinations[name][status] += 1;
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
