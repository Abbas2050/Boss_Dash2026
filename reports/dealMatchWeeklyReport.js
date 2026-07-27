import cron from "node-cron";
import {
  BACKEND_BASE_URL,
  toYmdUtc,
  parseRecipients,
  fmtNum,
  money,
  escapeHtml,
  mapWithConcurrency,
  previousFullWeekUtc,
  toUnixRange,
  sendBrevoEmail,
  renderChartBuffer,
} from "./reportShared.js";

const DEFAULT_SCHEDULE = "0 20 * * 5"; // 20:00 every Friday (UAE time)
const DEFAULT_TIMEZONE = "Asia/Dubai";
const CRM_API_VERSION = String(process.env.VITE_API_VERSION || "1.0.0");
const CRM_API_TOKEN = String(process.env.VITE_API_TOKEN || process.env.API_TOKEN || "").trim();
const CRM_REST_BASE = String(process.env.REST_PROXY_TARGET || "https://portal.skylinkscapital.com").replace(/\/+$/, "");

const fmtMoney = (value) => {
  const n = Number(value) || 0;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

function crmAuthHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
  };
}

async function crmFetchJson(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      ...crmAuthHeaders(),
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`CRM HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function getCrmUserIdByMt5Login(login) {
  const url = `${CRM_REST_BASE}/rest/accounts?version=${encodeURIComponent(CRM_API_VERSION)}`;
  const payload = {
    login: String(login),
    segment: { limit: 1, offset: 0 },
  };
  const rows = await crmFetchJson(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const first = Array.isArray(rows) ? rows[0] : null;
  const userId = Number(first?.userId || 0);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

async function isIbUser(crmUserId) {
  const url = `${CRM_REST_BASE}/rest/ib/tree?version=${encodeURIComponent(CRM_API_VERSION)}&ibId=${encodeURIComponent(String(crmUserId))}`;
  const rows = await crmFetchJson(url, { method: "GET" });
  return Array.isArray(rows) && rows.length > 0;
}

async function getIbWalletUsdBalance(crmUserId) {
  const url = `${CRM_REST_BASE}/rest/accounts?version=${encodeURIComponent(CRM_API_VERSION)}`;
  const payload = {
    userId: Number(crmUserId),
    segment: { limit: 500, offset: 0 },
  };
  const rows = await crmFetchJson(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((row) => String(row?.groupName || "").toUpperCase() === "IB-WALLET-USD")
    .reduce((sum, row) => sum + (Number(row?.balance) || 0), 0);
}

async function getIbApprovedTransfersAndWithdrawals(crmUserId, period) {
  const url = `${CRM_REST_BASE}/rest/transactions?version=${encodeURIComponent(CRM_API_VERSION)}`;
  const processedAt =
    period && period.from && period.to
      ? {
          begin: `${toYmdUtc(period.from)} 00:00:00`,
          end: `${toYmdUtc(period.to)} 23:59:59`,
        }
      : undefined;
  const payload = {
    fromUserId: Number(crmUserId),
    statuses: ["approved"],
    transactionTypes: ["ib transfer to account", "ib withdrawal"],
    ...(processedAt ? { processedAt } : {}),
    segment: { limit: 5000, offset: 0 },
  };
  const rows = await crmFetchJson(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const list = Array.isArray(rows) ? rows : [];
  return list.reduce((sum, row) => {
    const amount = Number(row?.processedAmount);
    const fallback = Number(row?.requestedAmount);
    return sum + (Number.isFinite(amount) ? amount : Number.isFinite(fallback) ? fallback : 0);
  }, 0);
}

async function getIbCommissionForLogin(login, cache, period) {
  const key = String(login || "").trim();
  if (!key) return 0;
  if (cache.has(key)) return cache.get(key);
  if (!CRM_API_TOKEN) {
    cache.set(key, 0);
    return 0;
  }
  try {
    const crmUserId = await getCrmUserIdByMt5Login(key);
    if (!crmUserId) {
      cache.set(key, 0);
      return 0;
    }
    const ib = await isIbUser(crmUserId);
    if (!ib) {
      cache.set(key, 0);
      return 0;
    }
    const [walletBalance, txTotal] = await Promise.all([
      getIbWalletUsdBalance(crmUserId),
      getIbApprovedTransfersAndWithdrawals(crmUserId, period),
    ]);
    const ibCommission = (Number(walletBalance) || 0) + (Number(txTotal) || 0);
    cache.set(key, ibCommission);
    return ibCommission;
  } catch (error) {
    console.warn(`[DealMatchWeekly] IB commission lookup failed for login=${key}:`, error?.message || error);
    cache.set(key, 0);
    return 0;
  }
}

// ── client volume (Equity vs CFD, per day) ───────────────────────────────────
// Same source the home dashboard's "Dealing (LP) → Client Volume" tile uses, so
// the report and the tile agree: ClientVolume/Run, all groups.

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-07-13" -> "Mon 13 Jul". Parsed as UTC to match the report's UTC week.
function fmtDayLabel(ymd) {
  const parts = String(ymd || "").split("-");
  if (parts.length !== 3) return String(ymd || "");
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  if (Number.isNaN(date.getTime())) return String(ymd);
  return `${DAY_NAMES[date.getUTCDay()]} ${parts[2]} ${MONTH_NAMES[Number(parts[1]) - 1]}`;
}

async function fetchClientVolume(fromYmd, toYmd) {
  const params = new URLSearchParams({ from: fromYmd, to: toYmd, group: "*" });
  const url = `${BACKEND_BASE_URL}/ClientVolume/Run?${params.toString()}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ClientVolume/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const raw = await resp.json();
  const num = (v) => Number(v) || 0;
  const byDate = Array.isArray(raw?.byDate) ? raw.byDate : [];
  return {
    totalLots: num(raw?.totalLots),
    totalStocksLots: num(raw?.totalStocksLots),
    totalCfdLots: num(raw?.totalCfdLots),
    byDate: byDate.map((r) => ({
      date: String(r?.date || ""),
      lots: num(r?.lots),
      stocksLots: num(r?.stocksLots),
      cfdLots: num(r?.cfdLots),
    })),
  };
}

