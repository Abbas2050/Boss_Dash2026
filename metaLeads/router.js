/**
 * The three calls the settings tab makes. Mounting, auth and the permission
 * gate are server.js's business; these are handlers and nothing else, which is
 * what lets them be tested without an HTTP server.
 *
 * Design: ../docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md
 */

const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 500;

/** A spreadsheet id, whether it arrived bare or inside a pasted URL. */
export function parseSpreadsheetId(raw) {
  const text = String(raw ?? "").trim();
  const inUrl = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return inUrl ? inUrl[1] : text;
}

function rowLimit(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_ROW_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_ROW_LIMIT;
  return Math.min(MAX_ROW_LIMIT, Math.max(1, Math.floor(n)));
}

/** A database row as the browser reads it. The raw column names do not travel. */
function toClientRow(row) {
  return {
    id: Number(row.id),
    sheetId: Number(row.sheet_id),
    sheetLabel: row.sheet_label ?? null,
    metaLeadId: row.meta_lead_id,
    createdTime: row.created_time ?? null,
    name: [row.first_name, row.last_name].filter(Boolean).join(" "),
    email: row.email ?? null,
    phone: row.phone ?? null,
    country: row.country ?? null,
    leadSource: row.lead_source ?? null,
    adName: row.ad_name ?? null,
    status: row.status,
    detail: row.detail ?? null,
    crmUserId: row.crm_user_id ?? null,
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** GET /api/meta-leads/overview?limit=100 */
export function makeMetaLeadsOverviewHandler({ listSheets, listRecentRows, countRowsByStatus }) {
  return async function metaLeadsOverview(req, res) {
    try {
      const limit = rowLimit(req?.query?.limit);
      const [sheets, rows, counts] = await Promise.all([
        listSheets(),
        listRecentRows(limit),
        countRowsByStatus(),
      ]);
      res.json({ ok: true, sheets, counts, rows: rows.map(toClientRow) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  };
}

/**
 * POST /api/meta-leads/sheets
 *
 * Creates when there is no id, updates when there is. The defaults are the
 * design's: English, not IB, no owner, no tags, no status, no lead source.
 */
export function makeMetaLeadsSaveSheetHandler({ insertSheet, updateSheet, kick }) {
  return async function metaLeadsSaveSheet(req, res) {
    const body = req?.body || {};
    const label = String(body.label ?? "").trim();
    const spreadsheetId = parseSpreadsheetId(body.spreadsheetId);
    if (!label || !spreadsheetId) {
      return res.status(400).json({ ok: false, error: "label and spreadsheetId are required" });
    }

    let managerId = null;
    if (body.managerId !== undefined && body.managerId !== null && String(body.managerId).trim() !== "") {
      const parsed = Number(body.managerId);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return res.status(400).json({ ok: false, error: "managerId must be a positive whole number" });
      }
      managerId = parsed;
    }

    const fields = {
      label,
      spreadsheetId,
      tabName: String(body.tabName ?? "").trim() || "Sheet1",
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      ib: Boolean(body.ib),
      // On unless asked otherwise. Without it a lead reaches FXBO with no
      // field naming where it came from, and the escape hatch exists only
      // because nobody has yet seen how FXBO renders this field.
      sendLeadSource: body.sendLeadSource === undefined ? true : Boolean(body.sendLeadSource),
      managerId,
      language: String(body.language ?? "").trim() || "en",
      status: String(body.status ?? "").trim() || null,
      tags: String(body.tags ?? "").trim() || null,
    };

    try {
      if (body.id) {
        await updateSheet(Number(body.id), fields);
        kick();
        return res.json({ ok: true, id: Number(body.id) });
      }
      const created = await insertSheet(fields);
      kick();
      return res.json({ ok: true, id: created.id });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ ok: false, error: "that spreadsheet and tab are already registered" });
      }
      return res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  };
}

/**
 * POST /api/meta-leads/retry
 *
 * Only a `failed` row moves; the store's WHERE sees to that. A `sent` row
 * answers requeued:false rather than being sent to the CRM a second time.
 */
export function makeMetaLeadsRetryHandler({ requeueRow, kick }) {
  return async function metaLeadsRetry(req, res) {
    const id = Number(req?.body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "id is required" });
    }
    try {
      const requeued = await requeueRow(id);
      if (requeued) kick();
      return res.json({ ok: true, requeued });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  };
}
