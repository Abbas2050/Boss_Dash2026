import React, { useEffect, useMemo, useRef, useState } from "react";
import { SignalRConnectionManager, SignalRStatus } from "@/lib/signalRConnectionManager";

type LpMarginAlertRow = {
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

type AlertSettings = {
  marginAlertThreshold: number;
  marginAlertIntervalSeconds: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
const apiUrl = (path: string) => (backendBaseUrl ? `${backendBaseUrl}${path}` : path);

const fmtNum = (v: unknown, dp = 2) => {
  const n = Number(v);
  return v == null || Number.isNaN(n) ? "" : n.toFixed(dp);
};

const fmtTime = (v?: string) => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
};

const SOURCE_BADGE: Record<string, string> = {
  Manager: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  Terminal: "bg-teal-500/15 text-teal-600 dark:text-teal-300",
  Api: "bg-purple-500/15 text-purple-600 dark:text-purple-300",
  Coverage: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
};

const wsStatusMeta: Record<SignalRStatus, { label: string; cls: string }> = {
  connected: { label: "Connected", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" },
  connecting: { label: "Connecting…", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-300" },
  reconnecting: { label: "Reconnecting…", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-300" },
  disconnected: { label: "Disconnected", cls: "bg-rose-500/15 text-rose-600 dark:text-rose-300" },
};

export const LpMarginAlerts: React.FC = () => {
  const managerRef = useRef<SignalRConnectionManager | null>(null);
  const [status, setStatus] = useState<SignalRStatus>("disconnected");
  const [rows, setRows] = useState<LpMarginAlertRow[]>([]);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [intervalSec, setIntervalSec] = useState<number>(30);
  const [thresholdInput, setThresholdInput] = useState<string>("");
  const [intervalInput, setIntervalInput] = useState<string>("");
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(0);
  const [saveMsg, setSaveMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applySettings = (data: AlertSettings) => {
    setThreshold(data.marginAlertThreshold);
    setIntervalSec(data.marginAlertIntervalSeconds);
    setThresholdInput(String(data.marginAlertThreshold ?? ""));
    setIntervalInput(String(data.marginAlertIntervalSeconds ?? ""));
  };

  // Load current settings.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const resp = await fetch(apiUrl("/api/AlertSettings"));
        if (!resp.ok) throw new Error(await resp.text());
        const data = (await resp.json()) as AlertSettings;
        if (active) applySettings(data);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (active) setError(`Failed to load settings: ${e?.message || "error"}`);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Connect to the SignalR hub and subscribe to LpMarginAlerts.
  useEffect(() => {
    const hubUrl = apiUrl("/ws/dashboard");
    const manager = new SignalRConnectionManager({
      hubUrl,
      trackedEvents: ["LpMarginAlerts"],
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
    managerRef.current = manager;

    const unsubStatus = manager.onStatusChange(setStatus);
    const unsubEvent = manager.onEvent((payload, eventName) => {
      if (eventName !== "LpMarginAlerts") return;
      setRows(Array.isArray(payload) ? (payload as LpMarginAlertRow[]) : []);
      setLastTickAt(Date.now());
    });
    const unsubError = manager.onError((message) => setError(message));

    manager.connect().catch(() => undefined);

    return () => {
      unsubStatus();
      unsubEvent();
      unsubError();
      manager.disconnect().catch(() => undefined);
    };
  }, []);

  // 1s ticker so the "last tick" staleness label stays current.
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const lastTick = useMemo(() => {
    void nowTick; // recompute every second
    const staleMs = 3 * intervalSec * 1000;
    if (lastTickAt == null) return { text: "Waiting for first tick…", stale: true };
    const ageSec = Math.floor((Date.now() - lastTickAt) / 1000);
    const stale = Date.now() - lastTickAt > staleMs;
    return { text: stale ? `Stale — no tick for ${ageSec}s` : `Last tick: ${ageSec}s ago`, stale };
  }, [lastTickAt, intervalSec, nowTick]);

  const saveSettings = async () => {
    setSaveMsg(null);
    const t = parseFloat(thresholdInput);
    if (!t || t <= 0 || t > 10000) {
      setSaveMsg({ text: "Threshold must be between 0.01 and 10000", ok: false });
      return;
    }
    const i = parseInt(intervalInput, 10);
    if (!Number.isInteger(i) || i < 5 || i > 600) {
      setSaveMsg({ text: "Interval must be an integer between 5 and 600 seconds", ok: false });
      return;
    }
    try {
      const resp = await fetch(apiUrl("/api/AlertSettings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marginAlertThreshold: t, marginAlertIntervalSeconds: i }),
      });
      if (!resp.ok) {
        setSaveMsg({ text: `Error: ${await resp.text()}`, ok: false });
        return;
      }
      applySettings((await resp.json()) as AlertSettings);
      setSaveMsg({ text: "Saved", ok: true });
      setTimeout(() => setSaveMsg(null), 2500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setSaveMsg({ text: `Failed: ${e?.message || "error"}`, ok: false });
    }
  };

  const ws = wsStatusMeta[status];

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded px-2 py-1 font-semibold ${ws.cls}`}>{ws.label}</span>
        <span className="rounded bg-blue-500/10 px-2 py-1 font-semibold text-blue-600 dark:text-blue-300">
          Threshold: {threshold == null ? "--" : `${fmtNum(threshold, 2)}%`}
        </span>
        <span className="rounded bg-blue-500/10 px-2 py-1 font-semibold text-blue-600 dark:text-blue-300">
          Interval: {intervalSec}s
        </span>
        <span
          className={`rounded px-2 py-1 ${
            lastTick.stale ? "bg-rose-500/10 text-rose-600 dark:text-rose-300" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
          }`}
        >
          {lastTick.text}
        </span>
        <span className="ml-auto text-muted-foreground">
          {rows.length} active alert{rows.length !== 1 ? "s" : ""}
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* Settings */}
      <div className="rounded-xl border border-border/40 bg-card/70 p-4">
        <div className="mb-3 text-sm font-semibold text-foreground">Alert Settings</div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="lp-threshold" className="text-muted-foreground">
            Margin Level ≤
          </label>
          <input
            id="lp-threshold"
            type="number"
            min={0.01}
            max={10000}
            step={0.1}
            placeholder="100.0"
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
            className="w-32 rounded-md border border-border bg-background/70 px-2 py-1.5"
          />
          <span className="text-xs text-muted-foreground">%</span>

          <label htmlFor="lp-interval" className="ml-4 text-muted-foreground">
            Tick every
          </label>
          <input
            id="lp-interval"
            type="number"
            min={5}
            max={600}
            step={1}
            placeholder="30"
            value={intervalInput}
            onChange={(e) => setIntervalInput(e.target.value)}
            className="w-28 rounded-md border border-border bg-background/70 px-2 py-1.5"
          />
          <span className="text-xs text-muted-foreground">seconds (5–600)</span>

          <button
            type="button"
            onClick={saveSettings}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Save
          </button>
          {saveMsg && (
            <span className={`text-xs ${saveMsg.ok ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}`}>
              {saveMsg.text}
            </span>
          )}
        </div>
      </div>

      {/* Live alerts grid */}
      <div className="rounded-xl border border-border/40 bg-card/70 p-3">
        <div className="mb-2 text-sm font-semibold text-foreground">Live Alerts</div>
        <div className="max-h-[540px] overflow-auto rounded-lg border border-border/40">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border/50 text-left text-muted-foreground">
                <th className="px-2 py-2">Source</th>
                <th className="px-2 py-2">LP Name</th>
                <th className="px-2 py-2">Login</th>
                <th className="px-2 py-2 text-right">Margin Level %</th>
                <th className="px-2 py-2 text-right">Equity</th>
                <th className="px-2 py-2 text-right">Balance</th>
                <th className="px-2 py-2 text-right">Credit</th>
                <th className="px-2 py-2 text-right">Margin</th>
                <th className="px-2 py-2 text-right">Free Margin</th>
                <th className="px-2 py-2">Last Update</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.source}:${r.login}`} className="border-b border-border/30 hover:bg-background/40">
                  <td className="px-2 py-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${SOURCE_BADGE[r.source || "Manager"] || SOURCE_BADGE.Manager}`}>
                      {r.source || "Manager"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">{r.lpName || "-"}</td>
                  <td className="px-2 py-1.5 font-mono font-semibold">{r.login ?? "-"}</td>
                  <td className="px-2 py-1.5 text-right font-bold text-rose-600 dark:text-rose-300">{fmtNum(r.marginLevel, 2)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtNum(r.equity)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtNum(r.balance)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtNum(r.credit)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtNum(r.margin)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtNum(r.freeMargin)}</td>
                  <td className="px-2 py-1.5">{fmtTime(r.timestampUtc)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-2 py-8 text-center text-muted-foreground">
                    No accounts currently below the margin threshold.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default LpMarginAlerts;
