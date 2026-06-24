import React, { useEffect, useMemo, useState } from "react";
import { Bell, BellOff, Sparkles } from "lucide-react";
import {
  ALERT_EVENT_KEYS,
  ALERT_EVENT_META,
  AlertEventKey,
  AlertPreferences,
  getDefaultAlertPreferences,
  readAlertPreferences,
  writeAlertPreferences,
} from "@/lib/alertPreferences";
import AccountAlerts from "@/components/dashboard/AccountAlerts";
import LpMarginAlerts from "@/components/dashboard/LpMarginAlerts";
import { hasAccess, getUsers, refreshUsers, type AuthUser } from "@/lib/auth";
import { primeAudio, playAlarm } from "@/lib/alertSound";
import { AlarmConfig, getAlarmConfig, saveAlarmConfig } from "@/lib/alarmConfig";

export const AlertsSettingsPage: React.FC = () => {
  const allowedEventKeys = useMemo(
    () => ALERT_EVENT_KEYS.filter((key) => hasAccess(`Notifications:${key}`)),
    []
  );
  const [prefs, setPrefs] = useState<AlertPreferences>(() => readAlertPreferences());
  const [saved, setSaved] = useState<string>("");
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

  const enabledCount = useMemo(
    () => allowedEventKeys.filter((k) => prefs[k]).length,
    [prefs, allowedEventKeys]
  );

  const setPref = (key: AlertEventKey, value: boolean) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    writeAlertPreferences(next);
    setSaved("Saved");
    setTimeout(() => setSaved(""), 1200);
  };

  const enableAll = () => {
    const next = ALERT_EVENT_KEYS.reduce((acc, key) => {
      acc[key] = allowedEventKeys.includes(key);
      return acc;
    }, {} as AlertPreferences);
    setPrefs(next);
    writeAlertPreferences(next);
    setSaved("Saved");
    setTimeout(() => setSaved(""), 1200);
  };

  const disableAll = () => {
    const next = ALERT_EVENT_KEYS.reduce((acc, key) => {
      acc[key] = false;
      return acc;
    }, {} as AlertPreferences);
    setPrefs(next);
    writeAlertPreferences(next);
    setSaved("Saved");
    setTimeout(() => setSaved(""), 1200);
  };

  const resetDefaults = () => {
    const next = getDefaultAlertPreferences();
    setPrefs(next);
    writeAlertPreferences(next);
    setSaved("Saved");
    setTimeout(() => setSaved(""), 1200);
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="space-y-6 p-4 sm:p-6 md:p-8">
        <section className="rounded-2xl border border-border/40 bg-gradient-to-br from-card/90 to-card/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/20 text-primary border border-primary/30">
                <Sparkles className="h-5 w-5" />
              </span>
              <div>
                <h1 className="text-2xl font-semibold text-foreground">Alerts Control Center</h1>
                <p className="text-sm text-muted-foreground">
                  Choose which backend SignalR events trigger live popup notifications.
                </p>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              Enabled: <span className="font-semibold text-foreground">{enabledCount}</span> /{" "}
              {allowedEventKeys.length}
              {saved && <span className="ml-3 text-success">{saved}</span>}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={enableAll}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 sm:w-auto"
            >
              <Bell className="h-4 w-4" />
              Enable All
            </button>
            <button
              onClick={disableAll}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border/60 bg-secondary px-3 py-2 text-sm text-secondary-foreground hover:bg-secondary/80 sm:w-auto"
            >
              <BellOff className="h-4 w-4" />
              Disable All
            </button>
            <button
              onClick={resetDefaults}
              className="w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-sm hover:bg-secondary/40 sm:w-auto"
            >
              Reset Defaults
            </button>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {allowedEventKeys.map((key) => (
            <div key={key} className="rounded-xl border border-border/40 bg-card/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-foreground">{ALERT_EVENT_META[key].title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 font-mono">{key}</div>
                  <p className="text-sm text-muted-foreground mt-2">{ALERT_EVENT_META[key].description}</p>
                </div>
                <label className="inline-flex cursor-pointer items-center self-center">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={prefs[key]}
                    onChange={(e) => setPref(key, e.target.checked)}
                  />
                  <span
                    className={`w-12 h-7 rounded-full transition ${
                      prefs[key] ? "bg-primary" : "bg-muted"
                    } relative`}
                  >
                    <span
                      className={`absolute top-1 w-5 h-5 rounded-full bg-white transition ${
                        prefs[key] ? "left-6" : "left-1"
                      }`}
                    />
                  </span>
                </label>
              </div>
            </div>
          ))}
        </section>

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

        <section>
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-foreground">LP Margin Alerts</h2>
            <p className="text-xs text-muted-foreground">
              Real-time LP accounts at or below the configured margin level. Threshold and poll interval are configurable.
            </p>
          </div>
          <LpMarginAlerts />
        </section>

        <section>
          <div className="mb-3">
            <h2 className="text-lg font-semibold text-foreground">Live Alerts Feed</h2>
            <p className="text-xs text-muted-foreground">
              Real-time stream monitor moved from dashboard to settings.
            </p>
          </div>
          <AccountAlerts />
        </section>
      </main>
    </div>
  );
};
