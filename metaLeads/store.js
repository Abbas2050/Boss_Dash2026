/**
 * Two tables: the sheets we watch, and every Meta lead row we have seen.
 *
 * On the same MariaDB the auth and CRM-events tables use (AUTH_DB_*), with the
 * same pool shape as crmSignup/store.js. Nothing here reaches outside the
 * database -- the Google read and the FXBO call live in their own modules, so
 * a failure of either cannot leave a half-written row behind.
 *
 * Design: ../docs/superpowers/specs/2026-11-06-meta-leads-to-fxbo-design.md
 */
import mysql from "mysql2/promise";

const AUTH_DB_HOST = process.env.AUTH_DB_HOST;
const AUTH_DB_PORT = Number(process.env.AUTH_DB_PORT || 3306);
const AUTH_DB_NAME = process.env.AUTH_DB_NAME;
const AUTH_DB_USER = process.env.AUTH_DB_USER;
const AUTH_DB_PASSWORD = process.env.AUTH_DB_PASSWORD;

let pool = null;
let initialized = false;

export const META_LEAD_SHEETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta_lead_sheets (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    label VARCHAR(128) NOT NULL,
    spreadsheet_id VARCHAR(128) NOT NULL,
    tab_name VARCHAR(128) NOT NULL DEFAULT 'Sheet1',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    ib TINYINT(1) NOT NULL DEFAULT 0,
    send_lead_source TINYINT(1) NOT NULL DEFAULT 0,
    manager_id INT UNSIGNED NULL,
    language VARCHAR(8) NULL,
    status VARCHAR(64) NULL,
    tags VARCHAR(512) NULL,
    last_row_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_polled_at DATETIME NULL,
    last_full_read_at DATETIME NULL,
    last_error TEXT NULL,
    bootstrapped_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_meta_lead_sheets_source (spreadsheet_id, tab_name)
  )
`;

/**
 * `meta_lead_id` is UNIQUE on its own, not per sheet.
 *
 * Meta's lead id is globally unique, so the same person cannot arrive twice
 * even if someone registers the same workbook under two labels -- which is
 * exactly the mistake a UNIQUE (sheet_id, meta_lead_id) would let through.
 */
export const META_LEAD_ROWS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta_lead_rows (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sheet_id INT UNSIGNED NOT NULL,
    meta_lead_id VARCHAR(64) NOT NULL,
    created_time VARCHAR(64) NULL,
    first_name VARCHAR(255) NULL,
    last_name VARCHAR(255) NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(32) NULL,
    country VARCHAR(2) NULL,
    lead_source VARCHAR(255) NULL,
    utm_params VARCHAR(1024) NULL,
    campaign_name VARCHAR(255) NULL,
    adset_name VARCHAR(255) NULL,
    ad_name VARCHAR(255) NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    detail TEXT NULL,
    crm_user_id INT UNSIGNED NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_meta_lead_rows_lead (meta_lead_id),
    KEY idx_meta_lead_rows_due (status, next_attempt_at),
    KEY idx_meta_lead_rows_sheet (sheet_id, id)
  )
`;

function hasDbConfig() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_NAME && AUTH_DB_USER && AUTH_DB_PASSWORD);
}

async function run(sql, params = []) {
  if (!pool) throw new Error("Meta leads DB pool is not initialized.");
  const [result] = await pool.query(sql, params);
  return result;
}

