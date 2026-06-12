# Backend-Down & LP-Margin Alerts (Email + Sound)

**Date:** 2026-06-12
**Status:** Approved design (pre-implementation)
**Scope:** Two alerts — (1) external data backend unreachable, (2) LP margin breach — each delivering an **email** (always-on, server-side) and an in-app **sound + banner** (when a dashboard is open).

## Summary

Add two operational alerts:

1. **Backend-unreachable alert** — when the app's connection to the external data backend
   (`api.skylinkscapital.com`, the `/ws/dashboard` SignalR hub) cannot be (re)established after
   a few retries.
2. **LP-margin alert** — when the external backend reports one or more LP accounts at/below the
   configured margin-level threshold (the existing `LpMarginAlerts` stream).

Delivery is split by reliability:

- **Email** is **server-side and always-on** — sent by our Node server whether or not any
  browser is open. One persistent SignalR client connection in Node powers both alerts.
- **Sound + on-screen banner** is **browser-side** — shown only when someone has the app open.
  One global SignalR connection in the browser powers both.

**Out of scope (deferred):** detecting that *our own Node server* is down (requires an external
uptime monitor). Confirmed by the user as later work.

## Decisions (from brainstorming)

- **Approach A:** Node connects to the external hub as a SignalR client; the same connection both
  receives `LpMarginAlerts` and detects backend-unreachable (reconnect exhaustion).
- **Email = backend-driven, always-on** (no browser needed).
- **Disconnect alert monitors the external data API + SignalR hub** (not our own Node server).
- **LP-margin email is new** — there is no existing LP-margin email today.
- **Sound = long and loud** — a multi-second, high-volume alarm.

## Architecture

```
External .NET hub  ──(LpMarginAlerts / connection state)──┐
  (/ws/dashboard)                                          │
        │                                                  ▼
        │                                   Node SignalR client  ── emails (Brevo + Telegram)
        │                                   (alerts/hubWatcher)      ALWAYS-ON, no browser needed
        │
        └──(LpMarginAlerts / connection state)── Browser SignalR connection
                                                  (AlertsHubProvider)  ── sound (long/loud) + banner
                                                                          WHEN a dashboard is open
```

Two independent observers of the same hub: Node (emails) and the browser (sound + banner). They
do not depend on each other.

## Node server (always-on email)

### `alerts/alertNotifier.js` (new)
Generic alert sender, reusing existing Brevo/Telegram config:

- `sendAlertEmail({ subject, html })` — POSTs to Brevo (`BREVO_API_KEY`, `EMAIL_FROM`,
  recipients from `ALERT_RECIPIENTS`). Returns `{ ok, reason? }`. Logs on failure; one retry.
