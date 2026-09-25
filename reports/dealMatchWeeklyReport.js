import {
  backendFetch,
  toYmdUtc,
  alreadySentFor,
  recordSentFor,
  fmtNum,
  money,
  escapeHtml,
  mapWithConcurrency,
  previousFullWeekUtc,
  toUnixRange,
  sendBrevoEmail,
  renderChartBuffer,
  publishChartImages,
  CADENCES,
  resolveRecipients,
} from "./reportShared.js";
import { extractVolume, renderVolumeSection } from "./volumeSection.js";

const CRM_API_VERSION = String(process.env.VITE_API_VERSION || "1.0.0");
const CRM_API_TOKEN = String(process.env.VITE_API_TOKEN || process.env.API_TOKEN || "").trim();
const CRM_REST_BASE = String(process.env.REST_PROXY_TARGET || "https://portal.skylinkscapital.com").replace(/\/+$/, "");

// The weekly key is bare because sends already recorded in the send log use it.
// A daily that reused it would make Saturday's weekly skip as "already sent".
export const DEALMATCH_GUARD_KEYS = {
  daily: "dealmatch-daily",
  weekly: "dealmatch",
  monthly: "dealmatch-monthly",
};

// Each cadence may have its own audience, and falls back to the one list this
// report has always used -- so the new sends work with no environment change.
export const DEALMATCH_RECIPIENT_VARS = {
  daily: ["DAILY_DEALMATCH_RECIPIENTS", "DEALMATCH_ALERT_RECIPIENTS"],
  weekly: ["DEALMATCH_ALERT_RECIPIENTS"],
  monthly: ["MONTHLY_DEALMATCH_RECIPIENTS", "DEALMATCH_ALERT_RECIPIENTS"],
};

// DealMatch/Run costs ~40s whatever the window: 41.8s for one day and 40.4s for
// a month, measured 2026-08-31. The cost is in starting the match, not in the
// deals matched, so a shorter period buys no headroom. The old 45s left under
// four seconds of it.
export const DEALMATCH_RUN_TIMEOUT_MS = 180_000;

export function dealMatchSubject(cadence, fromYmd, toYmd) {
  const word = CADENCES[cadence].subjectWord;
  // A single day rendered as "2026-08-31 to 2026-08-31" reads like a bug.
  const period = fromYmd === toYmd ? fromYmd : `${fromYmd} to ${toYmd}`;
  return `${word} Deal Match Analysis (${period})`;
}

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

// ── client identity and IB rebate ───────────────────────────────────────────
// The rebate is looked up ONCE PER CRM CLIENT. An earlier version cached per
// MT5 login while looking the value up per user, so a client with two accounts
// had their whole rebate charged to each one: Dawei Huang's 8,646 was billed as
// 17,292. Grouping first removes the need to split anything.
//
// It counts only the approved IB transfers and withdrawals SETTLED INSIDE the
// week. The IB wallet balance is deliberately excluded -- it is accumulated,
// still-unpaid commission read at the instant the report runs, so it is not a
// cost of this week, and including it made the same closed week produce a
// different Net Revenue on every run.
export async function resolveClientIds(logins) {
  const userIdByLogin = new Map();

  if (!CRM_API_TOKEN) {
    for (const login of logins) userIdByLogin.set(login, null);
    return { userIdByLogin, unresolved: logins.length };
  }

  await mapWithConcurrency(
    logins,
    async (login) => {
      try {
        const userId = await getCrmUserIdByMt5Login(login);
        userIdByLogin.set(login, Number.isFinite(userId) && userId > 0 ? userId : null);
      } catch (error) {
        console.warn(`[DealMatchWeekly] CRM user lookup failed for login=${login}:`, error?.message || error);
        userIdByLogin.set(login, null);
      }
    },
    6,
  );

  let unresolved = 0;
  for (const login of logins) {
    if (userIdByLogin.get(login) === null) unresolved += 1;
  }
  return { userIdByLogin, unresolved };
}

