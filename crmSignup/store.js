import mysql from "mysql2/promise";
import { maskEmail, maskPhone } from "./normalise.js";
import { SETTLED_STATUSES, SCRUBBABLE_STATUSES, REQUEUEABLE_STATUSES } from "./settled.js";
// OpenAI's own bound on how old an event may be, imported so that the resend's
// promise and the send's own skip decision are the same rule (see sendableWindow).
import { OPENAI_MAX_EVENT_AGE_MS, OPENAI_MAX_EVENT_SKEW_MS } from "./openai.js";

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
    oppref VARCHAR(512) NULL,
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
    openai_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    openai_detail TEXT NULL,
    openai_attempts INT NOT NULL DEFAULT 0,
    openai_next_attempt_at DATETIME NULL,
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
  // The ChatGPT Ads destination, added 2026-10-14. `oppref` is OpenAI's click
  // identifier and the four after it are the fourth destination's own statistics,
  // in the same shape and with the same defaults as the other three -- the
  // default matters most: a table altered without it would hold NULL where the
  // claim and the scrub both read a word, and a NULL is in no status list at all,
  // so such a row would never be claimed and never be scrubbed.
  ["oppref", `ALTER TABLE signup_events ADD COLUMN oppref VARCHAR(512) NULL`],
  [
    "openai_status",
    `ALTER TABLE signup_events ADD COLUMN openai_status VARCHAR(16) NOT NULL DEFAULT 'pending'`,
  ],
  ["openai_detail", `ALTER TABLE signup_events ADD COLUMN openai_detail TEXT NULL`],
  ["openai_attempts", `ALTER TABLE signup_events ADD COLUMN openai_attempts INT NOT NULL DEFAULT 0`],
  ["openai_next_attempt_at", `ALTER TABLE signup_events ADD COLUMN openai_next_attempt_at DATETIME NULL`],
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
  "oppref",
  "whatsapp_request_id",
  "meta_status",
  "meta_detail",
  "whatsapp_status",
  "whatsapp_detail",
  "brevo_status",
  "brevo_detail",
  "openai_status",
  "openai_detail",
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
    // Never cut, for exactly the reason fbc is not: a cut click id is a wrong
    // click id, and OpenAI would accept every conversion carrying it and match
    // none of them. Unlike fbc there is no wrapper around it, so the raw value is
    // the whole of what is frozen here.
    identifier(derived.oppref, "oppref"),
    str(derived.whatsappRequestId, "whatsapp_request_id"),
    status,
    detail,
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
 * The click ids this client already has, if any: Meta's `fbc` and OpenAI's
 * `oppref`.
 *
 * This is what freezes them. Each is captured once, at the first stage whose
 * full_link carried it -- a stage that arrived earlier without one stores
 * nothing -- and every later stage reuses the exact string. Recomputing per
 * stage would give the platform a different click identity for the same person
 * at each step, with no error anywhere; and `full_link` is scrubbed about a
 * minute after signup, so by the first deposit there is nothing left to parse
 * (the deposit is a different row, arriving weeks later, whose own full_link is
 * normally empty because that visit is not an ad click).
 *
 * **Two scalar subqueries, not two columns off one row, and not two round
 * trips.** The earliest row carrying an `fbclid` need not be the one carrying an
 * `oppref`: a client can click a Meta ad, come back through a ChatGPT ad, and
 * reach the funnel on either. "The first non-empty value stored for this client"
 * is therefore a question per column, which is what each subquery asks. It is
 * still one statement and one round trip, because the webhook answers FXBO
 * inside this request.
 */