- `sendAlertTelegram(text)` — optional; only when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHANNEL_ID`
  are set.
- Small HTML builders: `buildLpMarginEmail(newlyBreached[])`, `buildBackendDownEmail(meta)`,
  `buildBackendRecoveredEmail(meta)`.

Refactor note: `wallet/notifier.js` currently inlines the Brevo POST. Extract a shared
`postBrevoEmail({ subject, html, recipients })` into `alerts/alertNotifier.js` and have the wallet
notifier call it, so there is one Brevo path. The wallet report's HTML/subject stay in
`wallet/notifier.js`.

### `alerts/hubWatcher.js` (new)
A long-lived `@microsoft/signalr` `HubConnection` to `${BACKEND_API_TARGET}/ws/dashboard`
(`SIGNALR_TOKEN` optional via `accessTokenFactory`), `withAutomaticReconnect`. Pure decision
logic is separated from I/O for testability.

- **LP-margin:** on `LpMarginAlerts(rows)`, compute the set of breached logins. A pure function
  `diffBreaches(prevSet, rows, now, cooldownMs)` returns `{ newlyBreached[], nextState }`.
  "Newly breached" = a login in `rows` not currently considered active OR past its cooldown.
  Email (and Telegram) the `newlyBreached` batch in one message. A login that leaves `rows`
  is re-armed (removed from the active set). Per-login cooldown = `LP_ALERT_COOLDOWN_MS`
  (default 600000 = 10 min).
- **Backend-down:** a small state machine `connState: "up" | "down"`. The connection starts,
  and on `onreconnecting`/`onclose` the manager counts failed reconnect attempts; after
  `BACKEND_DOWN_RETRIES` (default 3) consecutive failures while not connected, transition
  `up → down` and send one backend-down email. On `onreconnected` (or a fresh successful
  `start()`), transition `down → up` and send one recovered email. Strictly edge-triggered —
  no repeats while down.
- Robustness: every handler is wrapped so a thrown error never crashes the server. If the initial
  `start()` fails, keep retrying in the background with backoff. A disabled flag
  (`ALERTS_WATCHER_ENABLED=false`) skips the watcher entirely.

### `server.js` (edit)
On boot, after the server is listening, call `startHubWatcher()` (guarded by
`ALERTS_WATCHER_ENABLED`, default on). Log start/stop. Never block server startup on it.

## Browser (sound + banner, when open)

### `src/components/AlertsHubProvider.tsx` (new)
A React context provider mounted once in `Layout`. Holds a single `SignalRConnectionManager`
(reused from `src/lib/signalRConnectionManager.ts`) to the external hub
(`apiUrl("/ws/dashboard")`, token via `/api/signalr/token`), `trackedEvents: ["LpMarginAlerts"]`,
reconnect delays tuned to ~3 attempts.

Exposes context `{ status: SignalRStatus, lpAlerts: LpMarginAlertRow[] }`:

- On `LpMarginAlerts` → update `lpAlerts`; diff for newly-breached logins (same idea as Node,
  browser-local) → play the **LP-margin alarm** (long/loud).
- On `status` → when it settles on `disconnected` (reconnects exhausted), set a global
  `disconnected` flag → render the **banner** + play the **disconnect alarm**; clear both on
  reconnect.

The **LP Margin Alerts settings component** (`src/components/dashboard/LpMarginAlerts.tsx`)
is refactored to read `lpAlerts` + `status` from this context instead of opening its own
connection — one browser connection total.

### `src/lib/alertSound.ts` (new)
WebAudio-generated alarm (no audio asset files):

- `primeAudio()` — create/resume an `AudioContext` on a user gesture (required by browsers).
- `playAlarm(kind: "disconnect" | "lp-margin")` — a **long, loud** alarm: a repeating
  two-tone (siren-like) pattern at high gain for ~**6 seconds** (configurable
  `ALARM_DURATION_MS`), distinct cadence per kind. Returns a handle with `.stop()`.
- `isSoundEnabled()` / `setSoundEnabled(bool)` — preference persisted in `localStorage`.
- Guard: never throw; if audio is unavailable or not primed, no-op.

"Long and loud" concretely: master gain near max (with a brief attack/"ramp" to avoid a click),
duration ~6s, an oscillating two-tone pattern that is hard to miss. The on-screen banner has a
**"Silence"** button to stop the current alarm immediately.

### Banner
A fixed top banner rendered by `Layout` when `status === "disconnected"`:
"⚠ Disconnected from data backend — retrying…" with a **Silence** button. Always shown when
disconnected, regardless of the sound setting (the visual is the dependable signal).

### `src/pages/settings/AlertsSettingsPage.tsx` (edit)
Add a "**Sound Alerts**" card: an enable/disable toggle (drives `setSoundEnabled`) and a
"**Test sound**" button that calls `primeAudio()` then `playAlarm("lp-margin")` — this doubles as
the one-time priming gesture browsers require.

## Dedup / rate rules (authoritative)

- **LP-margin (email & sound):** fire when a login **enters** the breach set; re-arm when it
  leaves; per-login cooldown (default 10 min) prevents a flapping account from spamming. One
  batched email per tick covering all newly-breached logins.
- **Backend-down (email):** strictly edge-triggered — one email on up→down, one on down→up.
- **Backend-down (sound/banner):** banner shows continuously while disconnected; the alarm plays
  once on the up→down transition (not looped forever) — user can re-trigger by interacting; banner
  remains until reconnect.

## Configuration (env)

Reused: `BACKEND_API_TARGET`, `SIGNALR_TOKEN` (optional), `BREVO_API_KEY`, `EMAIL_FROM`,
`ALERT_RECIPIENTS`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHANNEL_ID` (optional).
New (all optional, sane defaults): `ALERTS_WATCHER_ENABLED` (default true),
`LP_ALERT_COOLDOWN_MS` (default 600000), `BACKEND_DOWN_RETRIES` (default 3).

## Error handling

- Node watcher: all event handlers and email calls wrapped; failures log and never crash the
  server. Email send has a single retry. Background reconnect with backoff.
- Browser: sound failures degrade silently (no audio ≠ no alert — the banner still shows). Context
  provider tolerates connection errors and keeps retrying.

## Testing

Pure logic is unit-tested (vitest for browser-side TS; node test for server-side where practical):

- **`diffBreaches`** (Node + browser share the rule): previous active set + new rows + cooldown →
  correct `newlyBreached` and next state. Cases: first breach, repeated breach within cooldown
  (suppressed), breach after cooldown (re-fires), recovery then re-breach.
- **Backend-down state machine:** sequence of (re)connect/fail events → exactly one up→down and one
  down→up transition; no repeats while down.
- **Sound preference** read/write.

SignalR, Brevo, Telegram, and WebAudio are thin I/O wrappers — verified manually/integration
(the "Test sound" button; a manual disconnect; a simulated `LpMarginAlerts` payload).

## New / changed files

- New: `alerts/alertNotifier.js`, `alerts/hubWatcher.js`, `src/lib/alertSound.ts`,
  `src/components/AlertsHubProvider.tsx`, plus tests for the pure logic.
- Edit: `server.js` (start watcher), `wallet/notifier.js` (use shared Brevo sender),
  `src/components/Layout.tsx` (mount provider + banner), `src/components/dashboard/LpMarginAlerts.tsx`
  (consume context), `src/pages/settings/AlertsSettingsPage.tsx` (sound card).

## Out of scope

- Detecting our own Node server being down (needs an external uptime monitor — deferred).
- Alert #3 ("gold falls $50") — to be specced later.
- Per-recipient routing / per-user alert subscriptions beyond `ALERT_RECIPIENTS`.
