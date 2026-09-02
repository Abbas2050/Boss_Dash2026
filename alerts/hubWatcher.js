import * as signalR from "@microsoft/signalr";
import { diffBreaches, nextConnState, classifyHubFailure, shouldRenotify } from "./alertLogic.js";
import { getBackendToken } from "../wallet/backendToken.js";
import { redactText } from "../wallet/redactSecrets.js";
import {
  sendAlertEmail,
  sendAlertTelegram,
  buildLpMarginEmail,
  buildBackendDownEmail,
  buildBackendAuthFailedEmail,
  buildBackendRecoveredEmail,
} from "./alertNotifier.js";

/**
 * Re-notify this often while the connection is still down. Six hours: long
 * enough that a backend restart or a short outage resolves without a second
 * email, short enough that a permanent failure cannot sit silently for a
 * working day. Set BACKEND_DOWN_RENOTIFY_MS to 0 to turn the reminder off.
 */
export const DEFAULT_RENOTIFY_MS = 6 * 60 * 60 * 1000;

export function renotifyIntervalMs(env = process.env) {
  const raw = env.BACKEND_DOWN_RENOTIFY_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_RENOTIFY_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_RENOTIFY_MS;
}

/**
 * The Bearer the watcher presents on /ws/dashboard/negotiate.
 *
 * WHY THIS EXISTS
 * This used to read a single `process.env.SIGNALR_TOKEN`, a static legacy
 * token that is set in no environment and appears nowhere else in the
 * codebase. When it was empty the connection was built with no
 * accessTokenFactory at all, so negotiate went out anonymous. Once the backend
 * started refusing anonymous negotiate with 401 the watcher could never
 * connect: it emailed "backend unreachable" once, retried every 15 seconds
 * forever, and LpMarginAlerts stopped being delivered entirely. The browser
 * hit the same wall and was fixed in b4f56b3.
 *
 * WHY IT DOES NOT GO THROUGH /api/backend/hub-token LIKE THE BROWSER DOES
 * That endpoint exists because the browser must not hold BACKEND_API_KEY. This
 * process IS the holder of that key -- it is the process that endpoint calls
 * into -- so an HTTP round trip to ourselves would add a hop, a session
 * requirement and a failure mode to reach a token already in memory. We call
 * the exchange directly.
 *
 * WHY IT ASKS AGAIN ON EVERY INVOCATION
 * SignalR calls the factory afresh on every negotiate and every automatic
 * reconnect, and this watcher is meant to run for weeks against a token that
 * lives one hour. A token captured once at startup would work until the first
 * reconnect after expiry and then fail forever -- the same shape of bug this
 * file is fixing. getBackendToken() caches and refreshes ahead of expiry, so
 * calling it per invocation costs nothing in the common case.
 *
 * SIGNALR_TOKEN is kept as an explicit override for anyone who has it set, but
 * it is no longer the only path: unset, we fall through to the exchange, never
 * to no authentication.
 */
export function createHubAccessTokenFactory({ getToken = getBackendToken, env = process.env } = {}) {
  return async () => {
    // Read at call time, not at build time: an override added to .env should
    // take effect on the next reconnect, not require a restart, and a test
    // must be able to set it after the factory exists.
    const override = String(env.SIGNALR_TOKEN || "").trim();
    if (override) return override;
    return await getToken();
  };
}

/**
 * The options object handed to `.withUrl()`.
 *
 * Always carries an accessTokenFactory. The previous `token ? {...} : {}` was
 * the whole bug: with the env var unset the second branch produced a
 * connection that negotiated anonymously, and there is no configuration in
 * which that is what we want.
 */
export function buildHubUrlOptions(deps = {}) {
  return { accessTokenFactory: createHubAccessTokenFactory(deps) };
}

/**
 * Maps a failure classification to the alert that describes it. Kept next to
 * the watcher rather than inside the notifier so the notifier stays a set of
 * templates with no opinion about connection state.
 */
export function alertForKind(kind, { repeat = false } = {}) {
  if (kind === "recovered") {
    return { ...buildBackendRecoveredEmail(), telegram: "✓ Data backend recovered" };
  }
  if (kind === "auth") {
    return {
      ...buildBackendAuthFailedEmail({ repeat }),
      telegram: `⚠ Data backend ${repeat ? "still " : ""}rejecting dashboard credentials`,
    };
  }
  return {
    ...buildBackendDownEmail({ repeat }),
    telegram: `⚠ Data backend ${repeat ? "still " : ""}unreachable`,
  };
}

