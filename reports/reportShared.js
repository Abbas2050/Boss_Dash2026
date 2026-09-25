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
  // Palette taken from the Risk Analysis Report the business asked these
  // emails to look like: slate-900 ink and chrome, one cyan accent, and a
  // single grey for borders instead of the four near-identical blues this
  // previously carried. A gradient header was dropped for a flat slate bar --
  // Outlook renders a CSS gradient as nothing at all, so the old header was
  // already flat for a large share of recipients, just an unintended flat.
  light: {
    pageBg: "#eef1f6", cardBg: "#ffffff", cardBorder: "#e6eaf1",
    headerBg: "#0f172a", headerFg: "#ffffff",
    headerMeta: "#94a3b8", subtitle: "#e2e8f0",
    ink: "#0f172a", muted: "#64748b", line: "#e6eaf1", zebra: "#f8fafc",
    thBg: "#0f172a", thFg: "#cbd5e1", totalBg: "#f8fafc", totalFg: "#0f172a",
    kpiBg: "#f8fafc", kpiBorder: "#e6eaf1", kpiValue: "#0f172a",
    accent: "#22d3ee",
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
      /* The Risk Analysis Report's section rule: a cyan bar, then a tracked
         uppercase label. The bar is what makes a long report scannable -- the
         eye finds the next section without reading it. The accent token is
         optional on a theme, so this falls back to the ink colour rather than
         emitting "border-left:3px solid undefined". */
      .section-title { margin:22px 0 10px; font-size:12px; font-weight:700; letter-spacing:0.09em; text-transform:uppercase; color:${t.ink}; border-left:3px solid ${t.accent || t.totalFg}; padding-left:9px; }
      .note { margin:0 0 10px; font-size:11px; color:${t.muted}; }
      .kpis { width:100%; border-collapse:collapse; margin:0 0 8px; font-size:0; text-align:center; }
      /* .kpi is named as well as ".kpis td" because that is the class the
         markup actually carries. A class the HTML uses but the stylesheet only
         reaches by descendant selector is invisible to a coverage scan, and a
         card moved out of its table would silently lose every declaration. */
      .kpis td, .kpi { display:inline-block; width:100%; margin:0 3px 6px; vertical-align:top; box-sizing:border-box; font-size:12px; text-align:left; background:${t.kpiBg}; border:1px solid ${t.kpiBorder}; border-radius:10px; padding:10px 12px; }
      .kpi-label { font-size:10px; text-transform:uppercase; letter-spacing:0.3px; color:${t.muted}; margin:0 0 5px; line-height:1.25; }
      .kpi-value { font-size:16px; font-weight:700; color:${t.kpiValue}; margin:0; white-space:nowrap; }
      .kpi-note-sm { font-size:10px; color:${t.muted}; margin:4px 0 0; }
      /* Cells emitted by the shared card system (rptCard / rptHero). Their
         column width is an inline px max-width, because that is what survives
         a client with no stylesheet support at all; this rule exists so the
         phone override below has something to override, and so the class is
         not referenced without a rule. */
      .rpt-cell { vertical-align:top; }
      /* Phone widths: enhancement only, never load-bearing. The inline cap
         already stacks the cells when it exceeds the viewport -- what it cannot
         do is make a 228px card fill a 343px screen, which leaves the deck
         ragged. Zoho strips media queries entirely (see the "Single layout"
         note in the report shells), so a Zoho reader keeps exactly the stacked
         layout they have today and nothing here is depended upon. */
      @media only screen and (max-width: 600px) {
        .rpt-cell { max-width:100% !important; width:100% !important; display:block !important; }
      }
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
      /* The third kind of cell. It is the wrapping one, and it is written out
         rather than left to the default so that all three kinds dataCell can
         emit are declared here — and so a txt cell cannot inherit a nowrap
         from anywhere and quietly widen a table on a phone. */
      table.data td.txt .val { white-space:normal; }
      .ch-img { margin:0 0 16px; }
      .ch-img img { display:block; width:100%; max-width:100%; height:auto; border:1px solid ${t.line}; border-radius:8px; }
      .pos { color:#15803d; font-weight:700; }
      .neg { color:#b91c1c; font-weight:700; }
      /* The third outcome. A sign classifier that returns pos/neg for a figure
         has to return something for exactly zero too, and that something must
         be styled or the cell renders in whatever the surrounding weight is and
         reads as a value rather than as an absence of one. */
      .muted { color:${t.muted}; }
      /* An identifier that is not a real name — the "Unattributed" LP bucket.
         Italic so it is visibly not one of the LPs beside it. */
      .muted-key { font-style:italic; color:${t.muted}; }
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


/* ══ Report card system ═════════════════════════════════════════════════
 *
 * Lives here rather than in one report because every scheduled email is meant
 * to look like the same product. It was written for the Deal Match report; the
 * moment a second report wanted it, keeping it there would have meant either a
 * copy or swapsReport.js importing from dealMatchWeeklyReport.js, and neither
 * of those survives a third caller.
 * ═══════════════════════════════════════════════════════════════════════ */

/* ── Card deck, in the Risk Analysis Report's visual language ─────────────
 *
 * Styles are INLINE rather than classes in the shell's <style> block, and that
 * is the point rather than an oversight. The comments around `.tscroll` and
 * `table.data` in reports/reportShared.js record what this codebase already
 * learned the hard way: Zoho ships a 29-property allow-list and silently drops
 * the rest. A <style> block is a suggestion; a style attribute is not. The
 * Risk Analysis Report these cards are modelled on is inline throughout, which
 * is why it survives every client it is sent to.
 *
 * The palette is that report's, named here once so a later card cannot invent
 * its own greys.
 */
// SINGLE quotes around 'Segoe UI', never double.
//
// This string is interpolated into style="..." attributes. A double quote in
// the value closes the attribute at that point, so `font:700 10px/1.4
// -apple-system, BlinkMacSystemFont, "Segoe UI", ...` parsed as a style of
// `font:700 10px/1.4 -apple-system, BlinkMacSystemFont,` and everything after
// it -- including color -- was dropped. On the light cards that merely lost the
// intended size and weight; on the dark hero card it meant color:#ffffff never
// applied and the text rendered in the inherited near-black, invisible against
// #0f172a. CSS accepts single quotes for a family name, and they are safe
// inside a double-quoted attribute.
export const RPT_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const RPT = {
  ink: "#0f172a",
  accent: "#22d3ee",
  cardBg: "#f8fafc",
  cardBorder: "#e6eaf1",
  muted: "#64748b",
  pos: "#059669",
  neg: "#dc2626",
  warn: "#b45309",
};

/**
 * Card tints. Every card belonged to one grey family before this, which meant
 * colour carried no information and a reader scanning the deck had nothing to
 * group by. Each tone answers "what kind of number is this?" -- the same
 * grouping the Deal Match Analysis tab already uses on screen, so an operator
 * reading the email and then opening the tab sees the same colours mean the
 * same things.
 *
 *   em  money earned, and the client flow that earns it
 *   am  commission, and the shifting bucket
 *   cy  realized volume (a different unit from deals, so a different family)
 *   ro  cost
 *   in  internal accounts -- a parallel bucket, deliberately not em/cy
 *
 * `fg` is applied to the FIGURE only. The label and the note stay muted grey in
 * every tone, so the tint groups cards without turning the deck into a
 * ransom note.
 */
export const TONES = {
  em: { bg: "#ecfdf5", bd: "#6ee7b7", fg: "#047857" },
  am: { bg: "#fffbeb", bd: "#fcd34d", fg: "#b45309" },
  cy: { bg: "#ecfeff", bd: "#67e8f9", fg: "#0e7490" },
  ro: { bg: "#fff1f2", bd: "#fda4af", fg: "#be123c" },
  in: { bg: "#eef2ff", bd: "#a5b4fc", fg: "#4338ca" },
  plain: { bg: "#f8fafc", bd: "#e6eaf1", fg: "#0f172a" },
};

/**
 * A share, for a card note. Returns "—" rather than "0.0%" or "NaN%" when the
 * denominator is missing: this project's dash means "could not read", which is
 * the honest answer when there is no total to divide by.
 */
export function pctOf(part, whole) {
  const w = Number(whole) || 0;
  if (!w) return "—";
  const pct = (Number(part) || 0) / w * 100;
  return `${pct < 0.01 && pct > 0 ? "<0.01" : pct.toFixed(2)}%`;
}

/**
 * A section rule: cyan bar, tracked uppercase label, then a lower-case grey
 * subtitle carrying the METHODOLOGY rather than a restatement of the title.
 * "— live deal-matching · hedged vs internalised" is the move worth copying:
 * it says where the number came from in the same breath as naming it.
 */
export function rptSectionTitle(title, subtitle = "") {
  const sub = subtitle
    ? `<span style="font-weight:500;letter-spacing:0;text-transform:none;color:${RPT.muted};font-size:11px"> — ${escapeHtml(subtitle)}</span>`
    : "";
  return `<div style="font:700 12px/1.4 ${RPT_FONT};letter-spacing:.09em;text-transform:uppercase;color:${RPT.ink};border-left:3px solid ${RPT.accent};padding-left:9px;margin:22px 0 10px">${escapeHtml(title)}${sub}</div>`;
}

/**
 * One KPI card. `tone` colours the FIGURE only — never the card — so colour
 * stays semantic and a red number means money leaving rather than decoration.
 * `unit` rides at 13px muted so the magnitude reads first ("802,646.01 lots").
 */
export function rptCard({ label, value, unit = "", note = "", tone = "plain" }) {
  // Legacy tone names from the first pass, kept so a caller I miss still gets a
  // sensible card rather than an untinted one.
  const alias = { pos: "em", neg: "ro", warn: "am", ink: "plain" };
  const t = TONES[alias[tone] || tone] || TONES.plain;

  const unitHtml = unit
    ? ` <span style="font-size:11px;color:${RPT.muted};font-weight:600;letter-spacing:0">${escapeHtml(unit)}</span>`
    : "";
  const noteHtml = note
    ? `<div style="font:400 10px/1.45 ${RPT_FONT};color:${RPT.muted};margin-top:6px">${escapeHtml(note)}</div>`
    : "";
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${t.bg};border:1px solid ${t.bd};border-radius:12px;height:100%">
      <tr><td style="padding:12px 13px">
        <div style="font:700 9.5px/1.4 ${RPT_FONT};letter-spacing:.09em;text-transform:uppercase;color:${RPT.muted}">${escapeHtml(label)}</div>
        <div style="font:800 20px/1.25 ${RPT_FONT};color:${t.fg};margin-top:5px;white-space:nowrap;letter-spacing:-.4px">${value}${unitHtml}</div>
        ${noteHtml}
      </td></tr>
    </table>`;
}

/**
 * The headline band: one figure given the whole stage, flanked by the two that
 * explain it.
 *
 * Net revenue is what this email is opened for, and it used to be the fifth of
 * five identical tiles — nothing on the page said where to look. A dark card at
 * 30px says it without a word of copy.
 *
 * Built as a three-cell table rather than a grid: Outlook's Word renderer has
 * no CSS grid, and this has to survive there. border-radius degrades to square
 * corners in the same renderer, which is a fine way to lose that argument.
 */
/*
 * The label/value/note elements carry kpi-label / kpi-value / kpi-note-sm as
 * well as their inline styles. Those class names are hooks, not styling -- the
 * inline rules do the visual work and win over the shell's stylesheet either
 * way. They are here so a card stays machine-readable: the report tests locate
 * a headline figure by them, and keeping them means a card can be restyled
 * without rewriting the assertions that check what it SAYS. `cls` rides onto
 * kpi-value for the same reason (revenue / cost / muted).
 */
export function rptHero({ label, value, note, cls = "", left, right }) {
  const mini = (m) => {
    const t = TONES[m.tone] || TONES.plain;
    return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${t.bg};border:1px solid ${t.bd};border-radius:12px;height:100%">
        <tr><td style="padding:13px 14px">
          <p class="kpi-label" style="margin:0;font:700 9.5px/1.4 ${RPT_FONT};letter-spacing:.09em;text-transform:uppercase;color:${RPT.muted}">${escapeHtml(m.label)}</p>
          <p class="kpi-value${m.cls ? ` ${m.cls}` : ""}" style="margin:5px 0 0;font:800 19px/1.2 ${RPT_FONT};color:${t.fg};white-space:nowrap;letter-spacing:-.4px">${m.value}</p>
          <p class="kpi-note-sm" style="margin:6px 0 0;font:400 10px/1.4 ${RPT_FONT};color:${RPT.muted}">${escapeHtml(m.note)}</p>
        </td></tr>
      </table>`;
  };

  // Inline-block cells, same no-@media reasoning as rptCardGrid(): the hero is
  // ~430px and the two supporting cards ~245px, so all three sit on one line on
  // a desktop and each takes the full width on a phone. Widths as px caps, not
  // percentages -- a percentage would keep three columns at 375px and render
  // "$8,387.97" at 30px inside a 120px cell.
  const cell = (inner, cap) =>
    `<td class="rpt-cell" valign="top" style="display:inline-block;width:100%;max-width:${cap}px;box-sizing:border-box;vertical-align:top;padding:0 6px 12px;font-size:12px">${inner}</td>`;

  const main = `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${RPT.ink};border-radius:14px;height:100%">
        <tr><td style="padding:16px 18px">
          <p class="kpi-label" style="margin:0;font:700 10px/1.4 ${RPT_FONT};letter-spacing:.1em;text-transform:uppercase;color:${RPT.accent}">${escapeHtml(label)}</p>
          <p class="kpi-value${cls ? ` ${cls}` : ""}" style="margin:6px 0 0;font:800 30px/1.05 ${RPT_FONT};color:#ffffff;white-space:nowrap;letter-spacing:-1px">${value}</p>
          <p class="kpi-note-sm" style="margin:8px 0 0;font:400 10.5px/1.45 ${RPT_FONT};color:#94a3b8">${escapeHtml(note)}</p>
        </td></tr>
      </table>`;

  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 -6px 2px;font-size:0">
      <tr>${cell(main, 430)}${cell(mini(left), 245)}${cell(mini(right), 245)}</tr>
    </table>`;
}

/**
 * Cards in ONE row of inline-block cells, wrapping naturally. No @media.
 *
 * This is the layout technique the shell already documents and relies on, and
 * the reason is worth restating rather than rediscovering: Zoho strips @media
 * entirely, so there is no breakpoint to switch on and one layout has to read
 * at 375px and at desktop width.
 *
 * `display:inline-block` + `width:100%` + a px `max-width` does that with no
 * query at all. Wide screen: the cap holds each cell to its column and several
 * sit per line. Phone: 100% wins because the cap is wider than the viewport,
 * and every cell becomes its own full-width row. `perRow` therefore sets the
 * cap rather than emitting a fixed number of columns, so a narrow reader gets
 * a clean stack instead of four 80px columns of squeezed digits.
 *
 * A grid of <td width="25%"> — which this was — does NOT stack. It squeezes,
 * and 802,646.01 in an 80px column is a wrapped, unreadable smear.
 *
 * font-size:0 on the container kills the whitespace gap browsers insert between
 * inline-blocks; each cell restores a real size.
 */
export function rptCardGrid(cards, perRow = 3) {
  const list = cards.filter(Boolean);
  if (!list.length) return "";
  // Content width is ~940px inside the 980px wrap, less 6px of gutter a side.
  const cap = Math.floor(940 / perRow) - 12;
  const cells = list
    .map(
      (c) =>
        `<td class="kpi rpt-cell" valign="top" style="display:inline-block;width:100%;max-width:${cap}px;box-sizing:border-box;vertical-align:top;padding:0 6px 12px;font-size:12px">${rptCard(c)}</td>`,
    )
    .join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 -6px;font-size:0"><tr>${cells}</tr></table>`;
}

