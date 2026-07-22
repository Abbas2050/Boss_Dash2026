import mysql from "mysql2/promise";
import { WEBHOOK_LOG_RETENTION } from "./webhookLog.js";

const AUTH_DB_HOST = process.env.AUTH_DB_HOST;
const AUTH_DB_PORT = Number(process.env.AUTH_DB_PORT || 3306);
const AUTH_DB_NAME = process.env.AUTH_DB_NAME;
const AUTH_DB_USER = process.env.AUTH_DB_USER;
const AUTH_DB_PASSWORD = process.env.AUTH_DB_PASSWORD;

let pool = null;

let initialized = false;

function hasDbConfig() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_NAME && AUTH_DB_USER && AUTH_DB_PASSWORD);
}

async function query(sql, params = []) {
  if (!pool) {
    throw new Error("DocuSign DB pool is not initialized.");
  }
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function run(sql, params = []) {
  if (!pool) {
    throw new Error("DocuSign DB pool is not initialized.");
  }
  const [result] = await pool.query(sql, params);
  return {
    lastID: result?.insertId ?? null,
    changes: result?.affectedRows ?? 0,
  };
}

async function get(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function all(sql, params = []) {
  const rows = await query(sql, params);
  return Array.isArray(rows) ? rows : [];
}

export async function initDocusignStore() {
  if (initialized) return;

  if (!hasDbConfig()) {
    throw new Error("DocuSign DB env vars are missing. Expected AUTH_DB_HOST, AUTH_DB_NAME, AUTH_DB_USER, AUTH_DB_PASSWORD.");
  }

  if (!pool) {
    pool = mysql.createPool({
      host: AUTH_DB_HOST,
      port: AUTH_DB_PORT,
      database: AUTH_DB_NAME,
      user: AUTH_DB_USER,
      password: AUTH_DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }

  await run(`
    CREATE TABLE IF NOT EXISTS docusign_envelope_map (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      application_id VARCHAR(255) NOT NULL,
      applicant_email VARCHAR(255) NOT NULL,
      applicant_name VARCHAR(255) NULL,
      envelope_id VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'sent',
      template_id VARCHAR(255) NULL,
      doc_type VARCHAR(100) NULL,
      crm_upload_status VARCHAR(50) NOT NULL DEFAULT 'pending',
      raw_payload LONGTEXT NULL,
      last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_docusign_application_id (application_id)
    )
  `);

  await run(
    `CREATE INDEX IF NOT EXISTS idx_docusign_envelope_map_envelope_id ON docusign_envelope_map(envelope_id)`
  );

  const [colRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'docusign_envelope_map' AND COLUMN_NAME = 'crm_user_id'`
  );
  if (Number(colRows?.[0]?.cnt || 0) === 0) {
    await run(`ALTER TABLE docusign_envelope_map ADD COLUMN crm_user_id BIGINT NULL`);
  }

  await run(`
    CREATE TABLE IF NOT EXISTS docusign_webhook_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      outcome VARCHAR(20) NOT NULL,
      http_status SMALLINT NOT NULL DEFAULT 0,
      error VARCHAR(100) NULL,
      application_id VARCHAR(255) NULL,
      applicant_email VARCHAR(255) NULL,
      envelope_id VARCHAR(255) NULL,
      payload TEXT NULL,
      PRIMARY KEY (id),
      INDEX idx_docusign_webhook_log_received_at (received_at)
    )
  `);

  initialized = true;
}

export async function findByApplicationId(applicationId) {
  return get(`SELECT * FROM docusign_envelope_map WHERE application_id = ?`, [String(applicationId)]);
}

export async function findByEnvelopeId(envelopeId) {
  return get(`SELECT * FROM docusign_envelope_map WHERE envelope_id = ?`, [String(envelopeId)]);
}

export async function findOutstandingEnvelopeForEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  return get(
    `SELECT * FROM docusign_envelope_map
      WHERE LOWER(applicant_email) = ?
        AND LOWER(status) IN ('created', 'sent', 'delivered')
      ORDER BY updated_at DESC
      LIMIT 1`,
    [normalized]
  );
}

export async function upsertEnvelopeMap(input) {
  const {
    applicationId,
    applicantEmail,
    applicantName,
    envelopeId,
    status,
    templateId,
    docType,
    rawPayload,
    crmUserId,
  } = input;

  await run(
    `
      INSERT INTO docusign_envelope_map (
        application_id,
        applicant_email,
        applicant_name,
        envelope_id,
        status,
        template_id,
        doc_type,
        raw_payload,
        crm_user_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        applicant_email = VALUES(applicant_email),
        applicant_name = VALUES(applicant_name),
        envelope_id = VALUES(envelope_id),
        status = VALUES(status),
        template_id = VALUES(template_id),
        doc_type = VALUES(doc_type),
        raw_payload = VALUES(raw_payload),
        crm_user_id = VALUES(crm_user_id),
        updated_at = CURRENT_TIMESTAMP
    `,
    [
      String(applicationId),
      String(applicantEmail),
      applicantName ? String(applicantName) : "",
      String(envelopeId),
      String(status || "sent"),
      templateId ? String(templateId) : null,
      docType ? String(docType) : null,
      rawPayload ? JSON.stringify(rawPayload) : null,
      crmUserId == null ? null : Number(crmUserId),
    ]
  );

  return findByApplicationId(applicationId);
}

export async function markEnvelopeStatus(envelopeId, status, lastError = null) {
  await run(
    `
      UPDATE docusign_envelope_map
      SET status = ?,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE envelope_id = ?
    `,
    [String(status), lastError ? String(lastError) : null, String(envelopeId)]
  );

  return findByEnvelopeId(envelopeId);
}

export async function markCrmUploadStatus(envelopeId, crmUploadStatus, lastError = null) {
  await run(
    `
      UPDATE docusign_envelope_map
      SET crm_upload_status = ?,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE envelope_id = ?
    `,
    [String(crmUploadStatus), lastError ? String(lastError) : null, String(envelopeId)]
  );

  return findByEnvelopeId(envelopeId);
}

export async function listEnvelopeMaps(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return all(
    `
      SELECT *
      FROM docusign_envelope_map
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `,
    [safeLimit]
  );
}

export async function listPendingCrmUploads(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  return all(
    `
      SELECT *
      FROM docusign_envelope_map
      WHERE status = 'completed' AND crm_upload_status <> 'uploaded'
      ORDER BY updated_at ASC
      LIMIT ?
    `,
    [safeLimit]
  );
}

export async function getDocusignPool() {
  await initDocusignStore();
  return pool;
}

/**
 * Best-effort: never let a logging failure affect the webhook response.
 * Prunes to the newest WEBHOOK_LOG_RETENTION rows after each insert.
 */
export async function recordWebhookCall(entry) {
  try {
    await run(
      `INSERT INTO docusign_webhook_log
         (outcome, http_status, error, application_id, applicant_email, envelope_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(entry?.outcome || "rejected"),
        Number(entry?.httpStatus) || 0,
        entry?.error ?? null,
        entry?.applicationId ?? null,
        entry?.applicantEmail ?? null,
        entry?.envelopeId ?? null,
        entry?.payload ?? null,
      ]
    );
    // Derived table wrapper is required: MySQL cannot use a LIMIT subquery on the
    // same table it is deleting from.
    await run(
      `DELETE FROM docusign_webhook_log
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id FROM docusign_webhook_log ORDER BY id DESC LIMIT ${WEBHOOK_LOG_RETENTION}
          ) AS keep
        )`
    );
  } catch (error) {
    console.error("[docusign-webhook-log] write failed:", error instanceof Error ? error.message : String(error));
  }
}

export async function listWebhookLog(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  try {
    return await all(
      `SELECT received_at, outcome, http_status, error, application_id, applicant_email, envelope_id
         FROM docusign_webhook_log
        ORDER BY id DESC
        LIMIT ?`,
      [safeLimit]
    );
  } catch (error) {
    console.error("[docusign-webhook-log] read failed:", error instanceof Error ? error.message : String(error));
    return [];
  }
}
