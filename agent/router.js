import express from "express";
import jwt from "jsonwebtoken";
import { agentCapabilities, runAgentChat } from "./llmAgent.js";
import { dateUtils, getLiveSnapshot } from "./metricsService.js";

const router = express.Router();
const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || "";

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

function requireLiveAgentAccess(req, res, next) {
  if (!AUTH_JWT_SECRET) {
    return res.status(503).json({ error: "auth_not_configured" });
  }
  const token = parseToken(req);
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    const payload = jwt.verify(token, AUTH_JWT_SECRET);
    if (!canUseLiveAgent(payload)) return res.status(403).json({ error: "forbidden" });
    req.auth = payload;
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