export async function findExistingClickIds(crmClientId) {
  const id = String(crmClientId ?? "");
  const rows = await all(
    `SELECT
       (SELECT fbc FROM signup_events
          WHERE crm_client_id = ? AND fbc IS NOT NULL AND fbc <> ''
          ORDER BY received_at ASC, id ASC
          LIMIT 1) AS fbc,
       (SELECT oppref FROM signup_events
          WHERE crm_client_id = ? AND oppref IS NOT NULL AND oppref <> ''
          ORDER BY received_at ASC, id ASC
          LIMIT 1) AS oppref`,
    [id, id]
  );
  // A client with neither gets one row of two NULLs, which is the common case:
  // most signups are organic and carry no click at all.
  const frozen = rows[0] ?? {};
  return {
    fbc: frozen.fbc ? String(frozen.fbc) : "",
    oppref: frozen.oppref ? String(frozen.oppref) : "",
  };
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
 * Pass `invalidReason` and every destination is stored as `invalid` in this same
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
 * That is safe because the claim is one statement later, in the four writers
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
         OR (openai_status   IN ('pending','retrying') AND (openai_next_attempt_at   IS NULL OR openai_next_attempt_at   <= ?))
      ORDER BY received_at ASC
      LIMIT ?`,
    [now, now, now, now, Number(limit) || 25]
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

// The two vocabularies as SQL lists, each built from the one JavaScript list so
// a statement and the worker cannot come to disagree about what either word
// means. They are different sets and the clauses below are named for the set
// each is built from, because reading one where the other belongs is silent:
// scrubbing on SETTLED destroys the client data a `failed` send would be resent
// from, and settling on SCRUBBABLE overwrites a real refusal.
const SETTLED_LIST = SETTLED_STATUSES.map((status) => `'${status}'`).join(",");
const SCRUBBABLE_LIST = SCRUBBABLE_STATUSES.map((status) => `'${status}'`).join(",");
const REQUEUEABLE_LIST = REQUEUEABLE_STATUSES.map((status) => `'${status}'`).join(",");

/**
 * The precondition that makes a scrub correct whatever its caller believes.
 *
 * Built from SCRUBBABLE and deliberately NOT from SETTLED: a row is safe to
 * forget only once every destination either succeeded or was deliberately
 * skipped (2026-10-14, user's call). A `failed` or `rejected` destination is
 * settled -- nothing will attempt it again -- but its client data is exactly
 * what the resend needs once the cause is fixed, and `BREVO_LIST_ID` fails that
 * way. Scrubbing on SETTLED here made those clients permanently unrecoverable.
 * The thirty-day backstop still takes such a row, so the data is bounded.
 *
 * Same lesson as claimClause above: a precondition that matters belongs in the
 * statement, not in the caller's copy of the row. The worker reads the four
 * statuses out of its own in-memory row, and during an overlapped IIS recycle
 * two workers split the four claims between them -- so NEITHER copy ever shows
 * all four scrubbable, and a scrub decided by the copy alone never happens. The
 * row then holds a name, an email and a phone until the thirty-day backstop, in
 * precisely the case the policy asks to reduce to a minute.
 *
 * With the predicate here, both workers may attempt it: the one whose statuses
 * are not all in the table yet matches no row and writes nothing, and whichever
 * of them finishes last matches and scrubs. It is read against the row as the
 * table actually holds it, which is the only copy that has seen all four.
 *
 * Unlike claimClause there is no claim moment to pass: this is not a claim on an
 * action, it takes nothing away from another worker, and a second attempt is a
 * no-op rather than a loss. `scrubbed_at IS NULL` is the other half, and it is
 * the statement's, not this helper's: the two scrubs share it for a different
 * reason (the audit trail must not move).
 */
function scrubbableClause(action) {
  return `${action}_status IN (${SCRUBBABLE_LIST})`;
}

/**
 * The destinations the backstop has to settle itself: SETTLED negated, which is
 * `pending` and `retrying`.
 *
 * SETTLED and not SCRUBBABLE, and that is not interchangeable here. The backstop
 * writes `failed` with a detail saying the send was never attempted, so built
 * from the narrower list it would overwrite the `rejected` a provider really
 * gave us -- and its detail with it -- turning the record of a refusal into the
 * record of a scrub.
 */
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
 * Cutting first could leave half an address whole. One function for every writer,
 * so the destination added next cannot forget.
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
 * The four action writers. Each writes only its own action's columns, and each
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

/** Nothing of OpenAI's is written outside these four columns: there is no
 *  provider-side id to record (the event's `id` is derived from the row) and
 *  `oppref` is frozen at insert, so a send has nothing to add to it. */
export async function updateOpenaiStatus(id, { status, detail, attempts, nextAttemptAt }, claimAt = null) {
  const claim = claimClause("openai", claimAt);
  const result = await run(
    `UPDATE signup_events
        SET openai_status = ?, openai_detail = ?, openai_attempts = ?, openai_next_attempt_at = ?
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
 * receipt until every destination has succeeded or been skipped, retries
 * included -- and on a row whose destination failed they survive longer still, so
 * the cause can be fixed and the send retried. After that nothing needs them -- FXBO is the system of record for who a client is, and
 * this table only has to say whether client 48217 got their welcome and to
 * recognise FXBO's redeliveries.
 *
 * Three absences are deliberate, and all three are load-bearing:
 *
 *   `fbc` stays. It is captured at signup and reused weeks later for the
 *   first-deposit conversion, so scrubbing it would send every later conversion
 *   to Meta with no ad attached.
 *
 *   `oppref` stays, for the same reason and one more. It is OpenAI's click
 *   identifier, their Conversions API does not capture it, and the deposit is a
 *   different row arriving weeks later whose own `full_link` is empty -- so the
 *   only copy of it is this column, and scrubbing it would send every later
 *   ChatGPT Ads conversion unattributed, accepted and unmatched. It is not
 *   client data: it identifies an ad click, not a person, which is why it sits
 *   beside `fbc` here rather than with `full_link` below.
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
 * One row's client data, removed, once the table says every destination succeeded or was
 * deliberately skipped.
 *
 * Successes and skips, not every settled status (see scrubbableClause): a row
 * with a `failed` or `rejected` destination keeps its client data so the cause
 * can be fixed and the send retried, and the thirty-day backstop is what bounds
 * how long it may do so.
 *
 * The predicate is the statement's own (see scrubbableClause): the worker
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
        AND ${scrubbableClause("meta")}
        AND ${scrubbableClause("whatsapp")}
        AND ${scrubbableClause("brevo")}
        AND ${scrubbableClause("openai")}`,
    [at, id]
  );
  return matchedRows(result);
}

/**
 * The rows that never sent anything and never will, removed whole.
 *
 * An invalid row is an unparseable payload or an FXBO "Test webhook" press. Every
 * destination's status is written `invalid` in the insert itself, so this is the
 * shape that identifies them; a row where only some are invalid is not one of
 * these and is deliberately left alone.
 *
 * Every destination has to be named here, and a missing one is not a narrower
 * delete but a dead one: the condition asks for all of them at once, so a
 * destination absent from it is a column that can hold anything -- and one absent
 * from the INSERT's invalid writes while present here would make the condition
 * unsatisfiable, so no invalid row would ever be deleted again.
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
        AND openai_status = 'invalid'
        AND received_at < ?`,
    [receivedBefore]
  );
  return matchedRows(result);
}

