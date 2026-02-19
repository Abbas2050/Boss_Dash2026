import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/sonner";
import { SignalRConnectionManager } from "@/lib/signalRConnectionManager";
import { Activity, AlertTriangle, CheckCircle, Info, ShoppingCart, X, XCircle } from "lucide-react";
import {
  ALERT_EVENT_KEYS,
  ALERT_EVENT_META,
  AlertEventKey,
  AlertPreferences,
  onAlertPreferencesChanged,
  readAlertPreferences,
} from "@/lib/alertPreferences";

function eventPulseClass(eventName: AlertEventKey): string {
  if (eventName === "AccountAlert") return "from-red-500/30 to-red-500/5";
  if (eventName === "UserChangeAlert") return "from-emerald-500/30 to-emerald-500/5";
  if (eventName === "TransactionAlert") return "from-amber-500/30 to-amber-500/5";
  if (eventName === "PositionMatchTableUpdate") return "from-cyan-500/30 to-cyan-500/5";
  if (eventName === "DealUpdate") return "from-blue-500/30 to-blue-500/5";
  if (eventName === "PositionUpdate") return "from-lime-500/30 to-lime-500/5";
  if (eventName === "OrderUpdate") return "from-orange-500/30 to-orange-500/5";
  return "from-slate-500/30 to-slate-500/5";
}

function eventItemClass(eventName: AlertEventKey): string {
  if (eventName === "AccountAlert") return "text-destructive border-destructive/30 bg-destructive/10";
  if (eventName === "UserChangeAlert") return "text-success border-success/30 bg-success/10";
  if (eventName === "TransactionAlert") return "text-warning border-warning/30 bg-warning/10";
  if (eventName === "PositionMatchTableUpdate") return "text-cyan-300 border-cyan-400/30 bg-cyan-500/10";
  if (eventName === "DealUpdate") return "text-blue-300 border-blue-400/30 bg-blue-500/10";
  if (eventName === "PositionUpdate") return "text-lime-300 border-lime-400/30 bg-lime-500/10";
  if (eventName === "OrderUpdate") return "text-orange-300 border-orange-400/30 bg-orange-500/10";
  return "text-primary border-primary/30 bg-primary/10";
}

function EventIcon(eventName: AlertEventKey) {
  if (eventName === "AccountAlert") return XCircle;
  if (eventName === "UserChangeAlert") return CheckCircle;
  if (eventName === "TransactionAlert") return AlertTriangle;
  if (eventName === "PositionMatchTableUpdate") return Activity;
  if (eventName === "DealUpdate") return ShoppingCart;
  if (eventName === "PositionUpdate") return Activity;
  if (eventName === "OrderUpdate") return ShoppingCart;
  return Info;
}

function getHubAndTokenUrls() {
  const backendBaseUrl = (import.meta as any).env?.VITE_BACKEND_BASE_URL || "";
  const explicitTokenUrl = (import.meta as any).env?.VITE_SIGNALR_TOKEN_URL || "";
  const base = String(backendBaseUrl).replace(/\/+$/, "");
  const tokenBase = String(explicitTokenUrl).trim();
  return {
    hubUrl: base ? `${base}/ws/dashboard` : "/ws/dashboard",
    tokenUrls: tokenBase
      ? [tokenBase]
      : [],
  };
}

function buildDescription(eventName: AlertEventKey, payload: any): string {
  if (eventName === "UserChangeAlert") {
    return `${payload?.eventType || "Update"}: ${payload?.name || "Client"} (Login ${payload?.login ?? "-"}) in ${payload?.group || "unknown group"}`;
  }
  if (eventName === "AccountAlert") {
    return `${payload?.alertType || "Risk"} for account ${payload?.account?.login ?? "-"} in ${payload?.group || "unknown group"} | Equity ${payload?.account?.equity ?? "-"} | Balance ${payload?.account?.balance ?? "-"}`;
  }
  if (eventName === "PositionMatchTableUpdate") {
    const symbols = Array.isArray(payload?.rows) ? payload.rows.length : 0;
    const lps = Array.isArray(payload?.lpNames) ? payload.lpNames.length : 0;
    return `Position match table refreshed for ${symbols} symbols across ${lps} LPs.`;
  }
  if (eventName === "DealUpdate") {
    return `Client ${payload?.login ?? "-"} deal ${payload?.deal ?? payload?.dealId ?? "-"} on ${payload?.symbol ?? "-"} at ${payload?.price ?? "-"}.`;
  }
  if (eventName === "PositionUpdate") {
    return `Client ${payload?.login ?? "-"} position ${payload?.position ?? payload?.positionId ?? "-"} on ${payload?.symbol ?? "-"}.`;
  }
  if (eventName === "OrderUpdate") {
    return `Order ${payload?.order ?? payload?.orderId ?? "-"} for client ${payload?.login ?? "-"} changed to ${payload?.state ?? payload?.status ?? "updated"}.`;
  }
  if (eventName === "TransactionAlert") {
    return `${payload?.transactionType || "Transaction"} for client ${payload?.login ?? "-"} amount ${payload?.amount ?? "-"} ${payload?.currency ?? ""}.`;
  }
  return JSON.stringify(payload ?? {});
}

