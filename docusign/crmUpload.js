import { downloadCombinedDocument } from "./client.js";
import { createCrmDocument, fetchCrmApplicationApplicantById } from "./crm.js";
import { findByEnvelopeId, markCrmUploadStatus } from "./store.js";

/**
 * FXBO config 73 = "SCA Agreement"; its only data field is `file`, typed
 * [{ file: "base64string", name: "string" }]. hasExpiration is false, so we
 * never send expiresAt.
 */
export function buildDocumentPayload({ crmUserId, configId, applicationId, envelopeId, pdfBase64 }) {
  return {
    user: Number(crmUserId),
    config: Number(configId),
    status: "approved",
    isUploadedByClient: false,
    description: `DocuSign signed agreement (envelope ${envelopeId}, application ${applicationId})`,
    data: { file: [{ file: pdfBase64, name: `signed-agreement-${applicationId}.pdf` }] },
  };
}

export async function uploadSignedDocument(envelopeId) {
  const configId = String(process.env.DOCUSIGN_CRM_DOC_CONFIG_ID || "").trim();
  if (!configId) {
    console.warn("[docusign-crm-upload] DOCUSIGN_CRM_DOC_CONFIG_ID not set — skipping upload.");
    return { ok: false, reason: "config_id_not_set" };
  }

  const row = await findByEnvelopeId(envelopeId);
  if (!row) return { ok: false, reason: "envelope_not_found" };
  if (String(row.crm_upload_status || "").toLowerCase() === "uploaded") {
    return { ok: true, reason: "already_uploaded" };
  }

  try {
    let crmUserId = row.crm_user_id ? Number(row.crm_user_id) : null;
    if (!crmUserId) {
      const applicant = await fetchCrmApplicationApplicantById(row.application_id).catch(() => null);
      crmUserId = applicant?.userId ? Number(applicant.userId) : null;
    }
    if (!crmUserId) {
      await markCrmUploadStatus(envelopeId, "failed", "crm_user_unresolved");
      return { ok: false, reason: "crm_user_unresolved" };
    }

    const pdf = await downloadCombinedDocument(envelopeId);
    const payload = buildDocumentPayload({
      crmUserId,
      configId,
      applicationId: row.application_id,
      envelopeId,
      pdfBase64: pdf.toString("base64"),
    });
    await createCrmDocument(payload);
    await markCrmUploadStatus(envelopeId, "uploaded", null);
    console.log(`[docusign-crm-upload] uploaded envelope=${envelopeId} application=${row.application_id} user=${crmUserId}`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markCrmUploadStatus(envelopeId, "failed", message.slice(0, 500)).catch(() => undefined);
    console.error(`[docusign-crm-upload] failed envelope=${envelopeId}: ${message}`);
    return { ok: false, reason: "upload_failed", message };
  }
}
