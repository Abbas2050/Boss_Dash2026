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
  publishChartImages,
} from "./reportShared.js";

const DEFAULT_SCHEDULE = "0 9 * * 6"; // 09:00 every Saturday (UAE time)
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
  // IB transfers/withdrawals can be returned signed-negative (money leaving the
  // IB wallet). IB commission is a cost, so sum the magnitudes — otherwise the
  // total goes negative and Net Revenue ends up ABOVE Total Revenue, which is
  // impossible. Mirrors fetchIbPeriodTransactions() in src/lib/dealMatchApi.ts.
  return list.reduce((sum, row) => {
    const amount = Number(row?.processedAmount);
    const fallback = Number(row?.requestedAmount);
    const value = Number.isFinite(amount) ? amount : Number.isFinite(fallback) ? fallback : 0;
    return sum + Math.abs(value);
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
      // The backend returns LP commission signed-negative (money paid out). It is
      // a cost, so subtract its magnitude — without abs() the minus sign flips it
      // into revenue. Mirrors deriveBaseRows() in src/lib/dealMatchApi.ts.
      const lpComm = Math.abs(Number(row.lpCommissionUsd) || 0);
      // Deliberately NOT using the backend's totalRevenueUsd: for 13-19 Jul it
      // sums to 63,405.11 while the Deal Performance tab shows 65,571.75, which
      // is markup + clientComm - lpComm. Recomputing keeps the email and the
      // tab in agreement. Verified against DealMatch/Run on 2026-07-27.
      const totalRev = markup + clientComm - lpComm;
      return {
        login: String(row.login ?? ""),
        name: String(row.name ?? ""),
        lots: Number(row.lots) || 0,
        markup,
        clientComm,
        lpComm,
        totalRev,
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

// ── inline charts ────────────────────────────────────────────────────────────
// Charts ship as real Chart.js PNGs embedded in the message via Content-ID, so
// shapes CSS cannot draw (doughnut, dual-axis line) are available and nothing is
// exposed on a public URL. The table-based bar builders further down are the
// fallback used when image rendering is unavailable — a message with plain HTML
// bars beats a message with five broken images.

const pct = (value, max) => (max > 0 ? Math.max(0, Math.min(100, (Math.abs(value) / max) * 100)) : 0);

// ── PNG charts (Chart.js) ────────────────────────────────────────────────────

const CH = {
  ink: "#0f172a",
  grid: "#e2e8f0",
  axis: "#334155",
  muted: "#64748b",
  markup: "#0891b2",
  clientComm: "#0f766e",
  lpComm: "#b45309",
  ibComm: "#be123c",
  net: "#15803d",
  gross: "#1d4ed8",
  loss: "#b91c1c",
};

const shortMoney = (v) => {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
};
const shortNum = (v) => {
  const n = Math.abs(Number(v) || 0);
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return n.toFixed(0);
};

// Draws each value onto its own bar/point. chartjs-plugin-datalabels is not a
// dependency here, so this is a small inline plugin instead.
function valueLabels(formatFor) {
  return {
    id: "valueLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = "bold 11px Arial";
      ctx.fillStyle = CH.ink;
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach((el, i) => {
          const raw = ds.data[i];
          if (raw === null || raw === undefined) return;
          const text = formatFor(raw, di, i);
          if (!text) return;
          const horizontal = chart.options.indexAxis === "y";
          if (horizontal) {
            ctx.textAlign = raw < 0 ? "right" : "left";
            ctx.textBaseline = "middle";
            ctx.fillText(text, el.x + (raw < 0 ? -6 : 6), el.y);
          } else {
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText(text, el.x, el.y - 4);
          }
        });
      });
      ctx.restore();
    },
  };
}

