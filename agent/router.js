import express from "express";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import { agentCapabilities, runAgentChat } from "./llmAgent.js";
import { dateUtils, getLiveSnapshot } from "./metricsService.js";
import {
  analyzeClientByAccountLogin,
  closeLatestRunningClientProfileRun,
  createClientProfileActionAuditLog,
  getClientProfileRunErrors,
  getClientProfileDashboardSummary,
  listClientProfileActionAuditLogs,
  listClientProfileRuns,
  listClientProfileRunStepLogs,
  listCurrentClientProfiles,
  runClientProfilingJob,
} from "./clientProfilingService.js";

const router = express.Router();
const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || "";
const AUTH_DB_HOST = process.env.AUTH_DB_HOST;
const AUTH_DB_PORT = Number(process.env.AUTH_DB_PORT || 3306);
const AUTH_DB_NAME = process.env.AUTH_DB_NAME;
const AUTH_DB_USER = process.env.AUTH_DB_USER;
const AUTH_DB_PASSWORD = process.env.AUTH_DB_PASSWORD;

let pool = null;
let initPromise = null;

function hasDbConfig() {
  return Boolean(AUTH_DB_HOST && AUTH_DB_NAME && AUTH_DB_USER && AUTH_DB_PASSWORD);
}

async function ensureDbInitialized() {
  if (pool) return;
  if (initPromise) return initPromise;
  if (!hasDbConfig()) {
    throw new Error("auth_db_not_configured");
  }

  initPromise = (async () => {
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
  })();

  return initPromise;
}

function parseToken(req) {
  const raw = req.headers.authorization || "";
  const headerToken = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";
  return headerToken || queryToken || "";
}

function canUseLiveAgent(payload) {
  if (!payload) return false;
  if (String(payload.role || "").trim().toLowerCase() === "super admin") return true;
  const access = Array.isArray(payload.access) ? payload.access : [];
  return access.includes("LiveAgent") || access.includes("Backoffice");
}

function isSuperAdmin(payload) {
  return String(payload?.role || "").trim().toLowerCase() === "super admin";
}

async function requireLiveAgentAccess(req, res, next) {
  if (!AUTH_JWT_SECRET) {
    return res.status(503).json({ error: "auth_not_configured" });
  }

  try {
    await ensureDbInitialized();
  } catch {
    return res.status(503).json({ error: "auth_service_unavailable" });
  }

  const token = parseToken(req);
  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    const payload = jwt.verify(token, AUTH_JWT_SECRET);

    const [rows] = await pool.query(
      "SELECT id, email, role, status, access_json, token_version FROM users WHERE id=? LIMIT 1",
      [payload.sub]
    );
    if (!rows.length) return res.status(401).json({ error: "user_not_found" });

    const user = rows[0];
    if (String(user.status || "") !== "active") return res.status(403).json({ error: "user_suspended" });

    const tokenVersion = Number(user.token_version || 1);
    if (Number(payload?.tv || 1) !== tokenVersion) {
      return res.status(401).json({ error: "revoked_token" });
    }

    let access = [];
    try {
      const parsed = typeof user.access_json === "string" ? JSON.parse(user.access_json || "[]") : user.access_json;
      access = Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      access = [];
    }

    const resolvedAuth = {
      ...payload,
      sub: String(user.id),
      email: String(user.email || ""),
      role: String(user.role || ""),
      status: String(user.status || ""),
      access,
      tv: tokenVersion,
    };

    if (!canUseLiveAgent(resolvedAuth)) return res.status(403).json({ error: "forbidden" });
    req.auth = resolvedAuth;
    next();
  } catch (error) {
    if (error?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "expired_token" });
    }
    return res.status(401).json({ error: "invalid_token" });
  }
}

router.get("/capabilities", requireLiveAgentAccess, (req, res) => {
  try {
    res.json(agentCapabilities());
  } catch (error) {
    res.json({
      model: "rule-based-fallback",
      tools: [],
      warning: error?.message || "capabilities_unavailable",
    });
  }
});

router.post("/client-profiles/run", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const body = req.body || {};
    const clientIds = Array.isArray(body.clientIds)
      ? body.clientIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const result = await runClientProfilingJob({
      runType: String(body.runType || "manual"),
      snapshotDate: body.snapshotDate,
      maxClients: Number(body.maxClients) || undefined,
      clientIds,
      dryRun: Boolean(body.dryRun),
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_run_failed",
      message: error?.message || String(error),
    });
  }
});

