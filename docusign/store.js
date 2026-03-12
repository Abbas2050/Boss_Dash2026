import mysql from "mysql2/promise";

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

  initialized = true;
}

export async function findByApplicationId(applicationId) {
  return get(`SELECT * FROM docusign_envelope_map WHERE application_id = ?`, [String(applicationId)]);
}

export async function findByEnvelopeId(envelopeId) {
  return get(`SELECT * FROM docusign_envelope_map WHERE envelope_id = ?`, [String(envelopeId)]);
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
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE
        applicant_email = VALUES(applicant_email),
        applicant_name = VALUES(applicant_name),
        envelope_id = VALUES(envelope_id),
        status = VALUES(status),
        template_id = VALUES(template_id),
        doc_type = VALUES(doc_type),
        raw_payload = VALUES(raw_payload),
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
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT ?
    `,
    [safeLimit]
  );
}