/**
 * Holds the connection's alerting state: which alert to send, and when a
 * repeat is due.
 *
 * Separated from startHubWatcher() because everything interesting here is
 * decided by timing and by error shape, and neither can be exercised through a
 * real SignalR connection in a test. startHubWatcher() below is the wiring;
 * this is the behaviour.
 *
 * @param {object} opts
 * @param {(alert: {kind: string, repeat: boolean}) => void} opts.notify
 * @param {() => number} [opts.now]
 * @param {number} [opts.renotifyMs]
 */
export function createBackendConnectionMonitor({ notify, now = () => Date.now(), renotifyMs = DEFAULT_RENOTIFY_MS }) {
  let connState = "up"; // optimistic; first successful start keeps it up
  let lastNotifiedAt = null;

  return {
    get state() {
      return connState;
    },
    /**
     * A connection event. `error` is the failure that closed or refused the
     * connection, and is what decides auth-vs-unreachable.
     * @param {"connected"|"closed"} event
     */
    handleEvent(event, error) {
      const { state, action } = nextConnState(connState, event);
      connState = state;
      if (action === "down-email") {
        lastNotifiedAt = now();
        notify({ kind: classifyHubFailure(error), repeat: false });
        return action;
      }
      if (action === "recovered-email") {
        // Cleared so that a later outage starts its own re-notification clock
        // rather than inheriting the previous one and firing immediately.
        lastNotifiedAt = null;
        notify({ kind: "recovered", repeat: false });
        return action;
      }
      return null;
    },
    /**
     * A reconnect attempt failed while we are already down. Almost always a
     * no-op -- it fires an email only once the re-notify interval has fully
     * elapsed, which is what stops the 15-second retry loop from becoming a
     * 15-second email loop.
     */
    handleRetryFailure(error) {
      if (connState !== "down") return null;
      if (!shouldRenotify(lastNotifiedAt, now(), renotifyMs)) return null;
      lastNotifiedAt = now();
      // Reclassified from the CURRENT error, not the original: an outage that
      // started as "unreachable" and is now a 401 has changed who needs to act
      // on it.
      notify({ kind: classifyHubFailure(error), repeat: true });
      return "down-email";
    },
  };
}

/** Start the always-on alert watcher. Returns the connection (or null if disabled). */
export function startHubWatcher() {
  if (String(process.env.ALERTS_WATCHER_ENABLED || "true") === "false") {
    console.log("[Alerts] hub watcher disabled by ALERTS_WATCHER_ENABLED=false");
    return null;
  }
  const base = String(
    process.env.BACKEND_API_TARGET || process.env.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com",
  ).replace(/\/+$/, "");
  const cooldownMs = Number(process.env.LP_ALERT_COOLDOWN_MS) || 600000;
  const retries = Math.max(1, Number(process.env.BACKEND_DOWN_RETRIES) || 3);
  const reconnectDelays = Array.from({ length: retries }, (_, i) => (i === 0 ? 0 : i * 2500));

  let active = new Map();
  let retrying = false;

  const conn = new signalR.HubConnectionBuilder()
    .withUrl(`${base}/ws/dashboard`, buildHubUrlOptions())
    .withAutomaticReconnect(reconnectDelays)
    .configureLogging(signalR.LogLevel.None)
    .build();

  const monitor = createBackendConnectionMonitor({
    renotifyMs: renotifyIntervalMs(),
    notify: ({ kind, repeat }) => {
      const { subject, html, telegram } = alertForKind(kind, { repeat });
      void sendAlertEmail({ subject, html });
      void sendAlertTelegram(telegram);
    },
  });

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

  // redactText on every failure we print: the error can be a token-exchange
  // rejection, and a gateway complaining about a credential frequently echoes
  // that credential back in the complaint.
  const describe = (e) => redactText(String(e?.message || e || "unknown error"));

  function handleConn(event, error) {
    if (monitor.handleEvent(event, error) === "down-email") void reconnectLoop();
  }

  conn.onreconnected(() => handleConn("connected"));
  conn.onclose((error) => handleConn("closed", error));

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
      } catch (e) {
        // Silent for the whole re-notify interval, then one email. Without
        // this the outage of 01:14 would have been reported once and then
        // never again, however long it lasted.
        monitor.handleRetryFailure(e);
      }
    }
    retrying = false;
  }

  (async () => {
    try {
      await conn.start();
      console.log(`[Alerts] hub watcher connected to ${base}/ws/dashboard`);
    } catch (e) {
      console.error("[Alerts] hub initial connect failed:", describe(e));
      // conn.start() rejecting does not fire onclose -- the connection never
      // reached Connected -- so the first failure has to be reported here.
      handleConn("closed", e);
    }
  })();

  return conn;
}