router.get("/client-profiles/current", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const clientId = Number(req.query.clientId);
    const rows = await listCurrentClientProfiles({
      clientId: Number.isFinite(clientId) && clientId > 0 ? clientId : undefined,
      limit: Number(req.query.limit) || 100,
    });
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_current_fetch_failed",
      message: error?.message || String(error),
    });
  }
});

router.get("/client-profiles/dashboard", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const data = await getClientProfileDashboardSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_dashboard_failed",
      message: error?.message || String(error),
    });
  }
});

router.get("/client-profiles/analyze-account/:login", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const login = Number(req.params.login);
    if (!Number.isFinite(login) || login <= 0) return res.status(400).json({ ok: false, error: "invalid_login" });
    const data = await analyzeClientByAccountLogin(login);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_analysis_failed",
      message: error?.message || String(error),
    });
  }
});

router.get("/client-profiles/runs", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const rows = await listClientProfileRuns(Number(req.query.limit) || 50);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_runs_fetch_failed",
      message: error?.message || String(error),
    });
  }
});

router.get("/client-profiles/runs/:runId/errors", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const runId = Number(req.params.runId);
    if (!Number.isFinite(runId) || runId <= 0) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    const rows = await getClientProfileRunErrors(runId, Number(req.query.limit) || 200);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_run_errors_fetch_failed",
      message: error?.message || String(error),
    });
  }
});

router.get("/client-profiles/runs/:runId/steps", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const runId = Number(req.params.runId);
    if (!Number.isFinite(runId) || runId <= 0) return res.status(400).json({ ok: false, error: "invalid_run_id" });
    const rows = await listClientProfileRunStepLogs(runId, Number(req.query.limit) || 100);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_run_steps_fetch_failed",
      message: error?.message || String(error),
    });
  }
});

router.post("/client-profiles/runs/close-stuck", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const body = req.body || {};
    const result = await closeLatestRunningClientProfileRun(String(body.reason || "Manually closed stuck run from CP UI"));
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_close_stuck_failed",
      message: error?.message || String(error),
    });
  }
});

router.post("/client-profiles/actions", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const body = req.body || {};
    if (body.confirm !== true) {
      return res.status(400).json({ ok: false, error: "confirmation_required" });
    }
    const row = await createClientProfileActionAuditLog({
      actionKey: body.actionKey,
      clientId: body.clientId,
      login: body.login,
      recommendedBook: body.recommendedBook,
      confidencePct: body.confidencePct,
      confirmationNote: body.confirmationNote,
      payload: body.payload || {},
      actorUserId: req.auth?.sub || "",
      actorEmail: req.auth?.email || null,
      actorRole: req.auth?.role || null,
    });
    return res.json({ ok: true, auditId: row.id });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_action_log_failed",
      message: error?.message || String(error),
    });
  }
});

router.get("/client-profiles/actions/audit", requireLiveAgentAccess, async (req, res) => {
  if (!isSuperAdmin(req.auth)) return res.status(403).json({ ok: false, error: "forbidden_super_admin_only" });
  try {
    const rows = await listClientProfileActionAuditLogs(Number(req.query.limit) || 100);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "client_profile_action_audit_fetch_failed",
      message: error?.message || String(error),
    });
  }
});

router.post("/chat", requireLiveAgentAccess, async (req, res) => {
  const body = req.body || {};
  const range = dateUtils.buildRange({
    fromDate: body.fromDate,
    toDate: body.toDate,
  });

  try {
    const result = await runAgentChat({
      message: String(body.message || ""),
      history: Array.isArray(body.history) ? body.history : [],
      context: {
        fromDate: range.from,
        toDate: range.to,
      },
    });

    res.json({
      ok: true,
      answer: result.answer,
      toolsUsed: result.toolsUsed || [],
      toolSummaries: result.toolSummaries || [],
      context: {
        fromDate: range.from,
        toDate: range.to,
      },
      at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Agent chat failed",
    });
  }
});

router.get("/live", requireLiveAgentAccess, async (req, res) => {
  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    const range = dateUtils.buildRange({
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
    });

    const send = async () => {
      try {
        const snapshot = await getLiveSnapshot(range);
        res.write(`event: snapshot\n`);
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch (error) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: error?.message || "snapshot error" })}\n\n`);
      }
    };

    send();
    const interval = setInterval(send, 15000);

    req.on("close", () => {
      clearInterval(interval);
      try {
        res.end();
      } catch {
        // ignore
      }
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(200).json({
        ok: false,
        warning: error?.message || "live_unavailable",
      });
    }
  }
});

export default router;
