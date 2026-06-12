import * as signalR from "@microsoft/signalr";
import { diffBreaches, nextConnState } from "./alertLogic.js";
import {
  sendAlertEmail,
  sendAlertTelegram,
  buildLpMarginEmail,
  buildBackendDownEmail,
  buildBackendRecoveredEmail,
} from "./alertNotifier.js";

/** Start the always-on alert watcher. Returns the connection (or null if disabled). */
export function startHubWatcher() {
  if (String(process.env.ALERTS_WATCHER_ENABLED || "true") === "false") {
    console.log("[Alerts] hub watcher disabled by ALERTS_WATCHER_ENABLED=false");
    return null;
  }
  const base = String(
    process.env.BACKEND_API_TARGET || process.env.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com",
  ).replace(/\/+$/, "");
  const token = process.env.SIGNALR_TOKEN || "";
  const cooldownMs = Number(process.env.LP_ALERT_COOLDOWN_MS) || 600000;
  const retries = Math.max(1, Number(process.env.BACKEND_DOWN_RETRIES) || 3);
  const reconnectDelays = Array.from({ length: retries }, (_, i) => (i === 0 ? 0 : i * 2500));

  let active = new Map();
  let connState = "up"; // optimistic; first successful start keeps it up
  let retrying = false;

  const conn = new signalR.HubConnectionBuilder()
    .withUrl(`${base}/ws/dashboard`, token ? { accessTokenFactory: () => token } : {})
    .withAutomaticReconnect(reconnectDelays)
    .configureLogging(signalR.LogLevel.None)
    .build();

  conn.on("LpMarginAlerts", (rows) => {
    try {
      const list = Array.isArray(rows) ? rows : [];
      const { newlyBreached, nextActive } = diffBreaches(active, list, Date.now(), cooldownMs);
      active = nextActive;
      if (newlyBreached.length) {
        const { subject, html } = buildLpMarginEmail(newlyBreached);
        void sendAlertEmail({ subject, html });
        void sendAlertTelegram(`⚠ LP Margin: ${newlyBreached.length} account(s) below threshold`);
      }
    } catch (e) {
      console.error("[Alerts] LpMarginAlerts handler error:", e?.message || e);
    }
  });

  function handleConn(event) {
    const { state, action } = nextConnState(connState, event);
    connState = state;
    if (action === "down-email") {
      const { subject, html } = buildBackendDownEmail();
      void sendAlertEmail({ subject, html });
      void sendAlertTelegram("⚠ Data backend unreachable");
      void reconnectLoop();
    } else if (action === "recovered-email") {
      const { subject, html } = buildBackendRecoveredEmail();
      void sendAlertEmail({ subject, html });
      void sendAlertTelegram("✓ Data backend recovered");
    }
  }

  conn.onreconnected(() => handleConn("connected"));
  conn.onclose(() => handleConn("closed"));

  async function reconnectLoop() {
    if (retrying) return;
    retrying = true;
    while (conn.state !== signalR.HubConnectionState.Connected) {
      await new Promise((r) => setTimeout(r, 15000));
      try {
        await conn.start();
        retrying = false;
        handleConn("connected");
        return;
      } catch {
        /* keep trying */
      }
    }
    retrying = false;
  }

  (async () => {
    try {
      await conn.start();
      connState = "up";
      console.log(`[Alerts] hub watcher connected to ${base}/ws/dashboard`);
    } catch (e) {
      console.error("[Alerts] hub initial connect failed:", e?.message || e);
      handleConn("closed");
    }
  })();

  return conn;
}