// Doughnut labels sit on the slice, with the share underneath.
const doughnutLabels = {
  id: "doughnutLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const ds = chart.data.datasets[0];
    const total = ds.data.reduce((s, v) => s + Math.abs(Number(v) || 0), 0);
    if (!total) return;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    chart.getDatasetMeta(0).data.forEach((arc, i) => {
      const value = Math.abs(Number(ds.data[i]) || 0);
      const share = (value / total) * 100;
      if (share < 4) return; // too thin to letter without collision
      const { x, y } = arc.tooltipPosition();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 13px Arial";
      ctx.fillText(shortMoney(value), x, y - 8);
      ctx.font = "11px Arial";
      ctx.fillText(`${share.toFixed(1)}%`, x, y + 8);
    });
    ctx.restore();
  },
};

const chartTitle = (text, subtitle) => ({
  legend: { labels: { color: CH.axis, font: { size: 12 } } },
  title: { display: true, text, color: CH.ink, font: { size: 18, weight: "700" }, padding: { bottom: 2 } },
  subtitle: { display: Boolean(subtitle), text: subtitle || "", color: CH.muted, font: { size: 12 }, padding: { bottom: 10 } },
});

// Builds every PNG and returns [{ name, content }] ready for Brevo, each keyed
// by the same name the HTML references as cid:<name>.
async function buildChartImages(rows, volume, totals, titleSuffix) {
  const byNet = [...rows].sort((a, b) => (Number(b.netRev) || 0) - (Number(a.netRev) || 0)).slice(0, 10);
  const byTotal = [...rows].sort((a, b) => (Number(b.totalRev) || 0) - (Number(a.totalRev) || 0)).slice(0, 10);
  const byLots = [...rows].sort((a, b) => (Number(b.lots) || 0) - (Number(a.lots) || 0)).slice(0, 12);
  const days = volume?.byDate ?? [];

  const specs = [];

  specs.push({
    name: "top10-net-revenue.png",
    width: 1100,
    height: 620,
    config: {
      type: "bar",
      data: {
        labels: byNet.map((r) => String(r.login)),
        datasets: [
          {
            label: "Net revenue",
            data: byNet.map((r) => Number(r.netRev) || 0),
            backgroundColor: byNet.map((r) => ((Number(r.netRev) || 0) < 0 ? CH.loss : CH.net)),
            borderRadius: 5,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: false,
        animation: false,
        layout: { padding: { right: 70 } },
        scales: {
          x: { ticks: { color: CH.axis, callback: (v) => shortMoney(v) }, grid: { color: CH.grid } },
          y: { ticks: { color: CH.axis }, grid: { display: false } },
        },
        plugins: { ...chartTitle(`Top 10 Clients by Net Revenue ${titleSuffix}`, "highest net contributors this period"), legend: { display: false } },
      },
      plugins: [valueLabels((v) => money(v))],
    },
  });

  specs.push({
    name: "gross-vs-net.png",
    width: 1100,
    height: 620,
    config: {
      type: "bar",
      data: {
        labels: byTotal.map((r) => String(r.login)),
        datasets: [
          { label: "Gross revenue", data: byTotal.map((r) => Number(r.totalRev) || 0), backgroundColor: CH.gross, borderRadius: 4 },
          { label: "Net revenue", data: byTotal.map((r) => Number(r.netRev) || 0), backgroundColor: CH.net, borderRadius: 4 },
        ],
      },
      options: {
        responsive: false,
        animation: false,
        layout: { padding: { top: 20 } },
        scales: {
          x: { ticks: { color: CH.axis }, grid: { display: false } },
          y: { ticks: { color: CH.axis, callback: (v) => shortMoney(v) }, grid: { color: CH.grid } },
        },
        plugins: chartTitle(`Gross vs Net Revenue ${titleSuffix}`, "the gap between the pair is LP + IB commission"),
      },
      plugins: [valueLabels((v) => shortMoney(v))],
    },
  });

  specs.push({
    name: "lots-vs-net-by-client.png",
    width: 1100,
    height: 620,
    config: {
      type: "bar",
      data: {
        labels: byLots.map((r) => String(r.login)),
        datasets: [
          { type: "bar", label: "Lots", yAxisID: "yLots", data: byLots.map((r) => Number(r.lots) || 0), backgroundColor: "rgba(8,145,178,0.55)", borderRadius: 4 },
          { type: "line", label: "Net revenue", yAxisID: "yRev", data: byLots.map((r) => Number(r.netRev) || 0), borderColor: CH.net, backgroundColor: CH.net, borderWidth: 3, tension: 0.3, pointRadius: 4 },
        ],
      },
      options: {
        responsive: false,
        animation: false,
        layout: { padding: { top: 24 } },
        scales: {
          x: { ticks: { color: CH.axis }, grid: { display: false } },
          yLots: { position: "left", ticks: { color: CH.axis, callback: (v) => shortNum(v) }, grid: { color: CH.grid }, title: { display: true, text: "Lots", color: CH.muted } },
          yRev: { position: "right", ticks: { color: CH.axis, callback: (v) => shortMoney(v) }, grid: { drawOnChartArea: false }, title: { display: true, text: "Net revenue", color: CH.muted } },
        },
        plugins: chartTitle(`Lots vs Net Revenue by Client ${titleSuffix}`, "volume against what it actually earned"),
      },
      plugins: [valueLabels((v, di) => (di === 0 ? shortNum(v) : shortMoney(v)))],
    },
  });

  specs.push({
    name: "revenue-composition.png",
    width: 900,
    height: 620,
    config: {
      type: "doughnut",
      data: {
        labels: ["Markup", "Client commission", "LP commission", "IB commission", "Net revenue"],
        datasets: [
          {
            data: [totals.markup, totals.clientComm, totals.lpComm, totals.ibCommission, Math.abs(totals.netRev)],
            backgroundColor: [CH.markup, CH.clientComm, CH.lpComm, CH.ibComm, CH.net],
            borderColor: "#ffffff",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: false,
        animation: false,
        cutout: "45%",
        plugins: { ...chartTitle(`Revenue Composition ${titleSuffix}`, "what was earned, what was paid out, what was kept"), legend: { position: "right", labels: { color: CH.axis, font: { size: 12 }, boxWidth: 14 } } },
      },
      plugins: [doughnutLabels],
    },
  });

  if (days.length) {
    specs.push({
      name: "daily-volume-equity-vs-cfd.png",
      width: 1100,
      height: 620,
      config: {
        type: "bar",
        data: {
          labels: days.map((d) => fmtDayLabel(d.date)),
          datasets: [
            { label: "Equity lots", data: days.map((d) => Number(d.stocksLots) || 0), backgroundColor: CH.markup, borderRadius: 4 },
            { label: "CFD lots", data: days.map((d) => Number(d.cfdLots) || 0), backgroundColor: "#7c3aed", borderRadius: 4 },
          ],
        },
        options: {
          responsive: false,
          animation: false,
          layout: { padding: { top: 20 } },
          scales: {
            x: { ticks: { color: CH.axis }, grid: { display: false } },
            y: { beginAtZero: true, ticks: { color: CH.axis, callback: (v) => shortNum(v) }, grid: { color: CH.grid }, title: { display: true, text: "Lots", color: CH.muted } },
          },
          plugins: chartTitle(`Daily Volume - Equity vs CFD ${titleSuffix}`, "lots traded per day, split by instrument class"),
        },
        plugins: [valueLabels((v) => (Math.abs(Number(v) || 0) > 0 ? shortNum(v) : ""))],
      },
    });
  }

  const images = [];
  for (const spec of specs) {
    const buffer = await renderChartBuffer(spec.config, spec.width, spec.height);
    images.push({ name: spec.name, buffer });
  }
  return images;
}

// Brevo's API ignores cid:, so charts are fetched over HTTPS from the app.
const chartImg = (urls, name, alt) =>
  urls && urls[name]
    ? `<div class="ch-img"><img src="${urls[name]}" alt="${escapeHtml(alt)}" width="100%" /></div>`
    : "";

// One bar: a full-width table split into a filled cell and an empty remainder.
function barCell(segments) {
  const filled = segments
    .filter((s) => s.width > 0.4)
    .map(
      (s) =>
        `<td width="${s.width.toFixed(1)}%" style="width:${s.width.toFixed(1)}%;background:${s.color};font-size:0;line-height:14px;height:14px;">&nbsp;</td>`,
    )
    .join("");
  const used = segments.reduce((sum, s) => sum + (s.width > 0.4 ? s.width : 0), 0);
  const rest = Math.max(0, 100 - used);
  const filler = rest > 0.4 ? `<td width="${rest.toFixed(1)}%" style="width:${rest.toFixed(1)}%;font-size:0;line-height:14px;height:14px;">&nbsp;</td>` : "";
  return `<table role="presentation" class="ch-track"><tr>${filled}${filler}</tr></table>`;
}

// Horizontal bar chart. rows: [{ label, value, display, color }]
function buildBarChart(heading, note, rows) {
  if (!rows.length) return "";
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.value) || 0)), 0);
  const body = rows
    .map(
      (r) => `<tr>
        <td class="ch-label">${escapeHtml(r.label)}</td>
        <td class="ch-bar">${barCell([{ width: pct(r.value, max), color: r.color }])}</td>
        <td class="ch-val">${r.display}</td>
      </tr>`,
    )
    .join("");
  return `<p class="section-title" style="margin-top:16px;">${heading}</p>
          ${note ? `<p class="ch-note">${note}</p>` : ""}
          <table class="chart" role="presentation">${body}</table>`;
}

