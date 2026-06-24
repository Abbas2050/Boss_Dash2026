# Configurable Alarm — Recipients, Duration, Mute

**Date:** 2026-06-18
**Status:** Approved design (pre-implementation)
**Builds on:** the existing alerts feature (`AlertsHubProvider`, `src/lib/alertSound.ts`, Settings → Alerts).

## Summary

Make the in-browser alarm (currently default-on per browser, fixed ~6s) **centrally configurable**:

1. **Recipients** — an admin picks, in Settings → Alerts, exactly which users' browsers should ring (multi-select from User Management).
2. **Duration** — the alarm rings once for a configurable **N seconds**.
3. **Mute** — a global **Mute bell** in the header lets anyone instantly silence the current alarm and mute future alarms on their own device.

The email/Telegram channel is unchanged (always-on, server-side, reaches `ALERT_RECIPIENTS` regardless of any browser).

## Decisions (from brainstorming)

- **Targeting:** central user picker in Settings → Alerts (not per-user toggles, not role-based).
- **Duration:** ring once for a configurable N seconds (not loop-until-muted).
- **Mute:** global Mute bell in the header (silence current + mute this device).
- **Storage:** central config lives on **our Node server** as a small persisted JSON behind `GET/PUT /api/alarm-config` (not the auth DB; not the external `.NET /api/AlertSettings`).

## Model

- **Central config (server JSON):**
  `{ enabled: boolean, recipientUserIds: string[], durationSec: number }`
  Defaults: `enabled: true`, `recipientUserIds: []`, `durationSec: 10`. `durationSec` clamped to 1–60.
- **Per-device mute (browser localStorage):** `mutedOnThisDevice` (default `false`), toggled by the header bell.
- **Effective ring rule (pure, testable):**
  `shouldRing(config, myUserId, mutedOnThisDevice) = config.enabled && config.recipientUserIds.includes(myUserId) && !mutedOnThisDevice`
  Audio additionally requires the existing one-time interaction unlock.

This replaces the old per-browser "Sound Alerts on/off" preference (`alert_sound_enabled_v1`): targeting is now central; the only per-browser control is the device mute.

## Architecture / components

### Backend (Node, `server.js` + `alerts/alarmConfig.js`)
- `alerts/alarmConfig.js`: `readAlarmConfig()` / `writeAlarmConfig(cfg)` over `storage/alarm_config.json`. Validates + clamps (`durationSec` 1–60, `recipientUserIds` = array of strings, `enabled` boolean). Write is atomic (write temp file then rename) to avoid corruption. Missing/invalid file → returns defaults.
- `GET /api/alarm-config` — returns the current config. Available to any authenticated request.
- `PUT /api/alarm-config` — saves config. **Admin-gated**: requires a valid auth token with manage-users/settings rights (reuse the auth middleware pattern used by the auth router; if not readily reusable, require a valid logged-in token at minimum and note the gap).

### Frontend
- `src/lib/alarmConfig.ts`:
  - Types `AlarmConfig`.
  - `getAlarmConfig(): Promise<AlarmConfig>` (GET; falls back to safe defaults with `enabled:false`-equivalent "don't ring" on error — see Error handling).
  - `saveAlarmConfig(cfg): Promise<AlarmConfig>` (PUT, with auth header).
  - `isMutedOnThisDevice()` / `setMutedOnThisDevice(bool)` (localStorage `alarm_muted_device_v1`).
  - Pure `shouldRing(config, userId, muted)`.
- `AlertsHubProvider` (existing): on mount, fetch the alarm config; re-poll every ~60s so admin changes propagate without a reload. On an `LpMarginAlerts` new-breach or `disconnect` event, play the alarm **only if** `shouldRing(config, currentUser.id, mutedOnThisDevice)`, using `config.durationSec * 1000`. Expose `{ muted, toggleMute, silence }` through context (it already exposes `silence`). `toggleMute` flips `mutedOnThisDevice` and, when muting, calls `stopAlarm()`.
- `DashboardHeader` (existing): add a **Mute bell** button (it renders inside `AlertsHubProvider`, so it consumes the context). Click → `silence()` the current alarm and `toggleMute()` the device; icon reflects muted vs active state with a tooltip.
- Settings → Alerts (`AlertsSettingsPage`): the current "Sound Alerts" card becomes the **Alarm** admin card:
  - **Enable** master toggle.
  - **Recipients** multi-select built from `getUsers()` / `refreshUsers()` (name + email), storing selected `user.id`s.
  - **Duration (seconds)** number input (1–60).
  - **Save** → `saveAlarmConfig(...)`.
  - **Test sound** button (also primes audio).

## Data flow

1. Admin sets enable / recipients / duration in Settings → `PUT /api/alarm-config` → JSON on Node.
2. Every user's `AlertsHubProvider` fetches `/api/alarm-config` (load + 60s poll), and on an alert event rings only if `shouldRing(config, me, deviceMuted)` for `durationSec`.
3. Header **Mute bell** silences the current alarm and toggles device mute; reflected immediately.

## Error handling

- Config fetch failure → treat as **do not ring** on that browser (banner + email still convey the alert), so a backend hiccup never causes runaway/:surprise audio. Logged to console; retried on the next poll.
- `PUT` failure → inline error in the Settings card; config unchanged. JSON write is atomic (temp + rename).
- All audio paths remain `try/catch` no-ops (existing behavior).

## Testing

- Unit (vitest): pure `shouldRing()` — recipient included/excluded, disabled, muted, missing user id; `alarmConfig` validation/clamping (durationSec bounds, bad shapes → defaults); device-mute localStorage read/write.
- Manual: set recipients to include/exclude yourself and confirm ringing; change duration and confirm length; header bell silences + mutes; Test sound primes + plays.

## New / changed files

- New: `alerts/alarmConfig.js` (Node), `src/lib/alarmConfig.ts`, plus unit tests (`src/lib/alarmConfig.test.ts`, and a node test for the config validator or co-tested via vitest).
- Edit: `server.js` (two routes), `src/components/AlertsHubProvider.tsx` (config-gated ringing + mute context), `src/components/dashboard/DashboardHeader.tsx` (mute bell), `src/pages/settings/AlertsSettingsPage.tsx` (Alarm config card), `src/lib/alertSound.ts` (retire/replace the per-browser enabled pref in favor of device-mute; keep `primeAudio`/`playAlarm`/`stopAlarm`).

## Out of scope

- Role-based targeting (only an individual-user picker for now).
- Looping-until-muted alarms (duration is a fixed N-second ring).
- Per-recipient duration or per-alert-type recipients (one config for both alert kinds).
- Central "mute everyone" switch (mute is per-device; the master **Enable** toggle is the central off).
