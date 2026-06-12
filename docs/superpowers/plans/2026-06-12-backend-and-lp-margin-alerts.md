# Backend-Down & LP-Margin Alerts (Email + Sound) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two operational alerts — (1) external data backend unreachable, (2) LP margin breach — delivering always-on server-side email and an in-app long/loud sound + banner when a dashboard is open.

**Architecture:** One persistent `@microsoft/signalr` client in our Node server (`alerts/hubWatcher.js`) observes the external `/ws/dashboard` hub and sends all emails (Brevo/Telegram), 24/7. One global SignalR connection in the browser (`AlertsHubProvider`) drives the sound + disconnect banner when the app is open. Pure decision logic (breach de-dup, connection state machine) is isolated and unit-tested; SignalR/Brevo/WebAudio are thin I/O wrappers.

**Tech Stack:** Node ESM + Express (`server.js`), `@microsoft/signalr` (already a dependency), React + TypeScript + Vite, vitest, WebAudio.

**Spec:** `docs/superpowers/specs/2026-06-12-backend-and-lp-margin-alerts-design.md`

**Depends on:** the LP Margin Alerts component (`src/components/dashboard/LpMarginAlerts.tsx`) and the `SignalRConnectionManager` (`src/lib/signalRConnectionManager.ts`). This plan is implemented on top of the `feat/lp-margin-alerts` branch (where those live).

---

## File structure

- New (Node): `alerts/alertLogic.js` (pure: breach de-dup + connection state machine), `alerts/alertNotifier.js` (Brevo/Telegram senders + email HTML), `alerts/hubWatcher.js` (SignalR client wiring).
- New (Node test): `alerts/alertLogic.test.js`.
- New (browser): `src/lib/alertSound.ts` (WebAudio alarm + sound pref), `src/lib/alertBreaches.ts` (pure: new-breach diff for sound), `src/components/AlertsHubProvider.tsx` (context + connection).
- New (browser test): `src/lib/alertBreaches.test.ts`, `src/lib/alertSound.test.ts`.
- Modify: `server.js` (start watcher on boot), `src/components/Layout.tsx` (mount provider + banner), `src/components/dashboard/LpMarginAlerts.tsx` (consume context), `src/pages/settings/AlertsSettingsPage.tsx` (Sound Alerts card).

Note: to avoid destabilizing the working wallet report, `alerts/alertNotifier.js` is self-contained (it has its own small Brevo POST). We do **not** refactor `wallet/notifier.js` in this plan.

---

## Task 0: Branch

**Files:** none

- [ ] **Step 1: Create a feature branch off the current LP-margin work**

Run:
```bash
git checkout -b feat/alerts-email-sound
```
Expected: `Switched to a new branch 'feat/alerts-email-sound'`

---

## Task 1: Pure alert logic (Node) — breach de-dup + connection state machine

**Files:**
- Create: `alerts/alertLogic.js`
- Test: `alerts/alertLogic.test.js`

- [ ] **Step 1: Write the failing test**

