import mysql from "mysql2/promise";

const AUTH_DB_HOST = process.env.AUTH_DB_HOST;
const AUTH_DB_PORT = Number(process.env.AUTH_DB_PORT || 3306);
const AUTH_DB_NAME = process.env.AUTH_DB_NAME;
const AUTH_DB_USER = process.env.AUTH_DB_USER;
const AUTH_DB_PASSWORD = process.env.AUTH_DB_PASSWORD;

let pool = null;
let initialized = false;

/**
 * Exported so a test can assert on it without a database.
 *
 * The composite UNIQUE key is the whole deduplication strategy: a client
 * legitimately holds one row per funnel stage, and a redelivery of one stage
 * collides at the database rather than in a check-then-act race.
 */
export const SIGNUP_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS signup_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    crm_client_id VARCHAR(255) NOT NULL,
    stage VARCHAR(32) NOT NULL,
    fxbo_unique_id VARCHAR(255) NULL,
    first_name VARCHAR(255) NULL,
    middle_name VARCHAR(255) NULL,
    last_name VARCHAR(255) NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(32) NULL,
    record_type VARCHAR(16) NOT NULL DEFAULT 'lead',
    marketing_consent TINYINT(1) NOT NULL DEFAULT 0,
    is_ib TINYINT(1) NOT NULL DEFAULT 0,
    entity VARCHAR(255) NULL,
    source VARCHAR(255) NULL,
    language VARCHAR(64) NULL,
    utm_source VARCHAR(255) NULL,
    utm_medium VARCHAR(255) NULL,
    utm_campaign VARCHAR(255) NULL,
    referer VARCHAR(512) NULL,
    full_link VARCHAR(1024) NULL,
    fbc VARCHAR(255) NULL,
    whatsapp_request_id VARCHAR(64) NULL,
    meta_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    meta_detail TEXT NULL,
    meta_attempts INT NOT NULL DEFAULT 0,
    meta_next_attempt_at DATETIME NULL,
    whatsapp_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    whatsapp_message_id VARCHAR(64) NULL,
    whatsapp_detail TEXT NULL,
    whatsapp_attempts INT NOT NULL DEFAULT 0,
    whatsapp_next_attempt_at DATETIME NULL,
    brevo_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    brevo_detail TEXT NULL,
    brevo_attempts INT NOT NULL DEFAULT 0,
    brevo_next_attempt_at DATETIME NULL,
    raw_payload LONGTEXT NULL,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_signup_events_client_stage (crm_client_id, stage)
  )
