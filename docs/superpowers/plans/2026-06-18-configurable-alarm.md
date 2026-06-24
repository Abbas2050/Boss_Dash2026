# Configurable Alarm (Recipients + Duration + Mute) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-browser alarm centrally configurable — an admin picks which users it rings for and for how many seconds, and anyone can mute it on their device from the header.

**Architecture:** A small central config (`{ enabled, recipientUserIds, durationSec }`) is persisted as JSON on our Node server behind `GET/PUT /api/alarm-config` (PUT admin-gated). The browser's `AlertsHubProvider` fetches it and rings the existing WebAudio alarm only when `shouldRing(config, currentUserId, mutedOnThisDevice)` is true. A header Mute bell toggles a per-device mute and silences the current alarm.

**Tech Stack:** Node ESM + Express (`server.js`, `auth/router.js`), React + TypeScript + Vite, vitest, WebAudio.

**Spec:** `docs/superpowers/specs/2026-06-18-configurable-alarm-design.md`

## Global Constraints

- `durationSec` is clamped to **1–60** seconds everywhere (server normalizer is the source of truth).
- Central config defaults: `{ enabled: true, recipientUserIds: [], durationSec: 10 }`.
- `GET /api/alarm-config` is open to the app (relative path → our Node server, same as `/api/auth/*`). `PUT /api/alarm-config` requires a valid auth token AND `canManageUsers`.
- New `any` usages get `// eslint-disable-next-line @typescript-eslint/no-explicit-any` to match the codebase.
- Do not commit to `main` directly; all work on the feature branch (Task 0).

---

## Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git checkout -b feat/configurable-alarm
```
Expected: `Switched to a new branch 'feat/configurable-alarm'`

---

## Task 1: Server-side alarm config module (read/write/normalize)

**Files:**
- Create: `alerts/alarmConfig.js`
- Test: `alerts/alarmConfig.test.js`

**Interfaces:**
- Produces: `normalizeAlarmConfig(raw) -> { enabled:boolean, recipientUserIds:string[], durationSec:number }`, `readAlarmConfig() -> config`, `writeAlarmConfig(raw) -> config` (persists `storage/alarm_config.json`).

- [ ] **Step 1: Write the failing test (pure normalizer)**

Create `alerts/alarmConfig.test.js`:
```js
import { describe, expect, it } from "vitest";
import { normalizeAlarmConfig } from "./alarmConfig.js";