export function LiveAlertsNotifier() {
  const managerRef = useRef<SignalRConnectionManager | null>(null);
  const prefsRef = useRef<AlertPreferences>(readAlertPreferences());
  const lastShownRef = useRef<Record<string, number>>({});
  const [prefs, setPrefs] = useState<AlertPreferences>(prefsRef.current);

  const enabledEvents = useMemo(
    () => ALERT_EVENT_KEYS.filter((key) => prefs[key]),
    [prefs]
  );

  useEffect(() => {
    const off = onAlertPreferencesChanged((next) => {
      prefsRef.current = next;
      setPrefs(next);
    });
    return off;
  }, []);

  useEffect(() => {
    if (enabledEvents.length === 0) {
      if (managerRef.current) {
        managerRef.current.disconnect().catch(() => undefined);
        managerRef.current = null;
      }
      return;
    }

    if (managerRef.current) {
      managerRef.current.disconnect().catch(() => undefined);
      managerRef.current = null;
    }

    const { hubUrl, tokenUrls } = getHubAndTokenUrls();
    const manager = new SignalRConnectionManager({
      hubUrl,
      trackedEvents: enabledEvents,
      accessTokenFactory: async () => {
        if (tokenUrls.length === 0) {
          // Tunnel hub can be public/no-token. Skip token probing unless explicitly configured.
          return null;
        }
        for (const tokenUrl of tokenUrls) {
          try {
            const res = await fetch(tokenUrl);
            if (!res.ok) continue;
            const j = await res.json();
            if (j?.token) return j.token;
          } catch {
            // Try the next token endpoint candidate.
          }
        }
        return null;
      },
    });

    manager.onEvent((payload: unknown, eventName: string) => {
      const key = eventName as AlertEventKey;
      if (!prefsRef.current[key]) return;

      // Small dedupe window to avoid duplicate popups from mirrored streams.
      const now = Date.now();
      const sig = `${eventName}:${JSON.stringify(payload ?? {})}`;
      const last = lastShownRef.current[sig] || 0;
      if (now - last < 800) return;
      lastShownRef.current[sig] = now;

      const meta = ALERT_EVENT_META[key];
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const title = meta?.title || eventName;
      const sub = meta?.description || "";
      const detail = buildDescription(key, payload as any);
      const Icon = EventIcon(key);

      toast.custom((toastId) => (
        <div className={`w-full max-w-full p-3 rounded-lg border ${eventItemClass(key)} relative overflow-hidden`}>
          <div className={`pointer-events-none absolute inset-0 bg-gradient-to-r ${eventPulseClass(key)}`} />
          <div className="relative">
            <div className="flex items-start gap-2">
              <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm truncate">{title}</span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <span className="text-xs opacity-70 font-mono">{stamp}</span>
                    <button
                      type="button"
                      aria-label="Close alert"
                      onClick={() => toast.dismiss(toastId)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-foreground/30 bg-background/85 text-foreground hover:bg-background"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="mt-0.5 text-xs opacity-80">{sub}</div>
                <p className="text-xs opacity-80 mt-1 leading-relaxed">{detail}</p>
              </div>
            </div>
          </div>
        </div>
      ), {
        className: "!border-0 !bg-transparent !shadow-none !p-0 !m-0",
        closeButton: false,
      });
    });

    manager.connect().catch(() => undefined);
    managerRef.current = manager;

    return () => {
      manager.disconnect().catch(() => undefined);
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, [enabledEvents]);

  return null;
}