const legendDot = (color, text) =>
  `<span class="ch-key"><span class="ch-swatch" style="background:${color};">&nbsp;&nbsp;&nbsp;</span> ${escapeHtml(text)}</span>`;

// Grouped chart — one labelled bar per series, per category.
// series: [{ key, label, color }]; rows: [{ label, values:{key}, displays:{key} }]
// scale "shared" compares series against one axis (Gross vs Net); "per-series"
// gives each its own axis, for quantities in different units (lots vs dollars).
function buildGroupedChart(heading, note, series, rows, { scale = "shared" } = {}) {
  if (!rows.length) return "";
  const maxAll = Math.max(...rows.flatMap((r) => series.map((s) => Math.abs(Number(r.values[s.key]) || 0))), 0);
  const maxBySeries = Object.fromEntries(
    series.map((s) => [s.key, Math.max(...rows.map((r) => Math.abs(Number(r.values[s.key]) || 0)), 0)]),
  );
  const body = rows
    .map((r) =>
      series
        .map((s, i) => {
          const max = scale === "shared" ? maxAll : maxBySeries[s.key];
          return `<tr class="${i === 0 ? "ch-group-start" : ""}">
            <td class="ch-label">${i === 0 ? escapeHtml(r.label) : "&nbsp;"}</td>
            <td class="ch-series">${escapeHtml(s.label)}</td>
            <td class="ch-bar">${barCell([{ width: pct(r.values[s.key], max), color: s.color }])}</td>
            <td class="ch-val">${r.displays[s.key]}</td>
          </tr>`;
        })
        .join(""),
    )
    .join("");
  return `<p class="section-title" style="margin-top:16px;">${heading}</p>
          <p class="ch-note">${series.map((s) => legendDot(s.color, s.label)).join(" ")}${note ? ` &nbsp;&middot;&nbsp; ${note}` : ""}</p>
          <table class="chart" role="presentation">${body}</table>`;
}