/**
 * The four destinations, in the order the tab shows them.
 *
 * Exported because the requeue route validates its body parameter against this
 * list: the destination is interpolated into a column name below, so the route
 * and the statement have to agree about what a destination is, and two copies of
 * four strings is exactly the kind of list that drifts.
 */
export const DESTINATIONS = ["meta", "whatsapp", "brevo", "openai"];

/**
 * The rows a destination could still send, when it has a deadline at all.
 *
 * Only OpenAI does. Their documentation bounds `timestamp_ms` to "within the
 * last 7 days and no more than 10 minutes in the future", and that timestamp
 * comes from `received_at`, so a row older than the window can never be sent --
 * re-stamping it with today's time is not available, because the row's whole
 * purpose is to say when the conversion happened (spec section 7a). Meta,
 * WhatsApp and Brevo take an event of any age, so for them this is empty and
 * their statements are unchanged.
 *
 * **Built from the two constants decideOpenaiSkip tests against**, imported
 * rather than restated, because the whole point is that the count and the skip
 * cannot drift: a count built on 7 days beside a skip built on 6 would be a
 * button offering forty rows and delivering none, which is the failure spec 7a
 * is written down to prevent. The comparisons are `>=` and `<=` for the same
 * reason -- decideOpenaiSkip refuses only what is strictly outside, so a row
 * exactly on either edge is sendable in both places.
 *
 * `now` is the caller's, so the count and the UPDATE that follows it are judged
 * against one instant rather than two readings of the clock.
 */
function sendableWindow(action, now) {
  if (action !== "openai") return null;
  return {
    sql: "received_at >= ? AND received_at <= ?",
    params: [
      new Date(now.getTime() - OPENAI_MAX_EVENT_AGE_MS),
      new Date(now.getTime() + OPENAI_MAX_EVENT_SKEW_MS),
    ],
  };
}

/**
 * The destination, or an error naming it.
 *
 * Every statement below builds column names by interpolation, so this is the one
 * thing between a caller's string and the SQL. The route refuses an unknown
 * destination too, with a 400; this is not a duplicate of that check but the
 * floor under it, for whatever calls the store next.
 */