describe("normalizeAlarmConfig", () => {
  it("fills defaults from an empty object", () => {
    expect(normalizeAlarmConfig({})).toEqual({ enabled: true, recipientUserIds: [], durationSec: 10 });
  });
  it("clamps durationSec to 1..60 and rounds", () => {
    expect(normalizeAlarmConfig({ durationSec: 0 }).durationSec).toBe(1);
    expect(normalizeAlarmConfig({ durationSec: 999 }).durationSec).toBe(60);
    expect(normalizeAlarmConfig({ durationSec: 12.7 }).durationSec).toBe(13);
    expect(normalizeAlarmConfig({ durationSec: "abc" }).durationSec).toBe(10);
  });
  it("coerces recipientUserIds to a string array and drops blanks", () => {
    expect(normalizeAlarmConfig({ recipientUserIds: [1, "2", "", null] }).recipientUserIds).toEqual(["1", "2"]);
    expect(normalizeAlarmConfig({ recipientUserIds: "nope" }).recipientUserIds).toEqual([]);
  });
  it("keeps a boolean enabled, defaults non-boolean to true", () => {
    expect(normalizeAlarmConfig({ enabled: false }).enabled).toBe(false);
    expect(normalizeAlarmConfig({ enabled: "yes" }).enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing)**

Run: `npx vitest run alerts/alarmConfig.test.js`

- [ ] **Step 3: Create `alerts/alarmConfig.js`**

```js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "../storage/alarm_config.json");

const DEFAULTS = { enabled: true, recipientUserIds: [], durationSec: 10 };

export function normalizeAlarmConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled;
  const recipientUserIds = Array.isArray(cfg.recipientUserIds)
    ? cfg.recipientUserIds.map((v) => String(v)).filter(Boolean)
    : [];
  let durationSec = Number(cfg.durationSec);
  if (!Number.isFinite(durationSec)) durationSec = DEFAULTS.durationSec;
  durationSec = Math.min(60, Math.max(1, Math.round(durationSec)));
  return { enabled, recipientUserIds, durationSec };
}

export function readAlarmConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULTS };
    return normalizeAlarmConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeAlarmConfig(raw) {
  const cfg = normalizeAlarmConfig(raw);
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  return cfg;
}
```

- [ ] **Step 4: Run it — expect PASS (4 tests)**

Run: `npx vitest run alerts/alarmConfig.test.js`

- [ ] **Step 5: Commit**

```bash
git add alerts/alarmConfig.js alerts/alarmConfig.test.js
git commit -m "feat(alarm): server-side alarm config read/write/normalize"
```

---

## Task 2: Backend routes — GET/PUT /api/alarm-config

**Files:**
- Modify: `auth/router.js` (add named exports)
- Modify: `server.js` (import + two routes)

**Interfaces:**
- Consumes: `authRequired` (Express middleware that sets `req.auth`) and `canManageUsers(req.auth)` from `auth/router.js`; `readAlarmConfig`/`writeAlarmConfig` from `alerts/alarmConfig.js`.
- Produces: `GET /api/alarm-config` → JSON config; `PUT /api/alarm-config` (admin) → saved JSON config.

- [ ] **Step 1: Export the auth helpers from `auth/router.js`**

`auth/router.js` already defines `async function authRequired(req,res,next)` and `function canManageUsers(payload)`, and ends with `export default router;`. Add a named export line right above `export default router;`:
```js
export { authRequired, canManageUsers };
```

- [ ] **Step 2: Add imports to `server.js`**

Near the other top imports (e.g. after `import { startHubWatcher } from './alerts/hubWatcher.js';`), add:
```js
import { authRequired, canManageUsers } from './auth/router.js';
import { readAlarmConfig, writeAlarmConfig } from './alerts/alarmConfig.js';
```

- [ ] **Step 3: Add the routes**

In `server.js`, near the other `/api/*` routes (e.g. right after the `app.get('/api/signalr/token', ...)` handler), add:
```js
// Central alarm config (served by our Node server). GET is open to the app; PUT is admin-only.
app.get('/api/alarm-config', (req, res) => {
  res.json(readAlarmConfig());
});
app.put('/api/alarm-config', authRequired, (req, res) => {
  if (!canManageUsers(req.auth)) return res.status(403).json({ error: 'forbidden' });
  try {
    res.json(writeAlarmConfig(req.body || {}));
  } catch (e) {
    res.status(500).json({ error: 'save_failed', message: e?.message || String(e) });
  }
});
```
(`express.json()` body parsing is already enabled in this server — the auth routes rely on it.)

- [ ] **Step 4: Verify the server boots and GET responds**

Run:
```bash
npm run local:restart
```
Then:
```bash
curl -s http://localhost:3001/api/alarm-config
```
Expected: JSON like `{"enabled":true,"recipientUserIds":[],"durationSec":10}`. Backend must be UP.

- [ ] **Step 5: Verify PUT rejects unauthenticated**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PUT http://localhost:3001/api/alarm-config -H "Content-Type: application/json" -d "{\"durationSec\":15}"
```
Expected: `401` (missing token).

- [ ] **Step 6: Commit**

```bash
git add auth/router.js server.js
git commit -m "feat(alarm): GET/PUT /api/alarm-config (PUT admin-gated)"
```

---

## Task 3: Frontend alarm-config lib (fetch/save, device mute, shouldRing)

**Files:**
- Modify: `src/lib/auth.ts` (export `authHeaders`)
- Create: `src/lib/alarmConfig.ts`
- Test: `src/lib/alarmConfig.test.ts`

**Interfaces:**
- Consumes: `authHeaders()` from `@/lib/auth`.
- Produces: type `AlarmConfig`, `DEFAULT_ALARM_CONFIG`, `getAlarmConfig()`, `saveAlarmConfig(cfg)`, `isMutedOnThisDevice()`, `setMutedOnThisDevice(b)`, `shouldRing(config, userId, muted)`.

- [ ] **Step 1: Export `authHeaders` from `src/lib/auth.ts`**

Change the declaration `function authHeaders(): Record<string, string> {` to:
```ts
export function authHeaders(): Record<string, string> {
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/alarmConfig.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { isMutedOnThisDevice, setMutedOnThisDevice, shouldRing, DEFAULT_ALARM_CONFIG } from "./alarmConfig";

describe("shouldRing", () => {
  const base = { enabled: true, recipientUserIds: ["7"], durationSec: 10 };
  it("rings for a recipient when enabled and not muted", () => {
    expect(shouldRing(base, "7", false)).toBe(true);
  });
  it("does not ring for a non-recipient", () => {
    expect(shouldRing(base, "8", false)).toBe(false);
  });
  it("does not ring when disabled", () => {
    expect(shouldRing({ ...base, enabled: false }, "7", false)).toBe(false);
  });
  it("does not ring when muted on this device", () => {
    expect(shouldRing(base, "7", true)).toBe(false);
  });
  it("does not ring with no user id", () => {
    expect(shouldRing(base, null, false)).toBe(false);
  });
});

describe("device mute preference", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to not muted", () => {
    expect(isMutedOnThisDevice()).toBe(false);
  });
  it("persists mute state", () => {
    setMutedOnThisDevice(true);
    expect(isMutedOnThisDevice()).toBe(true);
    setMutedOnThisDevice(false);
    expect(isMutedOnThisDevice()).toBe(false);
  });
});

describe("defaults", () => {
  it("exposes the documented defaults", () => {
    expect(DEFAULT_ALARM_CONFIG).toEqual({ enabled: true, recipientUserIds: [], durationSec: 10 });
  });
});
```

- [ ] **Step 3: Run it — expect FAIL (module missing)**

Run: `npx vitest run src/lib/alarmConfig.test.ts`

- [ ] **Step 4: Create `src/lib/alarmConfig.ts`**

```ts
import { authHeaders } from "@/lib/auth";

export type AlarmConfig = {
  enabled: boolean;
  recipientUserIds: string[];
  durationSec: number;
};

export const DEFAULT_ALARM_CONFIG: AlarmConfig = { enabled: true, recipientUserIds: [], durationSec: 10 };

// /api/alarm-config is served by our own Node server (same-origin / Vite-proxied), like /api/auth/*.
export async function getAlarmConfig(): Promise<AlarmConfig> {
  const res = await fetch("/api/alarm-config", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`alarm-config ${res.status}`);
  const raw = await res.json();
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : true,
    recipientUserIds: Array.isArray(raw?.recipientUserIds) ? raw.recipientUserIds.map((v: unknown) => String(v)) : [],
    durationSec: Number(raw?.durationSec) || 10,
  };
}

export async function saveAlarmConfig(cfg: AlarmConfig): Promise<AlarmConfig> {
  const res = await fetch("/api/alarm-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `save ${res.status}`);
  return (await res.json()) as AlarmConfig;
}

const MUTE_KEY = "alarm_muted_device_v1";
export function isMutedOnThisDevice(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}
export function setMutedOnThisDevice(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function shouldRing(config: AlarmConfig, userId: string | null | undefined, mutedOnThisDevice: boolean): boolean {
  if (!config.enabled) return false;
  if (mutedOnThisDevice) return false;
  if (!userId) return false;
  return config.recipientUserIds.includes(String(userId));
}
```

- [ ] **Step 5: Run it — expect PASS (8 tests); tsc clean**

Run:
```bash
npx vitest run src/lib/alarmConfig.test.ts
npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth.ts src/lib/alarmConfig.ts src/lib/alarmConfig.test.ts
git commit -m "feat(alarm): frontend alarm-config lib (fetch/save, device mute, shouldRing)"
```

---

## Task 4: Gate ringing on config + add mute to AlertsHubProvider

**Files:**
- Modify: `src/components/AlertsHubProvider.tsx`

**Interfaces:**
- Consumes: `getAlarmConfig`, `DEFAULT_ALARM_CONFIG`, `AlarmConfig`, `isMutedOnThisDevice`, `setMutedOnThisDevice`, `shouldRing` from `@/lib/alarmConfig`; `getCurrentUser` from `@/lib/auth`; `playAlarm`, `stopAlarm` from `@/lib/alertSound`; `newBreaches` from `@/lib/alertBreaches`.
- Produces: context value `{ status, lpAlerts, disconnected, silence, muted, toggleMute }` via `useAlertsHub()`.

- [ ] **Step 1: Update imports**

In `src/components/AlertsHubProvider.tsx`, replace the alertSound import line:
```ts
import { isSoundEnabled, playAlarm, primeAudio, stopAlarm } from "@/lib/alertSound";
```
with:
```ts
import { playAlarm, primeAudio, stopAlarm } from "@/lib/alertSound";
import { getCurrentUser } from "@/lib/auth";
import {
  AlarmConfig,
  DEFAULT_ALARM_CONFIG,
  getAlarmConfig,
  isMutedOnThisDevice,
  setMutedOnThisDevice,
  shouldRing,
} from "@/lib/alarmConfig";
```

- [ ] **Step 2: Extend the context type + default**

Change the `AlertsHubValue` type to:
```ts
type AlertsHubValue = {
  status: SignalRStatus;
  lpAlerts: LpMarginAlertRow[];
  disconnected: boolean;
  silence: () => void;
  muted: boolean;
  toggleMute: () => void;
};
```
And the default context object to include the new fields:
```ts
const AlertsHubContext = createContext<AlertsHubValue>({
  status: "disconnected",
  lpAlerts: [],
  disconnected: false,
  silence: () => undefined,
  muted: false,
  toggleMute: () => undefined,
});
```

- [ ] **Step 3: Add config + mute state and the ring guard**

Inside `AlertsHubProvider`, just after the existing `const prevStatusRef = useRef<SignalRStatus>("disconnected");` line, add:
```ts
  const [muted, setMuted] = useState<boolean>(() => isMutedOnThisDevice());
  const configRef = useRef<AlarmConfig>(DEFAULT_ALARM_CONFIG);
  const userIdRef = useRef<string | null>(getCurrentUser()?.id ?? null);

  // Load central alarm config and re-poll so admin changes propagate without a reload.
  useEffect(() => {
    let active = true;
    const load = () =>
      getAlarmConfig()
        .then((c) => {
          if (active) configRef.current = c;
        })
        .catch(() => {
          // On failure, do not ring on this browser (banner + email still cover the alert).
          if (active) configRef.current = { ...DEFAULT_ALARM_CONFIG, enabled: false };
        });
    load();
    const id = setInterval(load, 60000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const ringIfAllowed = (kind: "disconnect" | "lp-margin") => {
    if (shouldRing(configRef.current, userIdRef.current, isMutedOnThisDevice())) {
      playAlarm(kind, configRef.current.durationSec * 1000);
    }
  };

  const toggleMute = () => {
    const next = !isMutedOnThisDevice();
    setMutedOnThisDevice(next);
    setMuted(next);
    if (next) stopAlarm();
  };
```

- [ ] **Step 4: Replace the two `isSoundEnabled()` ring sites with `ringIfAllowed`**

In the status handler, replace:
```ts
      if (next === "disconnected" && prevStatusRef.current !== "disconnected") {
        if (isSoundEnabled()) playAlarm("disconnect");
      }
```
with:
```ts
      if (next === "disconnected" && prevStatusRef.current !== "disconnected") {
        ringIfAllowed("disconnect");
      }
```
In the event handler, replace:
```ts
      if (newLogins.length && isSoundEnabled()) playAlarm("lp-margin");
```
with:
```ts
      if (newLogins.length) ringIfAllowed("lp-margin");
```

- [ ] **Step 5: Expose mute in the context value**

Change the `value` object to:
```ts
  const value: AlertsHubValue = {
    status,
    lpAlerts,
    disconnected: status === "disconnected",
    silence: stopAlarm,
    muted,
    toggleMute,
  };
```

- [ ] **Step 6: Verify**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/AlertsHubProvider.tsx
```
Expected: tsc clean; eslint no new errors (the file may carry the existing `react-refresh/only-export-components` warning — acceptable).

- [ ] **Step 7: Commit**

```bash
git add src/components/AlertsHubProvider.tsx
git commit -m "feat(alarm): gate ringing on central config + per-device mute in provider"
```

---

## Task 5: Header Mute bell

**Files:**
- Modify: `src/components/dashboard/DashboardHeader.tsx`

**Interfaces:**
- Consumes: `useAlertsHub()` → `{ muted, toggleMute }` from `@/components/AlertsHubProvider`.

- [ ] **Step 1: Add imports**

In `src/components/dashboard/DashboardHeader.tsx`:
- Add `Bell, BellOff` to the existing lucide-react import (line 2): change
  `import { RefreshCw, TrendingUp, FileText, Users, MoonStar, Sun, X } from 'lucide-react';`
  to
  `import { RefreshCw, TrendingUp, FileText, Users, MoonStar, Sun, X, Bell, BellOff } from 'lucide-react';`
- Add: `import { useAlertsHub } from '@/components/AlertsHubProvider';`

- [ ] **Step 2: Read the mute state in the component**

Inside `DashboardHeader`, after `const currentUser = getCurrentUser();` add:
```ts
  const { muted, toggleMute } = useAlertsHub();
```

- [ ] **Step 3: Add the bell button**

In the right-side controls, immediately before the theme `<div className="hidden sm:inline-flex items-center gap-2 rounded-lg border border-border/50 bg-secondary/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground">` block (the MoonStar/Switch/Sun one), insert:
```tsx
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute alarm" : "Mute alarm"}
          title={muted ? "Alarm muted on this device — click to unmute" : "Mute alarm on this device"}
          className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/50 ${
            muted ? "bg-rose-500/15 text-rose-500" : "bg-secondary/40 text-muted-foreground hover:text-foreground"
          }`}
        >
          {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
        </button>
```

- [ ] **Step 4: Verify**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/dashboard/DashboardHeader.tsx
```
Expected: tsc clean; no new eslint errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/DashboardHeader.tsx
git commit -m "feat(alarm): header Mute bell (silence + mute this device)"
```

---

## Task 6: Alarm config card in Settings → Alerts

**Files:**
- Modify: `src/pages/settings/AlertsSettingsPage.tsx`

**Interfaces:**
- Consumes: `getAlarmConfig`, `saveAlarmConfig`, `AlarmConfig` from `@/lib/alarmConfig`; `primeAudio`, `playAlarm` from `@/lib/alertSound`; `getUsers`, `refreshUsers`, `AuthUser` from `@/lib/auth`.

- [ ] **Step 1: Update imports**

In `src/pages/settings/AlertsSettingsPage.tsx`:
- Replace the line `import { isSoundEnabled, setSoundEnabled, primeAudio, playAlarm } from "@/lib/alertSound";` with:
  ```ts
  import { primeAudio, playAlarm } from "@/lib/alertSound";
  import { AlarmConfig, getAlarmConfig, saveAlarmConfig } from "@/lib/alarmConfig";
  ```
- Add to the existing `@/lib/auth` import: `getUsers`, `refreshUsers`, and the type `AuthUser`. (The file already imports `hasAccess` from `@/lib/auth`; extend that import, e.g. `import { hasAccess, getUsers, refreshUsers, type AuthUser } from "@/lib/auth";`.)
- Add `useEffect` to the React import if not present (file currently imports `useMemo, useState`): change to `import React, { useEffect, useMemo, useState } from "react";`.

- [ ] **Step 2: Replace the `soundOn` state with alarm-config state**

Remove `const [soundOn, setSoundOn] = useState<boolean>(() => isSoundEnabled());` and add:
```ts
  const [alarmCfg, setAlarmCfg] = useState<AlarmConfig>({ enabled: true, recipientUserIds: [], durationSec: 10 });
  const [alarmUsers, setAlarmUsers] = useState<AuthUser[]>(() => getUsers());
  const [alarmSaving, setAlarmSaving] = useState(false);
  const [alarmMsg, setAlarmMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    getAlarmConfig().then(setAlarmCfg).catch(() => undefined);
    refreshUsers().then(setAlarmUsers).catch(() => undefined);
  }, []);

  const toggleRecipient = (userId: string) => {
    setAlarmCfg((c) => ({
      ...c,
      recipientUserIds: c.recipientUserIds.includes(userId)
        ? c.recipientUserIds.filter((id) => id !== userId)
        : [...c.recipientUserIds, userId],
    }));
  };

  const saveAlarm = async () => {
    setAlarmSaving(true);
    setAlarmMsg(null);
    try {
      const saved = await saveAlarmConfig(alarmCfg);
      setAlarmCfg(saved);
      setAlarmMsg({ text: "Saved", ok: true });
      setTimeout(() => setAlarmMsg(null), 2500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setAlarmMsg({ text: `Failed: ${e?.message || "error"}`, ok: false });
    } finally {
      setAlarmSaving(false);
    }
  };
```

- [ ] **Step 3: Replace the old "Sound Alerts" card JSX with the Alarm card**

Find the existing `<section>` whose heading is "Sound Alerts" (added previously) and replace that entire `<section>...</section>` with:
```tsx
        <section className="rounded-2xl border border-border/40 bg-card/70 p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Alarm</h2>
              <p className="text-xs text-muted-foreground">
                A loud alarm rings in the browser of the selected users when an LP margin alert fires or the data backend
                disconnects. Anyone can mute it on their own device via the bell in the top bar.
              </p>
            </div>
            {alarmMsg && (
              <span className={`text-xs ${alarmMsg.ok ? "text-success" : "text-destructive"}`}>{alarmMsg.text}</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="sr-only"
                checked={alarmCfg.enabled}
                onChange={(e) => setAlarmCfg((c) => ({ ...c, enabled: e.target.checked }))}
              />
              <span className={`relative h-7 w-12 rounded-full transition ${alarmCfg.enabled ? "bg-primary" : "bg-muted"}`}>
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${alarmCfg.enabled ? "left-6" : "left-1"}`} />
              </span>
              <span className="text-sm text-foreground">{alarmCfg.enabled ? "Enabled" : "Disabled"}</span>
            </label>

            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              Ring for
              <input
                type="number"
                min={1}
                max={60}
                value={alarmCfg.durationSec}
                onChange={(e) =>
                  setAlarmCfg((c) => ({ ...c, durationSec: Math.min(60, Math.max(1, Number(e.target.value) || 1)) }))
                }
                className="w-20 rounded-md border border-border bg-background/70 px-2 py-1.5 text-foreground"
              />
              seconds
            </label>

            <button
              type="button"
              onClick={() => {
                primeAudio();
                playAlarm("lp-margin", alarmCfg.durationSec * 1000);
              }}
              className="rounded-lg border border-border/60 bg-secondary px-3 py-2 text-sm hover:bg-secondary/80"
            >
              Test sound
            </button>

            <button
              type="button"
              onClick={saveAlarm}
              disabled={alarmSaving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {alarmSaving ? "Saving…" : "Save"}
            </button>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Ring for these users ({alarmCfg.recipientUserIds.length} selected)
            </div>
            <div className="grid max-h-64 grid-cols-1 gap-1 overflow-auto rounded-lg border border-border/40 p-2 sm:grid-cols-2">
              {alarmUsers.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-background/50">
                  <input
                    type="checkbox"
                    checked={alarmCfg.recipientUserIds.includes(u.id)}
                    onChange={() => toggleRecipient(u.id)}
                  />
                  <span className="text-sm text-foreground">{u.name || u.email}</span>
                  <span className="text-xs text-muted-foreground">{u.email}</span>
                </label>
              ))}
              {alarmUsers.length === 0 && (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">No users found.</div>
              )}
            </div>
          </div>
        </section>
```

- [ ] **Step 4: Verify**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/pages/settings/AlertsSettingsPage.tsx
```
Expected: tsc clean (no leftover `soundOn`/`isSoundEnabled`/`setSoundEnabled` references); no new eslint errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/settings/AlertsSettingsPage.tsx
git commit -m "feat(alarm): Alarm config card (enable, duration, recipients, test) in Settings"
```

---

## Task 7: Retire the old per-browser sound pref

**Files:**
- Modify: `src/lib/alertSound.ts`
- Delete: `src/lib/alertSound.test.ts`

**Interfaces:**
- Produces: `alertSound.ts` keeps only `primeAudio`, `stopAlarm`, `playAlarm` (audio engine). `isSoundEnabled`/`setSoundEnabled` removed (no remaining consumers after Tasks 4 and 6).

- [ ] **Step 1: Confirm there are no remaining consumers**

Run:
```bash
grep -rn "isSoundEnabled\|setSoundEnabled" src/ ; echo "done"
```
Expected: only matches (if any) are inside `src/lib/alertSound.ts` / `src/lib/alertSound.test.ts`. If any OTHER file still references them, stop and report — a prior task missed a spot.

- [ ] **Step 2: Remove the pref functions from `src/lib/alertSound.ts`**

Delete the top block (the `PREF_KEY` constant and the `isSoundEnabled` and `setSoundEnabled` functions — lines 1–18). The file now starts at `let audioCtx: AudioContext | null = null;`.

- [ ] **Step 3: Delete the obsolete test**

```bash
git rm src/lib/alertSound.test.ts
```
(Its preference tests are replaced by the device-mute tests in `src/lib/alarmConfig.test.ts`.)

- [ ] **Step 4: Verify**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
```
Expected: tsc clean; all tests pass (no reference to the removed file/functions).

- [ ] **Step 5: Commit**

```bash
git add src/lib/alertSound.ts
git commit -m "refactor(alarm): retire per-browser sound pref (replaced by central config + device mute)"
```

---

## Task 8: Full verification

**Files:** none

- [ ] **Step 1: tsc, tests, build**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
npm run build
```
Expected: tsc clean; all tests pass (incl. `alarmConfig.test.js`, `alarmConfig.test.ts`); build succeeds.

- [ ] **Step 2: Run the app**

Run:
```bash
npm run local:restart
```
Confirm both servers UP and `curl -s http://localhost:3001/api/alarm-config` returns JSON.

- [ ] **Step 3: Manual checks**

1. Open `http://localhost:8080` → Settings → Alerts → **Alarm** card: toggle Enable, set Ring-for seconds, check a couple of users (yourself included), **Save** → "Saved". Reload the page — selections persist (server-stored).
2. **Test sound** plays for the configured number of seconds.
3. Header **bell**: click → turns to muted (rose); click again → unmuted. While an alarm is ringing, clicking it silences immediately.
4. Confirm gating: with yourself NOT in the recipient list, an LP/disconnect alarm should not ring on your browser (banner + email still occur); add yourself, save, and it rings.

- [ ] **Step 4: Stop the app**

Run: `npm run local:stop`

---

## Self-review notes (applied)

- **Spec coverage:** central config on Node JSON + GET/PUT (Tasks 1–2) ✓; recipient picker + duration + enable in Settings (Task 6) ✓; per-device mute + header bell (Tasks 3,4,5) ✓; `shouldRing` gating with config + duration in provider (Task 4) ✓; error handling = don't ring on config fetch failure (Task 4) ✓; admin-gated PUT via `authRequired`+`canManageUsers` (Task 2) ✓; tests for `normalizeAlarmConfig`, `shouldRing`, device mute (Tasks 1,3) ✓; retire old per-browser pref (Task 7) ✓; durationSec clamp 1–60 (server normalizer Task 1, UI Task 6) ✓.
- **Type/name consistency:** `AlarmConfig`/`DEFAULT_ALARM_CONFIG`/`getAlarmConfig`/`saveAlarmConfig`/`isMutedOnThisDevice`/`setMutedOnThisDevice`/`shouldRing` defined in Task 3 and consumed unchanged in Tasks 4 & 6; `authRequired`/`canManageUsers` exported in Task 2 and used in Task 2's routes; `authHeaders` exported in Task 3 and used by `saveAlarmConfig`; context `{ muted, toggleMute }` produced in Task 4 and consumed in Task 5.
- **Ordering:** `isSoundEnabled`/`setSoundEnabled` consumers are removed in Tasks 4 and 6 before the functions themselves are deleted in Task 7, so every task compiles.