// Composition chart — each component as a share of a whole, with its percentage.
// Conveys what the doughnut did, but readable without an image.
function buildCompositionChart(heading, note, parts, whole) {
  const base = Math.abs(whole) || parts.reduce((s, p) => s + Math.abs(Number(p.value) || 0), 0);
  if (!base) return "";
  const body = parts
    .map((p) => {
      const share = (Math.abs(Number(p.value) || 0) / base) * 100;
      return `<tr>
        <td class="ch-label">${escapeHtml(p.label)}</td>
        <td class="ch-bar">${barCell([{ width: Math.min(100, share), color: p.color }])}</td>
        <td class="ch-val">${p.display}<span class="ch-pct">${share.toFixed(1)}%</span></td>
      </tr>`;
    })
    .join("");
  return `<p class="section-title" style="margin-top:16px;">${heading}</p>
          ${note ? `<p class="ch-note">${note}</p>` : ""}
          <table class="chart" role="presentation">${body}</table>`;
}

// Stacked bar chart — one bar per row, split into coloured segments.
// series: [{ key, label, color }]; rows: [{ label, values:{key:number}, display }]
function buildStackedChart(heading, note, series, rows) {
  if (!rows.length) return "";
  const totalOf = (r) => series.reduce((sum, s) => sum + Math.abs(Number(r.values[s.key]) || 0), 0);
  const max = Math.max(...rows.map(totalOf), 0);
  const body = rows
    .map((r) => {
      const segs = series.map((s) => ({ width: pct(r.values[s.key], max), color: s.color }));
      return `<tr>
        <td class="ch-label">${escapeHtml(r.label)}</td>
        <td class="ch-bar">${barCell(segs)}</td>
        <td class="ch-val">${r.display}</td>
      </tr>`;
    })
    .join("");
  return `<p class="section-title" style="margin-top:16px;">${heading}</p>
          <p class="ch-note">${series.map((s) => legendDot(s.color, s.label)).join(" ")}${note ? ` &nbsp;&middot;&nbsp; ${note}` : ""}</p>
          <table class="chart" role="presentation">${body}</table>`;
}

