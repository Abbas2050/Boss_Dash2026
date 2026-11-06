/**
 * Poll the sheets, then drain the queue. Two passes, in that order, every
 * sixty seconds.
 *
 * They are separate on purpose. A Google outage leaves queued rows untouched,
 * and a CRM outage leaves the sheet's row count where it was -- so neither
 * failure can turn into the other one's data loss. Nothing here needs the
 * catch-up machinery the scheduled reports carry: polling is stateless, so a
 * dead app pool costs a delay and nothing else, and the unique lead id makes
 * the re-read that follows harmless.
 *
 * Design: ../docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md
 */
import { isTransientHttpStatus } from "../crmSignup/transientHttp.js";
import { headerProblem, readRow } from "./columns.js";
import { normaliseRow } from "./normalise.js";
import {
  buildLeadPayload,
  createLead as realCreateLead,
  findLeadByEmail as realFindLeadByEmail,
} from "./fxbo.js";
import { readHeaderAndRows as realReadHeaderAndRows } from "./sheetsReader.js";
import {
  claimRow as realClaimRow,
  deferRow as realDeferRow,
  disableSheetWithError as realDisableSheetWithError,
  getSheet as realGetSheet,
  insertLeadRow as realInsertLeadRow,
  listDueRows as realListDueRows,
  listSheets as realListSheets,
  markSheetBootstrapped as realMarkSheetBootstrapped,
  markSheetPolled as realMarkSheetPolled,
  settleRow as realSettleRow,
} from "./store.js";

/** Attempt 1 waits a minute, attempt 6 waits twelve hours, then it stops. */
export const BACKOFF_MINUTES = Object.freeze([1, 5, 15, 60, 180, 720]);
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

/** Once an hour the windowed read is replaced by a full one. */
export const FULL_READ_INTERVAL_MS = 60 * 60 * 1000;

const DRAIN_BATCH = 25;

function mysqlDatetime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function dueAfter(attempts, now) {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
  return mysqlDatetime(new Date(now.getTime() + minutes * 60 * 1000));
}

/**
 * Is this poll the hourly full read?
 *
 * A stored instant that is unreadable, or in the future, means the clock it
 * was written by is not the clock we are reading it with. That happened on
 * 2026-11-06 -- `last_full_read_at` came back five hours ahead -- and because
 * the age of a future instant is negative, it is never an hour old: the
 * reconciliation stopped for good and nothing said so. The cause is fixed in
 * store.js, and this answers "due" rather than "never" if it ever recurs. An
 * extra full read costs one API call; a reconciliation that silently stops
 * costs the rows it would have found.
 */
export function wantsFullRead(sheet, now) {
  if (!sheet.lastFullReadAt) return true;
  const age = now.getTime() - new Date(sheet.lastFullReadAt).getTime();
  if (!Number.isFinite(age) || age < 0) return true;
  return age >= FULL_READ_INTERVAL_MS;
}

/**
 * One sheet, one poll.
 *
 * On the very first poll of a newly registered sheet, every row present is
 * written as `skipped_existing` and nothing is sent. That is what makes going
 * live safe: the leads already in these workbooks, some of them worked by
 * hand already, cannot be re-created.
 */
export async function pollSheetOnce(sheet, deps = {}) {
  const readHeaderAndRows = deps.readHeaderAndRows || realReadHeaderAndRows;
  const insertLeadRow = deps.insertLeadRow || realInsertLeadRow;
  const markSheetPolled = deps.markSheetPolled || realMarkSheetPolled;
  const markSheetBootstrapped = deps.markSheetBootstrapped || realMarkSheetBootstrapped;
  const disableSheetWithError = deps.disableSheetWithError || realDisableSheetWithError;
  const now = (deps.now || (() => new Date()))();

  const bootstrapping = !sheet.bootstrappedAt;
  const fullRead = bootstrapping || wantsFullRead(sheet, now);
  const fromRow = fullRead ? 1 : Math.max(2, Number(sheet.lastRowCount || 0) + 1);

  let read;
  try {
    read = await readHeaderAndRows({
      spreadsheetId: sheet.spreadsheetId,
      tabName: sheet.tabName,
      fromRow,
    }, deps);
  } catch (error) {
    // The row count stays exactly where it was: a window we could not read is
    // a window the next poll must read again.
    await markSheetPolled(sheet.id, {
      rowCount: Number(sheet.lastRowCount || 0),
      fullRead: false,
      error: String(error?.message || error).slice(0, 500),
    });
    return { inserted: 0, skipped: 0, bootstrapped: false, disabled: false };
  }

  const problem = headerProblem(read.header);
  if (problem) {
    await disableSheetWithError(sheet.id, `header changed: ${problem}`);
    return { inserted: 0, skipped: 0, bootstrapped: false, disabled: true };
  }

  let inserted = 0;
  let skipped = 0;
  for (const cells of read.rows) {
    const lead = normaliseRow(readRow(cells));
    if (!lead.metaLeadId) continue; // a blank row at the end of the sheet
    const status = bootstrapping ? "skipped_existing" : (lead.skip || "pending");
    const result = await insertLeadRow(sheet.id, lead, status);
    if (!result.inserted) continue;
    if (status === "pending") inserted += 1;
    else skipped += 1;
  }

  const rowCount = Math.max(
    Number(sheet.lastRowCount || 0),
    read.firstRowNumber + read.rows.length - 1,
  );
  await markSheetPolled(sheet.id, { rowCount, fullRead, error: null });
  if (bootstrapping) await markSheetBootstrapped(sheet.id);

  return { inserted, skipped, bootstrapped: bootstrapping, disabled: false };
}