function deriveClientRevenueRows(report) {
  const list = Array.isArray(report?.clientRevenueSummaries) ? report.clientRevenueSummaries : [];
  if (list.length) {
    return list.map((row) => {
      const markup = Number(row.markupRevenueUsd) || 0;
      const clientComm = Number(row.clientCommissionUsd) || 0;
      const lpComm = Number(row.lpCommissionUsd) || 0;
      return {
        login: String(row.login ?? ""),
        name: String(row.name ?? ""),
        lots: Number(row.lots) || 0,
        markup,
        clientComm,
        lpComm,
        totalRev: markup + clientComm - lpComm,
      };
    });
  }

  const matches = Array.isArray(report?.matches) ? report.matches : [];
  const byLogin = new Map();
  for (const match of matches) {
    const login = String(match?.clientLogin ?? "").trim();
    if (!login) continue;
    if (!byLogin.has(login)) {
      byLogin.set(login, {
        login,
        name: String(match?.clientName ?? ""),
        lots: 0,
        markup: 0,
        clientComm: 0,
        lpComm: 0,
      });
    }
    const row = byLogin.get(login);
    row.lots += Number(match?.clientVolume) || 0;
    row.markup += Number(match?.spreadRevenueUsd) || 0;
    row.clientComm += Number(match?.clientCommission) || 0;
    row.lpComm += Math.abs(Number(match?.lpCommission) || 0);
  }

  return Array.from(byLogin.values()).map((row) => ({
    ...row,
    totalRev: row.markup + row.clientComm - row.lpComm,
  }));
}

// Builds one table cell carrying its own visible row label. The label span is
// hidden at the desktop breakpoint, where the real <thead> takes over.
// Right-aligned cells are numeric and get `num` (never wraps); `nowrap` marks a
// left-aligned identifier such as a login (also never wraps — "10218/6" is
// worse than a wide column); everything else gets `txt` (wraps between words).
function dataCell(label, value, { align = "left", bold = false, cls = "", nowrap = false } = {}) {
  const kind = align === "right" ? "num" : nowrap ? "key" : "txt";
  const style = bold ? ' style="font-weight:700;"' : "";
  const valueCls = cls ? ` ${cls}` : "";
  return `<td class="${kind}" data-label="${escapeHtml(label)}"${style}><span class="lbl">${escapeHtml(label)}</span><span class="val${valueCls}">${value}</span></td>`;
}

// Full-width cell (TOTAL label, empty-state notice) — no label/value split.
function spanCell(value, { colspan = 1, align = "left", cls = "" } = {}) {
  return `<td class="txt" colspan="${colspan}" style="text-align:${align};"><span class="val${cls ? ` ${cls}` : ""}">${value}</span></td>`;
}