function requireDestination(destination) {
  const name = String(destination ?? "");
  if (!DESTINATIONS.includes(name)) {
    throw new Error(`unknown CRM events destination '${name}'; expected one of ${DESTINATIONS.join(", ")}`);
  }
  return name;
}

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
 * One destination's failures, put back in the queue (2026-10-14, user's call).
 *
 * Bulk and per destination, because that is the shape of the problem: a wrong
 * list id or a missing key breaks a window of signups, and the operator fixes
 * the setting and then clears the backlog in one action. There is no per-row
 * version.
 *
 * Three preconditions, each with its own reason, and all three in the statement
 * rather than in the caller -- the same lesson as claimClause and
 * scrubbableClause above:
 *
 *   `scrubbed_at IS NULL`. A scrubbed row has no name, no email and no phone
 *   left, so requeueing one produces a row that is claimed on every sweep,
 *   refused by the worker's send guard, and never settles. It would sit at
 *   `pending` for ever -- and `pending` piling up is the one counter that means
 *   "the dispatch worker is dead", which is the signal eba9cf1 went to some
 *   length to keep usable.
 *
 *   The status filter, built from REQUEUEABLE and from neither of the other two
 *   lists. `failed` and `rejected` only. A `sent` row must be untouchable by
 *   this path: requeueing one re-sends a welcome to somebody who already got it.
 *   `rejected` is in on purpose -- Brevo's 400 for an attribute that does not
 *   exist yet is a rejection that succeeds once the attribute is created.
 *
 *   `<destination>_attempts = 0`. planRetry reads the stored count, so a row
 *   left at 3 of 3 is written `failed` by the pre-send claim before its request
 *   even leaves, and the resend gets one attempt with no retry behind it and a
 *   terminal status in the column while the request is still in the air. The
 *   clock goes to NULL for the matching reason: a row still carrying a
 *   five-minute-old next_attempt_at is due anyway, but one whose last failure
 *   set a clock in the future would wait it out, and the operator pressed the
 *   button now.
 *
 * `<destination>_detail` is deliberately left alone. It still says why the row
 * needs resending, which is worth reading in the second before the claim
 * replaces it with the in-flight note, and the claim replaces it on every row
 * that actually sends.
 *
 * `whatsapp_request_id` is NOT regenerated, and that is the point for WhatsApp.
 * It is frozen per row at insert. If DoubleTick honours a repeated messageId,
 * reusing it means a resend of a message that genuinely never arrived still goes
 * out -- DoubleTick never saw that id -- while a resend of one that did arrive is
 * deduplicated. Both are what we want. Minting a fresh id would guarantee the
 * duplicate instead. (Same reasoning as the over-width id being cut rather than
 * nulled, above: the worker reads the id back off the row on every attempt.)
 *
 * Returns how many rows it matched, so the caller can say what happened.
 */
export async function requeueFailedSends(destination, now = new Date()) {
  const action = requireDestination(destination);
  // The fourth precondition, and OpenAI's alone (see sendableWindow): a row
  // outside their 7-day window is unsendable whatever anybody fixes, so
  // requeueing it would spend a claim to reach a step that can only skip it --
  // and would replace the record of the real failure with a skip. It stays
  // `failed`, holding the reason it failed for. Nothing is appended for the other
  // three, whose statements are byte for byte what they were.
  const window = sendableWindow(action, now);
  const result = await run(
    `UPDATE signup_events
        SET ${action}_status = 'pending', ${action}_attempts = 0, ${action}_next_attempt_at = NULL
      WHERE scrubbed_at IS NULL
        AND ${action}_status IN (${REQUEUEABLE_LIST})${window ? `
        AND (${window.sql})` : ""}`,
    window ? window.params : []
  );
  return matchedRows(result);
}

/**
 * How many rows each destination could resend, and how many it can no longer.
 *
 * The tab's per-destination counters cannot answer the first question: they are
 * scoped to the selected period and they count scrubbed rows, which cannot be
 * resent at all. A button promising 40 and delivering 12 is worse than no
 * button.
 *
 * So `resendable` is what requeueFailedSends would match -- `failed` or
 * `rejected`, not scrubbed, and for OpenAI inside their window -- over the whole
 * table and not the tab's period, because the action is not scoped to a period
 * either. `scrubbed` is part of the rest of the same set: rows whose send went
 * wrong and whose client data the thirty-day backstop has since taken.
 * `expired` is the remainder, and exists only because OpenAI has a window: rows
 * still holding their client data that OpenAI would now refuse on their age
 * alone. Between them the three account for every failure an operator can see on
 * the card, which is the whole of the difference between the 40 they are looking
 * at and the 12 they get. All three come out of ONE statement, so the numbers are
 * a single snapshot and are guaranteed to add up; read separately they would not.
 *
 * The retention index leads with `scrubbed_at`, so the resendable half is a
 * handful of rows however large the table grows.
 */
