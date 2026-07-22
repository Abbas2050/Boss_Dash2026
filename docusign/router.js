import crypto from "crypto";
import express from "express";
import { createEnvelopeFromTemplate } from "./client.js";
import { fetchCrmApplicationApplicantById, fetchCrmApplicationsByType, fetchCrmUserById } from "./crm.js";
import { verifyOAuthBearerToken } from "../oauth/router.js";
import { normalizeApplicationId } from "./appId.js";
import { onEnvelopeStatus } from "./reconcile.js";
import { authRequired, hasAccessPermission } from "../auth/router.js";
import { getDocusignSyncState, runApprovedApplicationsSync } from "./sync.js";
import {
  findByApplicationId,
  findByEnvelopeId,
  findOutstandingEnvelopeForEmail,
  initDocusignStore,
  listEnvelopeMaps,
  recordWebhookCall,
  upsertEnvelopeMap,
} from "./store.js";
import { buildWebhookLogEntry } from "./webhookLog.js";

const router = express.Router();

function requireBackoffice(req, res, next) {
  if (!hasAccessPermission(req.auth, "Backoffice")) return res.status(403).json({ ok: false, error: "forbidden" });
  return next();
}

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

// Fail CLOSED when no HMAC secret is configured: the DocuSign account currently has
// ZERO Connect configurations, meaning DocuSign never calls this endpoint at all — so
// any request that arrives here is not DocuSign, it's an unauthenticated caller on the
// internet. Once a Connect configuration and DOCUSIGN_CONNECT_HMAC_SECRET are added,
// this check starts verifying signatures automatically with no code change required.
export function verifyConnectSignatureRaw(rawBody, headerSig, secret) {
  if (!secret) return { ok: false, reason: "hmac_not_configured" };
  const sig = String(headerSig || "").trim();
  if (!sig) return { ok: false, reason: "missing_signature_header" };
  if (!rawBody || !rawBody.length) return { ok: false, reason: "raw_body_unavailable" };
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(computed);
  const b = Buffer.from(sig);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, reason: ok ? "ok" : "signature_mismatch" };
}