async function all(sql, params = []) {
  if (!pool) throw new Error("Meta leads DB pool is not initialized.");
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

export async function initMetaLeadsStore() {
  if (initialized) return;
  if (!hasDbConfig()) {
    throw new Error(
      "Meta leads DB env vars are missing. Expected AUTH_DB_HOST, AUTH_DB_NAME, AUTH_DB_USER, AUTH_DB_PASSWORD."
    );
  }
  if (!pool) {
    pool = mysql.createPool({
      host: AUTH_DB_HOST,
      port: AUTH_DB_PORT,
      database: AUTH_DB_NAME,
      user: AUTH_DB_USER,
      password: AUTH_DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 3,
      queueLimit: 0,
    });
  }
  await run(META_LEAD_SHEETS_SCHEMA);
  await run(META_LEAD_ROWS_SCHEMA);
  initialized = true;
}

const bool = (value) => value === 1 || value === true || value === "1";
const nullableNumber = (value) => (value === null || value === undefined ? null : Number(value));

/** A database row as the rest of the module wants to read it. */
export function toSheetConfig(row) {
  return {
    id: Number(row.id),
    label: row.label ?? null,
    spreadsheetId: row.spreadsheet_id ?? null,
    tabName: row.tab_name ?? null,
    enabled: bool(row.enabled),
    ib: bool(row.ib),
    sendLeadSource: bool(row.send_lead_source),
    managerId: nullableNumber(row.manager_id),
    language: row.language ?? null,
    status: row.status ?? null,
    tags: row.tags ?? null,
    lastRowCount: Number(row.last_row_count ?? 0),
    lastPolledAt: row.last_polled_at ?? null,
    lastFullReadAt: row.last_full_read_at ?? null,
    lastError: row.last_error ?? null,
    bootstrappedAt: row.bootstrapped_at ?? null,
  };
}

export async function listSheets() {
  const rows = await all(`SELECT * FROM meta_lead_sheets ORDER BY id`);
  return rows.map(toSheetConfig);
}

export async function getSheet(id) {
  const rows = await all(`SELECT * FROM meta_lead_sheets WHERE id = ?`, [id]);
  return rows.length ? toSheetConfig(rows[0]) : null;
}

export async function insertSheet(fields) {
  const result = await run(
    `INSERT INTO meta_lead_sheets
       (label, spreadsheet_id, tab_name, enabled, ib, send_lead_source, manager_id, language, status, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.label, fields.spreadsheetId, fields.tabName || "Sheet1",
      fields.enabled ? 1 : 0, fields.ib ? 1 : 0, fields.sendLeadSource ? 1 : 0,
      fields.managerId ?? null, fields.language ?? null,
      fields.status ?? null, fields.tags ?? null,
    ],
  );
  return { id: Number(result?.insertId) };
}

export async function updateSheet(id, fields) {
  await run(
    `UPDATE meta_lead_sheets
        SET label = ?, tab_name = ?, enabled = ?, ib = ?, send_lead_source = ?,
            manager_id = ?, language = ?, status = ?, tags = ?
      WHERE id = ?`,
    [
      fields.label, fields.tabName || "Sheet1", fields.enabled ? 1 : 0,
      fields.ib ? 1 : 0, fields.sendLeadSource ? 1 : 0, fields.managerId ?? null,
      fields.language ?? null, fields.status ?? null, fields.tags ?? null, id,
    ],
  );
}

export async function markSheetPolled(id, { rowCount, fullRead = false, error = null }) {
  await run(
    `UPDATE meta_lead_sheets
        SET last_row_count = ?,
            last_polled_at = UTC_TIMESTAMP(),
            last_full_read_at = CASE WHEN ? THEN UTC_TIMESTAMP() ELSE last_full_read_at END,
            last_error = ?
      WHERE id = ?`,
    [rowCount, fullRead ? 1 : 0, error, id],
  );
}

export async function markSheetBootstrapped(id) {
  await run(`UPDATE meta_lead_sheets SET bootstrapped_at = UTC_TIMESTAMP() WHERE id = ?`, [id]);
}

/**
 * A sheet whose header moved stops, rather than importing into the wrong
 * columns. Disabling is the loud failure: the tab shows it off with a reason.
 */
export async function disableSheetWithError(id, message) {
  await run(`UPDATE meta_lead_sheets SET enabled = 0, last_error = ? WHERE id = ?`, [message, id]);
}

export async function insertLeadRow(sheetId, lead, status) {
  try {
    const result = await run(
      `INSERT INTO meta_lead_rows
         (sheet_id, meta_lead_id, created_time, first_name, last_name, email, phone,
          country, lead_source, utm_params, campaign_name, adset_name, ad_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sheetId, lead.metaLeadId, lead.createdTime || null,
        lead.firstName || null, lead.lastName || null, lead.email || null,
        lead.phone || null, lead.country, lead.leadSource, lead.utmParams,
        lead.campaignName || null, lead.adsetName || null, lead.adName || null,
        status,
      ],
    );
    return { inserted: true, id: Number(result?.insertId) };
  } catch (error) {
    // The unique key doing its job: this lead is already known.
    if (error?.code === "ER_DUP_ENTRY") return { inserted: false, id: null };
    throw error;
  }
}

