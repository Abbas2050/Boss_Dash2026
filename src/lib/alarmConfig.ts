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
