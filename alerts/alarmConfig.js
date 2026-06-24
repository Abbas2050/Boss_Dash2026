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
    ? cfg.recipientUserIds
        .filter((v) => v != null && v !== "")
        .map((v) => String(v))
        .filter(Boolean)
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