/** The queued row as the payload builder wants it. */
function toLead(row) {
  return {
    metaLeadId: row.meta_lead_id,
    createdTime: row.created_time || "",
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    email: row.email || "",
    phone: row.phone || "",
    country: row.country || null,
    leadSource: row.lead_source || null,
    utmParams: row.utm_params || null,
    campaignName: row.campaign_name || "",
    adsetName: row.adset_name || "",
    adName: row.ad_name || "",
    skip: null,
  };
}

export async function drainOnce(deps = {}) {
  const listDueRows = deps.listDueRows || realListDueRows;
  const claimRow = deps.claimRow || realClaimRow;
  const getSheet = deps.getSheet || realGetSheet;
  const findLeadByEmail = deps.findLeadByEmail || realFindLeadByEmail;
  const createLead = deps.createLead || realCreateLead;
  const settleRow = deps.settleRow || realSettleRow;
  const deferRow = deps.deferRow || realDeferRow;
  const clock = deps.now || (() => new Date());

  const counts = { sent: 0, duplicate: 0, failed: 0, deferred: 0 };
  const rows = await listDueRows(DRAIN_BATCH);

  for (const row of rows) {
    if (!(await claimRow(row.id))) continue;
    const attempts = Number(row.attempts || 0) + 1;
    const now = clock();

    const give = async (detail) => {
      if (attempts >= MAX_ATTEMPTS) {
        await settleRow(row.id, { status: "failed", detail, crmUserId: null });
        counts.failed += 1;
      } else {
        await deferRow(row.id, { detail, nextAttemptAt: dueAfter(attempts, now) });
        counts.deferred += 1;
      }
    };

    try {
      const sheet = await getSheet(row.sheet_id);
      if (!sheet) {
        await settleRow(row.id, {
          status: "failed",
          detail: `sheet ${row.sheet_id} no longer registered`,
          crmUserId: null,
        });
        counts.failed += 1;
        continue;
      }

      const lead = toLead(row);

      // Skip on email, allow on phone. No email means no check, not a block:
      // a lead with a phone is still workable.
      if (lead.email) {
        const existing = await findLeadByEmail(lead.email);
        if (existing) {
          await settleRow(row.id, {
            status: "duplicate",
            detail: `already in the CRM as user ${existing.id}`,
            crmUserId: existing.id,
          });
          counts.duplicate += 1;
          continue;
        }
      }

      const result = await createLead(buildLeadPayload(lead, sheet));
      if (result.ok) {
        await settleRow(row.id, { status: "sent", detail: null, crmUserId: result.userId });
        counts.sent += 1;
        continue;
      }

      if (isTransientHttpStatus(result.status)) {
        await give(result.detail);
      } else {
        await settleRow(row.id, { status: "failed", detail: result.detail, crmUserId: null });
        counts.failed += 1;
      }
    } catch (error) {
      // A thrown lookup, a dropped socket, a CRM with no token configured:
      // transport trouble, which is worth another attempt.
      await give(String(error?.message || error).slice(0, 500));
    }
  }

  return counts;
}

let sweeping = false;

export async function sweepOnce(deps = {}) {
  if (sweeping) return { polled: 0, drained: null };
  sweeping = true;
  try {
    const listSheets = deps.listSheets || realListSheets;
    const sheets = await listSheets();
    let polled = 0;
    for (const sheet of sheets) {
      if (!sheet.enabled) continue;
      try {
        await pollSheetOnce(sheet, deps);
        polled += 1;
      } catch (error) {
        console.error(`[meta-leads] sheet ${sheet.id} poll failed: ${error?.message || String(error)}`);
      }
    }
    // Rows queued by the poll above are drained in this same sweep, so a lead
    // is in the CRM a second after it is noticed rather than a minute.
    const drained = await drainOnce(deps);
    return { polled, drained };
  } finally {
    sweeping = false;
  }
}

function workerEnabled() {
  return String(process.env.META_LEADS_WORKER_ENABLED || "true").toLowerCase() !== "false";
}

/** Fire and forget, for a settings-tab action that should not wait a minute. */
export function kickMetaLeadsWorker() {
  setImmediate(() => {
    sweepOnce().catch((e) => console.error("[meta-leads] kick failed:", e?.message || String(e)));
  });
}

export function startMetaLeadsWorker() {
  if (!workerEnabled()) {
    console.log("[meta-leads] worker disabled by META_LEADS_WORKER_ENABLED=false");
    return null;
  }
  const intervalSeconds = Math.max(30, Number(process.env.META_LEADS_WORKER_INTERVAL_SECONDS || 60) || 60);
  const timer = setInterval(() => {
    sweepOnce().catch((e) => console.error("[meta-leads] sweep failed:", e?.message || String(e)));
  }, intervalSeconds * 1000);
  console.log(`[meta-leads] worker started (interval=${intervalSeconds}s)`);
  return { stop: () => clearInterval(timer), intervalSeconds };
}
