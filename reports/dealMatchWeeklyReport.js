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

function buildEmailHtml({ fromYmd, toYmd, rows }) {
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
    .map((row) => {
      return `<tr>
        <td data-label="Login">${escapeHtml(row.login)}</td>
        <td data-label="Name">${escapeHtml(row.name)}</td>
        <td data-label="Lots" style="text-align:right;">${fmtNum(row.lots, 2)}</td>
        <td data-label="Markup" style="text-align:right;">${money(row.markup)}</td>
        <td data-label="Client Comm" style="text-align:right;">${money(row.clientComm)}</td>
        <td data-label="LP Comm" style="text-align:right;">${money(row.lpComm)}</td>
        <td data-label="Total Rev" style="text-align:right;font-weight:700;">${money(row.totalRev)}</td>
        <td data-label="IB Commission" style="text-align:right;">${money(row.ibCommission)}</td>
        <td data-label="Net Revenue" style="text-align:right;font-weight:700;">${money(row.netRev)}</td>
      </tr>`;
    })
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
      body { margin:0; padding:0; background:#f3f7fb; color:#0f172a; font-family: Arial, Helvetica, sans-serif; }
      .outer { width:100%; background:#f3f7fb; padding:20px 10px; }
      .wrap { max-width: 980px; margin: 0 auto; background:#ffffff; border:1px solid #dbe6f2; border-radius:14px; overflow:hidden; }
      .header { padding:18px 20px; background:linear-gradient(135deg,#0f2d4f,#114b7a); color:#eaf4ff; }
      .header-grid { width:100%; border-collapse:collapse; }
      .header-left { vertical-align:top; text-align:left; }
      .header-right { vertical-align:top; text-align:right; }
      .title { margin:0; font-size:22px; font-weight:700; letter-spacing:0.2px; }
      .subtitle { margin:6px 0 0; font-size:13px; color:#cfe3f8; }
      .header-meta { margin:0; font-size:11px; line-height:1.55; color:#bcd6ee; }
      .content { padding:18px 20px 16px; }
      .meta { color:#475569; font-size:13px; margin:0 0 14px; line-height:1.5; }
      .kpis { width:100%; border-collapse:separate; border-spacing:8px; margin: 0 0 14px; }
      .kpi { background:#f8fbff; border:1px solid #d9e8f8; border-radius:10px; padding:10px 12px; }
      .kpi.clients { background:#eef8ff; border-color:#bfe3ff; }
      .kpi.lots { background:#edfdf7; border-color:#bbf7d0; }
      .kpi.gross { background:#fffbeb; border-color:#fde68a; }
      .kpi.net { background:#f5f3ff; border-color:#ddd6fe; }
      .kpi-label { font-size:11px; text-transform:uppercase; letter-spacing:0.4px; color:#64748b; margin:0 0 6px; }
      .kpi-value { font-size:18px; font-weight:700; color:#0f2d4f; margin:0; }
      .kpi-note { font-size:12px; color:#334155; margin:8px 0 10px; padding:8px 10px; background:#f8fafc; border:1px solid #e2e8f0; border-left:4px solid #14b8a6; border-radius:8px; }
      .section-title { margin: 2px 0 8px; font-size:14px; color:#0f2d4f; font-weight:700; }
      table.data { border-collapse: collapse; width: 100%; font-size: 12px; }
      table.data th, table.data td { border: 1px solid #e2e8f0; padding: 8px; }
      table.data th { background: #0f2d4f; color:#f8fafc; text-align:left; font-weight:700; }
      table.data tbody tr:nth-child(even) { background:#f9fcff; }
      table.data tbody tr:hover { background:#eef6ff; }
      table.data tfoot td { font-weight:700; background:#eff6ff; color:#0f2d4f; }
      .money-pos { color:#0369a1; font-weight:700; }
      .money-cost { color:#b45309; }
      .money-neg { color:#b91c1c; font-weight:700; }
      .foot { border-top:1px solid #e2e8f0; margin-top:14px; padding-top:10px; color:#64748b; font-size:12px; line-height:1.5; }
      .attachments { margin-top:8px; color:#334155; font-size:12px; }
      @media only screen and (max-width: 680px) {
        .outer { padding:8px 2px; }
        .wrap { border-radius:8px; }
        .header { padding:12px; }
        .header-grid, .header-grid tbody, .header-grid tr, .header-grid td { display:block !important; width:100% !important; }
        .header-right { text-align:left !important; margin-top:10px; }
        .title { font-size:18px; }
        .subtitle { font-size:12px; }
        .header-meta { font-size:11px; }
        .content { padding:10px; }
        .kpis, .kpis tbody, .kpis tr, .kpis td { display:block !important; width:100% !important; }
        .kpis { border-spacing:0; }
        .kpi { display:block; margin:0 0 8px; }
        .kpi-value { font-size:16px; }
        table.data, table.data thead, table.data tbody, table.data th, table.data td, table.data tr, table.data tfoot { display:block !important; width:100% !important; }
        table.data thead { display:none !important; }
        table.data tr { margin:0 0 10px; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden; background:#fff !important; }
        table.data td { border:0; border-bottom:1px solid #eef2f7; padding:7px 8px 7px 42%; position:relative; text-align:right !important; min-height:18px; font-size:11px; }
        table.data td:last-child { border-bottom:0; }
        table.data td:before { position:absolute; left:8px; top:7px; width:36%; text-align:left; font-weight:700; color:#475569; content: attr(data-label); white-space:nowrap; }
        table.data tfoot tr { border:1px solid #cfe3ff; background:#eff6ff !important; }
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
          <table class="data">
        <thead>
          <tr>
            <th>Login</th>
            <th>Name</th>
            <th>Lots</th>
            <th>Markup</th>
            <th>Client Comm</th>
            <th>LP Comm</th>
            <th>Total Rev</th>
            <th>IB Commission</th>
            <th>Net Revenue</th>
          </tr>
        </thead>
        <tbody>
          ${bodyRows || `<tr><td data-label="Notice" colspan="9" style="text-align:center;color:#64748b;">No rows with Lots &gt; 0 for this week.</td></tr>`}
        </tbody>
        <tfoot>
          <tr>
            <td data-label="Login" colspan="2">TOTAL</td>
            <td data-label="Lots" style="text-align:right;">${fmtNum(totals.lots, 2)}</td>
            <td data-label="Markup" style="text-align:right;" class="money-pos">${money(totals.markup)}</td>
            <td data-label="Client Comm" style="text-align:right;" class="money-pos">${money(totals.clientComm)}</td>
            <td data-label="LP Comm" style="text-align:right;" class="money-cost">${money(totals.lpComm)}</td>
            <td data-label="Total Rev" style="text-align:right;" class="money-pos">${money(totals.totalRev)}</td>
            <td data-label="IB Commission" style="text-align:right;" class="money-cost">${money(totals.ibCommission)}</td>
            <td data-label="Net Revenue" style="text-align:right;" class="${totals.netRev < 0 ? "money-neg" : "money-pos"}">${money(totals.netRev)}</td>
          </tr>
        </tfoot>
          </table>

          <div class="attachments">
            Attached visuals: Top 10 Net Revenue, Gross vs Net Revenue, Lots vs Net Revenue, Revenue Composition.
          </div>
          <div class="foot">
            Automated report generated by Deal Matching pipeline.<br/>
            Formula: Total Revenue = (Markup + Client Comm) - LP Comm; Net Revenue = (Markup + Client Comm) - (LP Comm + IB Commission)
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

async function buildEmailChartAttachments(rows, fromYmd, toYmd) {
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

export async function runWeeklyDealMatchEmailReport({ fromDate, toDate } = {}) {
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
  const recipients = parseRecipients(process.env.DEALMATCH_ALERT_RECIPIENTS || "");
  if (!recipients.length) {
    console.warn("[DealMatchWeekly] No recipients configured. Skipping.");
    return { ok: false, reason: "no-recipients", rows: rows.length, fromYmd, toYmd };
  }
  const subject = `Weekly Deal Match Analysis (${fromYmd} to ${toYmd})`;
  const html = buildEmailHtml({ fromYmd, toYmd, rows });
  const attachments = await buildEmailChartAttachments(rows, fromYmd, toYmd);
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
