import mysql from "mysql2/promise";
import { maskEmail, maskPhone } from "./normalise.js";
import { SETTLED_STATUSES } from "./settled.js";

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
    is_lead_raw VARCHAR(32) NULL,
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
    scrubbed_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_signup_events_client_stage (crm_client_id, stage),
    KEY idx_signup_events_retention (scrubbed_at, received_at)
  )
`;

/**
 * The retention index, named here because the guarded ALTER below adds the same
 * one to a table that predates it.
 *
 * `scrubbed_at` leads because it is the selective half: a row is scrubbed within
 * about a minute of arriving, so the unscrubbed set stays a handful however large
 * the table grows, while "older than thirty days" grows to cover nearly all of
 * it. MySQL reaches the NULLs through the leading column and finishes the
 * received_at range inside the index, so the backstop never reads a scrubbed row.
 */
const RETENTION_INDEX = "idx_signup_events_retention";

/**
 * What was added after the table's first version.
 *
 * `signup_events` has never been deployed, so a new install gets both columns and
 * the index from SIGNUP_EVENTS_SCHEMA and runs none of this. A table someone
 * created while testing predates them, and silently lacking one is not a loud
 * failure: a missing `scrubbed_at` leaves the scrub nowhere to record itself, and
 * a missing `is_lead_raw` leaves CUTOVER step 5 nothing to read. Guarded on
 * information_schema, following docusign/store.js.
 */
export const SIGNUP_EVENTS_ADDED_COLUMNS = [
  ["is_lead_raw", `ALTER TABLE signup_events ADD COLUMN is_lead_raw VARCHAR(32) NULL`],
  ["scrubbed_at", `ALTER TABLE signup_events ADD COLUMN scrubbed_at DATETIME NULL`],
];

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
  "is_lead_raw",
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
    // The literal FXBO put in %client_is_lead%, verbatim, because the derived
    // record_type beside it cannot be read backwards: everything unrecognised
    // derives to "lead". It is the one thing raw_payload was kept for -- CUTOVER
    // step 5 reads it to learn what the placeholder really contains -- and it is
    // a flag, not client data, so the scrub leaves it alone. Cut rather than
    // refused: a literal longer than the column is already not a literal we
    // would add to CLIENT_LITERALS, and seeing its first 32 characters beats
    // storing nothing.
    str(fields.isLeadRaw, "is_lead_raw"),
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
  await addWhatIsMissing();
  initialized = true;
}

/** How many rows information_schema reported, treating anything unreadable as none:
 *  adding a column that is already there fails loudly, which is the safe direction. */
const counted = (rows) => Number(rows?.[0]?.cnt || 0);

async function addWhatIsMissing() {
  for (const [column, statement] of SIGNUP_EVENTS_ADDED_COLUMNS) {
    const rows = await all(
      `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_events' AND COLUMN_NAME = ?`,
      [column]
    );
    if (counted(rows) === 0) await run(statement);
  }
  // Guarded the same way rather than with `CREATE INDEX IF NOT EXISTS`, which
  // MySQL 8 does not accept -- it is MariaDB syntax, and this host is MySQL.
  const rows = await all(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signup_events' AND INDEX_NAME = ?`,
    [RETENTION_INDEX]
  );
  if (counted(rows) === 0) {
    await run(`ALTER TABLE signup_events ADD KEY ${RETENTION_INDEX} (scrubbed_at, received_at)`);
  }
}

/**
 * The click id this client already has, if any.
 *
 * This is what freezes it. The fbc is assembled once, at the first stage whose
 * full_link carries an fbclid -- a stage that arrives earlier without one
 * stores nothing here -- and every later stage reuses the exact string.
 * Recomputing it would give Meta a different click identity for the same person
 * at each step, with no error anywhere.
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

/**
 * The `code` on the error thrown for a dedupe key that can never be stored, in the
 * same shape as the `ER_DUP_ENTRY` the insert below tells apart by `error.code`.
 *
 * The distinction is the caller's to act on. Every other error this file throws is
 * a failure of the moment (a lock timeout, a dropped connection, a pool that is not
 * up yet), and a redelivery of the same payload can succeed. This one cannot: the
 * same key is over the same width on every attempt, so asking FXBO to redeliver only
 * spends its retries discovering that.
 */