Create `alerts/alertLogic.test.js`:
```js
import { describe, expect, it } from "vitest";
import { diffBreaches, nextConnState } from "./alertLogic.js";

describe("diffBreaches", () => {
  const COOLDOWN = 600000; // 10 min

  it("flags a first-time breach and records the time", () => {
    const { newlyBreached, nextActive } = diffBreaches(new Map(), [{ login: 101 }], 1000, COOLDOWN);
    expect(newlyBreached.map((r) => r.login)).toEqual([101]);
    expect(nextActive.get("101")).toBe(1000);
  });

  it("suppresses a repeat breach within the cooldown", () => {
    const active = new Map([["101", 1000]]);
    const { newlyBreached, nextActive } = diffBreaches(active, [{ login: 101 }], 1000 + 60000, COOLDOWN);
    expect(newlyBreached).toEqual([]);
    expect(nextActive.get("101")).toBe(1000); // unchanged
  });

  it("re-fires a breach after the cooldown elapses", () => {
    const active = new Map([["101", 1000]]);
    const { newlyBreached, nextActive } = diffBreaches(active, [{ login: 101 }], 1000 + COOLDOWN, COOLDOWN);
    expect(newlyBreached.map((r) => r.login)).toEqual([101]);
    expect(nextActive.get("101")).toBe(1000 + COOLDOWN);
  });

  it("re-arms a login that is no longer breached (drops from active)", () => {
    const active = new Map([["101", 1000]]);
    const { newlyBreached, nextActive } = diffBreaches(active, [], 2000, COOLDOWN);
    expect(newlyBreached).toEqual([]);
    expect(nextActive.has("101")).toBe(false);
  });

  it("ignores rows without a login", () => {
    const { newlyBreached, nextActive } = diffBreaches(new Map(), [{ login: "" }, { login: 5 }], 1, COOLDOWN);
    expect(newlyBreached.map((r) => r.login)).toEqual([5]);
    expect(nextActive.size).toBe(1);
  });
});

describe("nextConnState", () => {
  it("up + closed => down with down-email", () => {
    expect(nextConnState("up", "closed")).toEqual({ state: "down", action: "down-email" });
  });
  it("down + closed => stays down, no action", () => {
    expect(nextConnState("down", "closed")).toEqual({ state: "down", action: null });
  });
  it("down + connected => up with recovered-email", () => {
    expect(nextConnState("down", "connected")).toEqual({ state: "up", action: "recovered-email" });
  });
  it("up + connected => stays up, no action", () => {
    expect(nextConnState("up", "connected")).toEqual({ state: "up", action: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run alerts/alertLogic.test.js`
Expected: FAIL — `alerts/alertLogic.js` does not exist.

- [ ] **Step 3: Create the module**

Create `alerts/alertLogic.js`:
```js
// Pure decision logic for alerts — no I/O, fully unit-testable.

/**
 * Decide which currently-breached LP logins are "newly breached" (and should be emailed),
 * applying a per-login cooldown so a persistent/flapping breach does not spam.
 *
 * @param {Map<string, number>} active  login -> last-emailed epoch ms
 * @param {Array<{login?: string|number}>} rows  currently-breached rows from LpMarginAlerts
 * @param {number} nowMs
 * @param {number} cooldownMs
 * @returns {{ newlyBreached: Array<object>, nextActive: Map<string, number> }}
 */
export function diffBreaches(active, rows, nowMs, cooldownMs) {
  const next = new Map();
  const newlyBreached = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const login = String(row?.login ?? "").trim();
    if (!login) continue;
    const last = active.get(login);
    if (last === undefined || nowMs - last >= cooldownMs) {
      newlyBreached.push(row);
      next.set(login, nowMs);
    } else {
      next.set(login, last);
    }
  }
  return { newlyBreached, nextActive: next };
}

/**
 * Edge-triggered backend connection state machine.
 * @param {"up"|"down"} prev
 * @param {"connected"|"closed"} event
 * @returns {{ state: "up"|"down", action: null|"down-email"|"recovered-email" }}
 */
export function nextConnState(prev, event) {
  if (event === "connected") {
    return prev === "down" ? { state: "up", action: "recovered-email" } : { state: "up", action: null };
  }
  if (event === "closed") {
    return prev !== "down" ? { state: "down", action: "down-email" } : { state: "down", action: null };
  }
  return { state: prev, action: null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run alerts/alertLogic.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add alerts/alertLogic.js alerts/alertLogic.test.js
git commit -m "feat(alerts): pure breach de-dup and connection state machine"
```

---

## Task 2: Alert notifier (Node) — Brevo email + Telegram + HTML builders

**Files:**
- Create: `alerts/alertNotifier.js`

This is thin I/O (network) — no unit test; verified by integration. Keep it self-contained.

- [ ] **Step 1: Create the module**

