import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { mkdir, writeFile, readFile, readdir, rm, stat, open } from "fs/promises";
import { fileURLToPath } from "url";
import os from "os";
import path from "path";
import crypto from "crypto";
import cron from "node-cron";
import { fetchWithBackendToken } from "../wallet/backendToken.js";

export const BACKEND_BASE_URL = String(
  process.env.BACKEND_API_BASE_URL ||
  process.env.VITE_BACKEND_BASE_URL ||
  "https://api.skylinkscapital.com",
).replace(/\/+$/, "");

// Default budget for a backend call. Matches the 45s the report modules were
// already passing for everything except DealMatch/Run, which is slower than a
// whole minute and passes its own.
const BACKEND_FETCH_TIMEOUT_MS = 45_000;

/**
 * The one way a report module talks to the trading backend.
 *
 * WHY THIS EXISTS AT ALL: api.skylinkscapital.com now rejects every request
 * with 401 invalid_token unless a Bearer minted from BACKEND_API_KEY is
 * attached. Five report modules make that call, and they have drifted apart
 * before -- the Deal Match tab and the weekly email disagreed about Net Revenue
 * for weeks because the same maths was written twice. Writing the
 * fetch-with-token dance five times would set that up again, this time on the
 * credential rather than the arithmetic, so it is written once here.
 *
 * WHY NOT THE /api/backend PROXY: that proxy exists to keep the token out of
 * the BROWSER. These modules run in the same Node process that mints the
 * token, so going out through our own HTTP server would add a hop, a second
 * timeout budget and a session requirement for no benefit.
 *
 * FAILURE BEHAVIOUR IS DELIBERATELY BORING. This resolves with the upstream
 * Response whatever its status -- it does not throw on a 4xx/5xx and does not
 * invent a fallback payload -- so each caller's existing `if (!resp.ok) throw`
 * plus its surrounding try/catch keeps deciding what an outage looks like. A
 * token failure throws a BackendTokenError out of here, which is an ordinary
 * rejection landing in that same try/catch, so a missing or rejected
 * BACKEND_API_KEY renders "section unavailable" exactly like an HTTP 500 does.
 * It must never become a zero: a zero is indistinguishable from a real figure.
 *
 * @param {string} pathOrUrl Path relative to BACKEND_BASE_URL ("/DealMatch/Run?..."),
 *   or a full URL, which is passed through untouched.
 */
