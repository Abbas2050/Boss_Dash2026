import sqlite3 from "sqlite3";

const sqlite = sqlite3.verbose();
const db = new sqlite.Database("./crm_mt5.db");

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

let initialized = false;

export async function initDocusignStore() {
  if (initialized) return;
  await run(`
    CREATE TABLE IF NOT EXISTS docusign_envelope_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id TEXT NOT NULL UNIQUE,
      applicant_email TEXT NOT NULL,
      applicant_name TEXT,
      envelope_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      template_id TEXT,
      doc_type TEXT,
      crm_upload_status TEXT NOT NULL DEFAULT 'pending',
      raw_payload TEXT,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      ON CONFLICT(application_id) DO UPDATE SET
        applicant_email = excluded.applicant_email,
        applicant_name = excluded.applicant_name,
        envelope_id = excluded.envelope_id,
        status = excluded.status,
        template_id = excluded.template_id,
        doc_type = excluded.doc_type,
        raw_payload = excluded.raw_payload,
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
