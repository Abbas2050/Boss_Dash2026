import { STAGES, maskEmail, maskPhone } from "./normalise.js";

/** Matches docusign/webhookLog.js, which calls the same silence the same way. */
export const STALE_HOURS = 72;

const STATUSES = ["pending", "sent", "skipped", "retrying", "failed", "rejected", "invalid"];

/**
 * The five destinations, each with the three row columns it is read from.
 *
 * Its own list rather than an import of `store.js`'s `DESTINATIONS`, because
 * that one is a list of action NAMES used to interpolate column names into
 * statements, and this one is a mapping from a name to the three columns a row
 * actually carries -- a shared list would have to grow a convention tying the
 * two together, and a convention is the thing that breaks silently.
 *
 * **What it costs to leave a destination out is the reason it is commented at
 * all.** A missing entry does not fail: the destination sends, retries and
 * scrubs exactly as before, and the tab simply never mentions it. Its card is
 * absent, its column on every row is absent, and the one page built to reveal a
 * broken pipeline reports a healthy four-destination system. openai and google
 * are pinned by test here for that reason and no other.
 *
 * `google` joined on 2026-10-21, and it is the destination an omission here
 * would hide for longest: almost every one of its rows is a `skipped` for a
 * signup that arrived without a gclid, so nobody is waiting on a number from it
 * to go up. A card that was never built looks exactly like a card of zeroes
 * nobody has reason to question.
 *
 * Two of the five are no longer silent to remove, and that is an improvement
 * rather than a new rule to remember: `toTableRow` attaches the delivery proof
 * to `whatsapp` and the contact id to `brevo` after this loop has built them, so
 * dropping either name here throws instead of quietly emptying a column.
 */
const DESTINATIONS = [
  ["meta", "meta_status", "meta_detail", "meta_attempts"],
  ["whatsapp", "whatsapp_status", "whatsapp_detail", "whatsapp_attempts"],
  ["brevo", "brevo_status", "brevo_detail", "brevo_attempts"],
  ["openai", "openai_status", "openai_detail", "openai_attempts"],
  ["google", "google_status", "google_detail", "google_attempts"],
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
function newestReceivedAt(rows) {
  let newest = null;
  for (const r of rows) {
    const t = toMillis(r?.received_at);
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest === null ? null : new Date(newest);
}

/** The newest received_at per stage, as {stage, latest} rows, the shape the store returns. */
function latestByStageOf(rows) {
  const latest = new Map();
  for (const r of rows) {
    const t = toMillis(r?.received_at);
    const stage = String(r?.stage ?? "");
    if (t !== null && (!latest.has(stage) || t > latest.get(stage))) latest.set(stage, t);
  }
  return [...latest].map(([stage, t]) => ({ stage, latest: new Date(t) }));
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
 * Health for one stage. A stage that never fired is not stale: silence from a
 * rule that has never existed is expected, and a permanent red for it is a tab
 * people stop reading. Only a stage that fired and then stopped goes stale.
 */
function stageHealth(latestMs, now, staleHours) {
  if (latestMs === null) return { lastReceivedAt: null, ageHours: null, stale: false, everSeen: false };
  const ageHours = (now.getTime() - latestMs) / 3_600_000;
  return {
    lastReceivedAt: new Date(latestMs).toISOString(),
    ageHours,
    stale: ageHours > staleHours,
    everSeen: true,
  };
}

/**
 * Health, funnel and per-destination counters.
 *
 * `rows` is either table rows (one event each) or grouped counts carrying `n`.
 * Health comes from `latestReceivedAt` (the newest event in the whole table) and
 * `latestByStage` (the newest event per stage, whole table) when the caller passes
 * them, and otherwise from the rows given. Both are read independently of the
 * window, so a short window cannot make a stage look silent.
 *
 * The overall figure answers "is anything arriving at all". The per-stage figures
 * answer "is each rule still firing": one stage can die while another keeps going.
 *
 * Health is the one that earns its place: a broken FXBO rule raises no error
 * anywhere, it simply stops calling. An empty table therefore reports the overall
 * figure as STALE, never healthy -- silence must not read as calm.
 */
export function summariseCrmEvents(rows, { now = new Date(), staleHours = STALE_HOURS, latestReceivedAt, latestByStage } = {}) {
  const list = Array.isArray(rows) ? rows : [];

  const newest = toMillis(latestReceivedAt === undefined ? newestReceivedAt(list) : latestReceivedAt);
  const ageHours = newest === null ? null : (now.getTime() - newest) / 3_600_000;

  const stageLatest = new Map(
    (latestByStage === undefined ? latestByStageOf(list) : latestByStage).map(({ stage, latest }) => [
      String(stage),
      toMillis(latest),
    ])
  );
  const stages = Object.fromEntries(
    STAGES.map((stage) => [stage, stageHealth(stageLatest.get(stage) ?? null, now, staleHours)])
  );

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
      stages,
    },
    funnel,
    destinations,
  };
}

/** One row for the table, with the two PII fields masked.
 *
 *  `scrubbedAt` travels with them because masking and scrubbing look identical
 *  from the page: both arrive as an empty string. The page has to tell an
 *  operator "this row's client data is gone, as designed" apart from "this row
 *  never had a phone number", and this column is the only thing that can. */
export function toTableRow(row = {}) {
  const view = {
    id: row.id,
    receivedAt: row.received_at,
    scrubbedAt: row.scrubbed_at ?? null,
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

  // The two pieces of delivery PROOF, added beside the statuses rather than
  // folded into the DESTINATIONS tuple above. That tuple is "the three columns
  // every destination has"; these belong to one destination each, and widening
  // it to five would mean three nulls per row for the destinations that have
  // neither.
  //
  // Neither is a status and neither replaces one. `whatsapp_status` still says
  // what DoubleTick answered our request; this says what DoubleTick later said
  // became of the message, which is the only one of the two a handset is
  // involved in.
  view.whatsapp.delivery = {
    // Verbatim. The read status string is undocumented, so an unrecognised value
    // has to survive all the way to the page -- nothing here maps it to a word
    // of ours, and nothing drops it.
    status: row.whatsapp_delivery_status ? String(row.whatsapp_delivery_status) : null,
    at: row.whatsapp_delivery_at ?? null,
    detail: row.whatsapp_delivery_detail ?? null,
  };
  // The id of the contact Brevo created, which is the one thing in that exchange
  // that can be opened and looked at. Null is ordinary and not a fault: Brevo
  // mints an id only when it creates, so a repeat registration updates the
  // existing contact and returns none, and the row's detail says so.
  view.brevo.contactId = row.brevo_contact_id ? String(row.brevo_contact_id) : null;

  return view;
}