// Equity-vs-CFD summary cards + a per-day table for the report week. Renders a
// short notice instead of throwing when the volume endpoint was unavailable.
function buildVolumeSection(volume, charts, volumeStats) {
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
        ${dataCell("Traded Lots", fmtNum(d.lots, 2), { align: "right", bold: true })}
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
                <p class="kpi-label">Traded Lots (realized)</p>
                <p class="kpi-value">${fmtNum(volume.totalLots, 2)}</p>
              </td>
            </tr>
          </table>

          ${volumeStats ? `<table class="vol-kpis" role="presentation">
            <tr>
              <td class="kpi vol-total" width="33%">
                <p class="kpi-label">Deal Lots (both legs)</p>
                <p class="kpi-value">${fmtNum(volumeStats.dealLots, 2)}</p>
              </td>
              <td class="kpi equity" width="33%">
                <p class="kpi-label">Bridge Lots</p>
                <p class="kpi-value">${fmtNum(volumeStats.bridgeLots, 2)}</p>
              </td>
              <td class="kpi cfd" width="33%">
                <p class="kpi-label">Matched Lots</p>
                <p class="kpi-value">${fmtNum(volumeStats.matchedLots, 2)}</p>
              </td>
            </tr>
          </table>
          <p style="font-size:11px;color:#64748b;margin:0 0 10px;">
            Deal Lots count both legs of a round trip; Traded Lots count it once
            (${fmtNum(volumeStats.realizedEquity, 2)} equity + ${fmtNum(volumeStats.realizedCfd, 2)} CFD =
            ${fmtNum(volumeStats.realizedTotal, 2)}). Only Matched Lots reached an LP.
          </p>` : ""}

          <table class="data narrow">
            <thead>
              <tr><th width="28%">Day</th><th width="24%">Equity Lots</th><th width="24%">CFD Lots</th><th width="24%">Traded Lots</th></tr>
            </thead>
            <tbody>
              <tr class="total-row">
                ${spanCell("TOTAL")}
                ${dataCell("Equity Lots", fmtNum(volume.totalStocksLots, 2), { align: "right" })}
                ${dataCell("CFD Lots", fmtNum(volume.totalCfdLots, 2), { align: "right" })}
                ${dataCell("Traded Lots", fmtNum(volume.totalLots, 2), { align: "right" })}
              </tr>
              ${dailyRows || `<tr>${spanCell("No volume recorded for this week.", { colspan: 4, align: "center" })}</tr>`}
            </tbody>
          </table>

          ${charts ? chartImg(charts, "daily-volume-equity-vs-cfd.png", "Daily volume, equity versus CFD lots") : buildStackedChart(
            "Daily Volume &mdash; Equity vs CFD",
            "lots traded per day",
            [
              { key: "stocksLots", label: "Equity", color: "#0891b2" },
              { key: "cfdLots", label: "CFD", color: "#7c3aed" },
            ],
            days.map((d) => ({
              label: fmtDayLabel(d.date),
              values: { stocksLots: d.stocksLots, cfdLots: d.cfdLots },
              display: fmtNum(d.lots, 2),
            })),
          )}`;
}

function buildEmailHtml({ fromYmd, toYmd, rows, volume, volumeStats = null, charts = null, chartError = null }) {
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
      .kpis { width:100%; border-collapse:collapse; margin:0 0 8px; font-size:0; text-align:center; }
      .kpis td { display:inline-block; width:100%; max-width:222px; margin:0 3px 6px; vertical-align:top; box-sizing:border-box; font-size:12px; text-align:left; }
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
      /* BASE = the real table. Zoho ignores @media (verified in production from
         both directions), so there is no breakpoint to switch on — the table has
         to be the default or a desktop reader never gets one. The wrapper keeps
         a phone usable: it scrolls sideways instead of crushing 9 columns. */
      .tscroll { width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch; margin:0 0 16px; }
      table.data { border-collapse:collapse; width:100%; min-width:860px; font-size:12px; table-layout:fixed; }
      table.data.narrow { min-width:0; font-size:11px; }
      table.data th, table.data td { border:1px solid #e2e8f0; padding:7px 8px; text-align:left; vertical-align:top; }
      table.data th { background:#0f2d4f; color:#f8fafc; font-weight:700; font-size:11px; }
      table.data td.num { text-align:right; white-space:nowrap; }
      table.data td.key { white-space:nowrap; }
      table.data td.txt { overflow-wrap:break-word; }
      table.data tbody tr:nth-child(even) { background:#f9fcff; }
      /* TOTAL sits at the TOP of the body, not in a <tfoot>, so the headline
         figures are visible without scrolling past every client. Declared after
         the zebra rule so the stripe never overrides its fill. */
      table.data tr.total-row td { font-weight:700; background:#eff6ff; color:#0f2d4f; }
      table.data td .lbl { display:none; }
      table.data td .val { display:inline; }

      /* Inline charts: bars are nested tables with a background colour, which
         renders even when the client blocks images. Values sit in their own
         right-hand cell so short bars stay readable. */
      table.chart { width:100%; border-collapse:collapse; font-size:11px; margin:0 0 14px; }
      table.chart td { padding:3px 4px; vertical-align:middle; border:0; }
      .ch-label { width:26%; color:#334155; }
      .ch-series { width:11%; color:#64748b; font-size:10px; }
      .ch-bar { width:43%; }
      .ch-val { width:20%; text-align:right; font-weight:700; color:#0f2d4f; white-space:nowrap; }
      .ch-pct { display:block; font-weight:400; font-size:10px; color:#64748b; }
      tr.ch-group-start td { padding-top:7px; }
      table.ch-track { width:100%; border-collapse:collapse; background:#eef2f7; }
      table.ch-track td { padding:0; }
      .ch-note { margin:0 0 6px; font-size:11px; color:#64748b; }
      /* Chart images are embedded by Content-ID. max-width keeps them inside a
         375px screen; height:auto stops clients stretching them. */
      .ch-img { margin:0 0 16px; }
      .ch-img img { display:block; width:100%; max-width:100%; height:auto; border:1px solid #e2e8f0; border-radius:8px; }
      .ch-key { margin-right:10px; white-space:nowrap; }
      .ch-swatch { display:inline-block; font-size:0; line-height:9px; height:9px; border-radius:2px; vertical-align:middle; }
      .money-pos { color:#0369a1; font-weight:700; }
      .money-cost { color:#b45309; }
      .money-neg { color:#b91c1c; font-weight:700; }
      .foot { border-top:1px solid #e2e8f0; margin-top:14px; padding-top:10px; color:#64748b; font-size:12px; line-height:1.5; }
      .attachments { margin-top:8px; color:#334155; font-size:12px; }
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
                <p class="kpi-label">Total Lots (deals)</p>
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

          ${buildVolumeSection(volume, charts, volumeStats)}

          <p class="section-title" style="margin-top:18px;">Client Revenue Table</p>
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
              <tr class="total-row">
                ${spanCell("TOTAL", { colspan: 2 })}
                ${dataCell("Lots", fmtNum(totals.lots, 2), { align: "right" })}
                ${dataCell("Markup", money(totals.markup), { align: "right", cls: "money-pos" })}
                ${dataCell("Client Comm", money(totals.clientComm), { align: "right", cls: "money-pos" })}
                ${dataCell("LP Comm", money(totals.lpComm), { align: "right", cls: "money-cost" })}
                ${dataCell("Total Rev", money(totals.totalRev), { align: "right", cls: "money-pos" })}
                ${dataCell("IB Commission", money(totals.ibCommission), { align: "right", cls: "money-cost" })}
                ${dataCell("Net Revenue", money(totals.netRev), { align: "right", cls: totals.netRev < 0 ? "money-neg" : "money-pos" })}
              </tr>
              ${bodyRows || `<tr>${spanCell("No rows with Lots &gt; 0 for this week.", { colspan: 9, align: "center" })}</tr>`}
            </tbody>
          </table>
          </div>

          ${charts ? chartImg(charts, "top10-net-revenue.png", "Top 10 clients by net revenue") : buildBarChart(
            "Top 10 Clients by Net Revenue",
            "ranked by net revenue for the period",
            [...rows]
              .sort((a, b) => (Number(b.netRev) || 0) - (Number(a.netRev) || 0))
              .slice(0, 10)
              .map((r) => ({
                label: `${r.login} ${String(r.name || "").slice(0, 18)}`.trim(),
                value: r.netRev,
                display: money(r.netRev),
                color: (Number(r.netRev) || 0) < 0 ? "#b91c1c" : "#0f766e",
              })),
          )}

          ${charts ? chartImg(charts, "gross-vs-net.png", "Gross versus net revenue by client") : buildGroupedChart(
            "Gross vs Net Revenue",
            "top 10 by total revenue &mdash; the gap is LP + IB commission",
            [
              { key: "totalRev", label: "Gross", color: "#1d4ed8" },
              { key: "netRev", label: "Net", color: "#15803d" },
            ],
            [...rows]
              .sort((a, b) => (Number(b.totalRev) || 0) - (Number(a.totalRev) || 0))
              .slice(0, 10)
              .map((r) => ({
                label: `${r.login} ${String(r.name || "").slice(0, 10)}`.trim(),
                values: { totalRev: r.totalRev, netRev: r.netRev },
                displays: { totalRev: money(r.totalRev), netRev: money(r.netRev) },
              })),
          )}

          ${charts ? chartImg(charts, "lots-vs-net-by-client.png", "Lots versus net revenue by client") : buildGroupedChart(
            "Lots vs Net Revenue by Client",
            "top 12 by volume &mdash; each series on its own scale, so compare shapes not lengths",
            [
              { key: "lots", label: "Lots", color: "#0891b2" },
              { key: "netRev", label: "Net rev", color: "#15803d" },
            ],
            [...rows]
              .sort((a, b) => (Number(b.lots) || 0) - (Number(a.lots) || 0))
              .slice(0, 12)
              .map((r) => ({
                label: `${r.login} ${String(r.name || "").slice(0, 10)}`.trim(),
                values: { lots: r.lots, netRev: r.netRev },
                displays: { lots: fmtNum(r.lots, 2), netRev: money(r.netRev) },
              })),
            { scale: "per-series" },
          )}

          ${charts ? chartImg(charts, "revenue-composition.png", "Revenue composition doughnut") : buildCompositionChart(
            "Revenue Composition",
            `share of gross revenue (${money(totals.markup + totals.clientComm)} earned before costs)`,
            [
              { label: "Markup", value: totals.markup, display: money(totals.markup), color: "#0891b2" },
              { label: "Client Comm", value: totals.clientComm, display: money(totals.clientComm), color: "#0f766e" },
              { label: "LP Comm", value: totals.lpComm, display: money(totals.lpComm), color: "#b45309" },
              { label: "IB Commission", value: totals.ibCommission, display: money(totals.ibCommission), color: "#be123c" },
              { label: "Net Revenue", value: totals.netRev, display: money(totals.netRev), color: "#15803d" },
            ],
            totals.markup + totals.clientComm,
          )}
          <div class="foot">
            Automated report generated by Deal Matching pipeline.<br/>
            Formula: Total Revenue = (Markup + Client Comm) - LP Comm; Net Revenue = (Markup + Client Comm) - (LP Comm + IB Commission)<br/>
            ${chartError ? `Chart images unavailable: ${escapeHtml(chartError)} &mdash; showing built-in bar charts instead.<br/>` : ""}
            Traded Lots (realized) come from ClientVolume/Run &mdash; the dashboard's Dealing (LP) volume tile. Total Lots (deals) count every MT5 deal, so a round trip appears twice; realized equity + CFD reconciles the two.
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}


export async function runWeeklyDealMatchEmailReport({ fromDate, toDate, recipients: recipientsOverride } = {}) {
  const week = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullWeekUtc();
  const { from, to } = toUnixRange(week.start, week.end);
  const params = new URLSearchParams({
    group: "*",
    from: String(from),
    to: String(to),
    symbol: "",
    // Summary mode. Carries clientRevenueSummaries + all the total* scalars; the
    // full match arrays (~45 MB for a month) are not read by this report.
    lite: "true",
  });

  const runUrl = `${BACKEND_BASE_URL}/DealMatch/Run?${params.toString()}`;
  const resp = await fetch(runUrl, { signal: AbortSignal.timeout(45_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DealMatch/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const report = await resp.json();
  // Volume scalars, straight from DealMatch. "Deal" lots count both legs of a
  // round trip; "realized" counts it once — which is why realized (CFD+Equity)
  // equals what ClientVolume/Run reports, and deal lots are ~2x that.
  const n = (v) => Number(v) || 0;
  const volumeStats = {
    dealLots: n(report?.totalMt5DealLots) + n(report?.totalShiftingMt5DealLots),
    realizedCfd: n(report?.totalRealizedLotsCfd),
    realizedEquity: n(report?.totalRealizedLotsEquity),
    realizedTotal: n(report?.totalRealizedLotsCfd) + n(report?.totalRealizedLotsEquity),
    bridgeLots: n(report?.totalBridgeLots),
    matchedLots: n(report?.totalMatchedLots),
  };
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

  // Charts render to PNG and travel inside the message, referenced by cid:. If
  // rendering is unavailable (chartjs-node-canvas needs a native canvas build),
  // fall back to the HTML bar charts rather than shipping broken images.
  const totalsForCharts = rows.reduce(
    (acc, row) => {
      acc.markup += Number(row.markup) || 0;
      acc.clientComm += Number(row.clientComm) || 0;
      acc.lpComm += Number(row.lpComm) || 0;
      acc.ibCommission += Number(row.ibCommission) || 0;
      acc.netRev += Number(row.netRev) || 0;
      return acc;
    },
    { markup: 0, clientComm: 0, lpComm: 0, ibCommission: 0, netRev: 0 },
  );

  let chartUrls = null;
  let chartError = null;
  try {
    const images = await buildChartImages(rows, volume, totalsForCharts, `(${fromYmd} to ${toYmd})`);
    const published = await publishChartImages(images);
    chartUrls = published.urls;
    console.log(`[DealMatchWeekly] published ${images.length} charts to ${published.dir}`);
  } catch (error) {
    chartError = `${error?.code ? `${error.code}: ` : ""}${error?.message || String(error)}`;
    console.warn("[DealMatchWeekly] chart rendering failed, using HTML fallback:", chartError);
  }

  const subject = `Weekly Deal Match Analysis (${fromYmd} to ${toYmd})`;
  const html = buildEmailHtml({ fromYmd, toYmd, rows, volume, volumeStats, charts: chartUrls, chartError });
  // Charts are referenced by URL and rendered in the body — no attachments.
  await sendBrevoEmail({ subject, html, recipients });

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
    // Summary mode. Carries clientRevenueSummaries + all the total* scalars; the
    // full match arrays (~45 MB for a month) are not read by this report.
    lite: "true",
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