export async function countResendableSends(now = new Date()) {
  const params = [];
  const columns = DESTINATIONS.flatMap((action) => {
    const window = sendableWindow(action, now);
    const failures = `${action}_status IN (${REQUEUEABLE_LIST})`;
    if (window) params.push(...window.params, ...window.params);
    return [
      // Exactly what requeueFailedSends would match, window included, because
      // this number is a promise about that statement and nothing else.
      `COUNT(CASE WHEN ${failures} AND scrubbed_at IS NULL${window ? ` AND (${window.sql})` : ""} THEN 1 END) AS ${action}_resendable`,
      `COUNT(CASE WHEN ${failures} AND scrubbed_at IS NOT NULL THEN 1 END) AS ${action}_scrubbed`,
      // The third reason a failure can no longer be resent, and the only one
      // that is not a scrub: OpenAI's window has closed on it. A literal zero
      // for the destinations that have no window, rather than a missing key --
      // the card prints this number, and `undefined` prints as "undefined".
      window
        ? `COUNT(CASE WHEN ${failures} AND scrubbed_at IS NULL AND NOT (${window.sql}) THEN 1 END) AS ${action}_expired`
        : `0 AS ${action}_expired`,
    ];
  });
  const rows = await all(
    `SELECT ${columns.join(", ")}
       FROM signup_events`,
    params
  );
  const counts = rows[0] ?? {};
  // COUNT never returns NULL, but an empty result set and a driver that hands
  // back strings both have to read as numbers here: the page disables its
  // control on a zero, and "0" is truthy.
  const n = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  };
  return Object.fromEntries(
    DESTINATIONS.map((action) => [
      action,
      {
        resendable: n(counts[`${action}_resendable`]),
        scrubbed: n(counts[`${action}_scrubbed`]),
        expired: n(counts[`${action}_expired`]),
      },
    ])
  );
}

/**
 * Every event since a date, newest first, capped.
 *
 * This feeds the events TABLE and nothing else. The counts beside it come from
 * countEventsSince, grouped in SQL and never capped: counting this capped list
 * in JavaScript is exactly the silent undercount Task 9 removed, so nothing
 * aggregated belongs here.
 *
 * **One status, detail and attempts column per destination, all four of them.**
 * A destination missing from this select list sends perfectly and then reports
 * as though it did not exist: `toTableRow` reads `undefined` for its status and
 * the tab's own column shows an empty cell on every row. On the one page whose
 * job is to reveal a broken pipeline, that is the worst way to be wrong -- so
 * the list is enumerated here rather than built from DESTINATIONS, because the
 * other statements that interpolate column names all write them, and a read
 * cannot borrow their guard.
 */
export async function listEventsSince(since, cap = 2000) {
  return all(
    `SELECT id, crm_client_id, stage, first_name, last_name, email, phone, record_type, source,
            meta_status, meta_detail, meta_attempts,
            whatsapp_status, whatsapp_detail, whatsapp_attempts,
            brevo_status, brevo_detail, brevo_attempts,
            openai_status, openai_detail, openai_attempts, received_at, scrubbed_at
       FROM signup_events
      WHERE received_at >= ?
      ORDER BY received_at DESC
      LIMIT ?`,
    [since, Number(cap) || 2000]
  );
}

/**
 * Event counts per (stage, status quadruple) since a date, over the whole window.
 *
 * Grouped in SQL and never capped: the result is bounded by the number of distinct
 * status combinations, not by how many events the window holds. A count read from
 * the capped list would undercount a busy month without saying so.
 *
 * **Every destination's status is in the select list AND in the GROUP BY, and
 * the two have to stay the same list.** A status selected but not grouped is
 * one arbitrary row's value standing for a whole group under MySQL's
 * ONLY_FULL_GROUP_BY-off behaviour, which is not a count of anything; and a
 * destination left out of both reports nothing at all, so its card reads seven
 * zeroes while it is sending. Adding a fourth status multiplies the number of
 * groups, not the number of rows scanned, and the result is still bounded by
 * the distinct combinations that actually occur -- which is a handful, because
 * a row's four statuses move together.
 */
export async function countEventsSince(since) {
  return all(
    `SELECT stage, meta_status, whatsapp_status, brevo_status, openai_status, COUNT(*) AS n
       FROM signup_events
      WHERE received_at >= ?
      GROUP BY stage, meta_status, whatsapp_status, brevo_status, openai_status`,
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