Create `alerts/alertNotifier.js`:
```js
// Generic alert sender (email via Brevo, optional Telegram), independent of the wallet report.

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

function getRecipients() {
  const csv = process.env.ALERT_RECIPIENTS || process.env.WALLET_RECIPIENTS || "";
  return csv.split(",").map((r) => r.trim()).filter(Boolean).map((email) => ({ email }));
}

async function postBrevo({ subject, html }) {
  const apiKey = process.env.BREVO_API_KEY || "";
  const from = process.env.EMAIL_FROM || "noreply@skylinkscapital.com";
  const recipients = getRecipients();
  if (!apiKey) return { ok: false, reason: "BREVO_API_KEY not set" };
  if (!recipients.length) return { ok: false, reason: "ALERT_RECIPIENTS not set" };

  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: { accept: "application/json", "api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ sender: { email: from, name: "SLC Alerts" }, to: recipients, subject, htmlContent: html }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, reason: `Brevo HTTP ${res.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

/** Send an alert email with a single retry. Never throws. */
export async function sendAlertEmail({ subject, html }) {
  try {
    let result = await postBrevo({ subject, html });
    if (!result.ok && result.reason && result.reason.startsWith("Brevo HTTP")) {
      result = await postBrevo({ subject, html }); // one retry on HTTP failure
    }
    if (!result.ok) console.warn(`[Alerts] email skipped/failed: ${result.reason}`);
    else console.log(`[Alerts] email sent: ${subject}`);
    return result;
  } catch (e) {
    console.error("[Alerts] email error:", e?.message || e);
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** Optional Telegram. Never throws. */
export async function sendAlertTelegram(text) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
    const channelId = process.env.TELEGRAM_CHANNEL_ID || "";
    if (!botToken || !channelId) return { ok: false, reason: "telegram not configured" };
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ chat_id: channelId, text }),
      signal: AbortSignal.timeout(20000),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `Telegram HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

const esc = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function buildLpMarginEmail(rows) {
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai" });
  const body = rows
    .map(
      (r) =>
        `<tr><td style="padding:6px;border-bottom:1px solid #eee">${esc(r.lpName || "-")}</td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee"><b>${esc(r.login ?? "-")}</b></td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee;color:#c62828"><b>${fmt(r.marginLevel)}%</b></td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee">${fmt(r.equity)}</td>` +
        `<td style="padding:6px;border-bottom:1px solid #eee">${fmt(r.freeMargin)}</td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:Arial,sans-serif">
    <h2 style="color:#c62828">⚠ LP Margin Alert — ${rows.length} account(s) below threshold</h2>
    <p style="color:#666">${when} (Asia/Dubai)</p>
    <table style="border-collapse:collapse;width:100%">
      <thead><tr style="background:#f5f5f5;text-align:left">
        <th style="padding:6px">LP Name</th><th style="padding:6px">Login</th>
        <th style="padding:6px">Margin Level</th><th style="padding:6px">Equity</th><th style="padding:6px">Free Margin</th>
      </tr></thead><tbody>${body}</tbody></table>
    <p style="color:#999;font-size:12px">Automated alert from SLC Dashboard.</p></div>`;
  return { subject: `[ALERT] LP Margin — ${rows.length} account(s) below threshold`, html };
}

export function buildBackendDownEmail() {
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai" });
  return {
    subject: "[ALERT] Data backend unreachable",
    html: `<div style="font-family:Arial,sans-serif"><h2 style="color:#c62828">⚠ Data backend unreachable</h2>
      <p>The dashboard's connection to the data backend could not be re-established after retries.</p>
      <p style="color:#666">${when} (Asia/Dubai)</p></div>`,
  };
}