/**
 * How long a row may sit in `sending` before it is treated as abandoned.
 *
 * A row is moved to `sending` before the CRM is called, so a worker that dies
 * between the two -- an app pool recycle, which this host does routinely, or
 * the outright stop it suffered on 1 and 3 November -- would otherwise leave
 * the lead in a status nothing ever looks at again, and that the tab's retry
 * button cannot reach either.
 *
 * Ten minutes rather than one: a real send takes a second, but a worker
 * competing for a row still being sent is worse than a lead that arrives ten
 * minutes late. A recovered row is re-sent, and for anything with an email the
 * duplicate check catches a first send that did in fact succeed, so the repeat
 * is recorded as `duplicate` rather than creating a second person.
 */
export const RECLAIM_AFTER_MINUTES = 10;

export const DUE_ROWS_SQL = `
  SELECT * FROM meta_lead_rows
   WHERE (status IN ('pending', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP()))
      OR (status = 'sending'
          AND updated_at <= UTC_TIMESTAMP() - INTERVAL ${RECLAIM_AFTER_MINUTES} MINUTE)
   ORDER BY id
   LIMIT ?
`;

export async function listDueRows(limit = 25) {
  return all(DUE_ROWS_SQL, [limit]);
}

/**
 * Take the row, or discover somebody else already has.
 *
 * IIS overlapped recycling briefly runs two Node workers, each with its own
 * in-process flag, so two sweepers really can read the same row from
 * listDueRows. The claim is what makes that harmless: the UPDATE narrows on
 * the status it expects, and only one caller sees a row change.
 */
export const CLAIM_ROW_SQL = `
  UPDATE meta_lead_rows
     SET status = 'sending', attempts = attempts + 1, updated_at = UTC_TIMESTAMP()
   WHERE id = ?
     AND (status IN ('pending', 'retrying')
          OR (status = 'sending'
              AND updated_at <= UTC_TIMESTAMP() - INTERVAL ${RECLAIM_AFTER_MINUTES} MINUTE))
`;

export async function claimRow(id) {
  const result = await run(CLAIM_ROW_SQL, [id]);
  return Number(result?.affectedRows || 0) === 1;
}

export async function settleRow(id, { status, detail = null, crmUserId = null }) {
  await run(
    `UPDATE meta_lead_rows
        SET status = ?, detail = ?, crm_user_id = ?, next_attempt_at = NULL
      WHERE id = ?`,
    [status, detail, crmUserId, id],
  );
}

export async function deferRow(id, { detail, nextAttemptAt }) {
  await run(
    `UPDATE meta_lead_rows SET status = 'retrying', detail = ?, next_attempt_at = ? WHERE id = ?`,
    [detail, nextAttemptAt, id],
  );
}

export async function requeueRow(id) {
  const result = await run(
    `UPDATE meta_lead_rows
        SET status = 'pending', attempts = 0, next_attempt_at = NULL, detail = NULL
      WHERE id = ? AND status = 'failed'`,
    [id],
  );
  return Number(result?.affectedRows || 0) === 1;
}

export async function listRecentRows(limit = 100) {
  return all(
    `SELECT r.*, s.label AS sheet_label
       FROM meta_lead_rows r
       LEFT JOIN meta_lead_sheets s ON s.id = r.sheet_id
      ORDER BY r.id DESC
      LIMIT ?`,
    [limit],
  );
}

export async function countRowsByStatus() {
  const rows = await all(`SELECT status, COUNT(*) AS cnt FROM meta_lead_rows GROUP BY status`);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.cnt)]));
}
