import express from "express";
import { agentCapabilities, runAgentChat } from "./llmAgent.js";
import { dateUtils, getLiveSnapshot } from "./metricsService.js";

const router = express.Router();

router.get("/capabilities", (req, res) => {
  res.json(agentCapabilities());
});

router.post("/chat", async (req, res) => {
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

router.get("/live", async (req, res) => {
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
});

export default router;
