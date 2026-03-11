import { createEnvelopeFromTemplate } from "./client.js";
import { fetchCrmApplicationsByType, fetchCrmUserById } from "./crm.js";
import { findByApplicationId, upsertEnvelopeMap } from "./store.js";

const syncState = {
  schedulerEnabled: false,
  intervalSeconds: null,
  isRunning: false,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastTrigger: null,
  lastSummary: null,
  lastError: null,
};

function nowIso() {
  return new Date().toISOString();
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

function buildDefaultCreatedAtWindow() {
  const lookbackMinutes = Math.max(1, Number(process.env.DOCUSIGN_SYNC_LOOKBACK_MINUTES || 6) || 6);
  const end = new Date();
  const begin = new Date(end.getTime() - lookbackMinutes * 60 * 1000);
  return {
    begin: toSqlDateTime(begin),
    end: toSqlDateTime(end),
    lookbackMinutes,
  };
}

function buildApplicationsQuery(options) {
  const window = options?.createdAt && typeof options.createdAt === "object"
    ? options.createdAt
    : buildDefaultCreatedAtWindow();

  const segment = options?.segment && typeof options.segment === "object"
    ? options.segment
    : { limit: 500, offset: 0 };

  const orders = Array.isArray(options?.orders) && options.orders.length > 0
    ? options.orders
    : [{ field: "id", direction: "DESC" }];

  const query = {
    createdAt: {
      begin: String(window.begin || "").trim(),
      end: String(window.end || "").trim(),
    },
    segment,
    orders,
  };

  if (options?.user != null) query.user = options.user;
  if (options?.processedAt) query.processedAt = options.processedAt;
  if (options?.checkedAt) query.checkedAt = options.checkedAt;
  if (options?.uploadedByClient != null) query.uploadedByClient = Boolean(options.uploadedByClient);

  return query;
}

export function getDocusignSyncState() {
  return {
    ...syncState,
    lastSummary: syncState.lastSummary ? { ...syncState.lastSummary } : null,
  };
}

export async function runApprovedApplicationsSync(options = {}, trigger = "manual") {
  if (syncState.isRunning) {
    return { skipped: true, reason: "sync_already_running", state: getDocusignSyncState() };
  }

  syncState.isRunning = true;
  syncState.lastStartedAt = nowIso();
  syncState.lastTrigger = trigger;
  syncState.lastError = null;

  try {
    const summary = await processApprovedApplications(options);
    syncState.lastSummary = summary;
    syncState.lastCompletedAt = nowIso();
    return summary;
  } catch (error) {
    syncState.lastCompletedAt = nowIso();
    syncState.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    syncState.isRunning = false;
  }
}

export async function processApprovedApplications(options = {}) {
  const type = String(options.type || "docusign").trim() || "docusign";
  const templateId = String(options.templateId || "").trim() || undefined;
  const roleName = String(options.roleName || "").trim() || undefined;
  const docType = String(options.docType || "approve-form").trim() || "approve-form";

  const query = buildApplicationsQuery(options);
  const apps = await fetchCrmApplicationsByType(type, query);
  const summary = {
    fetched: apps.length,
    approved: 0,
    alreadySent: 0,
    skippedNotApproved: 0,
    skippedMissingUser: 0,
    skippedMissingSigner: 0,
    sent: 0,
    failed: 0,
    query,
    sentItems: [],
    failedItems: [],
  };

  for (const app of apps) {
    const applicationId = String(app?.id || "").trim();
    const status = String(app?.status || "").trim().toLowerCase();
    const userId = Number(app?.userId || 0) || null;

    if (!applicationId) continue;

    if (status !== "approved") {
      summary.skippedNotApproved += 1;
      continue;
    }

    summary.approved += 1;

    const existing = await findByApplicationId(applicationId);
    if (existing?.envelope_id) {
      summary.alreadySent += 1;
      continue;
    }

    if (!userId) {
      summary.skippedMissingUser += 1;
      continue;
    }

    try {
      const crmUser = await fetchCrmUserById(userId);
      const signerEmail = String(crmUser?.email || "").trim().toLowerCase();
      const signerName = `${String(crmUser?.firstName || "").trim()} ${String(crmUser?.lastName || "").trim()}`.trim();

      if (!signerEmail || !signerName) {
        summary.skippedMissingSigner += 1;
        continue;
      }

      const created = await createEnvelopeFromTemplate({
        signerEmail,
        signerName,
        templateId,
        roleName,
        applicationId,
      });

      await upsertEnvelopeMap({
        applicationId,
        applicantEmail: signerEmail,
        applicantName: signerName,
        envelopeId: created.envelopeId,
        status: created.status,
        templateId: templateId || process.env.DOCUSIGN_TEMPLATE_ID || "",
        docType,
        rawPayload: app,
      });

      summary.sent += 1;
      summary.sentItems.push({ applicationId, envelopeId: created.envelopeId, status: created.status });
    } catch (error) {
      summary.failed += 1;
      summary.failedItems.push({
        applicationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

export function startDocusignApprovedSyncScheduler() {
  const enabled = String(process.env.DOCUSIGN_AUTO_SYNC_ENABLED || "false").toLowerCase() === "true";
  syncState.schedulerEnabled = enabled;
  if (!enabled) return null;

  const intervalSeconds = Math.max(30, Number(process.env.DOCUSIGN_AUTO_SYNC_INTERVAL_SECONDS || 300) || 300);
  const intervalMs = intervalSeconds * 1000;

  syncState.intervalSeconds = intervalSeconds;

  const runOnce = async (trigger) => {
    try {
      const result = await runApprovedApplicationsSync({}, trigger);
      if (result?.skipped) return;
      console.log(
        `[docusign-sync] fetched=${result.fetched} approved=${result.approved} sent=${result.sent} alreadySent=${result.alreadySent} skippedNotApproved=${result.skippedNotApproved} failed=${result.failed}`
      );
    } catch (error) {
      console.error("[docusign-sync] failed:", error instanceof Error ? error.message : String(error));
    }
  };

  const timer = setInterval(() => {
    runOnce("scheduler_interval");
  }, intervalMs);

  const runOnStartup = String(process.env.DOCUSIGN_AUTO_SYNC_RUN_ON_START || "true").toLowerCase() === "true";
  if (runOnStartup) {
    setTimeout(() => {
      runOnce("scheduler_startup");
    }, 3000);
  }

  console.log(`[docusign-sync] scheduler started (interval=${intervalSeconds}s)`);
  return {
    stop: () => clearInterval(timer),
    intervalSeconds,
  };
}