export function backendFetch(pathOrUrl, { timeoutMs = BACKEND_FETCH_TIMEOUT_MS, headers = {}, ...init } = {}) {
  const target = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : `${BACKEND_BASE_URL}${String(pathOrUrl).startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;

  // The signal is built INSIDE the callback, not once outside it, because
  // fetchWithBackendToken may run this a second time after refreshing a
  // rejected token. A signal shared with the first attempt would hand the
  // retry whatever was left of the original budget -- on DealMatch/Run, which
  // costs ~40s whatever window it is asked for, that is reliably nothing.
  return fetchWithBackendToken((token) =>
    fetch(target, {
      ...init,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
}

// Where the report emails point when they reference a chart image. Must be the
// app's public origin, because the reader's mail client fetches it directly.
export const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL || "https://app.skylinkscapital.com",
).replace(/\/+$/, "");

// Resolved from this file, not process.cwd(): under IIS/a service the working
// directory is often not the app root, and a relative path would then write
// (or look) somewhere unexpected.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CHART_ROUTE = "/report-charts";

// The app pool cannot always create folders inside the site root (Plesk/IIS
// returns EPERM there), so fall through to a location it can write. Resolved
// once and cached, because the write side and the serving route must agree.
let resolvedChartDir = null;
export async function getChartDir() {
  if (resolvedChartDir) return resolvedChartDir;
  const candidates = [
    process.env.REPORT_CHART_DIR,
    path.join(REPO_ROOT, "storage", "report-charts"),
    path.join(os.tmpdir(), "boss-dash-report-charts"),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p));

  const failures = [];
  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      resolvedChartDir = dir;
      if (dir !== candidates[0]) console.warn(`[reports] chart dir not writable higher up; using ${dir}`);
      return dir;
    } catch (error) {
      failures.push(`${dir} (${error?.code || error?.message})`);
    }
  }
  throw new Error(`no writable chart directory. Tried: ${failures.join("; ")}`);
}
const CHART_RETENTION_DAYS = Number(process.env.REPORT_CHART_RETENTION_DAYS || 60);

// Writes rendered charts to disk under a random, unguessable folder and returns
// absolute URLs. Brevo's transactional API ignores cid:, so inline images have
// to be fetched over HTTP — there is no way to keep the bytes inside the message
// short of switching the whole mailer to SMTP.
export async function publishChartImages(images) {
  const base = await getChartDir();
  const token = crypto.randomBytes(16).toString("hex");
  const dir = path.join(base, token);
  await mkdir(dir, { recursive: true });

  const urls = {};
  for (const image of images) {
    // Names are used in a URL and a filesystem path, so keep them boring.
    if (!/^[A-Za-z0-9._-]+\.png$/.test(image.name)) {
      throw new Error(`unsafe chart filename: ${image.name}`);
    }
    await writeFile(path.join(dir, image.name), image.buffer);
    urls[image.name] = `${PUBLIC_BASE_URL}${CHART_ROUTE}/${token}/${image.name}`;
  }

  pruneChartImages().catch((error) =>
    console.warn("[reports] chart cleanup failed:", error?.message || error),
  );
  return { token, dir, urls };
}

// Old report images are dead weight once the email has been read; drop folders
// past the retention window so the directory does not grow without bound.
export async function pruneChartImages() {
  const base = await getChartDir().catch(() => null);
  if (!base) return 0;
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return 0; // nothing written yet
  }
  const cutoff = Date.now() - CHART_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(base, entry.name);
    const info = await stat(full).catch(() => null);
    if (info && info.mtimeMs < cutoff) {
      await rm(full, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// ── one send per reporting window ───────────────────────────────────────────
// WEEKLY_*_RUN_ON_START fires a report every time the process boots. That is
// fine for a one-off check, but a server that recycles its app pool overnight
// turns it into a daily mailshot -- which is exactly what happened with the
// Business Summary. The same guard also stops a cron run duplicating a window a
// startup run already sent.
//
// Only SCHEDULED runs consult and update this. The on-demand test route passes
// explicit recipients and must always send, so it never touches the log.
const SEND_LOG_NAME = "weekly_report_sends.json";
let resolvedSendLog = null;

async function getSendLogFile() {
  if (resolvedSendLog) return resolvedSendLog;
  const candidates = [
    process.env.WEEKLY_REPORT_STATE_FILE,
    path.join(REPO_ROOT, "storage", SEND_LOG_NAME),
    path.join(os.tmpdir(), `boss_dash_${SEND_LOG_NAME}`),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const handle = await open(file, "a");
      await handle.close();
      if (file !== candidates[0]) console.warn(`[reports] send log not writable higher up; using ${file}`);
      resolvedSendLog = file;
      return file;
    } catch {
      // try the next candidate
    }
  }
  return null; // no writable location: the guard disables itself, see below
}

async function readSendLog() {
  const file = await getSendLogFile();
  if (!file) return {};
  try {
    return JSON.parse(await readFile(file, "utf8")) || {};
  } catch {
    return {}; // absent or corrupt: treat as nothing sent yet
  }
}

// `reportKey` names the report ("summary"), `windowKey` names the period
// ("2026-08-08..2026-08-14"). A report is re-sent when the window changes.
export async function alreadySentFor(reportKey, windowKey) {
  const log = await readSendLog();
  return log?.[reportKey]?.window === windowKey;
}

export async function recordSentFor(reportKey, windowKey) {
  const file = await getSendLogFile();
  // Failing to record must never block a send that already succeeded; the cost
  // is a possible duplicate on the next boot, which beats losing the report.
  if (!file) {
    console.warn("[reports] no writable send log; cannot guard against a repeat send");
    return false;
  }
  try {
    const log = await readSendLog();
    log[reportKey] = { window: windowKey, sentAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(log, null, 2), "utf8");
    return true;
  } catch (error) {
    console.warn("[reports] could not record send:", error?.message || error);
    return false;
  }
}

export function toYmdUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseRecipients(csv) {
  return String(csv || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function fmtNum(value, digits = 2) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  return safe.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function money(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(safe).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${safe < 0 ? "-" : ""}$${abs}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function mapWithConcurrency(items, worker, limit = 8) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, limit) }).map(async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

// The last COMPLETE Saturday-to-Friday week, in UTC. Shared by all three weekly
// reports so they always describe an identical period.
//
// Saturday->Friday, not Monday->Sunday, because the reports go out Saturday
// morning Dubai: the forex week closes Friday night, so a Sat-Fri window is
// finished and roughly 13 hours old when the email lands. A Sun-Sat window
// would still have 14 hours to run at that point, and waiting for it would make
// every report six days stale.
//
// `now` is injectable so the boundaries can be tested without freezing a clock.
export function previousFullWeekUtc(now = new Date()) {
  // Sunday=0 ... Saturday=6 in getUTCDay terms.
  const daysSinceSaturday = (now.getUTCDay() + 1) % 7;

  // Start of the week currently in progress; it is deliberately excluded.
  const currentSaturday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  currentSaturday.setUTCDate(currentSaturday.getUTCDate() - daysSinceSaturday);

  const start = new Date(currentSaturday);
  start.setUTCDate(start.getUTCDate() - 7);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(currentSaturday);
  end.setUTCDate(end.getUTCDate() - 1);
  end.setUTCHours(23, 59, 59, 0);

  return { start, end };
}

export function previousFullDayUtc(now = new Date()) {
  // Yesterday, whole. The day in progress is excluded for the same reason the
  // week in progress is: a figure that keeps moving is not a report.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - 1);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCHours(23, 59, 59, 0);

  return { start, end };
}

export function previousFullMonthUtc(now = new Date()) {
  // Day 0 of a month is the last day of the month before it, so the end date
  // needs no table of month lengths and gets February right in a leap year.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  end.setUTCHours(23, 59, 59, 0);

  return { start, end };
}

// The three reporting rhythms, in one place. Every report answers the same
// questions over one of these windows, so the noun its copy uses, the word its
// subject starts with, the period it covers and the key the send guard records
// all belong together rather than being restated in each report module.
export const CADENCES = {
  daily: {
    noun: "day",
    subjectWord: "Daily",
    period: previousFullDayUtc,
    windowKey: (fromYmd) => fromYmd,
  },
  weekly: {
    noun: "week",
    subjectWord: "Weekly",
    period: previousFullWeekUtc,
    windowKey: (fromYmd, toYmd) => `${fromYmd}..${toYmd}`,
  },
  monthly: {
    noun: "month",
    subjectWord: "Monthly",
    period: previousFullMonthUtc,
    // YYYY-MM, not the date range. A monthly re-run on the same 1st after an app
    // pool recycle must find its own key and skip.
    windowKey: (fromYmd) => fromYmd.slice(0, 7),
  },
};

// First variable that carries an actual list wins. An empty string is not a
// list: writing DAILY_SLIPPAGE_RECIPIENTS= in the env file must fall through to
// the report's own list rather than resolving to nobody.
export function resolveRecipients(recipientVars) {
  for (const name of recipientVars) {
    const parsed = parseRecipients(process.env[name] || "");
    if (parsed.length) return parsed;
  }
  return [];
}

// One scheduler for all nine sends. Every report used to carry its own copy of
// this block; five copies meant the boot-time warning below could be forgotten
// in the sixth, which is the failure that made the weekly summary silently send
// nothing for weeks.
//
// `schedule` is injectable so tests can observe registration without leaving a
// live cron job behind.
export function startReportScheduler({
  label,
  defaultCron,
  defaultTimezone = "Asia/Dubai",
  enabledVar,
  cronVar,
  timezoneVar,
  runOnStartVar,
  recipientVars,
  run,
  schedule: scheduleFn = cron.schedule,
}) {
  const enabled = String(process.env[enabledVar] || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log(`[${label}] disabled by ${enabledVar}=false`);
    return { registered: false, reason: "disabled" };
  }

  const expression = String(process.env[cronVar] || defaultCron);
  const timezone = String(process.env[timezoneVar] || defaultTimezone);
  if (!cron.validate(expression)) {
    console.error(`[${label}] Invalid cron expression: "${expression}"`);
    return { registered: false, reason: "invalid-cron", schedule: expression, timezone };
  }

  scheduleFn(
    expression,
    async () => {
      try {
        await run();
      } catch (error) {
        // One report failing must never take the other eight down with it.
        console.error(`[${label}] run failed:`, error?.message || error);
      }
    },
    { timezone },
  );
  console.log(`[${label}] scheduled with expression "${expression}" (${timezone})`);

  // Say this at BOOT, while someone is watching. On schedule it is invisible:
  // the job fires, logs one line and sends nothing. The test-send routes take
  // their recipients from the request body, so they keep working and hide it.
  const warnedNoRecipients = resolveRecipients(recipientVars).length === 0;
  if (warnedNoRecipients) {
    console.error(
      `[${label}] WILL NOT SEND: none of ${recipientVars.join(", ")} is set. ` +
        "Scheduled runs skip silently; test sends still work because they pass recipients explicitly.",
    );
  }

  if (String(process.env[runOnStartVar] || "false").toLowerCase() === "true") {
    run().catch((error) => {
      console.error(`[${label}] startup run failed:`, error?.message || error);
    });
  }

  return { registered: true, schedule: expression, timezone, warnedNoRecipients };
}

export function toUnixRange(fromDate, toDate) {
  const from = Math.floor(fromDate.getTime() / 1000);
  const to = Math.floor(toDate.getTime() / 1000);
  return { from, to };
}

export async function sendBrevoEmail({ subject, html, recipients, attachments = [], senderName = "Deal Match Reporter" }) {
  const apiKey = process.env.BREVO_API_KEY || "";
  const from = process.env.EMAIL_FROM || "noreply@skylinkscapital.com";
  if (!apiKey) throw new Error("BREVO_API_KEY not set");
  if (!recipients.length) throw new Error("No recipients configured");

  const to = recipients.map((email) => ({ email }));
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: from, name: senderName },
      to,
      subject,
      htmlContent: html,
      ...(attachments.length ? { attachment: attachments } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Brevo HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
}

export async function renderChartBuffer(config, width = 1200, height = 700) {
  const renderer = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "#ffffff",
  });
  return renderer.renderToBuffer(config, "image/png");
}

// ─────────────────────────────────────────────────────────────────────────────
// CRM (FXBO) access
// ─────────────────────────────────────────────────────────────────────────────
// dealMatchWeeklyReport.js has its own private copy of this for IB commission.
// These exports exist so new reports do not hand-copy it; that report is
// deliberately left alone rather than refactored onto this.

export const CRM_API_VERSION = String(process.env.VITE_API_VERSION || "1.0.0");
export const CRM_REST_BASE = String(
  process.env.REST_PROXY_TARGET || "https://portal.skylinkscapital.com",
).replace(/\/+$/, "");

const CRM_API_TOKEN = String(process.env.VITE_API_TOKEN || process.env.API_TOKEN || "").trim();

export function crmConfigured() {
  return Boolean(CRM_API_TOKEN);
}

// POSTs a CRM search payload and returns the parsed array. `path` is the part
// after /rest, e.g. "transactions".
export async function crmPost(path, payload, { timeoutMs = 45_000 } = {}) {
  const url = `${CRM_REST_BASE}/rest/${path}?version=${encodeURIComponent(CRM_API_VERSION)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`CRM /rest/${path} HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  return Array.isArray(json) ? json : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Email shell
// ─────────────────────────────────────────────────────────────────────────────
// Encodes the rendering rules documented in docs/dealing-reporting.md section 6:
//   * NO @media anywhere — Zoho strips it, so one layout serves every screen.
//   * Row labels are real DOM text, never ::before content.
//   * box-sizing on the wrappers, or width:100% + padding overflows the viewport.
//   * Numeric cells never wrap; wide tables scroll inside .tscroll.
//   * TOTAL rows go at the TOP of <tbody>, never in <tfoot>.
// Do not "tidy" these back to conventional responsive CSS.

const THEMES = {
  light: {
    pageBg: "#f3f7fb", cardBg: "#ffffff", cardBorder: "#dbe6f2",
    headerBg: "linear-gradient(135deg,#0f2d4f,#114b7a)", headerFg: "#eaf4ff",
    headerMeta: "#bcd6ee", subtitle: "#cfe3f8",
    ink: "#0f172a", muted: "#64748b", line: "#e2e8f0", zebra: "#f9fcff",
    thBg: "#0f2d4f", thFg: "#f8fafc", totalBg: "#eff6ff", totalFg: "#0f2d4f",
    kpiBg: "#f8fbff", kpiBorder: "#d9e8f8", kpiValue: "#0f2d4f",
  },
  dark: {
    pageBg: "#0b1220", cardBg: "#111a2c", cardBorder: "#1f2a44",
    headerBg: "linear-gradient(135deg,#0b1a33,#132a4f)", headerFg: "#eaf4ff",
    headerMeta: "#9fb8d6", subtitle: "#93c5fd",
    ink: "#e2e8f0", muted: "#8ea4c6", line: "#223255", zebra: "#101c33",
    thBg: "#16233f", thFg: "#cfe0fb", totalBg: "#16233f", totalFg: "#e2e8f0",
    kpiBg: "#0f1a30", kpiBorder: "#223255", kpiValue: "#e2e8f0",
  },
};

// One table cell carrying its own visible row label. Right-aligned cells are
// numeric and never wrap; `nowrap` marks a left-aligned identifier (a login),
// which must not break either — "10218/6" is worse than a wide column.
export function dataCell(label, value, { align = "left", bold = false, cls = "", nowrap = false } = {}) {
  const kind = align === "right" ? "num" : nowrap ? "key" : "txt";
  const style = bold ? ' style="font-weight:700;"' : "";
  const valueCls = cls ? ` ${cls}` : "";
  return `<td class="${kind}" data-label="${escapeHtml(label)}"${style}><span class="lbl">${escapeHtml(label)}</span><span class="val${valueCls}">${value}</span></td>`;
}

// Full-width cell (TOTAL label, empty-state notice) — no label/value split.
export function spanCell(value, { colspan = 1, align = "left", cls = "" } = {}) {
  return `<td class="txt" colspan="${colspan}" style="text-align:${align};"><span class="val${cls ? ` ${cls}` : ""}">${value}</span></td>`;
}

// KPI cards. Capped at a px width so several sit on a desktop row and they
// stack one per line on a phone — no media query involved.
export function kpiGrid(cards, { maxWidth = 222 } = {}) {
  if (!cards.length) return "";
  const cells = cards
    .map(
      (c) => `<td class="kpi" style="max-width:${maxWidth}px;">
        <p class="kpi-label">${escapeHtml(c.label)}</p>
        <p class="kpi-value${c.cls ? ` ${c.cls}` : ""}">${c.value}</p>
        ${c.note ? `<p class="kpi-note-sm">${escapeHtml(c.note)}</p>` : ""}
      </td>`,
    )
    .join("");
  return `<table class="kpis" role="presentation"><tr>${cells}</tr></table>`;
}

// A data table with its TOTAL row first. `headers` is [{label, width}].
export function dataTable({ headers, totalRow = "", bodyRows = "", emptyText = "No rows.", narrow = false }) {
  const head = headers.map((h) => `<th width="${h.width}">${h.label}</th>`).join("");
  const empty = `<tr>${spanCell(emptyText, { colspan: headers.length, align: "center" })}</tr>`;
  const table = `<table class="data${narrow ? " narrow" : ""}">
            <thead><tr>${head}</tr></thead>
            <tbody>
              ${totalRow ? `<tr class="total-row">${totalRow}</tr>` : ""}
              ${bodyRows || empty}
            </tbody>
          </table>`;
  return narrow ? table : `<div class="tscroll">${table}</div>`;
}

export function emailShell({ theme = "light", title, subtitle = "", metaLines = [], body, footerLines = [] }) {
  const t = THEMES[theme] || THEMES.light;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { margin:0; padding:0; background:${t.pageBg}; color:${t.ink}; font-family: Arial, Helvetica, sans-serif; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
      .outer, .wrap, .header, .content { box-sizing:border-box; }
      .outer { width:100%; background:${t.pageBg}; padding:8px 4px; }
      .wrap { width:100%; max-width:980px; margin:0 auto; background:${t.cardBg}; border:1px solid ${t.cardBorder}; border-radius:10px; overflow:hidden; }
      .header { padding:14px 16px; background:${t.headerBg}; color:${t.headerFg}; }
      .title { margin:0; font-size:19px; font-weight:700; letter-spacing:0.2px; }
      .subtitle { margin:6px 0 0; font-size:12px; color:${t.subtitle}; }
      .header-meta { margin:10px 0 0; font-size:11px; line-height:1.55; color:${t.headerMeta}; }
      .content { padding:16px; }
      .section-title { margin:14px 0 8px; font-size:14px; color:${t.totalFg}; font-weight:700; }
      .note { margin:0 0 10px; font-size:11px; color:${t.muted}; }
      .kpis { width:100%; border-collapse:collapse; margin:0 0 8px; font-size:0; text-align:center; }
      .kpis td { display:inline-block; width:100%; margin:0 3px 6px; vertical-align:top; box-sizing:border-box; font-size:12px; text-align:left; background:${t.kpiBg}; border:1px solid ${t.kpiBorder}; border-radius:10px; padding:10px 12px; }
      .kpi-label { font-size:10px; text-transform:uppercase; letter-spacing:0.3px; color:${t.muted}; margin:0 0 5px; line-height:1.25; }
      .kpi-value { font-size:16px; font-weight:700; color:${t.kpiValue}; margin:0; white-space:nowrap; }
      .kpi-note-sm { font-size:10px; color:${t.muted}; margin:4px 0 0; }
      /* ── cells flow, they never scroll ──────────────────────────────────
         Zoho ships a 29-property allow-list. It KEEPS display / width /
         max-width / white-space / box-sizing, and DROPS
         -webkit-overflow-scrolling, overflow-wrap, word-break -- and with them
         overscroll-behavior and touch-action. So a horizontally scrolling
         table could not be made safe: on Android the swipe chained out of the
         table and Zoho flipped to the next email.

         Instead each cell is an inline-block of fixed width, exactly the way
         the KPI cards already behave in Zoho today. Wide screen: cells sit
         side by side and the columns line up. Phone: each takes the full width
         and the row becomes a stack. No media query, no scrolling, nothing
         Zoho strips.

         The header row is hidden because every cell carries its own label. */
      .tscroll { width:100%; overflow-x:auto; margin:0 0 16px; }
      table.data { border-collapse:collapse; width:100%; font-size:12px; }
      table.data.narrow { font-size:11px; margin:0 0 16px; }
      table.data thead { display:none; }
      table.data tbody tr { display:block; box-sizing:border-box; border-bottom:1px solid ${t.line}; padding:4px 0; }
      table.data tbody tr:nth-child(even) { background:${t.zebra}; }
      table.data tr.total-row { background:${t.totalBg}; }
      table.data tr.total-row td { font-weight:700; color:${t.totalFg}; }
      table.data td, table.data th { display:inline-block; box-sizing:border-box; width:100%; max-width:156px; vertical-align:top; border:0; padding:4px 8px; text-align:left; }
      table.data td .lbl { display:block; font-size:9px; font-weight:700; letter-spacing:0.4px; text-transform:uppercase; color:${t.muted}; }
      table.data td .val { display:block; font-size:12px; }
      table.data td.num .val { white-space:nowrap; }
      table.data td.key .val { white-space:nowrap; }
      .ch-img { margin:0 0 16px; }
      .ch-img img { display:block; width:100%; max-width:100%; height:auto; border:1px solid ${t.line}; border-radius:8px; }
      .pos { color:#15803d; font-weight:700; }
      .neg { color:#b91c1c; font-weight:700; }
      .cost { color:#b45309; }
      .badge { display:inline-block; font-size:9px; font-weight:700; color:#15803d; border:1px solid #86efac; background:#f0fdf4; border-radius:4px; padding:1px 4px; margin-left:4px; }
      .foot { border-top:1px solid ${t.line}; margin-top:14px; padding-top:10px; color:${t.muted}; font-size:12px; line-height:1.5; }
    </style>
  </head>
  <body>
    <div class="outer">
      <div class="wrap">
        <div class="header">
          <h1 class="title">${escapeHtml(title)}</h1>
          ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
          ${metaLines.length ? `<div class="header-meta">${metaLines.join("<br/>")}</div>` : ""}
        </div>
        <div class="content">
          ${body}
          ${footerLines.length ? `<div class="foot">${footerLines.join("<br/>")}</div>` : ""}
        </div>
      </div>
    </div>
  </body>
</html>`;
}