export function buildBackendRecoveredEmail() {
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai" });
  return {
    subject: "[ALERT] Data backend recovered",
    html: `<div style="font-family:Arial,sans-serif"><h2 style="color:#2e7d32">✓ Data backend recovered</h2>
      <p>The connection to the data backend has been restored.</p>
      <p style="color:#666">${when} (Asia/Dubai)</p></div>`,
  };
}
```

- [ ] **Step 2: Verify it imports cleanly**

Run:
```bash
node --input-type=module -e "import('./alerts/alertNotifier.js').then(m => console.log(Object.keys(m).join(',')))"
```
Expected: prints `sendAlertEmail,sendAlertTelegram,buildLpMarginEmail,buildBackendDownEmail,buildBackendRecoveredEmail`

- [ ] **Step 3: Commit**

```bash
git add alerts/alertNotifier.js
git commit -m "feat(alerts): generic Brevo/Telegram alert notifier + email builders"
```

---

## Task 3: Hub watcher (Node) — SignalR client wiring

**Files:**
- Create: `alerts/hubWatcher.js`

Integration glue (no unit test; the pure logic it uses is tested in Task 1).

- [ ] **Step 1: Create the module**

Create `alerts/hubWatcher.js`:
```js
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

  let active = new Map();
  let connState = "up"; // optimistic; first successful start keeps it up
  let retrying = false;

  const conn = new signalR.HubConnectionBuilder()
    .withUrl(`${base}/ws/dashboard`, token ? { accessTokenFactory: () => token } : {})
    .withAutomaticReconnect([0, 2000, 5000])
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
```

- [ ] **Step 2: Verify it imports cleanly**

Run:
```bash
node --input-type=module -e "import('./alerts/hubWatcher.js').then(m => console.log(typeof m.startHubWatcher))"
```
Expected: prints `function`

- [ ] **Step 3: Commit**

```bash
git add alerts/hubWatcher.js
git commit -m "feat(alerts): node signalr hub watcher (lp-margin + backend-down emails)"
```

---

## Task 4: Wire the watcher into server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add the import**

Near the other imports at the top of `server.js` (e.g. after the `notifyIfTotalChanged` import on line ~20), add:
```js
import { startHubWatcher } from './alerts/hubWatcher.js';
```

- [ ] **Step 2: Start it when the server boots**

Find where the server starts listening (search for `.listen(` — it is the `http`/`server` listen near the bottom, around the `WebSocketServer` setup line ~812). Immediately after the server is listening (in or right after the listen callback), add:
```js
try {
  startHubWatcher();
} catch (e) {
  console.error('[Alerts] failed to start hub watcher:', e?.message || e);
}
```
(Place it so it runs once at startup and never blocks/here-throws.)

- [ ] **Step 3: Verify the server still boots**

Run:
```bash
node -e "require('child_process')" 2>/dev/null; npm run local:restart
```
Then check the backend log for the watcher line:
```bash
grep -i "hub watcher" .local-backend.log | tail -3
```
Expected: a line like `[Alerts] hub watcher connected ...` OR `[Alerts] hub initial connect failed ...` (either is fine — it means the watcher started). The server must be UP.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(alerts): start hub watcher on server boot"
```

---

## Task 5: Browser breach diff (pure) for sound

**Files:**
- Create: `src/lib/alertBreaches.ts`
- Test: `src/lib/alertBreaches.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/alertBreaches.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newBreaches } from "./alertBreaches";

describe("newBreaches", () => {
  it("reports a login that newly appears", () => {
    const { newLogins, nextLogins } = newBreaches(new Set<string>(), [{ login: 101 }]);
    expect(newLogins).toEqual(["101"]);
    expect(nextLogins.has("101")).toBe(true);
  });

  it("does not re-report a login already present", () => {
    const { newLogins } = newBreaches(new Set(["101"]), [{ login: 101 }]);
    expect(newLogins).toEqual([]);
  });

  it("drops logins no longer present", () => {
    const { nextLogins } = newBreaches(new Set(["101"]), []);
    expect(nextLogins.has("101")).toBe(false);
  });

  it("ignores blank logins", () => {
    const { newLogins } = newBreaches(new Set<string>(), [{ login: "" }, { login: 7 }]);
    expect(newLogins).toEqual(["7"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/alertBreaches.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module**

Create `src/lib/alertBreaches.ts`:
```ts
export type BreachRow = { login?: string | number };

/** Returns logins present now that were not present before, plus the new login set. */
export function newBreaches(
  prevLogins: Set<string>,
  rows: BreachRow[],
): { newLogins: string[]; nextLogins: Set<string> } {
  const nextLogins = new Set<string>();
  const newLogins: string[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const login = String(r?.login ?? "").trim();
    if (!login) continue;
    nextLogins.add(login);
    if (!prevLogins.has(login)) newLogins.push(login);
  }
  return { newLogins, nextLogins };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/alertBreaches.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/alertBreaches.ts src/lib/alertBreaches.test.ts
git commit -m "feat(alerts): browser new-breach diff for sound"
```

---

## Task 6: WebAudio alarm + sound preference

**Files:**
- Create: `src/lib/alertSound.ts`
- Test: `src/lib/alertSound.test.ts`

- [ ] **Step 1: Write the failing test (preference only — audio is I/O)**

Create `src/lib/alertSound.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { isSoundEnabled, setSoundEnabled } from "./alertSound";

describe("sound preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to disabled", () => {
    expect(isSoundEnabled()).toBe(false);
  });

  it("persists enabled state", () => {
    setSoundEnabled(true);
    expect(isSoundEnabled()).toBe(true);
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/alertSound.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module**

Create `src/lib/alertSound.ts`:
```ts
const PREF_KEY = "alert_sound_enabled_v1";

export function isSoundEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

let audioCtx: AudioContext | null = null;
let activeStop: (() => void) | null = null;

/** Must be called from a user gesture once before sound can play (browser autoplay policy). */
export function primeAudio(): void {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) audioCtx = new Ctor();
    }
    if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    /* ignore */
  }
}

export function stopAlarm(): void {
  try {
    activeStop?.();
  } catch {
    /* ignore */
  }
  activeStop = null;
}

/**
 * Play a LONG, LOUD two-tone siren alarm (~6s by default). Distinct cadence per kind.
 * No-op if audio is unavailable or not primed.
 */
export function playAlarm(kind: "disconnect" | "lp-margin", durationMs = 6000): void {
  try {
    primeAudio();
    if (!audioCtx) return;
    stopAlarm();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const end = now + durationMs / 1000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.6, now + 0.05); // loud
    gain.gain.setValueAtTime(0.6, end - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = "square";
    const hi = kind === "lp-margin" ? 1046 : 1318;
    const lo = kind === "lp-margin" ? 659 : 880;
    const step = kind === "lp-margin" ? 0.4 : 0.25; // distinct cadence
    const steps = Math.ceil(durationMs / 1000 / step);
    for (let i = 0; i < steps; i++) {
      osc.frequency.setValueAtTime(i % 2 === 0 ? hi : lo, now + i * step);
    }
    osc.connect(gain);
    osc.start(now);
    osc.stop(end);

    const stop = () => {
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
      try {
        gain.disconnect();
      } catch {
        /* ignore */
      }
    };
    activeStop = stop;
    osc.onended = () => {
      if (activeStop === stop) activeStop = null;
    };
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/alertSound.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add src/lib/alertSound.ts src/lib/alertSound.test.ts
git commit -m "feat(alerts): long/loud webaudio alarm + sound preference"
```

---

## Task 7: AlertsHubProvider (browser context + connection)

**Files:**
- Create: `src/components/AlertsHubProvider.tsx`

Integration glue; verified manually. Uses the tested `newBreaches` + `alertSound`.

- [ ] **Step 1: Create the provider**

Create `src/components/AlertsHubProvider.tsx`:
```tsx
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { SignalRConnectionManager, SignalRStatus } from "@/lib/signalRConnectionManager";
import { newBreaches } from "@/lib/alertBreaches";
import { isSoundEnabled, playAlarm, stopAlarm } from "@/lib/alertSound";

export type LpMarginAlertRow = {
  source?: string;
  lpName?: string;
  login?: string | number;
  marginLevel?: number;
  equity?: number;
  balance?: number;
  credit?: number;
  margin?: number;
  freeMargin?: number;
  timestampUtc?: string;
};

type AlertsHubValue = {
  status: SignalRStatus;
  lpAlerts: LpMarginAlertRow[];
  disconnected: boolean;
  silence: () => void;
};

const AlertsHubContext = createContext<AlertsHubValue>({
  status: "disconnected",
  lpAlerts: [],
  disconnected: false,
  silence: () => undefined,
});

export const useAlertsHub = () => useContext(AlertsHubContext);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
const apiUrl = (path: string) => (backendBaseUrl ? `${backendBaseUrl}${path}` : path);

export const AlertsHubProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<SignalRStatus>("disconnected");
  const [lpAlerts, setLpAlerts] = useState<LpMarginAlertRow[]>([]);
  const prevLoginsRef = useRef<Set<string>>(new Set());
  const prevStatusRef = useRef<SignalRStatus>("disconnected");

  useEffect(() => {
    const manager = new SignalRConnectionManager({
      hubUrl: apiUrl("/ws/dashboard"),
      trackedEvents: ["LpMarginAlerts"],
      reconnectDelaysMs: [0, 2000, 5000], // ~3 attempts before "disconnected"
      accessTokenFactory: async () => {
        try {
          const res = await fetch(apiUrl("/api/signalr/token"));
          if (!res.ok) return null;
          const json = await res.json();
          return json.token || null;
        } catch {
          return null;
        }
      },
    });

    const unsubStatus = manager.onStatusChange((next) => {
      setStatus(next);
      // Edge: entering "disconnected" → alarm once.
      if (next === "disconnected" && prevStatusRef.current !== "disconnected") {
        if (isSoundEnabled()) playAlarm("disconnect");
      }
      prevStatusRef.current = next;
    });

    const unsubEvent = manager.onEvent((payload, eventName) => {
      if (eventName !== "LpMarginAlerts") return;
      const rows = Array.isArray(payload) ? (payload as LpMarginAlertRow[]) : [];
      setLpAlerts(rows);
      const { newLogins, nextLogins } = newBreaches(prevLoginsRef.current, rows);
      prevLoginsRef.current = nextLogins;
      if (newLogins.length && isSoundEnabled()) playAlarm("lp-margin");
    });

    manager.connect().catch(() => undefined);

    return () => {
      unsubStatus();
      unsubEvent();
      manager.disconnect().catch(() => undefined);
      stopAlarm();
    };
  }, []);

  const value: AlertsHubValue = {
    status,
    lpAlerts,
    disconnected: status === "disconnected",
    silence: stopAlarm,
  };

  return <AlertsHubContext.Provider value={value}>{children}</AlertsHubContext.Provider>;
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/AlertsHubProvider.tsx
git commit -m "feat(alerts): global AlertsHubProvider (sound + status context)"
```

---

## Task 8: Mount provider + disconnect banner in Layout

**Files:**
- Modify: `src/components/Layout.tsx`

- [ ] **Step 1: Add imports**

At the top of `src/components/Layout.tsx`, add:
```tsx
import { AlertsHubProvider, useAlertsHub } from "./AlertsHubProvider";
```

- [ ] **Step 2: Add a banner component (bottom of the file, before `export const Layout`)**

Add this component definition above the `Layout` component:
```tsx
const DisconnectBanner: React.FC = () => {
  const { disconnected, silence } = useAlertsHub();
  if (!disconnected) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow">
      <span>⚠ Disconnected from data backend — retrying…</span>
      <button
        type="button"
        onClick={silence}
        className="rounded border border-white/40 bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20"
      >
        Silence
      </button>
    </div>
  );
};
```

- [ ] **Step 3: Wrap the rendered tree with the provider + banner**

In the `Layout` component's returned JSX, wrap the existing outermost returned element with `<AlertsHubProvider>` and render `<DisconnectBanner />` inside it. For example, change:
```tsx
  return (
    <div className={theme === "dark" ? "theme-dark" : "theme-light"}>
      <DashboardHeader theme={theme} onThemeToggle={toggleTheme} />
      ...
    </div>
  );
```
to:
```tsx
  return (
    <AlertsHubProvider>
      <DisconnectBanner />
      <div className={theme === "dark" ? "theme-dark" : "theme-light"}>
        <DashboardHeader theme={theme} onThemeToggle={toggleTheme} />
        ...
      </div>
    </AlertsHubProvider>
  );
```
(Keep all existing children of the `<div>` unchanged — only wrap and add the banner.)

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json` → clean.
```bash
git add src/components/Layout.tsx
git commit -m "feat(alerts): mount AlertsHubProvider + disconnect banner in Layout"
```

---

## Task 9: LP Margin Alerts page consumes the shared context

**Files:**
- Modify: `src/components/dashboard/LpMarginAlerts.tsx`

Goal: remove this component's own SignalR connection and read `status` + `lpAlerts` from `useAlertsHub()`. Keep the settings load/save (`/api/AlertSettings`) and the grid/status-bar UI.

- [ ] **Step 1: Replace the connection with the shared hook**

Read the current file. Then:
- Add import: `import { useAlertsHub } from "@/components/AlertsHubProvider";`
- Remove the `import { SignalRConnectionManager, SignalRStatus } from "@/lib/signalRConnectionManager";` line and the entire `useEffect` block that builds/connects the `SignalRConnectionManager` (the one subscribing to `LpMarginAlerts`), plus the local `managerRef`, the local `rows` state's population from the event, and the local `status` state.
- Replace them with:
```tsx
  const { status, lpAlerts } = useAlertsHub();
  const rows = lpAlerts;
```
- Drive `lastTickAt` from `lpAlerts` changes. Add:
```tsx
  useEffect(() => {
    if (lpAlerts.length >= 0) setLastTickAt(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lpAlerts]);
```
- Keep the settings-loading `useEffect` (GET `/api/AlertSettings`) and `saveSettings` (PUT) exactly as-is.
- Keep the 1-second `nowTick` ticker, the status bar, settings panel, and the grid — they now read `rows`/`status` from the hook.
- Ensure the `LpMarginAlertRow` type used locally matches the one exported by `AlertsHubProvider` (import it instead of redefining, OR keep the local one identical). Prefer: `import { type LpMarginAlertRow } from "@/components/AlertsHubProvider";` and delete the local duplicate type.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean (no unused `SignalRConnectionManager`/`managerRef`, no duplicate type).

- [ ] **Step 3: Lint**

Run: `npx eslint src/components/dashboard/LpMarginAlerts.tsx`
Expected: no new errors beyond suppressed `any` patterns.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/LpMarginAlerts.tsx
git commit -m "refactor(alerts): LP Margin Alerts page reads shared AlertsHub context"
```

---

## Task 10: Sound Alerts card in Settings → Alerts

**Files:**
- Modify: `src/pages/settings/AlertsSettingsPage.tsx`

- [ ] **Step 1: Add imports + state**

At the top of `src/pages/settings/AlertsSettingsPage.tsx` add:
```tsx
import { isSoundEnabled, setSoundEnabled, primeAudio, playAlarm } from "@/lib/alertSound";
```
Inside the component, add state:
```tsx
  const [soundOn, setSoundOn] = useState<boolean>(() => isSoundEnabled());
```

- [ ] **Step 2: Add the Sound Alerts card**

Add this `<section>` directly above the existing "LP Margin Alerts" section in the returned JSX:
```tsx
        <section className="rounded-2xl border border-border/40 bg-card/70 p-5">
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-foreground">Sound Alerts</h2>
            <p className="text-xs text-muted-foreground">
              Play a loud alarm in this browser when an LP margin alert fires or the data backend disconnects.
              Browsers stay silent until you interact once — use “Test sound” to enable.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="sr-only"
                checked={soundOn}
                onChange={(e) => {
                  const on = e.target.checked;
                  setSoundOn(on);
                  setSoundEnabled(on);
                  if (on) primeAudio();
                }}
              />
              <span className={`relative h-7 w-12 rounded-full transition ${soundOn ? "bg-primary" : "bg-muted"}`}>
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${soundOn ? "left-6" : "left-1"}`} />
              </span>
              <span className="text-sm text-foreground">{soundOn ? "Enabled" : "Disabled"}</span>
            </label>
            <button
              type="button"
              onClick={() => {
                primeAudio();
                playAlarm("lp-margin");
              }}
              className="rounded-lg border border-border/60 bg-secondary px-3 py-2 text-sm hover:bg-secondary/80"
            >
              Test sound
            </button>
          </div>
        </section>
```
Ensure `useState` is imported (it already is in this file).

- [ ] **Step 3: Typecheck + lint + commit**

Run: `npx tsc --noEmit -p tsconfig.json` → clean; `npx eslint src/pages/settings/AlertsSettingsPage.tsx` → no new errors.
```bash
git add src/pages/settings/AlertsSettingsPage.tsx
git commit -m "feat(alerts): Sound Alerts card (enable + test) in Settings → Alerts"
```

---

## Task 11: Full verification

**Files:** none

- [ ] **Step 1: Typecheck, tests, build**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run build
```
Expected: tsc clean; all tests pass (existing + new `alertLogic`, `alertBreaches`, `alertSound`); build succeeds.

- [ ] **Step 2: Run the app**

Run:
```bash
npm run local:restart
```
Confirm both servers UP. Check `.local-backend.log` for a `[Alerts] hub watcher ...` line.

- [ ] **Step 3: Manual checks**

1. Open `http://localhost:8080` → Settings → Alerts → toggle **Sound Alerts** on → click **Test sound**: a long (~6s), loud two-tone alarm should play.
2. Scroll to **LP Margin Alerts**: the status badge + grid should still work (now fed by the shared context).
3. Disconnect test: stop the data backend / block the hub (or temporarily set `VITE_BACKEND_BASE_URL` to an unreachable host and reload) → after the reconnect attempts, a red **“Disconnected from data backend”** banner appears at the top and (if sound on) the disconnect alarm plays; **Silence** stops it.
4. Email path (server-side): with `BREVO_API_KEY` + `ALERT_RECIPIENTS` set, a real `LpMarginAlerts` breach (or a backend outage) should produce an email; without them, the backend log shows `[Alerts] email skipped/failed: ... not set` (graceful).

- [ ] **Step 4: Stop the app**

Run: `npm run local:stop`

---

## Self-review notes (applied)

- **Spec coverage:** always-on Node email via SignalR client (Tasks 2–4) ✓; backend-down edge-triggered email (Tasks 1,3) ✓; LP-margin de-dup w/ cooldown (Tasks 1,3) ✓; browser sound long/loud (Task 6) ✓; global provider + banner (Tasks 7–8) ✓; LP page consumes context (Task 9) ✓; Settings sound card + test/prime gesture (Task 10) ✓; config env (Tasks 2–3) ✓; tests for pure logic + sound pref (Tasks 1,5,6) ✓; error handling wrapped (Tasks 2,3,6,7) ✓.
- **Type/name consistency:** `diffBreaches`/`nextConnState` (Task 1) consumed unchanged in Task 3; `newBreaches` (Task 5) used in Task 7; `LpMarginAlertRow` exported from `AlertsHubProvider` (Task 7) and reused in Task 9; `isSoundEnabled`/`setSoundEnabled`/`primeAudio`/`playAlarm`/`stopAlarm` (Task 6) used in Tasks 7,8,10.
- **Deviation from spec (noted):** `wallet/notifier.js` is NOT refactored (kept stable); `alerts/alertNotifier.js` carries its own small Brevo POST instead. Minor, deliberate.
