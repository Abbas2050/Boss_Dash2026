import crypto from "crypto";
import express from "express";
import { createEnvelopeFromTemplate } from "./client.js";
import { fetchCrmApplicationApplicantById, fetchCrmApplicationsByType, fetchCrmUserById } from "./crm.js";
import { verifyOAuthBearerToken } from "../oauth/router.js";
import { getDocusignSyncState, runApprovedApplicationsSync } from "./sync.js";
import {
  findByApplicationId,
  findByEnvelopeId,
  initDocusignStore,
  listEnvelopeMaps,
  markEnvelopeStatus,
  upsertEnvelopeMap,
} from "./store.js";

const router = express.Router();

function verifyFxboWebhookAuth(req) {
  const expected = process.env.DOCUSIGN_FXBO_WEBHOOK_BEARER || "";
  const raw = String(req.headers.authorization || "");
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";

  if (expected && token && token === expected) {
    return { ok: true, mode: "shared_bearer" };
  }

  const oauthCheck = verifyOAuthBearerToken(raw, req);
  if (oauthCheck.ok) {
    return { ok: true, mode: "oauth_jwt", payload: oauthCheck.payload };
  }

  if (!expected && !raw.trim()) {
    return { ok: true, mode: "open" };
  }

  return { ok: false, reason: oauthCheck.reason || "unauthorized_webhook" };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function verifyConnectSignature(req) {
  const secret = process.env.DOCUSIGN_CONNECT_HMAC_SECRET || "";
  if (!secret) return { ok: true, reason: "hmac_not_configured" };

  const headerSig = String(req.headers["x-docusign-signature-1"] || "").trim();
  if (!headerSig) return { ok: false, reason: "missing_signature_header" };

  // Express JSON middleware runs before this router in server.js.
  // We recompute using the JSON string for a best-effort check.
  const raw = JSON.stringify(req.body || {});
  const computed = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  return {
    ok: computed === headerSig,
    reason: computed === headerSig ? "ok" : "signature_mismatch",
  };
}

function toSqlDateTime(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function buildPendingApplicationsQuery() {
  const lookbackMinutes = Math.max(10, Number(process.env.DOCUSIGN_PENDING_APPS_LOOKBACK_MINUTES || 1440) || 1440);
  const end = new Date();
  const begin = new Date(end.getTime() - lookbackMinutes * 60 * 1000);
  return {
    createdAt: {
      begin: toSqlDateTime(begin),
      end: toSqlDateTime(end),
    },
    orders: [{ field: "id", direction: "DESC" }],
    segment: {
      limit: Math.max(10, Number(process.env.DOCUSIGN_PENDING_APPS_LIMIT || 100) || 100),
      offset: 0,
    },
  };
}

function getApplicationFullName(application) {
  const candidateA = application?.sections?.data?.["Client Onboarding"]?.full_name?.value;
  const candidateB = application?.sections?.data?.["Client Onboarding"]?.["Full Name"]?.value;
  const value = String(candidateA || candidateB || "").trim();
  return value;
}

function isLikelyPlaceholder(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  return /^%[^%]+%$/.test(v) || /^\{\{[^}]+\}\}$/.test(v);
}

function normalizeWebhookText(value) {
  const v = String(value || "").trim();
  return isLikelyPlaceholder(v) ? "" : v;
}

function normalizeWebhookEmail(value) {
  const email = normalizeWebhookText(value).toLowerCase();
  // Keep validation intentionally simple; invalid values should trigger CRM fallback.
  if (!email || !email.includes("@") || email.startsWith("%") || email.includes(" ")) return "";
  return email;
}

router.get("/health", async (_req, res) => {
  try {
    await initDocusignStore();
    res.json({ ok: true, service: "docusign-integration" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/sync-status", async (_req, res) => {
  try {
    await initDocusignStore();
    return res.json({ ok: true, sync: getDocusignSyncState() });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "sync_status_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/overview", async (_req, res) => {
  try {
    await initDocusignStore();

    const rows = await listEnvelopeMaps(250);
    const normalizedRows = rows.map((row) => ({
      ...row,
      status: String(row.status || "unknown").toLowerCase(),
      crm_upload_status: String(row.crm_upload_status || "pending").toLowerCase(),
    }));

    const completedStatuses = new Set(["completed", "signed", "delivered"]);
    const pendingStatuses = new Set(["created", "sent", "delivered", "pending"]);

    const sentCount = normalizedRows.length;
    const completedRows = normalizedRows.filter((row) => completedStatuses.has(row.status));
    const pendingRows = normalizedRows.filter((row) => !completedStatuses.has(row.status) && pendingStatuses.has(row.status));

    const latestUpdatedAt = normalizedRows[0]?.updated_at || null;
    const hasCoreConfig = Boolean(
      process.env.DOCUSIGN_INTEGRATION_KEY &&
      process.env.DOCUSIGN_USER_ID &&
      process.env.DOCUSIGN_TEMPLATE_ID &&
      process.env.DOCUSIGN_AUTH_BASE
    );

    const pendingClients = pendingRows.slice(0, 8).map((row) => ({
      applicationId: row.application_id,
      name: row.applicant_name || row.applicant_email,
      email: row.applicant_email,
      status: row.status,
      updatedAt: row.updated_at,
    }));

    const completedClients = completedRows.slice(0, 8).map((row) => ({
      applicationId: row.application_id,
      name: row.applicant_name || row.applicant_email,
      email: row.applicant_email,
      status: row.status,
      updatedAt: row.updated_at,
      crmUploadStatus: row.crm_upload_status,
    }));

    let pendingApplications = [];
    let pendingApplicationsError = null;
    try {
      const query = buildPendingApplicationsQuery();
      const crmApplications = await fetchCrmApplicationsByType("docusign", query);
      pendingApplications = crmApplications
        .filter((app) => String(app?.status || "").trim().toLowerCase() === "pending")
        .slice(0, 20)
        .map((app) => ({
          applicationId: String(app?.id || ""),
          userId: Number(app?.userId || 0) || null,
          status: String(app?.status || "pending"),
          createdAt: String(app?.createdAt || ""),
          createdBy: String(app?.createdBy || "").trim(),
          fullName: getApplicationFullName(app),
        }));
    } catch (error) {
      pendingApplicationsError = error instanceof Error ? error.message : String(error);
    }

    return res.json({
      ok: true,
      summary: {
        sent: sentCount,
        pending: pendingRows.length,
        completed: completedRows.length,
      },
      pendingClients,
      completedClients,
      pendingApplications,
      pendingApplicationsCount: pendingApplications.length,
      system: {
        status: hasCoreConfig ? "operational" : "configuration_required",
        hasCoreConfig,
        oauthEnabled: Boolean(process.env.AUTH_CLIENT_ID && process.env.AUTH_CLIENT_SECRET),
        connectHmacEnabled: Boolean(process.env.DOCUSIGN_CONNECT_HMAC_SECRET),
        latestUpdatedAt,
        pendingApplicationsError,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "overview_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// Triggered by FXBO assistant/webhook when application is approved.
router.post("/webhooks/fxbo/application-approved", async (req, res) => {
  try {
    await initDocusignStore();

    const authCheck = verifyFxboWebhookAuth(req);
    if (!authCheck.ok) {
      return res.status(401).json({ ok: false, error: "unauthorized_webhook", reason: authCheck.reason });
    }

    // Merge body and query params — FXBO may send via form-encoded body, JSON body, or query string
    const p = Object.assign({}, req.query || {}, req.body || {});
    const applicationId = String(p.applicationId || p.id || "").trim();
    let userId = Number(p.userId || p.user?.id || 0) || null;
    let signerEmail = normalizeWebhookEmail(p.email || p.applicantEmail || "");
    let signerName = normalizeWebhookText(p.name || p.applicantName || "");
    const templateId = String(p.templateId || "").trim() || undefined;
    const roleName = String(p.roleName || p.templateRole || "").trim() || undefined;
    const docType = String(p.docType || "approve-form").trim() || "approve-form";

    if ((!signerEmail || !signerName) && applicationId) {
      const applicationApplicant = await fetchCrmApplicationApplicantById(applicationId);
      if (applicationApplicant) {
        if (!userId && applicationApplicant.userId) userId = applicationApplicant.userId;
        if (!signerEmail) signerEmail = normalizeWebhookEmail(applicationApplicant.email);
        if (!signerName) signerName = normalizeWebhookText(applicationApplicant.fullName);
      }
    }

    if ((!signerEmail || !signerName) && userId) {
      const crmUser = await fetchCrmUserById(userId);
      if (crmUser) {
        if (!signerEmail) signerEmail = normalizeWebhookEmail(crmUser.email);
        if (!signerName) signerName = normalizeWebhookText(`${crmUser.firstName} ${crmUser.lastName}`.trim());
      }
    }

    if (!applicationId) return res.status(400).json({ ok: false, error: "applicationId_required" });
    if (!signerEmail) return res.status(400).json({ ok: false, error: "signer_email_required" });
    if (!signerName) return res.status(400).json({ ok: false, error: "signer_name_required" });

    const existing = await findByApplicationId(applicationId);
    if (existing?.envelope_id) {
      return res.json({
        ok: true,
        idempotent: true,
        applicationId,
        envelopeId: existing.envelope_id,
        status: existing.status,
      });
    }

    const created = await createEnvelopeFromTemplate({
      signerEmail,
      signerName,
      templateId,
      roleName,
      applicationId,
    });

    const row = await upsertEnvelopeMap({
      applicationId,
      applicantEmail: signerEmail,
      applicantName: signerName,
      envelopeId: created.envelopeId,
      status: created.status,
      templateId: templateId || process.env.DOCUSIGN_TEMPLATE_ID || "",
      docType,
      rawPayload: req.body,
    });

    return res.json({
      ok: true,
      applicationId,
      envelopeId: created.envelopeId,
      status: created.status,
      record: row,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "docusign_send_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// Pull from CRM applications API and send DocuSign for approved+unsent applications.
router.post("/sync-approved-applications", async (req, res) => {
  try {
    await initDocusignStore();

    const authCheck = verifyFxboWebhookAuth(req);
    if (!authCheck.ok) {
      return res.status(401).json({ ok: false, error: "unauthorized_webhook", reason: authCheck.reason });
    }

    const summary = await runApprovedApplicationsSync({
      type: req.body?.type,
      templateId: req.body?.templateId,
      roleName: req.body?.roleName,
      docType: req.body?.docType,
      user: req.body?.user,
      createdAt: req.body?.createdAt,
      processedAt: req.body?.processedAt,
      checkedAt: req.body?.checkedAt,
      uploadedByClient: req.body?.uploadedByClient,
      orders: req.body?.orders,
      segment: req.body?.segment,
    }, "manual_api");

    if (summary?.skipped) {
      return res.status(409).json({ ok: false, error: "sync_already_running", sync: summary.state });
    }

    return res.json({ ok: true, ...summary });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "sync_approved_applications_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// DocuSign Connect webhook endpoint.
router.post("/webhooks/connect", async (req, res) => {
  try {
    await initDocusignStore();

    const sigCheck = verifyConnectSignature(req);
    if (!sigCheck.ok) {
      return res.status(401).json({ ok: false, error: "invalid_connect_signature", reason: sigCheck.reason });
    }

    const body = req.body || {};
    const maybeEnvelopeId =
      body?.data?.envelopeId ||
      body?.envelopeId ||
      body?.envelopeStatus?.envelopeID ||
      body?.EnvelopeStatus?.EnvelopeID ||
      "";

    const envelopeId = String(maybeEnvelopeId || "").trim();
    if (!envelopeId) {
      return res.status(400).json({ ok: false, error: "envelope_id_not_found" });
    }

    const statusRaw =
      body?.data?.envelopeSummary?.status ||
      body?.status ||
      body?.envelopeStatus?.status ||
      body?.EnvelopeStatus?.Status ||
      "";
    const status = String(statusRaw || "unknown").toLowerCase();

    const updated = await markEnvelopeStatus(envelopeId, status);
    return res.json({ ok: true, envelopeId, status, record: updated });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "connect_webhook_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/applications/:applicationId", async (req, res) => {
  try {
    await initDocusignStore();
    const applicationId = String(req.params.applicationId || "").trim();
    if (!applicationId) return res.status(400).json({ ok: false, error: "applicationId_required" });
    const row = await findByApplicationId(applicationId);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const payload = row.raw_payload ? safeJsonParse(row.raw_payload) : null;
    return res.json({ ok: true, record: { ...row, raw_payload: payload } });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/envelopes/:envelopeId", async (req, res) => {
  try {
    await initDocusignStore();
    const envelopeId = String(req.params.envelopeId || "").trim();
    if (!envelopeId) return res.status(400).json({ ok: false, error: "envelopeId_required" });
    const row = await findByEnvelopeId(envelopeId);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const payload = row.raw_payload ? safeJsonParse(row.raw_payload) : null;
    return res.json({ ok: true, record: { ...row, raw_payload: payload } });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