`;

/** Exported so a test can pin each parameter to its column by name rather
 *  than by position — a swap between two adjacent columns is otherwise
 *  invisible, and `fbc` and `whatsapp_request_id` sit next to each other. */
export const INSERT_COLUMNS = [
  "crm_client_id",
  "stage",
  "fxbo_unique_id",
  "first_name",
  "middle_name",
  "last_name",
  "email",
  "phone",
  "record_type",
  "marketing_consent",
  "is_ib",
  "entity",
  "source",
  "language",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "referer",
  "full_link",
  "fbc",
  "whatsapp_request_id",
  "meta_status",
  "meta_detail",
  "whatsapp_status",
  "whatsapp_detail",
  "brevo_status",
  "brevo_detail",
  "received_at",
  "raw_payload",
];

// The width of each VARCHAR column, read from the schema text so the two cannot
// drift. A value longer than its column would make MySQL reject the whole row.
const COLUMN_WIDTHS = Object.fromEntries(
  [...SIGNUP_EVENTS_SCHEMA.matchAll(/^\s+(\w+) VARCHAR\((\d+)\)/gm)].map((m) => [m[1], Number(m[2])])
);

const bool = (v) => (v ? 1 : 0);
// Cut by code point, which is how MySQL counts VARCHAR length in utf8mb4.
const fit = (v, column) => Array.from(String(v)).slice(0, COLUMN_WIDTHS[column]).join("");
const str = (v, column) => (v === undefined || v === null || v === "" ? null : fit(v, column));

// fbc and the provider's message id are never cut, because a cut id is a wrong id, not
// a shorter one. A cut click id is attribution that silently never matches. An uncut
// over-width message id would fail the UPDATE that records a send already made, which
// leaves the row due for a second welcome. Over-width writes NULL and warns instead; the
// event, and the status it records, are still stored.
// whatsapp_request_id is the one identifier that is cut rather than NULLed: the worker
// reads it back from the row on every attempt, and a NULL would mint a fresh id each time.
const identifier = (v, column) => {
  if (v === undefined || v === null || v === "") return null;
  const text = String(v);
  const length = Array.from(text).length;
  if (length > COLUMN_WIDTHS[column]) {
    console.warn(
      `[crm-events] ${column} is ${length} characters, over its ${COLUMN_WIDTHS[column]}-character column; storing NULL`
    );
    return null;
  }
  return text;
};

/**
 * The parameters for the INSERT, in INSERT_COLUMNS order.
 *
 * Pure except in one place: an over-width fbc is written as NULL and `console.warn`
 * is called with the column name and the length seen. The warning appears without
 * the caller having to arrange for it, which is the point of it.
 *
 * `receivedAt` is the Node clock. The column default is the database clock, and a
 * mismatch between the two would shift every event_time, so Node writes it.
 */
export function buildInsertParams(fields = {}, derived = {}, rawPayload = null, invalidReason = null, receivedAt = new Date()) {
  let serialised;
  try {
    serialised = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload ?? {});
  } catch {
    serialised = '{"unserialisable":true}';
  }

  // An invalid payload is stored as invalid in the same statement that stores it,
  // so no sweeper can send it in between. A valid payload is written as pending.
  const invalid = invalidReason !== null && invalidReason !== undefined;
  const status = invalid ? "invalid" : "pending";
  const detail = invalid ? String(invalidReason).slice(0, 500) : null;

  return [
    // Never cut: this is the dedupe key. insertSignupEvent refuses an over-width one
    // before it gets here, because NULL is not an option on a NOT NULL key either.
    String(fields.crmClientId ?? ""),
    // Never cut, for the same reason as crm_client_id: insertSignupEvent refuses an
    // over-width key before it reaches here.
    String(fields.stage ?? ""),
    str(fields.fxboUniqueId, "fxbo_unique_id"),
    str(fields.firstName, "first_name"),
    str(fields.middleName, "middle_name"),
    str(fields.lastName, "last_name"),
    str(fields.email, "email"),
    str(fields.phone, "phone"),
    fit(fields.recordType ?? "lead", "record_type"),
    bool(fields.marketingConsent),
    bool(fields.isIb),
    str(fields.entity, "entity"),
    str(fields.source, "source"),
    str(fields.language, "language"),
    str(fields.utmSource, "utm_source"),
    str(fields.utmMedium, "utm_medium"),
    str(fields.utmCampaign, "utm_campaign"),
    str(fields.referer, "referer"),
    str(fields.fullLink, "full_link"),
    identifier(derived.fbc, "fbc"),
    str(derived.whatsappRequestId, "whatsapp_request_id"),
    status,
    detail,
    status,
    detail,
    status,
    detail,
    receivedAt,
    serialised,
  ];
}

function hasDbConfig() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_NAME && AUTH_DB_USER && AUTH_DB_PASSWORD);
}

async function run(sql, params = []) {
  if (!pool) throw new Error("CRM events DB pool is not initialized.");
  const [result] = await pool.query(sql, params);
  return result;
}

async function all(sql, params = []) {
  if (!pool) throw new Error("CRM events DB pool is not initialized.");
  const [rows] = await pool.query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

export async function initCrmSignupStore() {
  if (initialized) return;
  if (!hasDbConfig()) {
    throw new Error(
      "CRM events DB env vars are missing. Expected AUTH_DB_HOST, AUTH_DB_NAME, AUTH_DB_USER, AUTH_DB_PASSWORD."
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
      connectionLimit: 5,
      queueLimit: 0,
    });
  }
  await run(SIGNUP_EVENTS_SCHEMA);
  initialized = true;
}

/**
 * The click id this client already has, if any.
 *
 * This is what freezes it. The fbc is assembled once, at whichever stage
 * arrives first, and every later stage reuses the exact string -- recomputing
 * it would give Meta a different click identity for the same person at each
 * step, with no error anywhere.
 */
export async function findExistingFbc(crmClientId) {
  const rows = await all(
    `SELECT fbc FROM signup_events
      WHERE crm_client_id = ? AND fbc IS NOT NULL AND fbc <> ''
      ORDER BY received_at ASC, id ASC
      LIMIT 1`,
    [String(crmClientId ?? "")]
  );
  return rows.length ? String(rows[0].fbc) : "";
}

/**
 * The dedupe key is (crm_client_id, stage). Neither half is ever cut: two values that
 * cut to one would collide into one row. An over-width value is refused here, before
 * any statement runs, so the error names the column. This does not depend on the
 * server's sql_mode, which a host move could change.
 */
const dedupeKey = (fields) => ({
  crm_client_id: String(fields?.crmClientId ?? ""),
  stage: String(fields?.stage ?? ""),
});

function refuseOverWidthDedupeKey(fields) {
  for (const [column, value] of Object.entries(dedupeKey(fields))) {
    const over = Array.from(value).length;
    if (over > COLUMN_WIDTHS[column]) {
      throw new Error(
        `${column} is ${over} characters, over its ${COLUMN_WIDTHS[column]}-character column; the event is refused, not stored`
      );
    }
  }
}

/**
 * Stores one event. A redelivery of a stored client and stage is a duplicate-key
 * error from MySQL, which is returned as `inserted: false` rather than thrown.
 *
 * This is a plain INSERT on purpose. `ON DUPLICATE KEY UPDATE` reports an
 * affected-row count that depends on the connection's CLIENT_FOUND_ROWS flag, so
 * `affectedRows === 1` would be true for a duplicate too. The error code does not
 * depend on any connection setting.
 *
 * Pass `invalidReason` and all three actions are stored as `invalid` in this same
 * statement. There is no window in which a sweeper could send the payload, which
 * matters for an FXBO test press.
 */
export async function insertSignupEvent(fields, derived, rawPayload, invalidReason = null) {
  refuseOverWidthDedupeKey(fields);
  const placeholders = INSERT_COLUMNS.map(() => "?").join(", ");
  try {
    const result = await run(
      `INSERT INTO signup_events (${INSERT_COLUMNS.join(", ")})
       VALUES (${placeholders})`,
      buildInsertParams(fields, derived, rawPayload, invalidReason)
    );
    return { inserted: true, id: result?.insertId ?? null };
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") return { inserted: false, id: null };
    throw error;
  }
}

/**
 * Rows due for an action. This takes NO lock and claims NOTHING: it is a plain
 * SELECT. Two concurrent callers would both receive the same rows and both
 * send -- duplicate WhatsApp welcomes to real clients.
 *
 * The only thing preventing that today is single-process execution, guarded by
 * the in-process `sweeping` flag in the worker. That is not a hypothetical
 * boundary on this host: IIS overlapped app-pool recycling can briefly run two
 * Node workers, each with its own `sweeping` flag, so two sweepers can overlap.
 * Anyone adding a second worker process, or a second app pool that runs the
 * sweeper, must first add a real claim here (e.g. SELECT ... FOR UPDATE SKIP
 * LOCKED inside a transaction, or an atomic status flip). The name is kept
 * deliberately so this constraint is met where the function is defined.
 */
export async function claimDueEvents(limit = 25, now = new Date()) {
  return all(
    `SELECT * FROM signup_events
      WHERE (meta_status     IN ('pending','retrying') AND (meta_next_attempt_at     IS NULL OR meta_next_attempt_at     <= ?))
         OR (whatsapp_status IN ('pending','retrying') AND (whatsapp_next_attempt_at IS NULL OR whatsapp_next_attempt_at <= ?))
         OR (brevo_status    IN ('pending','retrying') AND (brevo_next_attempt_at    IS NULL OR brevo_next_attempt_at    <= ?))
      ORDER BY received_at ASC
      LIMIT ?`,
    [now, now, now, Number(limit) || 25]
  );
}

export async function updateMetaStatus(id, { status, detail, attempts, nextAttemptAt }) {
  await run(
    `UPDATE signup_events
        SET meta_status = ?, meta_detail = ?, meta_attempts = ?, meta_next_attempt_at = ?
      WHERE id = ?`,
    [String(status), String(detail ?? "").slice(0, 500) || null, Number(attempts) || 0, nextAttemptAt ?? null, id]
  );
}

export async function updateWhatsappStatus(id, { status, messageId, detail, attempts, nextAttemptAt }) {
  await run(
    `UPDATE signup_events
        SET whatsapp_status = ?, whatsapp_message_id = ?, whatsapp_detail = ?,
            whatsapp_attempts = ?, whatsapp_next_attempt_at = ?
      WHERE id = ?`,
    [
      String(status),
      identifier(messageId, "whatsapp_message_id"),
      String(detail ?? "").slice(0, 500) || null,
      Number(attempts) || 0,
      nextAttemptAt ?? null,
      id,
    ]
  );
}

export async function updateBrevoStatus(id, { status, detail, attempts, nextAttemptAt }) {
  await run(
    `UPDATE signup_events
        SET brevo_status = ?, brevo_detail = ?, brevo_attempts = ?, brevo_next_attempt_at = ?
      WHERE id = ?`,
    [String(status), String(detail ?? "").slice(0, 500) || null, Number(attempts) || 0, nextAttemptAt ?? null, id]
  );
}

/**
 * Every event since a date, newest first, capped.
 *
 * The overview aggregates in JavaScript rather than SQL: the volume is low
 * (a few hundred rows in a 30-day window) and a pure function is testable
 * without a database, which GROUP BY is not.
 */
export async function listEventsSince(since, cap = 2000) {
  return all(
    `SELECT id, crm_client_id, stage, first_name, last_name, email, phone, record_type, source,
            meta_status, meta_detail, meta_attempts,
            whatsapp_status, whatsapp_detail, whatsapp_attempts,
            brevo_status, brevo_detail, brevo_attempts, received_at
       FROM signup_events
      WHERE received_at >= ?
      ORDER BY received_at DESC
      LIMIT ?`,
    [since, Number(cap) || 2000]
  );
}