// Equity-vs-CFD summary cards + a per-day table for the report week. Renders a
// short notice instead of throwing when the volume endpoint was unavailable.
function buildVolumeSection(volume) {
  const title = `<p class="section-title" style="margin-top:18px;">Client Volume &mdash; Equity vs CFD</p>`;

  if (!volume) {
    return `${title}
          <p style="font-size:12px;color:#64748b;margin:0 0 10px;">Volume data was unavailable when this report was generated.</p>`;
  }

  const days = volume.byDate || [];
  const dailyRows = days
    .map(
      (d) => `<tr>
        ${dataCell("Day", escapeHtml(fmtDayLabel(d.date)), { nowrap: true })}
        ${dataCell("Equity Lots", fmtNum(d.stocksLots, 2), { align: "right" })}
        ${dataCell("CFD Lots", fmtNum(d.cfdLots, 2), { align: "right" })}
        ${dataCell("Total Lots", fmtNum(d.lots, 2), { align: "right", bold: true })}
      </tr>`,
    )
    .join("");

  return `${title}
          <table class="vol-kpis" role="presentation">
            <tr>
              <td class="kpi equity" width="33%">
                <p class="kpi-label">Equity Lots</p>
                <p class="kpi-value">${fmtNum(volume.totalStocksLots, 2)}</p>
              </td>
              <td class="kpi cfd" width="33%">
                <p class="kpi-label">CFD Lots</p>
                <p class="kpi-value">${fmtNum(volume.totalCfdLots, 2)}</p>
              </td>
              <td class="kpi vol-total" width="33%">
                <p class="kpi-label">Total Lots</p>
                <p class="kpi-value">${fmtNum(volume.totalLots, 2)}</p>
              </td>
            </tr>
          </table>

          <table class="data narrow">
            <thead>
              <tr><th width="28%">Day</th><th width="24%">Equity Lots</th><th width="24%">CFD Lots</th><th width="24%">Total Lots</th></tr>
            </thead>
            <tbody>
              ${dailyRows || `<tr>${spanCell("No volume recorded for this week.", { colspan: 4, align: "center" })}</tr>`}
            </tbody>
            <tfoot>
              <tr>
                ${spanCell("TOTAL")}
                ${dataCell("Equity Lots", fmtNum(volume.totalStocksLots, 2), { align: "right" })}
                ${dataCell("CFD Lots", fmtNum(volume.totalCfdLots, 2), { align: "right" })}
                ${dataCell("Total Lots", fmtNum(volume.totalLots, 2), { align: "right" })}
              </tr>
            </tfoot>
          </table>`;
}