function verifyConnectSignature(req) {
  return verifyConnectSignatureRaw(
    req.rawBody,
    req.headers["x-docusign-signature-1"],
    process.env.DOCUSIGN_CONNECT_HMAC_SECRET || ""
  );
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

/**
 * Summarise an inbound webhook request for diagnostics.
 *
 * FXBO placeholders such as %application_id% sometimes arrive unresolved — either
 * empty or as the placeholder's own description text ("Application ID + Link").
 * Echoing every field received makes it obvious whether one placeholder failed or
 * the whole rule lost its application context, instead of inferring it.
 */
export function describeWebhookPayload(req, merged) {
  const fields = {};
  for (const [key, value] of Object.entries(merged || {})) {
    if (value && typeof value === "object") {
      fields[key] = { type: Array.isArray(value) ? "array" : "object", value: JSON.stringify(value).slice(0, 160) };
      continue;
    }
    const text = String(value ?? "");
    fields[key] = {
      type: typeof value,
      value: text.slice(0, 160),
      empty: text.trim() === "",
      looksUnresolved: isLikelyPlaceholder(text) || /^[A-Z][A-Za-z ]+ \+ [A-Za-z ]+$/.test(text.trim()),
    };
  }
  return {
    contentType: String(req?.headers?.["content-type"] || ""),
    bodyKeys: Object.keys(req?.body || {}),
    queryKeys: Object.keys(req?.query || {}),
    fields,
  };
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

router.get("/sync-status", authRequired, requireBackoffice, async (_req, res) => {
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

const COMPLETED_STATUSES = new Set(["completed", "signed"]);
const PENDING_STATUSES = new Set(["created", "sent", "delivered", "pending"]);
const ATTENTION_STATUSES = new Set(["declined", "voided", "expired"]);

export function bucketEnvelopes(rows) {
  const norm = rows.map((r) => ({ ...r, status: String(r.status || "unknown").toLowerCase() }));
  const live = norm.filter((r) => r.status !== "superseded");
  return {
    completed: live.filter((r) => COMPLETED_STATUSES.has(r.status)),
    pending: live.filter((r) => !COMPLETED_STATUSES.has(r.status) && PENDING_STATUSES.has(r.status)),
    needsAttention: live.filter((r) => ATTENTION_STATUSES.has(r.status)),
  };
}

router.get("/overview", authRequired, requireBackoffice, async (_req, res) => {
  try {
    await initDocusignStore();

    const rows = await listEnvelopeMaps(250);
    const normalizedRows = rows.map((row) => ({
      ...row,
      status: String(row.status || "unknown").toLowerCase(),
      crm_upload_status: String(row.crm_upload_status || "pending").toLowerCase(),
    }));

    const { completed: completedRows, pending: pendingRows, needsAttention: attentionRows } = bucketEnvelopes(normalizedRows);
    const sentCount = normalizedRows.filter((r) => r.status !== "superseded").length;

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

    const needsAttentionClients = attentionRows.slice(0, 8).map((row) => ({
      applicationId: row.application_id,
      name: row.applicant_name || row.applicant_email,
      email: row.applicant_email,
      status: row.status,
      updatedAt: row.updated_at,
    }));

    return res.json({
      ok: true,
      summary: {
        sent: sentCount,
        pending: pendingRows.length,
        completed: completedRows.length,
        needsAttention: attentionRows.length,
      },
      pendingClients,
      completedClients,
      needsAttentionClients,
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

/**
 * Log one inbound-webhook outcome and return the response, so every exit point
 * is recorded with a single expression. Logging is awaited but never throws —
 * recordWebhookCall swallows its own errors.
 */
async function logAndRespond(res, { status, body, outcome, error, applicationId, applicantEmail, envelopeId, payload }) {
  await recordWebhookCall(
    buildWebhookLogEntry({ outcome, httpStatus: status, error, applicationId, applicantEmail, envelopeId, payload })
  );
  return res.status(status).json(body);
}

// Triggered by FXBO assistant/webhook when application is approved.
router.post("/webhooks/fxbo/application-approved", async (req, res) => {
  try {
    await initDocusignStore();

    const authCheck = verifyFxboWebhookAuth(req);
    if (!authCheck.ok) {
      return logAndRespond(res, {
        status: 401,
        body: { ok: false, error: "unauthorized_webhook", reason: authCheck.reason },
        outcome: "rejected",
        error: "unauthorized_webhook",
        payload: Object.assign({}, req.query || {}, req.body || {}),
      });
    }

    // Merge body and query params — FXBO may send via form-encoded body, JSON body, or query string
    const p = Object.assign({}, req.query || {}, req.body || {});
    const rawApplicationId = String(p.applicationId || p.id || "").trim();
    const applicationId = normalizeApplicationId(rawApplicationId);
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

    if (!rawApplicationId || !applicationId) {
      // Echo back exactly what arrived so a misconfigured/unresolved placeholder can be
      // identified from the webhook response alone, without guesswork.
      const debug = describeWebhookPayload(req, p);
      console.warn(
        `[docusign-webhook] rejected: ${!rawApplicationId ? "applicationId_required" : "applicationId_invalid"} ` +
        `received=${JSON.stringify(rawApplicationId)} payload=${JSON.stringify(debug)}`
      );
      const errorCode = !rawApplicationId ? "applicationId_required" : "applicationId_invalid";
      return logAndRespond(res, {
        status: 400,
        body: { ok: false, error: errorCode, received: rawApplicationId.slice(0, 120), debug },
        outcome: "rejected",
        error: errorCode,
        applicationId: rawApplicationId,
        applicantEmail: signerEmail,
        payload: p,
      });
    }
    if (!signerEmail) {
      return logAndRespond(res, {
        status: 400,
        body: { ok: false, error: "signer_email_required" },
        outcome: "rejected",
        error: "signer_email_required",
        applicationId,
        payload: p,
      });
    }
    if (!signerName) {
      return logAndRespond(res, {
        status: 400,
        body: { ok: false, error: "signer_name_required" },
        outcome: "rejected",
        error: "signer_name_required",
        applicationId,
        applicantEmail: signerEmail,
        payload: p,
      });
    }

    const existing = await findByApplicationId(applicationId);
    if (existing?.envelope_id) {
      return logAndRespond(res, {
        status: 200,
        body: { ok: true, idempotent: true, applicationId, envelopeId: existing.envelope_id, status: existing.status },
        outcome: "skipped",
        error: "already_sent",
        applicationId,
        applicantEmail: signerEmail,
        envelopeId: existing.envelope_id,
        payload: p,
      });
    }

    const outstanding = await findOutstandingEnvelopeForEmail(signerEmail);
    if (outstanding) {
      console.log(`[docusign] skipping send for ${signerEmail} — envelope ${outstanding.envelope_id} (application ${outstanding.application_id}) is still ${outstanding.status}`);
      return logAndRespond(res, {
        status: 200,
        body: {
          ok: true,
          skipped: true,
          reason: "client_has_outstanding_envelope",
          applicationId,
          existingEnvelopeId: outstanding.envelope_id,
          existingApplicationId: outstanding.application_id,
          status: outstanding.status,
        },
        outcome: "skipped",
        error: "client_has_outstanding_envelope",
        applicationId,
        applicantEmail: signerEmail,
        envelopeId: outstanding.envelope_id,
        payload: p,
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
      crmUserId: userId,
    });

    return logAndRespond(res, {
      status: 200,
      body: { ok: true, applicationId, envelopeId: created.envelopeId, status: created.status, record: row },
      outcome: "sent",
      applicationId,
      applicantEmail: signerEmail,
      envelopeId: created.envelopeId,
      payload: p,
    });
  } catch (error) {
    return logAndRespond(res, {
      status: 500,
      body: { ok: false, error: "docusign_send_failed", message: error instanceof Error ? error.message : String(error) },
      outcome: "rejected",
      error: "docusign_send_failed",
      payload: Object.assign({}, req.query || {}, req.body || {}),
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

// Operator-triggered sweep from the Back Office panel (session auth, not the webhook bearer).
router.post("/run-sync", authRequired, requireBackoffice, async (_req, res) => {
  try {
    await initDocusignStore();
    const summary = await runApprovedApplicationsSync({}, "panel_button");
    if (summary?.skipped) return res.status(409).json({ ok: false, error: "sync_already_running", sync: summary.state });
    return res.json({ ok: true, ...summary });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "run_sync_failed", message: error instanceof Error ? error.message : String(error) });
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

    const updated = await onEnvelopeStatus(envelopeId, status);
    return res.json({ ok: true, envelopeId, status, record: updated });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "connect_webhook_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/applications/:applicationId", authRequired, requireBackoffice, async (req, res) => {
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

router.get("/envelopes/:envelopeId", authRequired, requireBackoffice, async (req, res) => {
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