export const UNSTORABLE_KEY_CODE = "CRM_EVENT_KEY_UNSTORABLE";

function refuseOverWidthDedupeKey(fields) {
  for (const [column, value] of Object.entries(dedupeKey(fields))) {
    const over = Array.from(value).length;
    if (over > COLUMN_WIDTHS[column]) {
      throw Object.assign(
        new Error(
          `${column} is ${over} characters, over its ${COLUMN_WIDTHS[column]}-character column; the event is refused, not stored`
        ),
        { code: UNSTORABLE_KEY_CODE }
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
 * The rows that look due for an action. This takes no lock: it is a plain
 * SELECT, and two concurrent callers do receive the same rows.
 *
 * That is safe because the claim is one statement later, in the three writers
 * below: a sweeper sends only after its own pre-send UPDATE has reported that
 * it, and not the other one, moved the row. IIS overlapped app-pool recycling
 * briefly runs two Node workers, each with its own in-process `sweeping` flag,
 * so this is not a hypothetical boundary on this host -- but a second reader
 * here is harmless where a second sender is not. Anything new that sends from
 * this list must take the same claim.
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

/**
 * The precondition that turns a pre-send write into the claim on a row.
 *
 * Both halves are needed, and each covers what the other cannot:
 *
 *   `<action>_status IN ('pending','retrying')` -- the action is still ours to
 *   attempt. One that another sweeper has already settled (`sent`, `rejected`,
 *   `failed`, `skipped`, `invalid`) matches nothing, so a stale worker cannot
 *   overwrite `sent` with `retrying` and leave the next sweep a second send.
 *
 *   the clock is not in the future -- the pre-send write itself moves the clock
 *   five minutes out, and `retrying` is claimable again, so without this the
 *   loser of a race would match the winner's own fresh row and send as well. On
 *   the final attempt the pre-send write stores `failed` with no clock, and
 *   there it is the status half that stops the loser.
 *
 * `claimAt` is the sweeper's own "now", the instant claimDueEvents compared
 * against. A write with NO claimAt is not a claim: it records the outcome of a
 * send already made, on a row this worker owns, and has to land whatever status
 * the claim left behind -- including the `failed` of a final attempt.
 */
function claimClause(action, claimAt) {
  if (claimAt === null || claimAt === undefined) return { sql: "", params: [] };
  return {
    sql: `
        AND ${action}_status IN ('pending','retrying')
        AND (${action}_next_attempt_at IS NULL OR ${action}_next_attempt_at <= ?)`,
    params: [claimAt],
  };
}

// The settled statuses as a SQL list, built from the one JavaScript list so the
// statement and the worker cannot come to disagree about what "settled" means.
const SETTLED_LIST = SETTLED_STATUSES.map((status) => `'${status}'`).join(",");

/**
 * The precondition that makes a scrub correct whatever its caller believes.
 *
 * Same lesson as claimClause above: a precondition that matters belongs in the
 * statement, not in the caller's copy of the row. The worker reads the three
 * statuses out of its own in-memory row, and during an overlapped IIS recycle
 * two workers split the three claims between them -- so NEITHER copy ever shows
 * all three settled, and a scrub decided by the copy alone never happens. The
 * row then holds a name, an email and a phone until the thirty-day backstop, in
 * precisely the case the policy asks to reduce to a minute.
 *
 * With the predicate here, both workers may attempt it: the one whose statuses
 * are not all in the table yet matches no row and writes nothing, and whichever
 * of them finishes last matches and scrubs. It is read against the row as the
 * table actually holds it, which is the only copy that has seen all three.
 *
 * Unlike claimClause there is no claim moment to pass: this is not a claim on an
 * action, it takes nothing away from another worker, and a second attempt is a
 * no-op rather than a loss. `scrubbed_at IS NULL` is the other half, and it is
 * the statement's, not this helper's: the two scrubs share it for a different
 * reason (the audit trail must not move).
 */
function settledClause(action) {
  return `${action}_status IN (${SETTLED_LIST})`;
}

/** The same list negated: the destinations the backstop has to settle itself. */
function unsettledClause(action) {
  return `${action}_status NOT IN (${SETTLED_LIST})`;
}

/**
 * How many rows the UPDATE matched, or null when the driver did not say.
 *
 * mysql2 connects with CLIENT_FOUND_ROWS, under which `affectedRows` counts the
 * rows MATCHED rather than the rows whose values changed. That is what a claim
 * needs: re-writing the identical status and attempt count is still a won
 * claim. (The same flag is why insertSignupEvent tells a duplicate apart by
 * error code and not by this number.) A result carrying no count is not a lost
 * claim but a driver that did not report one, and reading it as lost would stop
 * every send.
 */
const matchedRows = (result) => (typeof result?.affectedRows === "number" ? result.affectedRows : null);

/**
 * What a `*_detail` column is allowed to hold.
 *
 * Masked first, then cut. The text is usually the provider's own message, and a
 * provider quotes back what we sent it -- Brevo's 400 names the email address
 * from the request body -- so spec section 13's masking has to hold here and
 * not only in the log line: this column is read straight into the admin table.
 * Cutting first could leave half an address whole. One function for all three
 * writers, so a fourth destination cannot forget.
 */
export function redactDetail(detail) {
  return (
    String(detail ?? "")
      // Any run without whitespace that carries an @ is an address, whatever
      // punctuation surrounds it; the module's own masking decides what is left.
      .replace(/\S*@\S*/g, (token) => maskEmail(token))
      // Eight digits is already an account or phone number. Shorter runs are
      // HTTP statuses, attempt counts and provider error codes, which are the
      // whole diagnostic value of the column.
      .replace(/\d{8,}/g, (digits) => maskPhone(digits))
  );
}

const detailFor = (detail) => redactDetail(detail).slice(0, 500) || null;

/**
 * The three action writers. Each writes only its own action's columns, and each
 * returns how many rows it matched.
 *
 * Pass `claimAt` and the write is a claim (see claimClause): a 0 back means
 * another sweeper owns this action and the caller must send nothing. Leave it
 * out and the write records the outcome of a send already made.
 */
export async function updateMetaStatus(id, { status, detail, attempts, nextAttemptAt }, claimAt = null) {
  const claim = claimClause("meta", claimAt);
  const result = await run(
    `UPDATE signup_events
        SET meta_status = ?, meta_detail = ?, meta_attempts = ?, meta_next_attempt_at = ?
      WHERE id = ?${claim.sql}`,
    [
      String(status),
      detailFor(detail),
      Number(attempts) || 0,
      nextAttemptAt ?? null,
      id,
      ...claim.params,
    ]
  );
  return matchedRows(result);
}

export async function updateWhatsappStatus(id, { status, messageId, detail, attempts, nextAttemptAt }, claimAt = null) {
  const claim = claimClause("whatsapp", claimAt);
  const result = await run(
    `UPDATE signup_events
        SET whatsapp_status = ?, whatsapp_message_id = ?, whatsapp_detail = ?,
            whatsapp_attempts = ?, whatsapp_next_attempt_at = ?
      WHERE id = ?${claim.sql}`,
    [
      String(status),
      identifier(messageId, "whatsapp_message_id"),
      detailFor(detail),
      Number(attempts) || 0,
      nextAttemptAt ?? null,
      id,
      ...claim.params,
    ]
  );
  return matchedRows(result);
}

export async function updateBrevoStatus(id, { status, detail, attempts, nextAttemptAt }, claimAt = null) {
  const claim = claimClause("brevo", claimAt);
  const result = await run(
    `UPDATE signup_events
        SET brevo_status = ?, brevo_detail = ?, brevo_attempts = ?, brevo_next_attempt_at = ?
      WHERE id = ?${claim.sql}`,
    [
      String(status),
      detailFor(detail),
      Number(attempts) || 0,
      nextAttemptAt ?? null,
      id,
      ...claim.params,
    ]
  );
  return matchedRows(result);
}

/**
 * The columns that are the client, as opposed to the statistics the table exists
 * for. Exported so a test can pin the list: both scrubs below are built from it,
 * so a column cannot be in one and missing from the other.
 *
 * The reason any of this is stored at all is that the endpoint answers FXBO
 * immediately and sends afterwards, so the phone and the email must survive from
 * receipt until all three destinations settle, retries included. After that
 * nothing needs them -- FXBO is the system of record for who a client is, and
 * this table only has to say whether client 48217 got their welcome and to
 * recognise FXBO's redeliveries.
 *
 * Two absences are deliberate, and both are load-bearing:
 *
 *   `fbc` stays. It is captured at signup and reused weeks later for the
 *   first-deposit conversion, so scrubbing it would send every later conversion
 *   to Meta with no ad attached.
 *
 *   `crm_client_id` stays. It is the dedupe key; without it FXBO's redeliveries
 *   insert again and send a second welcome.
 *
 * `entity`, `source` and the three `utm_*` columns stay too: they are segmentation,
 * not identity, and they are the statistics worth keeping. `full_link` and
 * `referer` go, because `full_link` carries the `fbclid` and the whole query
 * string verbatim and both are redundant once `fbc` and the `utm_*` columns have
 * been extracted from them.
 */
export const SCRUB_COLUMNS = [
  "first_name",
  "middle_name",
  "last_name",
  "email",
  "phone",
  "full_link",
  "referer",
  "raw_payload",
];

const SCRUB_SET = SCRUB_COLUMNS.map((column) => `${column} = NULL`).join(", ");

/**
 * One row's client data, removed, once the table says all three have settled.
 *
 * The settled predicate is the statement's own (see settledClause): the worker
 * decides whether to try from its in-memory copy of the row, and two workers
 * sharing a recycle window hold two copies that each saw one claim. Neither copy
 * is the truth; the row is. So both may attempt this, the attempt from the copy
 * whose siblings are still `retrying` in the table matches nothing, and whichever
 * worker finishes last scrubs. Nothing is lost by attempting: this takes no
 * claim, and a second attempt is a no-op.
 *
 * `scrubbed_at IS NULL` is what makes that no-op silent rather than a second
 * timestamp: the column is the audit trail, and overwriting it would move the
 * moment the data actually went. It also means the two scrubs cannot fight -- the
 * backstop below skips what this has already done, and the other way round.
 *
 * Returns how many rows it matched, so a caller can tell "scrubbed now" from
 * "scrubbed already".
 */
export async function scrubSignupEvent(id, at = new Date()) {
  const result = await run(
    `UPDATE signup_events
        SET ${SCRUB_SET}, scrubbed_at = ?
      WHERE id = ?
        AND scrubbed_at IS NULL
        AND ${settledClause("meta")}
        AND ${settledClause("whatsapp")}
        AND ${settledClause("brevo")}`,
    [at, id]
  );
  return matchedRows(result);
}

/**
 * The rows that never sent anything and never will, removed whole.
 *
 * An invalid row is an unparseable payload or an FXBO "Test webhook" press. All
 * three statuses are written `invalid` in the insert itself, so this is the shape
 * that identifies them; a row where only some are invalid is not one of these and
 * is deliberately left alone.
 *
 * They are the only rows that keep their `raw_payload` for a while, because they
 * are the rows CUTOVER step 5 reads.
 */
export async function deleteInvalidSignupEvents(receivedBefore) {
  const result = await run(
    `DELETE FROM signup_events
      WHERE meta_status = 'invalid'
        AND whatsapp_status = 'invalid'
        AND brevo_status = 'invalid'
        AND received_at < ?`,
    [receivedBefore]
  );
  return matchedRows(result);
}

/** The three destinations, in the order the tab shows them. */
const DESTINATIONS = ["meta", "whatsapp", "brevo"];

/**
 * What an unsent destination is left saying when the backstop takes its data.
 *
 * `failed` is the status: it is terminal, and the vocabulary has nothing better.
 * `skipped` would be wrong -- a skip is a deliberate decision not to send, and
 * this was not a decision. The detail is what has to carry the difference to
 * whoever reads the tab, where it prints under the status: this one was never
 * attempted, as against attempted and refused.
 */
const UNSENDABLE_DETAIL = "not attempted: the client data this send needed was scrubbed";

/**
 * The backstop: every row still unscrubbed past its window, scrubbed regardless
 * of what its statuses say, and every destination it leaves unsendable settled.
 *
 * The settle path scrubs a row about a minute after signup. This catches the ones
 * it never reaches -- a worker left off by CRM_EVENTS_WORKER_ENABLED, or a row
 * whose scrub could not be written in the moment it settled. Nothing claims those
 * rows again, so without this they would keep a name, an email and a phone for
 * ever.
 *
 * And the statuses have to be settled with them, because the send guard refuses
 * a scrubbed row for ever while nothing writes a status saying so. Such a row
 * reads `pending` in the destination counters for the rest of the table's life,
 * and `pending` piling up is the single signal that means the dispatch worker is
 * dead -- one row stuck there for ever is enough to make the number an operator
 * would check unusable.
 *
 * Four statements rather than one UPDATE carrying an IF() per column. Atomicity
 * buys nothing here (hourly, against thirty-day-old rows, and a pass that dies
 * half way leaves the row unscrubbed for the next hour to finish), and the four
 * read as what they are. The IF() form also has a trap: MySQL evaluates an
 * UPDATE's assignments left to right and a later one sees the new value, so
 * `<action>_detail = IF(<action>_status IN (...), ...)` would be deciding against
 * the status the same statement had just overwritten -- a mistake no fake pool
 * could show us. Each statement here names one destination and skips the rows
 * where that one is already settled, so a `sent` keeps both its status and its
 * detail while its unsent sibling is settled beside it.
 *
 * Settling runs BEFORE the scrub, and not the other way round: a pass that dies
 * between the two leaves a row unscrubbed, which `scrubbed_at IS NULL` brings
 * back here next hour. Scrubbing first would leave a scrubbed row with `pending`
 * statuses and nothing that ever selects it again -- the very row this exists to
 * stop existing.
 *
 * Returns how many rows were scrubbed, which is what the sweep reports.
 */
export async function scrubStaleSignupEvents(receivedBefore, at = new Date()) {
  for (const action of DESTINATIONS) {
    await run(
      `UPDATE signup_events
          SET ${action}_status = 'failed', ${action}_detail = ?
        WHERE scrubbed_at IS NULL
          AND received_at < ?
          AND ${unsettledClause(action)}`,
      [UNSENDABLE_DETAIL, receivedBefore]
    );
  }

  const result = await run(
    `UPDATE signup_events
        SET ${SCRUB_SET}, scrubbed_at = ?
      WHERE scrubbed_at IS NULL AND received_at < ?`,
    [at, receivedBefore]
  );
  return matchedRows(result);
}

/**
 * Every event since a date, newest first, capped.
 *
 * This feeds the events TABLE and nothing else. The counts beside it come from
 * countEventsSince, grouped in SQL and never capped: counting this capped list
 * in JavaScript is exactly the silent undercount Task 9 removed, so nothing
 * aggregated belongs here.
 */
export async function listEventsSince(since, cap = 2000) {
  return all(
    `SELECT id, crm_client_id, stage, first_name, last_name, email, phone, record_type, source,
            meta_status, meta_detail, meta_attempts,
            whatsapp_status, whatsapp_detail, whatsapp_attempts,
            brevo_status, brevo_detail, brevo_attempts, received_at, scrubbed_at
       FROM signup_events
      WHERE received_at >= ?
      ORDER BY received_at DESC
      LIMIT ?`,
    [since, Number(cap) || 2000]
  );
}

/**
 * Event counts per (stage, status triple) since a date, over the whole window.
 *
 * Grouped in SQL and never capped: the result is bounded by the number of distinct
 * status combinations, not by how many events the window holds. A count read from
 * the capped list would undercount a busy month without saying so.
 */
export async function countEventsSince(since) {
  return all(
    `SELECT stage, meta_status, whatsapp_status, brevo_status, COUNT(*) AS n
       FROM signup_events
      WHERE received_at >= ?
      GROUP BY stage, meta_status, whatsapp_status, brevo_status`,
    [since]
  );
}

/**
 * The newest received_at in the whole table, ignoring any window. Null when the
 * table is empty. Health reads this, not the window, so a short window cannot make
 * an event that arrived inside the stale threshold look like silence.
 */
export async function latestEventReceivedAt() {
  const rows = await all(`SELECT MAX(received_at) AS latest FROM signup_events`);
  return rows[0]?.latest ?? null;
}

/**
 * The newest received_at for each stage, over the whole table: one row per stage that
 * has ever fired. A stage with no row has never fired, which is not the same as a stage
 * that has gone quiet. Health reads the two differently, so the distinction is kept here.
 */
export async function latestReceivedAtByStage() {
  return all(`SELECT stage, MAX(received_at) AS latest FROM signup_events GROUP BY stage`);
}