function buildEmailHtml({ fromYmd, toYmd, rows, volume }) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.lots += Number(row.lots) || 0;
      acc.markup += Number(row.markup) || 0;
      acc.clientComm += Number(row.clientComm) || 0;
      acc.lpComm += Number(row.lpComm) || 0;
      acc.ibCommission += Number(row.ibCommission) || 0;
      acc.totalRev += Number(row.totalRev) || 0;
      acc.netRev += Number(row.netRev) || 0;
      return acc;
    },
    { lots: 0, markup: 0, clientComm: 0, lpComm: 0, ibCommission: 0, totalRev: 0, netRev: 0 },
  );

  const bodyRows = rows
    .map(
      (row) => `<tr>
        ${dataCell("Login", escapeHtml(row.login), { nowrap: true })}
        ${dataCell("Name", escapeHtml(row.name))}
        ${dataCell("Lots", fmtNum(row.lots, 2), { align: "right" })}
        ${dataCell("Markup", money(row.markup), { align: "right" })}
        ${dataCell("Client Comm", money(row.clientComm), { align: "right" })}
        ${dataCell("LP Comm", money(row.lpComm), { align: "right" })}
        ${dataCell("Total Rev", money(row.totalRev), { align: "right", bold: true })}
        ${dataCell("IB Commission", money(row.ibCommission), { align: "right" })}
        ${dataCell("Net Revenue", money(row.netRev), { align: "right", bold: true })}
      </tr>`,
    )
    .join("");

  const topClient = rows.reduce((best, row) => {
    if (!best) return row;
    return (Number(row.netRev) || 0) > (Number(best.netRev) || 0) ? row : best;
  }, null);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      /* ── Mobile-first base: stacked & fluid so it stays responsive even in
         clients that honor <style> but strip @media (Gmail app for non-Google
         accounts, several webmail clients). Desktop layout is restored in the
         @media (min-width) block below. ── */
      body { margin:0; padding:0; background:#f3f7fb; color:#0f172a; font-family: Arial, Helvetica, sans-serif; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
      /* box-sizing on the layout wrappers: without it, width:100% + padding
         overflows the viewport and the whole email scrolls sideways. */
      .outer, .wrap, .header, .content { box-sizing:border-box; }
      .outer { width:100%; background:#f3f7fb; padding:8px 4px; }
      /* 980px is what Zoho actually gives the message body; pinning the canvas
         there makes the card-per-row maths deterministic instead of depending
         on the reader's window size. */
      .wrap { width:100%; max-width: 980px; margin: 0 auto; background:#ffffff; border:1px solid #dbe6f2; border-radius:10px; overflow:hidden; }
      .header { padding:14px 16px; background:linear-gradient(135deg,#0f2d4f,#114b7a); color:#eaf4ff; }
      .header-grid { width:100%; border-collapse:collapse; }
      .header-grid td { display:block; width:100% !important; box-sizing:border-box; }
      .header-left { vertical-align:top; text-align:left; }
      .header-right { vertical-align:top; text-align:left; margin-top:10px; }
      .title { margin:0; font-size:19px; font-weight:700; letter-spacing:0.2px; }
      .subtitle { margin:6px 0 0; font-size:12px; color:#cfe3f8; }
      .header-meta { margin:0; font-size:11px; line-height:1.55; color:#bcd6ee; }
      .content { padding:16px; }
      .meta { color:#475569; font-size:13px; margin:0 0 14px; line-height:1.5; }
      /* ── Single layout, NO @media ────────────────────────────────────────
         Zoho strips @media entirely, so there is no breakpoint to switch on and
         one layout has to read well at both 375px and desktop width.
         Card grids use inline-block cells with a px cap: 4 fit a desktop row and
         collapse to one per line on a phone. That trick only works for small
         counts — a 9-across row can never also be 1-across — so the data tables
         are split into <=5-column tables instead. */
      /* Four cards capped at 230px: they span the full width four-across on a
         desktop-width email, and stack one per line on a phone. Forcing all
         four onto a 375px row gives 78px each — narrower than "$13,677.50",
         so the values would bleed over each other. */
      .kpis { width:100%; border-collapse:collapse; margin:0 0 8px; }
      .kpis, .kpis tbody, .kpis tr, .kpis td { display:block; width:100%; box-sizing:border-box; }
      .kpis td { margin:0 0 8px; }
      .kpi { background:#f8fbff; border:1px solid #d9e8f8; border-radius:10px; padding:10px 12px; }
      .kpi.clients { background:#eef8ff; border-color:#bfe3ff; }
      .kpi.lots { background:#edfdf7; border-color:#bbf7d0; }
      .kpi.gross { background:#fffbeb; border-color:#fde68a; }
      .kpi.net { background:#f5f3ff; border-color:#ddd6fe; }
      /* Volume summary: 3 cards, one row at every width. Only three columns to
         share, so these fit a phone — but the padding and value size have to be
         trimmed, or "29,160.45" overruns its third of a 375px screen. */
      .vol-kpis { width:100%; border-collapse:separate; border-spacing:5px; margin:0 0 8px; table-layout:fixed; }
      .vol-kpis td { vertical-align:top; box-sizing:border-box; }
      .vol-kpis .kpi { padding:8px 5px; }
      .vol-kpis .kpi-value { font-size:13px; }
      .kpi.equity { background:#ecfeff; border-color:#a5f3fc; }
      .kpi.cfd { background:#f5f3ff; border-color:#ddd6fe; }
      .kpi.vol-total { background:#f8fafc; border-color:#e2e8f0; }
      .kpi-label { font-size:10px; text-transform:uppercase; letter-spacing:0.3px; color:#64748b; margin:0 0 5px; line-height:1.25; }
      .kpi-value { font-size:16px; font-weight:700; color:#0f2d4f; margin:0; white-space:nowrap; }
      .kpi-note { font-size:12px; color:#334155; margin:8px 0 10px; padding:8px 10px; background:#f8fafc; border:1px solid #e2e8f0; border-left:4px solid #14b8a6; border-radius:8px; }
      .section-title { margin: 2px 0 8px; font-size:14px; color:#0f2d4f; font-weight:700; }
      /* The full table needs ~860px to stay legible. On a desktop-width email it
         simply fills the width; on a phone the wrapper scrolls sideways rather
         than crushing nine columns into 375px, which is what mangled the
         figures. Numeric cells never wrap. */
      /* BASE = phone: one card per record, each field a label/value line. This
         is the default so a phone is right even where @media is stripped. */
      .tscroll { width:100%; margin:0 0 16px; }
      table.data { border-collapse:collapse; width:100%; font-size:12px; }
      table.data, table.data tbody, table.data tfoot, table.data tr, table.data td { display:block; width:100%; box-sizing:border-box; }
      table.data thead { display:none; }
      table.data tr { margin:0 0 10px; border:1px solid #e2e8f0; border-radius:8px; background:#fff; overflow:hidden; }
      table.data td { border:0; border-bottom:1px solid #eef2f7; padding:8px 10px; }
      table.data td:last-child { border-bottom:0; }
      table.data td .lbl { display:inline-block; width:44%; text-align:left; font-weight:700; color:#475569; vertical-align:top; }
      table.data td .val { display:inline-block; width:54%; text-align:right; vertical-align:top; }
      table.data tfoot tr { border:1px solid #cfe3ff; background:#eff6ff; }
      table.data tfoot td { font-weight:700; color:#0f2d4f; }

      /* The 4-column volume table fits a phone as-is, so it stays a real table
         at every width rather than expanding into seven cards. */
      table.data.narrow, table.data.narrow tbody, table.data.narrow tfoot { display:revert; }
      table.data.narrow { display:table; table-layout:fixed; font-size:11px; }
      table.data.narrow thead { display:table-header-group; }
      table.data.narrow tbody { display:table-row-group; }
      table.data.narrow tfoot { display:table-footer-group; }
      table.data.narrow tr { display:table-row; margin:0; border:0; border-radius:0; }
      table.data.narrow th, table.data.narrow td { display:table-cell; width:auto; border:1px solid #e2e8f0; padding:6px 5px; text-align:left; }
      table.data.narrow th { background:#0f2d4f; color:#f8fafc; font-weight:700; font-size:10px; }
      table.data.narrow td.num { text-align:right; white-space:nowrap; }
      table.data.narrow td .lbl { display:none; }
      table.data.narrow td .val { display:inline; width:auto; text-align:inherit; }
      table.data.narrow tbody tr:nth-child(even) { background:#f9fcff; }
      table.data.narrow tfoot td { background:#eff6ff; }
      .money-pos { color:#0369a1; font-weight:700; }
      .money-cost { color:#b45309; }
      .money-neg { color:#b91c1c; font-weight:700; }
      .foot { border-top:1px solid #e2e8f0; margin-top:14px; padding-top:10px; color:#64748b; font-size:12px; line-height:1.5; }
      .attachments { margin-top:8px; color:#334155; font-size:12px; }
      /* TEMPORARY probe: tells us whether this mail client honours @media at
         all. If the footer reads WIDE on a desktop and NARROW on a phone, we
         can serve a table to desktop and cards to phones. If it reads the same
         on both, @media is being stripped and one layout must serve both.
         Remove once the question is settled. */
      .probe-wide { display:none; }
      @media only screen and (min-width: 681px) {
        .probe-narrow { display:none; }
        .probe-wide { display:inline; }
      }
      /* DESKTOP enhancement: restore the full-width table and the four-across
         KPI row. If a client strips @media it simply keeps the phone layout
         above, which is the safer thing to fall back to. */
      @media only screen and (min-width: 681px) {
        .outer { padding:20px 10px; }
        .wrap { border-radius:14px; }
        .header { padding:18px 20px; }
        .header-grid td { display:table-cell; width:auto !important; }
        .header-left { width:48%; }
        .header-right { width:52%; text-align:right; margin-top:0; }
        .title { font-size:22px; }
        .subtitle { font-size:13px; }
        .content { padding:18px 20px 16px; }
        .kpi-value { font-size:18px; }

        .kpis { display:table; table-layout:fixed; border-collapse:separate; border-spacing:6px; }
        .kpis tbody { display:table-row-group; }
        .kpis tr { display:table-row; }
        .kpis td { display:table-cell; width:25%; margin:0; }

        .tscroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
        table.data { display:table; table-layout:fixed; min-width:860px; }
        table.data thead { display:table-header-group; }
        table.data tbody { display:table-row-group; }
        table.data tfoot { display:table-footer-group; }
        table.data tr { display:table-row; margin:0; border:0; border-radius:0; background:transparent; }
        table.data th, table.data td { display:table-cell; width:auto; border:1px solid #e2e8f0; padding:7px 8px; text-align:left; vertical-align:top; }
        table.data th { background:#0f2d4f; color:#f8fafc; font-weight:700; font-size:11px; }
        table.data td.num { text-align:right; white-space:nowrap; }
        table.data td.key { white-space:nowrap; }
        table.data td.txt { overflow-wrap:break-word; }
        table.data td .lbl { display:none; }
        table.data td .val { display:inline; width:auto; text-align:inherit; }
        table.data tbody tr:nth-child(even) { background:#f9fcff; }
        table.data tfoot tr { border:0; background:transparent; }
        table.data tfoot td { background:#eff6ff; }
        table.data.narrow { min-width:0; font-size:12px; }
      }
    </style>
  </head>
  <body>
    <div class="outer">
      <div class="wrap">
        <div class="header">
          <table class="header-grid" role="presentation">
            <tr>
              <td class="header-left" width="48%">
                <div class="header-meta">
                  Period: <strong>${escapeHtml(fromYmd)}</strong> to <strong>${escapeHtml(toYmd)}</strong> (UTC)<br/>
                  Scope: all groups, all logins, all symbols<br/>
                  Filter: only accounts with <strong>Lots &gt; 0</strong>
                </div>
              </td>
              <td class="header-right" width="52%">
                <h1 class="title">Weekly Deal Performance Summary</h1>
                <div class="subtitle">Management Reporting | Deal Match Revenue Analytics</div>
              </td>
            </tr>
          </table>
        </div>
        <div class="content">
          <table class="kpis" role="presentation">
            <tr>
              <td class="kpi clients" width="25%">
                <p class="kpi-label">Active Clients</p>
                <p class="kpi-value">${fmtNum(rows.length, 0)}</p>
              </td>
              <td class="kpi lots" width="25%">
                <p class="kpi-label">Total Lots</p>
                <p class="kpi-value">${fmtNum(totals.lots, 2)}</p>
              </td>
              <td class="kpi gross" width="25%">
                <p class="kpi-label">Total Revenue</p>
                <p class="kpi-value">${money(totals.totalRev)}</p>
              </td>
              <td class="kpi net" width="25%">
                <p class="kpi-label">Net Revenue</p>
                <p class="kpi-value">${money(totals.netRev)}</p>
              </td>
            </tr>
          </table>

          <div class="kpi-note">
            Top Net Revenue Client:
            <strong>${topClient ? `${escapeHtml(topClient.name || topClient.login)} (${escapeHtml(topClient.login)})` : "-"}</strong>
            ${topClient ? `| ${money(topClient.netRev)}` : ""}
          </div>

          <p class="section-title">Client Revenue Table</p>
          <div class="tscroll">
          <table class="data">
            <thead>
              <tr>
                <th width="8%">Login</th>
                <th width="20%">Name</th>
                <th width="9%">Lots</th>
                <th width="9%">Markup</th>
                <th width="10%">Client Comm</th>
                <th width="9%">LP Comm</th>
                <th width="10%">Total Rev</th>
                <th width="11%">IB Commission</th>
                <th width="10%">Net Revenue</th>
              </tr>
            </thead>
            <tbody>
              ${bodyRows || `<tr>${spanCell("No rows with Lots &gt; 0 for this week.", { colspan: 9, align: "center" })}</tr>`}
            </tbody>
            <tfoot>
              <tr>
                ${spanCell("TOTAL", { colspan: 2 })}
                ${dataCell("Lots", fmtNum(totals.lots, 2), { align: "right" })}
                ${dataCell("Markup", money(totals.markup), { align: "right", cls: "money-pos" })}
                ${dataCell("Client Comm", money(totals.clientComm), { align: "right", cls: "money-pos" })}
                ${dataCell("LP Comm", money(totals.lpComm), { align: "right", cls: "money-cost" })}
                ${dataCell("Total Rev", money(totals.totalRev), { align: "right", cls: "money-pos" })}
                ${dataCell("IB Commission", money(totals.ibCommission), { align: "right", cls: "money-cost" })}
                ${dataCell("Net Revenue", money(totals.netRev), { align: "right", cls: totals.netRev < 0 ? "money-neg" : "money-pos" })}
              </tr>
            </tfoot>
          </table>
          </div>

          ${buildVolumeSection(volume)}

          <div class="attachments">
            Attached visuals: Top 10 Net Revenue, Gross vs Net Revenue, Lots vs Net Revenue, Revenue Composition${volume && (volume.byDate || []).length ? ", Daily Volume (Equity vs CFD)" : ""}.
          </div>
          <div class="foot">
            Automated report generated by Deal Matching pipeline.<br/>
            Formula: Total Revenue = (Markup + Client Comm) - LP Comm; Net Revenue = (Markup + Client Comm) - (LP Comm + IB Commission)<br/>
            Client Volume is sourced from ClientVolume/Run (all groups) &mdash; the same feed as the dashboard's Dealing (LP) volume tile.<br/>
            Layout probe: <strong><span class="probe-narrow">NARROW</span><span class="probe-wide">WIDE</span></strong>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

async function buildEmailChartAttachments(rows, fromYmd, toYmd, volume) {
  const topNet = [...rows].sort((a, b) => (Number(b.netRev) || 0) - (Number(a.netRev) || 0)).slice(0, 10);
  const topTotal = [...rows].sort((a, b) => (Number(b.totalRev) || 0) - (Number(a.totalRev) || 0)).slice(0, 10);
  const topLots = [...rows].sort((a, b) => (Number(b.lots) || 0) - (Number(a.lots) || 0)).slice(0, 12);

  const breakdown = rows.reduce(
    (acc, row) => {
      acc.markup += Number(row.markup) || 0;
      acc.clientComm += Number(row.clientComm) || 0;
      acc.lpComm += Math.abs(Number(row.lpComm) || 0);
      acc.ibCommission += Math.abs(Number(row.ibCommission) || 0);
      acc.netRevenue += Number(row.netRev) || 0;
      return acc;
    },
    { markup: 0, clientComm: 0, lpComm: 0, ibCommission: 0, netRevenue: 0 },
  );

  const titleSuffix = `(${fromYmd} to ${toYmd})`;
  const commonPlugins = {
    legend: { labels: { color: "#334155", font: { size: 12 } } },
    title: { display: true, text: "", color: "#1d4ed8", font: { size: 22, weight: "700" } },
    subtitle: { display: true, text: "", color: "#64748b", font: { size: 12 } },
  };

  const charts = [
    {
      name: "top10-net-revenue.png",
      config: {
        type: "bar",
        data: {
          labels: topNet.map((r) => `${r.login}`),
          datasets: [
            {
              label: "Net Revenue",
              data: topNet.map((r) => Number(r.netRev) || 0),
              backgroundColor: topNet.map((_, i) => (i < 3 ? "#b45309" : "#0f766e")),
              borderRadius: 6,
            },
          ],
        },
        options: {
          indexAxis: "y",
          responsive: false,
          animation: false,
          scales: {
            x: { ticks: { color: "#334155", callback: (v) => `$${Math.round(v / 1000)}k` }, grid: { color: "#e2e8f0" } },
            y: { ticks: { color: "#334155" }, grid: { display: false } },
          },
          plugins: {
            ...commonPlugins,
            title: { ...commonPlugins.title, text: `Top 10 Clients by Net Revenue ${titleSuffix}` },
            subtitle: { ...commonPlugins.subtitle, text: "Top 3 highlighted" },
          },
        },
      },
    },
    {
      name: "gross-vs-net.png",
      config: {
        type: "bar",
        data: {
          labels: topTotal.map((r) => `${r.login}`),
          datasets: [
            {
              label: "Total Revenue",
              data: topTotal.map((r) => Number(r.totalRev) || 0),
              backgroundColor: "#1d4ed8",
              borderRadius: 5,
            },
            {
              label: "Net Revenue",
              data: topTotal.map((r) => Number(r.netRev) || 0),
              backgroundColor: "#15803d",
              borderRadius: 5,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          scales: {
            x: { ticks: { color: "#334155" }, grid: { display: false } },
            y: { ticks: { color: "#334155", callback: (v) => `$${Math.round(v / 1000)}k` }, grid: { color: "#e2e8f0" } },
          },
          plugins: {
            ...commonPlugins,
            title: { ...commonPlugins.title, text: `Gross Revenue vs Net Revenue ${titleSuffix}` },
            subtitle: { ...commonPlugins.subtitle, text: "Top clients by total revenue" },
          },
        },
      },
    },
    {
      name: "lots-vs-net-by-client.png",
      config: {
        type: "bar",
        data: {
          labels: topLots.map((r) => `${r.login}`),
          datasets: [
            {
              type: "bar",
              label: "Lots",
              yAxisID: "yLots",
              data: topLots.map((r) => Number(r.lots) || 0),
              backgroundColor: "rgba(8,145,178,0.55)",
              borderRadius: 4,
            },
            {
              type: "line",
              label: "Net Revenue",
              yAxisID: "yRev",
              data: topLots.map((r) => Number(r.netRev) || 0),
              borderColor: "#15803d",
              backgroundColor: "#15803d",
              tension: 0.3,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          scales: {
            yLots: { position: "left", ticks: { color: "#334155" }, grid: { color: "#e2e8f0" } },
            yRev: {
              position: "right",
              ticks: { color: "#334155", callback: (v) => `$${Math.round(v / 1000)}k` },
              grid: { drawOnChartArea: false },
            },
            x: { ticks: { color: "#334155" } },
          },
          plugins: {
            ...commonPlugins,
            title: { ...commonPlugins.title, text: `Lots vs Net Revenue by Client ${titleSuffix}` },
            subtitle: { ...commonPlugins.subtitle, text: "Top volume clients" },
          },
        },
      },
    },
    {
      name: "revenue-composition.png",
      config: {
        type: "doughnut",
        data: {
          labels: ["Markup", "Client Comm", "LP Comm", "IB Commission", "Net Revenue"],
          datasets: [
            {
              data: [
                breakdown.markup,
                breakdown.clientComm,
                breakdown.lpComm,
                breakdown.ibCommission,
                Math.abs(breakdown.netRevenue),
              ],
              backgroundColor: ["#0891b2", "#0f766e", "#b45309", "#be123c", "#15803d"],
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            ...commonPlugins,
            title: { ...commonPlugins.title, text: `Revenue Composition ${titleSuffix}` },
            subtitle: { ...commonPlugins.subtitle, text: "Aggregate contribution by component" },
          },
        },
      },
    },
  ];

  // Daily Equity-vs-CFD volume — grouped bars, one pair per day of the week.
  // Colours match the dashboard's volume tile (cyan = equity, violet = CFD).
  const volumeDays = volume?.byDate ?? [];
  if (volumeDays.length) {
    charts.push({
      name: "daily-volume-equity-vs-cfd.png",
      config: {
        type: "bar",
        data: {
          labels: volumeDays.map((d) => fmtDayLabel(d.date)),
          datasets: [
            {
              label: "Equity Lots",
              data: volumeDays.map((d) => Number(d.stocksLots) || 0),
              backgroundColor: "#0891b2",
              borderRadius: 5,
            },
            {
              label: "CFD Lots",
              data: volumeDays.map((d) => Number(d.cfdLots) || 0),
              backgroundColor: "#7c3aed",
              borderRadius: 5,
            },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          scales: {
            x: { ticks: { color: "#334155" }, grid: { display: false } },
            y: {
              beginAtZero: true,
              ticks: { color: "#334155", callback: (v) => Math.round(v).toLocaleString() },
              grid: { color: "#e2e8f0" },
              title: { display: true, text: "Lots", color: "#64748b" },
            },
          },
          plugins: {
            ...commonPlugins,
            title: { ...commonPlugins.title, text: `Daily Volume - Equity vs CFD ${titleSuffix}` },
            subtitle: { ...commonPlugins.subtitle, text: "Lots traded per day, split by instrument class" },
          },
        },
      },
    });
  }

  const attachments = [];
  for (const item of charts) {
    const buffer = await renderChartBuffer(item.config, item.name.includes("composition") ? 1100 : 1200, 700);
    attachments.push({
      name: item.name,
      content: buffer.toString("base64"),
    });
  }
  return attachments;
}

export async function runWeeklyDealMatchEmailReport({ fromDate, toDate, recipients: recipientsOverride } = {}) {
  const week = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullWeekUtc();
  const { from, to } = toUnixRange(week.start, week.end);
  const params = new URLSearchParams({
    group: "*",
    from: String(from),
    to: String(to),
    symbol: "",
    lite: "false",
  });

  const runUrl = `${BACKEND_BASE_URL}/DealMatch/Run?${params.toString()}`;
  const resp = await fetch(runUrl, { signal: AbortSignal.timeout(45_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DealMatch/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const report = await resp.json();
  const baseRows = deriveClientRevenueRows(report)
    .filter((row) => (Number(row.lots) || 0) > 0)
    .sort((a, b) => (Number(b.lots) || 0) - (Number(a.lots) || 0));

  const ibCache = new Map();
  const rows = await mapWithConcurrency(
    baseRows,
    async (row) => {
      const ibCommission = await getIbCommissionForLogin(row.login, ibCache, {
        from: week.start,
        to: week.end,
      });
      const markup = Number(row.markup) || 0;
      const clientComm = Number(row.clientComm) || 0;
      const lpComm = Number(row.lpComm) || 0;
      const totalRev = Number(row.totalRev) || 0;
      const netRev = (markup + clientComm) - (lpComm + ibCommission);
      return {
        ...row,
        totalRev,
        ibCommission,
        netRev,
      };
    },
    8,
  );

  const fromYmd = toYmdUtc(week.start);
  const toYmd = toYmdUtc(week.end);
  // Explicit recipients (e.g. the on-demand test button) take precedence over the configured list.
  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : parseRecipients(process.env.DEALMATCH_ALERT_RECIPIENTS || "");
  if (!recipients.length) {
    console.warn("[DealMatchWeekly] No recipients configured. Skipping.");
    return { ok: false, reason: "no-recipients", rows: rows.length, fromYmd, toYmd };
  }
  // Volume is supplementary — a ClientVolume outage must not block the revenue
  // report, so fall back to rendering the section as unavailable.
  let volume = null;
  try {
    volume = await fetchClientVolume(fromYmd, toYmd);
  } catch (error) {
    console.warn("[DealMatchWeekly] client volume lookup failed:", error?.message || error);
  }

  const subject = `Weekly Deal Match Analysis (${fromYmd} to ${toYmd})`;
  const html = buildEmailHtml({ fromYmd, toYmd, rows, volume });
  const attachments = await buildEmailChartAttachments(rows, fromYmd, toYmd, volume);
  await sendBrevoEmail({ subject, html, recipients, attachments });

  console.log(`[DealMatchWeekly] Sent to ${recipients.join(", ")} | rows=${rows.length} | period=${fromYmd}..${toYmd}`);
  return { ok: true, rows: rows.length, fromYmd, toYmd };
}

export async function getWeeklyDealMatchDataset({ fromDate, toDate, limit = 100 } = {}) {
  const week = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullWeekUtc();
  const { from, to } = toUnixRange(week.start, week.end);
  const params = new URLSearchParams({
    group: "*",
    from: String(from),
    to: String(to),
    symbol: "",
    lite: "false",
  });

  const runUrl = `${BACKEND_BASE_URL}/DealMatch/Run?${params.toString()}`;
  const resp = await fetch(runUrl, { signal: AbortSignal.timeout(45_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DealMatch/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const report = await resp.json();
  const baseRows = deriveClientRevenueRows(report)
    .filter((row) => (Number(row.lots) || 0) > 0)
    .sort((a, b) => (Number(b.lots) || 0) - (Number(a.lots) || 0));

  const ibCache = new Map();
  const enriched = await mapWithConcurrency(
    baseRows,
    async (row) => {
      const ibCommission = await getIbCommissionForLogin(row.login, ibCache, {
        from: week.start,
        to: week.end,
      });
      const markup = Number(row.markup) || 0;
      const clientComm = Number(row.clientComm) || 0;
      const lpComm = Number(row.lpComm) || 0;
      const totalRev = Number(row.totalRev) || 0;
      const netRev = (markup + clientComm) - (lpComm + ibCommission);
      return { ...row, totalRev, ibCommission, netRev };
    },
    8,
  );

  const hardLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 100;
  const rows = enriched.slice(0, hardLimit);
  return {
    fromYmd: toYmdUtc(week.start),
    toYmd: toYmdUtc(week.end),
    rows,
    totalAvailable: enriched.length,
  };
}

export function startWeeklyDealMatchScheduler() {
  const enabled = String(process.env.WEEKLY_DEALMATCH_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[DealMatchWeekly] disabled by WEEKLY_DEALMATCH_ENABLED=false");
    return;
  }

  const schedule = String(process.env.WEEKLY_DEALMATCH_CRON || DEFAULT_SCHEDULE);
  const timezone = String(process.env.WEEKLY_DEALMATCH_TIMEZONE || DEFAULT_TIMEZONE);
  if (!cron.validate(schedule)) {
    console.error(`[DealMatchWeekly] Invalid cron expression: "${schedule}"`);
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      try {
        await runWeeklyDealMatchEmailReport();
      } catch (error) {
        console.error("[DealMatchWeekly] run failed:", error?.message || error);
      }
    },
    { timezone },
  );

  console.log(`[DealMatchWeekly] scheduled with expression "${schedule}" (${timezone})`);

  if (String(process.env.WEEKLY_DEALMATCH_RUN_ON_START || "false").toLowerCase() === "true") {
    runWeeklyDealMatchEmailReport().catch((error) => {
      console.error("[DealMatchWeekly] startup run failed:", error?.message || error);
    });
  }
}