export async function attachRebateWithdrawn(clientRows, period) {
  const withUser = clientRows.filter((row) => Number.isFinite(row.userId) && row.userId > 0);
  let failed = 0;

  if (!CRM_API_TOKEN) {
    for (const row of clientRows) row.rebateWithdrawn = 0;
    return { failed: withUser.length, clients: withUser.length };
  }

  await mapWithConcurrency(
    withUser,
    async (row) => {
      try {
        if (!(await isIbUser(row.userId))) {
          row.rebateWithdrawn = 0;
          return;
        }
        row.rebateWithdrawn = await getIbApprovedTransfersAndWithdrawals(row.userId, period);
      } catch (error) {
        console.warn(`[DealMatchWeekly] rebate lookup failed for client=${row.userId}:`, error?.message || error);
        // Zero UNDERSTATES the cost and so overstates Net Revenue. It is counted
        // here and named in the footer rather than passing as a real figure.
        row.rebateWithdrawn = 0;
        failed += 1;
      }
    },
    6,
  );

  return { failed, clients: withUser.length };
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
  const resp = await backendFetch(`/ClientVolume/Run?${params.toString()}`, { timeoutMs: 45_000 });
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

export function deriveClientRevenueRows(report) {
  const list = Array.isArray(report?.clientRevenueSummaries) ? report.clientRevenueSummaries : [];
  if (list.length) {
    return list.map((row) => {
      const markup = Number(row.markupRevenueUsd) || 0;
      const clientComm = Number(row.clientCommissionUsd) || 0;
      // The backend returns LP commission signed-negative (money paid out). It is
      // a cost, so subtract its magnitude — without abs() the minus sign flips it
      // into revenue. Mirrors deriveBaseRows() in src/lib/dealMatchApi.ts.
      const lpComm = Math.abs(Number(row.lpCommissionUsd) || 0);
      // The cost that actually reduces revenue is the PER-MILLION commission
      // (notional x the weighted rate), not the coverage-attributed
      // lpCommissionUsd. Checked against DealMatch/Run for 2026-08-08..14:
      // gross - lpCommPerMillionUsd reproduced totalRevenueUsd on 78 of 78
      // rows, gross - lpCommissionUsd on 0 of 78.
      //
      // This email previously recomputed gross - lpCommissionUsd so it would
      // agree with the Deal Performance tab. That made both agree on the wrong
      // subtrahend and overstated Total Revenue by 0.2-3.5% a week. The
      // reference page (temporay_for_reference_pages/deal-matching 7.html)
      // shows totalRevenueUsd directly, so this now does too.
      const lpCommPerM = Math.abs(Number(row.lpCommPerMillionUsd) || 0);
      const apiTotal = Number(row.totalRevenueUsd);
      const totalRev =
        Number.isFinite(apiTotal) && apiTotal !== 0 ? apiTotal : markup + clientComm - (lpCommPerM || lpComm);
      return {
        login: String(row.login ?? ""),
        name: String(row.name ?? ""),
        lots: Number(row.lots) || 0,
        markup,
        clientComm,
        // Client swap, the backend's swapRevenueUsd. Nothing subtracts it -- it
        // is already inside totalRevenueUsd. It is carried so the composition
        // chart can name the gap between markup + commission and the total,
        // instead of leaving it as an unexplained residual.
        swap: Number(row.swapRevenueUsd) || 0,
        lpComm,
        /** Notional x weighted per-million rate. The figure Net Revenue is built from. */
        lpCommPerM,
        millionsUsd: Number(row.clientMillionsUsd) || 0,
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

  // The matches array carries no notional and no per-million commission, so
  // this fallback can only subtract the coverage-attributed cost. It runs when
  // clientRevenueSummaries is empty, and the footer notes the degraded source.
  return Array.from(byLogin.values()).map((row) => ({
    ...row,
    swap: 0,
    lpCommPerM: 0,
    millionsUsd: 0,
    totalRev: row.markup + row.clientComm - row.lpComm,
  }));
}

// One row per CRM client rather than per MT5 account. A client commonly holds
// several trading accounts -- 10 did in the week of 8-14 Aug, one of them four
// -- which made the table hard to read and, before this, caused their IB rebate
// to be charged once per account.
//
// Pure: the login-to-user map is resolved by resolveClientIds() and passed in,
// so this function does no I/O and is cheap to test.
export function groupRowsByClient(rows, userIdByLogin) {
  const byClient = new Map();
  let blankLoginCount = 0;

  rows.forEach((row, index) => {
    const login = String(row.login || "").trim();
    let clientKey;
    let resolved = null;
    if (login) {
      const userId = userIdByLogin.get(login);
      resolved = Number.isFinite(userId) && userId > 0 ? userId : null;
      // An unresolved login cannot be merged without inventing a relationship
      // the CRM does not assert, so it stands alone under its own key.
      clientKey = resolved === null ? `login:${login}` : `user:${resolved}`;
    } else {
      // A blank login is not "the same client" as any other blank login --
      // they are unrelated accounts that merely share an absent login. Keying
      // them all as `login:` collapsed several unrelated accounts' figures
      // into one fabricated row and hid them from the unresolved count, so
      // each blank login gets its own key by position instead.
      blankLoginCount += 1;
      clientKey = `login:#${index}`;
    }

    let client = byClient.get(clientKey);
    if (!client) {
      client = {
        clientKey,
        userId: resolved,
        name: "",
        accounts: [],
        lots: 0,
        markup: 0,
        clientComm: 0,
        swap: 0,
        lpComm: 0,
        lpCommPerM: 0,
        millionsUsd: 0,
        totalRev: 0,
        rebateWithdrawn: 0,
        netRev: 0,
        _nameLots: -1,
      };
      byClient.set(clientKey, client);
    }

    if (login) client.accounts.push(login);
    client.lots += Number(row.lots) || 0;
    client.markup += Number(row.markup) || 0;
    client.clientComm += Number(row.clientComm) || 0;
    client.swap += Number(row.swap) || 0;
    client.lpComm += Number(row.lpComm) || 0;
    client.lpCommPerM += Number(row.lpCommPerM) || 0;
    client.millionsUsd += Number(row.millionsUsd) || 0;
    client.totalRev += Number(row.totalRev) || 0;

    // Name comes from the largest account, so the choice is deterministic
    // instead of depending on the order the API happened to return.
    const lots = Number(row.lots) || 0;
    const name = String(row.name || "").trim();
    if (name && lots > client._nameLots) {
      client.name = name;
      client._nameLots = lots;
    }
  });

  const result = [...byClient.values()]
    .map(({ _nameLots, ...client }) => ({ ...client, accounts: client.accounts.sort() }))
    .sort((a, b) => b.lots - a.lots);
  // Non-enumerable so it rides along on the array without breaking the
  // existing array-shaped return contract the tests rely on.
  Object.defineProperty(result, "blankLoginCount", { value: blankLoginCount, enumerable: false });
  return result;
}

// Shared by both call sites below: resolve logins to CRM clients, fold the
// per-account rows into one row per client, attach the rebate, and compute
// netRev. Kept as one helper rather than pasted twice — the two call sites
// differ only in which of { rows, unresolved, rebateResult } they need.
export async function buildClientRows(baseRows, week) {
  const logins = [...new Set(baseRows.map((r) => String(r.login || "").trim()).filter(Boolean))];
  const { userIdByLogin, unresolved } = await resolveClientIds(logins);
  const clientRows = groupRowsByClient(baseRows, userIdByLogin);
  const rebateResult = await attachRebateWithdrawn(clientRows, { from: week.start, to: week.end });

  // netRev is totalRev MINUS the rebate, not a second revenue figure built from
  // scratch. It used to be (markup + clientComm) - (lpComm + rebateWithdrawn),
  // which silently dropped every revenue component the backend counts that is
  // not markup or client commission -- above all client swap. On 2026-09-16, a
  // day with no IB rebate at all, that reported Total $21,609.65 against Net
  // $1,295.74, and the entire $20,313.91 gap was swap revenue. The Net Revenue
  // card's own note ("Total Revenue less IB Rebate") described a figure the
  // report was not showing. reports/dailyDigest.js has always computed it this
  // way; this brings the two into agreement.
  const rows = clientRows.map((row) => ({
    ...row,
    netRev: row.totalRev - row.rebateWithdrawn,
  }));
  // Blank-login rows can never be matched to a CRM client either, so they
  // belong in the same "could not be matched" count the footer already shows.
  return { rows, unresolved: unresolved + (clientRows.blankLoginCount || 0), rebateResult };
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

// Chart palette, retuned to the Risk Analysis Report's scheme: slate ink,
// cyan for revenue earned, emerald for what is kept, amber/rose for cost.
//
// Every series colour in this file resolves here. Several charts used to carry
// their own hex literals (a blue #1d4ed8 gross, a violet #7c3aed CFD) that
// existed in no palette, so the report's charts and its cards were drawn from
// two different schemes and only looked related by accident.
const CH = {
  ink: "#0f172a",
  grid: "#e6eaf1",
  axis: "#334155",
  muted: "#64748b",
  markup: "#22d3ee",
  clientComm: "#0891b2",
  swap: "#6366f1",
  lpComm: "#b45309",
  ibComm: "#be123c",
  net: "#059669",
  // Slate against emerald for the gross/net pair: the two bars sit side by
  // side, so they need contrast in value, not just hue.
  gross: "#0f172a",
  loss: "#dc2626",
  equity: "#0891b2",
  cfd: "#6366f1",
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
        labels: byNet.map((r) => String(r.name || r.accounts?.[0] || "").slice(0, 18)),
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
        labels: byTotal.map((r) => String(r.name || r.accounts?.[0] || "").slice(0, 18)),
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
        plugins: chartTitle(`Gross vs Net Revenue ${titleSuffix}`, "the gap between the pair is Rebate Withdrawn"),
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
        labels: byLots.map((r) => String(r.name || r.accounts?.[0] || "").slice(0, 18)),
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
        labels: ["Markup", "Client commission", "Swap revenue", "LP commission", "Rebate withdrawn", "Net revenue"],
        datasets: [
          {
            data: [totals.markup, totals.clientComm, totals.swap, totals.lpComm, totals.rebateWithdrawn, Math.abs(totals.netRev)],
            backgroundColor: [CH.markup, CH.clientComm, CH.swap, CH.lpComm, CH.ibComm, CH.net],
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
            { label: "CFD lots", data: days.map((d) => Number(d.cfdLots) || 0), backgroundColor: CH.cfd, borderRadius: 4 },
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
function buildVolumeSection(volume, charts, volumeStats, periodNoun) {
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

  // The six KPI cards that used to sit here (Equity / CFD / Traded, then Deal
  // Lots / Bridge / Matched) are gone: all six are cards at the top of the
  // report now, read from the same scalars. What is left is the part only this
  // section has -- the per-DAY split and the chart built from it.
  return `${title}
          <p style="font-size:11px;color:#64748b;margin:0 0 10px;">
            Totals are in the cards above. Deal Lots count both legs of a round trip;
            Traded Lots count it once${volumeStats ? ` (${fmtNum(volumeStats.realizedEquity, 2)} equity + ${fmtNum(volumeStats.realizedCfd, 2)} CFD = ${fmtNum(volumeStats.realizedTotal, 2)})` : ""}.
          </p>

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
              ${dailyRows || `<tr>${spanCell(`No volume recorded for this ${periodNoun}.`, { colspan: 4, align: "center" })}</tr>`}
            </tbody>
          </table>

          ${charts ? chartImg(charts, "daily-volume-equity-vs-cfd.png", "Daily volume, equity versus CFD lots") : buildStackedChart(
            "Daily Volume &mdash; Equity vs CFD",
            "lots traded per day",
            [
              { key: "stocksLots", label: "Equity", color: CH.equity },
              { key: "cfdLots", label: "CFD", color: CH.cfd },
            ],
            days.map((d) => ({
              label: fmtDayLabel(d.date),
              values: { stocksLots: d.stocksLots, cfdLots: d.cfdLots },
              display: fmtNum(d.lots, 2),
            })),
          )}`;
}

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
const RPT_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const RPT = {
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
const TONES = {
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
function pctOf(part, whole) {
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
function rptSectionTitle(title, subtitle = "") {
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
function rptCard({ label, value, unit = "", note = "", tone = "plain" }) {
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
function rptHero({ label, value, note, left, right }) {
  const mini = (m) => {
    const t = TONES[m.tone] || TONES.plain;
    return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${t.bg};border:1px solid ${t.bd};border-radius:12px;height:100%">
        <tr><td style="padding:13px 14px">
          <div style="font:700 9.5px/1.4 ${RPT_FONT};letter-spacing:.09em;text-transform:uppercase;color:${RPT.muted}">${escapeHtml(m.label)}</div>
          <div style="font:800 19px/1.2 ${RPT_FONT};color:${t.fg};margin-top:5px;white-space:nowrap;letter-spacing:-.4px">${m.value}</div>
          <div style="font:400 10px/1.4 ${RPT_FONT};color:${RPT.muted};margin-top:6px">${escapeHtml(m.note)}</div>
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
          <div style="font:700 10px/1.4 ${RPT_FONT};letter-spacing:.1em;text-transform:uppercase;color:${RPT.accent}">${escapeHtml(label)}</div>
          <div style="font:800 30px/1.05 ${RPT_FONT};color:#ffffff;margin-top:6px;white-space:nowrap;letter-spacing:-1px">${value}</div>
          <div style="font:400 10.5px/1.45 ${RPT_FONT};color:#94a3b8;margin-top:8px">${escapeHtml(note)}</div>
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
function rptCardGrid(cards, perRow = 3) {
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

export function buildEmailHtml({ fromYmd, toYmd, rows, volume, volumeStats = null, volumeDetail = null, revenueStats = null, mt5Volume = null, charts = null, chartError = null, ibNotice = null, periodNoun = "week", cadence = "weekly" }) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.lots += Number(row.lots) || 0;
      acc.markup += Number(row.markup) || 0;
      acc.clientComm += Number(row.clientComm) || 0;
      acc.swap += Number(row.swap) || 0;
      acc.lpComm += Number(row.lpComm) || 0;
      acc.rebateWithdrawn += Number(row.rebateWithdrawn) || 0;
      acc.totalRev += Number(row.totalRev) || 0;
      acc.netRev += Number(row.netRev) || 0;
      return acc;
    },
    { lots: 0, markup: 0, clientComm: 0, swap: 0, lpComm: 0, rebateWithdrawn: 0, totalRev: 0, netRev: 0 },
  );

  const bodyRows = rows
    .map(
      (row) => `<tr>
        ${dataCell("Client", escapeHtml(row.name || "(unnamed)"))}
        ${dataCell("Accounts", escapeHtml(row.accounts.join(", ")))}
        ${dataCell("Lots", fmtNum(row.lots, 2), { align: "right" })}
        ${dataCell("Markup", money(row.markup), { align: "right" })}
        ${dataCell("Client Comm", money(row.clientComm), { align: "right" })}
        ${dataCell("LP Comm", money(row.lpComm), { align: "right" })}
        ${dataCell("Total Rev", money(row.totalRev), { align: "right", bold: true })}
        ${dataCell("Rebate Withdrawn", money(row.rebateWithdrawn), { align: "right" })}
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
         accounts, several webmail clients). This is the ONLY layout -- Zoho
         strips @media entirely, so there is no desktop breakpoint to switch to;
         see the "Single layout, NO @media" note further down. ── */
      body { margin:0; padding:0; background:#eef1f6; color:#0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
      /* box-sizing on the layout wrappers: without it, width:100% + padding
         overflows the viewport and the whole email scrolls sideways. */
      .outer, .wrap, .header, .content { box-sizing:border-box; }
      .outer { width:100%; background:#eef1f6; padding:8px 4px; }
      /* 980px is what Zoho actually gives the message body; pinning the canvas
         there makes the card-per-row maths deterministic instead of depending
         on the reader's window size. */
      .wrap { width:100%; max-width: 980px; margin: 0 auto; background:#ffffff; border:1px solid #e6eaf1; border-radius:14px; overflow:hidden; }
      .header { padding:22px 24px; background:#0f172a; color:#ffffff;
                border-bottom:3px solid #22d3ee; }
      .header-grid { width:100%; border-collapse:collapse; }
      .header-grid td { display:block; width:100% !important; box-sizing:border-box; }
      .header-left { vertical-align:top; text-align:left; }
      .header-right { vertical-align:top; text-align:left; margin-top:10px; }
      .title { margin:0; font-size:23px; font-weight:800; letter-spacing:-0.4px; line-height:1.2; }
      .header-eyebrow { font-size:10px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:#22d3ee; margin:0 0 6px; }
      /* Scope pills. inline-block so they wrap to as many lines as the width
         needs -- no @media, same constraint as everything else here. */
      .header-pills { margin:12px 0 0; font-size:0; }
      .hpill { display:inline-block; font-size:10px; font-weight:600; color:#cbd5e1;
               background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.14);
               border-radius:20px; padding:3px 9px; margin:0 5px 5px 0; }
      .subtitle { margin:5px 0 0; font-size:11.5px; font-weight:500; color:#94a3b8; }
      .header-meta { margin:0; font-size:11px; line-height:1.55; color:#94a3b8; }
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
      .kpi-note { font-size:12px; color:#334155; margin:8px 0 10px; padding:8px 10px; background:#f8fafc; border:1px solid #e2e8f0; border-left:3px solid #22d3ee; border-radius:8px; }
      /* ── Phone widths: enhancement only, never load-bearing ──────────────
         The px max-width on each .rpt-cell is the real layout and it already
         works without this: when the cap exceeds the viewport, width:100% wins
         and the cells stack one per line. What it cannot do is make a 228px
         card fill a 343px phone, so the deck ends with a ragged right edge.

         This query fixes that where it is honoured. It is deliberately additive
         -- Zoho strips @media entirely (see the "Single layout, NO @media" note
         above, which is why the caps exist at all), and a Zoho reader therefore
         keeps exactly the stacked layout they have today. Apple Mail, the Gmail
         app and Outlook mobile do honour it and get full-width cards. Nothing
         depends on it, so nothing breaks where it is dropped. */
      @media only screen and (max-width: 600px) {
        .rpt-cell { max-width:100% !important; width:100% !important; display:block !important; }
      }
      .section-title { margin:22px 0 10px; font-size:12px; font-weight:700; letter-spacing:0.09em; text-transform:uppercase; color:#0f172a; border-left:3px solid #22d3ee; padding-left:9px; }
      /* The full table needs ~860px to stay legible. table.data thead is hidden
         below, which makes every <th width="..."> here inert -- it survives only
         as inline documentation of each column's intended share. Each <td>
         becomes an inline-block cell capped at max-width:156px instead, so on a
         desktop-width email the cells line up in columns across the row, and on
         a phone they wrap and stack one per line. No @media, no scrolling.
         Numeric cells never wrap. */
      /* Cells flow instead of scrolling. Zoho strips overscroll-behavior and
         touch-action, so a horizontally scrolling table could not be made
         safe on Android -- the swipe chained out and flipped to the next
         email. inline-block cells line up in columns on a wide screen and
         stack on a phone, with no media query. See reportShared.js. */
      .tscroll { width:100%; overflow-x:auto; margin:0 0 16px; }
      table.data { border-collapse:collapse; width:100%; font-size:12px; }
      table.data.narrow { font-size:11px; }
      table.data thead { display:none; }
      table.data tbody tr { display:block; box-sizing:border-box; border-bottom:1px solid #e6eaf1; padding:4px 0; }
      table.data tbody tr:nth-child(even) { background:#f8fafc; }
      table.data tr.total-row { background:#0f172a; }
      table.data tr.total-row td { font-weight:700; color:#ffffff; }
      table.data tr.total-row td .lbl { color:#cbd5e1; }
      table.data tr.total-row td .val, table.data tr.total-row td .money-pos,
      table.data tr.total-row td .money-cost, table.data tr.total-row td .money-neg { color:#ffffff; }
      table.data td, table.data th { display:inline-block; box-sizing:border-box; width:100%; max-width:156px; vertical-align:top; border:0; padding:4px 8px; text-align:left; }
      table.data td .lbl { display:block; font-size:9px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; color:#64748b; }
      table.data td .val { display:block; font-size:12px; }
      table.data td.num .val { white-space:nowrap; }
      table.data td.key .val { white-space:nowrap; }

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
        ${/* Header rebuilt as a single stacked block, not a two-column grid.
              The old left/right split put the scope lines BEFORE the title in
              source order, so on a phone -- where header-grid's cells are
              already forced to display:block -- the first thing in the email
              was three lines of grey filter text and the title came second.
              One column reads the same at every width and needs no cells. */ ""}
        <div class="header">
          <div class="header-eyebrow">Management Reporting &middot; Deal Match</div>
          <h1 class="title">${CADENCES[cadence].subjectWord} Deal Performance Summary</h1>
          <div class="subtitle">${escapeHtml(fromYmd)}${fromYmd === toYmd ? "" : ` &rarr; ${escapeHtml(toYmd)}`} &middot; UTC</div>
          ${/* Scope as pills rather than three lines of prose: it is reference
                detail, read once, and it should not out-weigh the title. */ ""}
          <div class="header-pills">
            <span class="hpill">All groups &middot; all symbols</span>
            <span class="hpill">Accounts with lots &gt; 0</span>
            <span class="hpill">${fmtNum(rows.length, 0)} active client${rows.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div class="content">
          ${
            revenueStats
              ? rptHero({
                    label: "Total Net Revenue",
                    value: money(revenueStats.netRevenue),
                    note: "Gross revenue less LP commission — what the book actually kept.",
                    left: {
                      label: "Gross Revenue", value: money(revenueStats.grossRevenue),
                      tone: "cy", note: "Before LP cost",
                    },
                    right: {
                      label: "LP Commission",
                      value: `−${money(revenueStats.lpCommission).replace("-", "")}`,
                      tone: "ro",
                      // A cost is only judgeable against what it was paid out of.
                      note: `${pctOf(revenueStats.lpCommission, revenueStats.grossRevenue)} of gross`,
                    },
                  })
                + rptSectionTitle("Revenue build-up", "how gross was earned, before cost — from DealMatch/Run, the figures the Deal Match Analysis tab shows")
                + rptCardGrid(
                    [
                      { label: "Markup Revenue", value: money(revenueStats.markupRevenue), tone: "em",
                        note: `Spread revenue on client flow — ${pctOf(revenueStats.markupRevenue, revenueStats.grossRevenue)} of gross.` },
                      { label: "Commission Revenue", value: money(revenueStats.commissionRevenue), tone: "am",
                        note: `Commission charged to clients — ${pctOf(revenueStats.commissionRevenue, revenueStats.grossRevenue)} of gross.` },
                    ],
                    2,
                  )
              : `<table class="kpis" role="presentation">
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
          </table>`
          }

          ${
            volumeDetail
              ? rptSectionTitle("MT5 client volume", "lots — “deals” count both legs of a round trip, “realized” counts it once")
                + rptCardGrid(
                    [
                      { label: "Total MT5 Deals", value: fmtNum(volumeDetail.totalMt5Deals, 2), unit: "lots", tone: "em",
                        note: "Client deal lots plus shifting deal lots." },
                      { label: "Client Deals", value: fmtNum(volumeDetail.clientDeals, 2), unit: "lots", tone: "em",
                        note: "MT5 client deal lots, each leg counted." },
                      { label: "Realized — CFD", value: fmtNum(volumeDetail.realizedCfd, 2), unit: "lots", tone: "cy",
                        note: "Closed CFD volume, once per round trip." },
                      { label: "Realized — Equity", value: fmtNum(volumeDetail.realizedEquity, 2), unit: "lots", tone: "cy",
                        note: "Closed equity volume. Share-based, so it dwarfs CFD." },
                      { label: "Shifting Deals", value: fmtNum(volumeDetail.shiftingDeals, 2), unit: "lots", tone: "am",
                        note: "Shifting-account deal lots. Already inside Total MT5 Deals." },
                      { label: "Shifting Realized", value: fmtNum(volumeDetail.shiftingRealized, 2), unit: "lots", tone: "am",
                        note: "The closed volume behind those shifting deals." },
                      { label: "Internal Deals", value: fmtNum(volumeDetail.internalDeals, 2), unit: "lots", tone: "in",
                        note: "Internal-account deal lots. A separate bucket, not client flow." },
                      { label: "Internal Realized", value: fmtNum(volumeDetail.internalRealized, 2), unit: "lots", tone: "in",
                        note: "The closed internal-account volume." },
                    ],
                    4,
                  )
                + rptSectionTitle("Bridge / matched", "lots reaching the bridge, and the share matched to an LP order")
                + rptCardGrid(
                    [
                      // The share is what the dropped MT5 Volume Flow funnel
                      // contributed that a raw figure does not: 529 lots means
                      // nothing until you know it is 0.07% of the flow.
                      { label: "Bridge Lots", value: fmtNum(volumeDetail.bridgeLots, 2), unit: "lots", tone: "am",
                        note: `Reached the bridge — ${pctOf(volumeDetail.bridgeLots, volumeDetail.totalMt5Deals)} of total MT5 deals.` },
                      { label: "Matched Lots", value: fmtNum(volumeDetail.matchedLots, 2), unit: "lots", tone: "em",
                        note: `Matched to an LP order — ${pctOf(volumeDetail.matchedLots, volumeDetail.bridgeLots)} of bridge lots.` },
                      { label: "Active Clients", value: fmtNum(rows.length, 0),
                        note: "Accounts with lots > 0 in this period — the rows in the table below." },
                    ],
                    3,
                  )
              : ""
          }

          <div class="kpi-note">
            Top Net Revenue Client:
            <strong>${topClient ? `${escapeHtml(topClient.name || "(unnamed)")}${topClient.accounts.length ? ` (${escapeHtml(topClient.accounts.join(", "))})` : ""}` : "-"}</strong>
            ${topClient ? `| ${money(topClient.netRev)}` : ""}
          </div>

          ${buildVolumeSection(volume, charts, volumeStats, periodNoun)}

          ${/* The shared volume-flow section is deliberately NOT rendered here.
                Its flow rows (total deals / bridge / matched) and its
                client-shifting-internal breakdown are both printed by the card
                deck at the top of this report, which reads the same DealMatch
                scalars, so rendering it too put the same figures on screen
                three times. The coverage percentages it added now ride on the
                Bridge / Matched cards. Same reasoning monthlyReview.js records
                for not calling it. The section itself is unchanged and still
                used by dailyDigest.js and slippageWeeklyReport.js.
                Kept as a JS comment, not an HTML one: an HTML comment ships
                inside every email for no reader's benefit. */ ""}

          <p class="section-title" style="margin-top:18px;">Client revenue<span style="font-weight:500;letter-spacing:0;text-transform:none;color:#64748b;font-size:11px;"> &mdash; per client, net of that client's own withdrawn rebate</span></p>
          ${
            revenueStats
              ? `<p style="font-size:11px;color:#64748b;margin:0 0 10px;">
            This table answers a different question from the Revenue cards above and its
            TOTAL will not match them. The cards are whole-run totals for the book; these
            rows cover only clients with <strong>Lots &gt; 0</strong> and each is reduced by
            that client's withdrawn rebate. Use the cards for the book, this table for who
            earned it.
          </p>`
              : ""
          }
          <div class="tscroll">
          <table class="data">
            <thead>
              <tr>
                <th width="22%">Client</th>
                <th width="14%">Accounts</th>
                <th width="8%">Lots</th>
                <th width="9%">Markup</th>
                <th width="10%">Client Comm</th>
                <th width="8%">LP Comm</th>
                <th width="9%">Total Rev</th>
                <th width="10%">Rebate Withdrawn</th>
                <th width="10%">Net Revenue</th>
              </tr>
            </thead>
            <tbody>
              <tr class="total-row">
                ${/* "LISTED CLIENTS", not "TOTAL": this sums only the rows below
                      it, and a reader who sees "TOTAL" next to a figure that
                      disagrees with the Revenue cards concludes one of them is
                      broken. Naming the scope is what makes both honest. */ ""}
                ${spanCell("TOTAL (listed clients)", { colspan: 2 })}
                ${dataCell("Lots", fmtNum(totals.lots, 2), { align: "right" })}
                ${dataCell("Markup", money(totals.markup), { align: "right", cls: "money-pos" })}
                ${dataCell("Client Comm", money(totals.clientComm), { align: "right", cls: "money-pos" })}
                ${dataCell("LP Comm", money(totals.lpComm), { align: "right", cls: "money-cost" })}
                ${dataCell("Total Rev", money(totals.totalRev), { align: "right", cls: "money-pos" })}
                ${dataCell("Rebate Withdrawn", money(totals.rebateWithdrawn), { align: "right", cls: "money-cost" })}
                ${dataCell("Net Revenue", money(totals.netRev), { align: "right", cls: totals.netRev < 0 ? "money-neg" : "money-pos" })}
              </tr>
              ${bodyRows || `<tr>${spanCell(`No rows with Lots &gt; 0 for this ${periodNoun}.`, { colspan: 9, align: "center" })}</tr>`}
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
                label: `${String(r.name || r.accounts?.[0] || "").slice(0, 18)}`.trim(),
                value: r.netRev,
                display: money(r.netRev),
                color: (Number(r.netRev) || 0) < 0 ? CH.loss : CH.net,
              })),
          )}

          ${charts ? chartImg(charts, "gross-vs-net.png", "Gross versus net revenue by client") : buildGroupedChart(
            "Gross vs Net Revenue",
            "top 10 by total revenue &mdash; the gap is Rebate Withdrawn",
            [
              { key: "totalRev", label: "Gross", color: CH.gross },
              { key: "netRev", label: "Net", color: CH.net },
            ],
            [...rows]
              .sort((a, b) => (Number(b.totalRev) || 0) - (Number(a.totalRev) || 0))
              .slice(0, 10)
              .map((r) => ({
                label: String(r.name || r.accounts[0] || "").slice(0, 18),
                values: { totalRev: r.totalRev, netRev: r.netRev },
                displays: { totalRev: money(r.totalRev), netRev: money(r.netRev) },
              })),
          )}

          ${charts ? chartImg(charts, "lots-vs-net-by-client.png", "Lots versus net revenue by client") : buildGroupedChart(
            "Lots vs Net Revenue by Client",
            "top 12 by volume &mdash; each series on its own scale, so compare shapes not lengths",
            [
              { key: "lots", label: "Lots", color: CH.equity },
              { key: "netRev", label: "Net rev", color: CH.net },
            ],
            [...rows]
              .sort((a, b) => (Number(b.lots) || 0) - (Number(a.lots) || 0))
              .slice(0, 12)
              .map((r) => ({
                label: String(r.name || r.accounts[0] || "").slice(0, 18),
                values: { lots: r.lots, netRev: r.netRev },
                displays: { lots: fmtNum(r.lots, 2), netRev: money(r.netRev) },
              })),
            { scale: "per-series" },
          )}

          ${charts ? chartImg(charts, "revenue-composition.png", "Revenue composition doughnut") : buildCompositionChart(
            "Revenue Composition",
            `share of gross revenue (${money(totals.markup + totals.clientComm + totals.swap)} earned before costs)`,
            [
              { label: "Markup", value: totals.markup, display: money(totals.markup), color: CH.markup },
              { label: "Client Comm", value: totals.clientComm, display: money(totals.clientComm), color: CH.clientComm },
              { label: "Swap Revenue", value: totals.swap, display: money(totals.swap), color: CH.swap },
              { label: "LP Comm", value: totals.lpComm, display: money(totals.lpComm), color: CH.lpComm },
              { label: "Rebate Withdrawn", value: totals.rebateWithdrawn, display: money(totals.rebateWithdrawn), color: CH.ibComm },
              { label: "Net Revenue", value: totals.netRev, display: money(totals.netRev), color: CH.net },
            ],
            totals.markup + totals.clientComm + totals.swap,
          )}
          <div class="foot">
            Automated report generated by Deal Matching pipeline.<br/>
            Formula: Total Revenue = (Markup + Client Comm + Swap Revenue) - LP Comm, as returned by DealMatch/Run; Net Revenue = Total Revenue - Rebate Withdrawn<br/>
            Rebate Withdrawn is the approved IB transfers and withdrawals <em>settled inside this ${periodNoun}</em>, looked up once per client. It is money that left the IB wallet during the ${periodNoun} and may have been earned earlier, so it is a cash figure rather than earnings. The running IB wallet balance is not included.<br/>
            ${ibNotice ? `<strong>Check:</strong> ${escapeHtml(ibNotice)}<br/>` : ""}
            ${chartError ? `Chart images unavailable: ${escapeHtml(chartError)} &mdash; showing built-in bar charts instead.<br/>` : ""}
            Traded Lots (realized) come from ClientVolume/Run &mdash; the dashboard's Dealing (LP) volume tile. Total Lots (deals) count every MT5 deal, so a round trip appears twice; realized equity + CFD reconciles the two.
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}


export async function runDealMatchEmailReport({ cadence = "weekly", fromDate, toDate, recipients: recipientsOverride } = {}) {
  const spec = CADENCES[cadence];
  if (!spec) throw new Error(`Unknown cadence "${cadence}"`);
  const label = `DealMatch${cadence[0].toUpperCase()}${cadence.slice(1)}`;

  const period = fromDate && toDate ? { start: fromDate, end: toDate } : spec.period();
  const { from, to } = toUnixRange(period.start, period.end);
  const params = new URLSearchParams({
    group: "*",
    from: String(from),
    to: String(to),
    symbol: "",
    // Summary mode. Carries clientRevenueSummaries + all the total* scalars; the
    // full match arrays (~45 MB for a month) are not read by this report.
    lite: "true",
  });

  const resp = await backendFetch(`/DealMatch/Run?${params.toString()}`, {
    timeoutMs: DEALMATCH_RUN_TIMEOUT_MS,
  });
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

  /**
   * The figures the Deal Match Analysis tab puts on screen, read from the SAME
   * scalars that tab reads (DealMatchingTab.tsx:1306-1310) rather than
   * recomputed here.
   *
   * This exists because the email and the tab disagreed, and the email was
   * wrong. Its KPI cards were built by summing the per-client revenue rows --
   * which are filtered to `lots > 0` a few lines below and then reduced again
   * by each client's withdrawn rebate. For 2026-09-24 that produced a Total
   * Revenue of $389.74 against the tab's $10,256.24 gross / $8,387.97 net, and
   * management reasonably read the email as broken.
   *
   * These are whole-run totals straight off the response, so they are immune to
   * that filtering and to any per-client rebate lookup failing. The per-client
   * table below still uses the row-derived numbers -- it is a different
   * question ("who earned it", net of their rebate) and both belong in the
   * report, as long as the headline matches the tab.
   *
   * Net is computed as gross - |LP commission|, exactly as the tab does it, and
   * deliberately NOT read from a server net field -- see the note at
   * DealMatchingTab.tsx:618.
   */
  const grossRevenue = n(report?.totalGrossRevenueUsd);
  const lpCommission = Math.abs(n(report?.totalLpCommissionAllocated));
  const revenueStats = {
    markupRevenue: n(report?.totalSpreadRevenueUsd),
    commissionRevenue: n(report?.totalClientCommission),
    grossRevenue,
    lpCommission,
    netRevenue: grossRevenue - lpCommission,
  };

  // The volume tiles the tab shows, same source. dealLots/realized*/bridge/
  // matched already live on volumeStats above; these are the ones the email
  // had no equivalent for at all.
  const volumeDetail = {
    totalMt5Deals: n(report?.totalMt5DealLots) + n(report?.totalShiftingMt5DealLots),
    clientDeals: n(report?.totalMt5DealLots),
    realizedCfd: n(report?.totalRealizedLotsCfd),
    realizedEquity: n(report?.totalRealizedLotsEquity),
    shiftingDeals: n(report?.totalShiftingMt5DealLots),
    shiftingRealized: n(report?.totalShiftingRealizedLots),
    internalDeals: n(report?.totalInternalAccountLots),
    internalRealized: n(report?.totalInternalAccountRealizedLots),
    bridgeLots: n(report?.totalBridgeLots),
    matchedLots: n(report?.totalMatchedLots),
  };
  // The volume funnel reads the SAME response, deliberately. A second
  // DealMatch/Run here would cost another ~40 seconds for a payload already in
  // hand.
  const mt5Volume = extractVolume(report);
  const baseRows = deriveClientRevenueRows(report)
    .filter((row) => (Number(row.lots) || 0) > 0)
    .sort((a, b) => (Number(b.lots) || 0) - (Number(a.lots) || 0));

  const { rows, unresolved, rebateResult } = await buildClientRows(baseRows, period);

  const fromYmd = toYmdUtc(period.start);
  const toYmd = toYmdUtc(period.end);
  // Explicit recipients (e.g. the on-demand test button) take precedence over the configured list.
  // An explicit recipient list means the on-demand test button, which must
  // always send. Everything else is the cron or a RUN_ON_START boot, and a
  // window that already went out must not go again -- an app pool that
  // recycles nightly would otherwise mail this every morning.
  const isScheduledRun = !(Array.isArray(recipientsOverride) && recipientsOverride.length);

  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : resolveRecipients(DEALMATCH_RECIPIENT_VARS[cadence]);
  if (!recipients.length) {
    console.warn(`[${label}] No recipients configured. Skipping.`);
    return { ok: false, reason: "no-recipients", rows: rows.length, fromYmd, toYmd };
  }

  // Same window, already sent: this is a restart, not a new period.
  const windowKey = spec.windowKey(fromYmd, toYmd);
  if (isScheduledRun && (await alreadySentFor(DEALMATCH_GUARD_KEYS[cadence], windowKey))) {
    console.log(`[${label}] ${windowKey} already sent; skipping (restart, not a new ${spec.noun}).`);
    return { ok: false, reason: "already-sent", fromYmd, toYmd };
  }
  // Volume is supplementary — a ClientVolume outage must not block the revenue
  // report, so fall back to rendering the section as unavailable.
  let volume = null;
  try {
    volume = await fetchClientVolume(fromYmd, toYmd);
  } catch (error) {
    console.warn(`[${label}] client volume lookup failed:`, error?.message || error);
  }

  // Charts render to PNG and travel inside the message, referenced by cid:. If
  // rendering is unavailable (chartjs-node-canvas needs a native canvas build),
  // fall back to the HTML bar charts rather than shipping broken images.
  const totalsForCharts = rows.reduce(
    (acc, row) => {
      acc.markup += Number(row.markup) || 0;
      acc.clientComm += Number(row.clientComm) || 0;
      acc.swap += Number(row.swap) || 0;
      acc.lpComm += Number(row.lpComm) || 0;
      acc.rebateWithdrawn += Number(row.rebateWithdrawn) || 0;
      acc.netRev += Number(row.netRev) || 0;
      return acc;
    },
    { markup: 0, clientComm: 0, swap: 0, lpComm: 0, rebateWithdrawn: 0, netRev: 0 },
  );

  let chartUrls = null;
  let chartError = null;
  try {
    const images = await buildChartImages(rows, volume, totalsForCharts, `(${fromYmd} to ${toYmd})`);
    const published = await publishChartImages(images);
    chartUrls = published.urls;
    console.log(`[${label}] published ${images.length} charts to ${published.dir}`);
  } catch (error) {
    chartError = `${error?.code ? `${error.code}: ` : ""}${error?.message || String(error)}`;
    console.warn(`[${label}] chart rendering failed, using HTML fallback:`, chartError);
  }

  const subject = dealMatchSubject(cadence, fromYmd, toYmd);
  // A zero rebate understates the cost and so overstates Net Revenue; an
  // unresolved login cannot be grouped. Both are named rather than left to look
  // like ordinary rows.
  const noticeParts = [];
  if (rebateResult.failed) {
    noticeParts.push(`rebate could not be read for ${rebateResult.failed} of ${rebateResult.clients} client(s), so their Net Revenue is overstated`);
  }
  if (unresolved) {
    noticeParts.push(`${unresolved} login(s) could not be matched to a CRM client and appear as their own rows`);
  }
  const ibNotice = noticeParts.length ? noticeParts.join("; ") : null;
  const html = buildEmailHtml({ fromYmd, toYmd, rows, volume, volumeStats, volumeDetail, revenueStats, mt5Volume, charts: chartUrls, chartError, ibNotice, periodNoun: spec.noun, cadence });
  // Charts are referenced by URL and rendered in the body — no attachments.
  await sendBrevoEmail({ subject, html, recipients });

  if (isScheduledRun) await recordSentFor(DEALMATCH_GUARD_KEYS[cadence], windowKey);

  console.log(`[${label}] Sent to ${recipients.join(", ")} | rows=${rows.length} | period=${fromYmd}..${toYmd}`);
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

  const resp = await backendFetch(`/DealMatch/Run?${params.toString()}`, {
    timeoutMs: DEALMATCH_RUN_TIMEOUT_MS,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DealMatch/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const report = await resp.json();
  const baseRows = deriveClientRevenueRows(report)
    .filter((row) => (Number(row.lots) || 0) > 0)
    .sort((a, b) => (Number(b.lots) || 0) - (Number(a.lots) || 0));

  const { rows: enriched, unresolved, rebateResult } = await buildClientRows(baseRows, week);

  const hardLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 100;
  const rows = enriched.slice(0, hardLimit);
  return {
    fromYmd: toYmdUtc(week.start),
    toYmd: toYmdUtc(week.end),
    rows,
    totalAvailable: enriched.length,
    unresolved,
    rebateResult,
  };
}
