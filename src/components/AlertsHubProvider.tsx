import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { SignalRConnectionManager, SignalRStatus } from "@/lib/signalRConnectionManager";
import { newBreaches } from "@/lib/alertBreaches";
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
  muted: boolean;
  toggleMute: () => void;
};

const AlertsHubContext = createContext<AlertsHubValue>({
  status: "disconnected",
  lpAlerts: [],
  disconnected: false,
  silence: () => undefined,
  muted: false,
  toggleMute: () => undefined,
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

  // Unlock audio on the first user interaction anywhere (browsers block sound until then).
  useEffect(() => {
    const unlock = () => primeAudio();
    const opts: AddEventListenerOptions = { once: true, capture: true };
    window.addEventListener("pointerdown", unlock, opts);
    window.addEventListener("keydown", unlock, opts);
    window.addEventListener("touchstart", unlock, opts);
    return () => {
      window.removeEventListener("pointerdown", unlock, opts);
      window.removeEventListener("keydown", unlock, opts);
      window.removeEventListener("touchstart", unlock, opts);
    };
  }, []);

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
        ringIfAllowed("disconnect");
      }
      prevStatusRef.current = next;
    });

    const unsubEvent = manager.onEvent((payload, eventName) => {
      if (eventName !== "LpMarginAlerts") return;
      const rows = Array.isArray(payload) ? (payload as LpMarginAlertRow[]) : [];
      setLpAlerts(rows);
      const { newLogins, nextLogins } = newBreaches(prevLoginsRef.current, rows);
      prevLoginsRef.current = nextLogins;
      if (newLogins.length) ringIfAllowed("lp-margin");
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
    muted,
    toggleMute,
  };

  return <AlertsHubContext.Provider value={value}>{children}</AlertsHubContext.Provider>;
};
