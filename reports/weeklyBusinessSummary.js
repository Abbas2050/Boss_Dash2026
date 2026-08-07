import cron from "node-cron";
import {
  BACKEND_BASE_URL,
  toYmdUtc,
  toUnixRange,
  parseRecipients,
  previousFullWeekUtc,
  fmtNum,
  money,
  escapeHtml,
  sendBrevoEmail,
  renderChartBuffer,
  publishChartImages,
  crmPost,
  crmConfigured,
  emailShell,
  kpiGrid,
  dataTable,
  dataCell,
  spanCell,
} from "./reportShared.js";

// Weekly Business Summary — money movement and account activity, with a glance
// strip that also carries the trading headline. Design:
// docs/superpowers/specs/2026-08-07-weekly-business-summary-design.md
//
// Sent AFTER Deal Match (20:00) and Slippage (20:30) so the glance is never
// computed before the reports it summarises.
const DEFAULT_SCHEDULE = "45 20 * * 5";
const DEFAULT_TIMEZONE = "Asia/Dubai";

const LARGE_DEPOSIT_THRESHOLD = Number(process.env.SUMMARY_LARGE_DEPOSIT_THRESHOLD || 1000);
const TX_STATUSES = parseRecipients(process.env.SUMMARY_TX_STATUSES || "approved");

const num = (v) => Number(v) || 0;

// ── transaction classification ──────────────────────────────────────────────
// The CRM doc enumerates withdrawal types (withdrawal / ib withdrawal /
// cashback withdrawal) but no deposit types, and the live system already uses
// at least one type absent from the doc ("ib transfer to account"). Matching on
// the word therefore beats an allow-list, which would silently drop money.
export function isWithdrawal(type) {
  return String(type || "").toLowerCase().includes("withdrawal");
}

// Direction comes from the type, never from the sign. A signed-negative amount
// is what previously made Net Revenue exceed Total Revenue in the Deal Match
// report, so take magnitudes here.
export function txAmount(row) {
  const processed = Number(row?.processedAmount);
  const requested = Number(row?.requestedAmount);
  const value = Number.isFinite(processed) && processed !== 0 ? processed : requested;
  return Math.abs(Number.isFinite(value) ? value : 0);
}

// IB commission leaves the company as "ib transfer to account" (IB wallet into
// their trading account) or "ib withdrawal" (IB wallet out to their bank).
// Matching the leading "ib" covers both without an allow-list that would go
// stale the way the doc's type list already has.
export function isIbMovement(type) {
  const t = String(type || "").trim().toLowerCase();
  return t === "ib" || t.startsWith("ib ");
}

const txPsp = (row) => String(row?.psp || "").trim() || "Unattributed";
const txLogin = (row) => String(row?.fromLoginSid || row?.fromUserId || "").trim();

// ── aggregation ─────────────────────────────────────────────────────────────

export function aggregate(transactions) {
  const byPsp = new Map();
  const byAccount = new Map();
  const byDay = new Map();
  const typesSeen = new Set();
  let deposits = 0;
  let withdrawals = 0;
  let ibRebate = 0;
  const currencies = new Set();

  for (const row of transactions) {
    const amount = txAmount(row);
    const out = isWithdrawal(row?.type);
    const psp = txPsp(row);
    const login = txLogin(row);
    const day = String(row?.processedAt || "").slice(0, 10);
    typesSeen.add(String(row?.type || "unknown"));
    if (row?.processedCurrency) currencies.add(String(row.processedCurrency));

    // IB commission is its own bucket, kept OUT of deposits/withdrawals. It has
    // to be: the per-account Net subtracts the rebate, and an "ib withdrawal"
    // counted in both Withdrawals and IB Rebate would be deducted twice.
    const isIb = isIbMovement(row?.type);

    if (isIb) ibRebate += amount;
    else if (out) withdrawals += amount;
    else deposits += amount;

    if (!byPsp.has(psp)) byPsp.set(psp, { psp, deposits: 0, withdrawals: 0, ibRebate: 0, count: 0 });
    const p = byPsp.get(psp);
    p.count += 1;
    if (isIb) p.ibRebate += amount;
    else if (out) p.withdrawals += amount;
    else p.deposits += amount;

    if (login) {
      if (!byAccount.has(login)) {
        byAccount.set(login, { login, name: String(row?.name || ""), deposits: 0, withdrawals: 0, ibRebate: 0, depositCount: 0, psps: new Set(), lastDate: "" });
      }
      const a = byAccount.get(login);
      if (!a.name && row?.name) a.name = String(row.name);
      if (isIb) {
        a.ibRebate += amount;
      } else if (out) {
        a.withdrawals += amount;
      } else {
        a.deposits += amount;
        a.depositCount += 1;
        a.psps.add(psp);
        if (day > a.lastDate) a.lastDate = day;
      }
    }

    if (day) {
      if (!byDay.has(day)) byDay.set(day, { day, deposits: 0, withdrawals: 0, ibRebate: 0 });
      const d = byDay.get(day);
      if (isIb) d.ibRebate += amount;
      else if (out) d.withdrawals += amount;
      else d.deposits += amount;
    }
  }

  // Every account that deposited during the week. Deliberately NOT a
  // first-time-deposit list: the CRM's userFtd flag is documented only as
  // "Transaction list by first time deposit", which reads two ways, and an
  // account wrongly labelled "new" is read as fact. Counting the week as it
  // happened needs no such inference.
  // IB accounts are included even with no client deposit, so the rebate is
  // never invisible just because that account only received commission.
  const depositors = [...byAccount.values()]
    .filter((a) => a.deposits > 0 || a.ibRebate > 0)
    .map((a) => ({
      login: a.login,
      name: a.name,
      deposits: a.deposits,
      withdrawals: a.withdrawals,
      ibRebate: a.ibRebate,
      net: a.deposits - a.withdrawals - a.ibRebate,
      depositCount: a.depositCount,
      psps: [...a.psps].sort().join(", "),
      lastDate: a.lastDate,
    }))
    .sort((a, b) => b.deposits - a.deposits || b.ibRebate - a.ibRebate);

  const largeDepositors = depositors.filter((a) => a.deposits > LARGE_DEPOSIT_THRESHOLD);

  return {
    deposits,
    withdrawals,
    // Deposits and Withdrawals are CLIENT money; IB commission is held apart so
    // the chain Deposits - Withdrawals - IB Rebate = Net holds at every level.
    netFlow: deposits - withdrawals - ibRebate,
    ibRebate,
    txCount: transactions.length,
    byPsp: [...byPsp.values()]
      .map((p) => ({ ...p, net: p.deposits - p.withdrawals - p.ibRebate }))
      .sort((a, b) => b.net - a.net),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    depositors,
    largeDepositors,
    typesSeen: [...typesSeen].sort(),
    currencies: [...currencies],
  };
}

// ── data fetching ───────────────────────────────────────────────────────────

const TX_SEGMENT_LIMIT = 5000;

async function fetchTransactions(fromYmd, toYmd) {
  return crmPost("transactions", {
    processedAt: { begin: `${fromYmd} 00:00:00`, end: `${toYmd} 23:59:59` },
    statuses: TX_STATUSES,
    segment: { limit: TX_SEGMENT_LIMIT, offset: 0 },
  });
}

// Each glance figure is fetched independently: one source being down renders
// that tile as a dash rather than losing the whole report.
async function fetchGlance(week, fromYmd, toYmd) {
  const glance = { totalRevenue: null, tradedLots: null, lpSlippage: null };
  const { from, to } = toUnixRange(week.start, week.end);

  try {
    const params = new URLSearchParams({ group: "*", from: String(from), to: String(to), symbol: "", lite: "true" });
    const resp = await fetch(`${BACKEND_BASE_URL}/DealMatch/Run?${params}`, { signal: AbortSignal.timeout(45_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const report = await resp.json();
    const rows = Array.isArray(report?.clientRevenueSummaries) ? report.clientRevenueSummaries : [];
    // Same maths as the Deal Match report: LP commission is a cost, so take its
    // magnitude. Net is gross minus IB commission, which that report computes
    // from live CRM balances — see the caveat in the footer.
    glance.totalRevenue = rows.reduce(
      (sum, r) => sum + num(r.markupRevenueUsd) + num(r.clientCommissionUsd) - Math.abs(num(r.lpCommissionUsd)),
      0,
    );
  } catch (error) {
    console.warn("[WeeklySummary] DealMatch lookup failed:", error?.message || error);
  }

  try {
    const params = new URLSearchParams({ from: fromYmd, to: toYmd, group: "*" });
    const resp = await fetch(`${BACKEND_BASE_URL}/ClientVolume/Run?${params}`, { signal: AbortSignal.timeout(45_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    glance.tradedLots = num(raw?.totalLots);
  } catch (error) {
    console.warn("[WeeklySummary] ClientVolume lookup failed:", error?.message || error);
  }

  try {
    const params = new URLSearchParams({ from: fromYmd, to: toYmd, group: "*" });
    const resp = await fetch(`${BACKEND_BASE_URL}/SlippageReport/Run?${params}`, { signal: AbortSignal.timeout(45_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    const rows = Array.isArray(raw?.rows) ? raw.rows : [];
    glance.lpSlippage = rows.reduce((sum, r) => sum + num(r.lpPlImpact), 0);
  } catch (error) {
    console.warn("[WeeklySummary] SlippageReport lookup failed:", error?.message || error);
  }

  return glance;
}

// ── chart ───────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDayLabel(ymd) {
  const parts = String(ymd || "").split("-");
  if (parts.length !== 3) return String(ymd || "");
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  if (Number.isNaN(date.getTime())) return String(ymd);
  return `${DAY_NAMES[date.getUTCDay()]} ${parts[2]} ${MONTH_NAMES[Number(parts[1]) - 1]}`;
}

const shortMoney = (v) => {
  const n = Math.abs(Number(v) || 0);
  return n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${n.toFixed(0)}`;
};

async function buildDailyChart(byDay, titleSuffix) {
  if (!byDay.length) return [];
  const config = {
    type: "bar",
    data: {
      labels: byDay.map((d) => fmtDayLabel(d.day)),
      datasets: [
        { label: "Deposits", data: byDay.map((d) => d.deposits), backgroundColor: "#15803d", borderRadius: 4 },
        { label: "Withdrawals", data: byDay.map((d) => d.withdrawals), backgroundColor: "#b45309", borderRadius: 4 },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: { top: 22 } },
      scales: {
        x: { ticks: { color: "#334155" }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#334155", callback: (v) => shortMoney(v) }, grid: { color: "#e2e8f0" } },
      },
      plugins: {
        legend: { labels: { color: "#334155", font: { size: 12 } } },
        title: { display: true, text: `Daily Money Movement ${titleSuffix}`, color: "#0f172a", font: { size: 18, weight: "700" } },
      },
    },
    // Values drawn on the bars — chartjs-plugin-datalabels is not a dependency.
    plugins: [
      {
        id: "valueLabels",
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          ctx.save();
          ctx.font = "bold 11px Arial";
          ctx.fillStyle = "#0f172a";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          chart.data.datasets.forEach((ds, di) => {
            chart.getDatasetMeta(di).data.forEach((el, i) => {
              const v = Number(ds.data[i]) || 0;
              if (v > 0) ctx.fillText(shortMoney(v), el.x, el.y - 4);
            });
          });
          ctx.restore();
        },
      },
    ],
  };
  const buffer = await renderChartBuffer(config, 1100, 620);
  return [{ name: "daily-money-movement.png", buffer }];
}

// ── email ───────────────────────────────────────────────────────────────────

const ACCOUNT_HEADERS = [
  { label: "Login", width: "14%" },
  { label: "Name", width: "30%" },
  { label: "Deposits", width: "14%" },
  { label: "Withdrawals", width: "14%" },
  { label: "IB Rebate", width: "14%" },
  { label: "Net", width: "14%" },
];

const dash = "&mdash;";
const orDash = (value, fmt) => (value === null || value === undefined ? dash : fmt(value));
const signCls = (v) => (num(v) > 0 ? "pos" : num(v) < 0 ? "neg" : "");

export function buildSummaryEmailHtml({ fromYmd, toYmd, agg, glance, chartUrl = null, notices = [] }) {
  const netRevenue = glance.totalRevenue === null || glance.totalRevenue === undefined
    ? null
    : glance.totalRevenue - agg.ibRebate;

  // Deposits | Withdrawals | IB Rebate | Net — the same chain at every level of
  // the report, so any row can be checked by eye.
  const flowCells = (d, net) =>
    dataCell("Deposits", money(d.deposits), { align: "right", cls: "pos" }) +
    dataCell("Withdrawals", money(d.withdrawals), { align: "right", cls: "cost" }) +
    dataCell("IB Rebate", money(d.ibRebate), { align: "right", cls: num(d.ibRebate) > 0 ? "cost" : "" }) +
    dataCell("Net", money(net), { align: "right", bold: true, cls: signCls(net) });

  const glanceCards = kpiGrid([
    { label: "Net Flow", value: money(agg.netFlow), cls: signCls(agg.netFlow) },
    { label: "Deposits", value: money(agg.deposits), cls: "pos" },
    { label: "Withdrawals", value: money(agg.withdrawals), cls: "cost" },
    { label: "Active Accounts", value: fmtNum(agg.depositors.length, 0), note: "deposited or received rebate" },
    { label: "Total Revenue", value: orDash(glance.totalRevenue, money) },
    { label: "IB Rebate", value: money(agg.ibRebate), cls: "cost" },
    { label: "Net Revenue", value: orDash(netRevenue, money), cls: signCls(netRevenue), note: "Total Revenue less IB Rebate" },
    { label: "Traded Lots (realized)", value: orDash(glance.tradedLots, (v) => fmtNum(v, 2)) },
    { label: "LP Slippage", value: orDash(glance.lpSlippage, money), cls: signCls(glance.lpSlippage) },
    { label: "Large Depositors", value: fmtNum(agg.largeDepositors.length, 0), note: `over ${money(LARGE_DEPOSIT_THRESHOLD)}` },
  ]);

  const pspTotalRow =
    spanCell("TOTAL") +
    flowCells(agg, agg.netFlow) +
    dataCell("Count", fmtNum(agg.txCount, 0), { align: "right" });

  const pspRows = agg.byPsp
    .map(
      (p) => `<tr>
        ${dataCell("PSP", escapeHtml(p.psp), { nowrap: true })}
        ${flowCells(p, p.net)}
        ${dataCell("Count", fmtNum(p.count, 0), { align: "right" })}
      </tr>`,
    )
    .join("");

  const sumRows = (rows) =>
    rows.reduce(
      (acc, r) => ({
        deposits: acc.deposits + num(r.deposits),
        withdrawals: acc.withdrawals + num(r.withdrawals),
        ibRebate: acc.ibRebate + num(r.ibRebate),
        net: acc.net + num(r.net),
      }),
      { deposits: 0, withdrawals: 0, ibRebate: 0, net: 0 },
    );

  // Deposits | Withdrawals | IB Rebate | Net, the same chain the Deal Match
  // report uses for Total Revenue | IB Commission | Net Revenue.
  const accountRow = (r, { bold = false } = {}) =>
    dataCell("Deposits", money(r.deposits), { align: "right", bold, cls: "pos" }) +
    dataCell("Withdrawals", money(r.withdrawals), { align: "right", cls: "cost" }) +
    dataCell("IB Rebate", money(r.ibRebate), { align: "right", cls: num(r.ibRebate) > 0 ? "cost" : "" }) +
    dataCell("Net", money(r.net), { align: "right", bold: true, cls: signCls(r.net) });

  const depositorTotals = sumRows(agg.depositors);
  const depositorTotalRow =
    spanCell(`TOTAL (${fmtNum(agg.depositors.length, 0)})`, { colspan: 2 }) + accountRow(depositorTotals);

  const largeTotals = sumRows(agg.largeDepositors);
  const largeTotalRow =
    spanCell(`TOTAL (${fmtNum(agg.largeDepositors.length, 0)})`, { colspan: 2 }) + accountRow(largeTotals);

  const dailyTotalRow = spanCell("TOTAL") + flowCells(agg, agg.netFlow);

  const accountRows = (rows) =>
    rows
      .map(
        (r) => `<tr>
        ${dataCell("Login", escapeHtml(r.login), { nowrap: true })}
        ${dataCell("Name", escapeHtml(r.name))}
        ${accountRow(r, { bold: true })}
      </tr>`,
      )
      .join("");

  const depositorRows = accountRows(agg.depositors);
  const largeRows = accountRows(agg.largeDepositors);

  const dailyRows = agg.byDay
    .map(
      (d) => `<tr>
        ${dataCell("Day", escapeHtml(fmtDayLabel(d.day)), { nowrap: true })}
        ${flowCells(d, d.deposits - d.withdrawals - d.ibRebate)}
      </tr>`,
    )
    .join("");

  const body = `
          <p class="section-title" style="margin-top:0;">Last Week at a Glance</p>
          ${glanceCards}

          <p class="section-title">Account Activity</p>
          <p class="note">Every account that moved money during the week, largest deposit first. Net = Deposits &minus; Withdrawals &minus; IB Rebate.</p>
          ${dataTable({
            headers: ACCOUNT_HEADERS,
            totalRow: agg.depositors.length ? depositorTotalRow : "",
            bodyRows: depositorRows,
            emptyText: "No deposits this week.",
          })}

          <p class="section-title">Large Depositors</p>
          <p class="note">The subset above that deposited more than ${money(LARGE_DEPOSIT_THRESHOLD)} this week.</p>
          ${dataTable({
            headers: ACCOUNT_HEADERS,
            totalRow: agg.largeDepositors.length ? largeTotalRow : "",
            bodyRows: largeRows,
            emptyText: `No accounts deposited more than ${money(LARGE_DEPOSIT_THRESHOLD)} this week.`,
          })}

          <p class="section-title">Daily Flow</p>
          ${dataTable({
            headers: [
              { label: "Day", width: "28%" },
              { label: "Deposits", width: "18%" },
              { label: "Withdrawals", width: "18%" },
              { label: "IB Rebate", width: "18%" },
              { label: "Net", width: "18%" },
            ],
            totalRow: agg.byDay.length ? dailyTotalRow : "",
            bodyRows: dailyRows,
            emptyText: "No daily movement recorded.",
            narrow: true,
          })}
          ${chartUrl ? `<div class="ch-img"><img src="${chartUrl}" alt="Daily money movement" width="100%" /></div>` : ""}

          <p class="section-title">Money Movement by PSP</p>
          <p class="note">Every settled transaction grouped by payment provider. IB movements carry no PSP and group under <em>Unattributed</em>.</p>
          ${dataTable({
            headers: [
              { label: "PSP", width: "24%" },
              { label: "Deposits", width: "16%" },
              { label: "Withdrawals", width: "16%" },
              { label: "IB Rebate", width: "16%" },
              { label: "Net", width: "16%" },
              { label: "Count", width: "12%" },
            ],
            totalRow: pspTotalRow,
            bodyRows: pspRows,
            emptyText: "No settled transactions for this week.",
          })}`;

  const footerLines = [
    "Automated Weekly Business Summary.",
    `Net = Deposits &minus; Withdrawals &minus; IB Rebate, counting ${escapeHtml(TX_STATUSES.join(", "))} transactions only. Amounts use magnitudes; direction comes from the transaction type.`,
    "Deposits and Withdrawals are <strong>client money only</strong>. IB commission is held in its own column so it is never counted twice &mdash; an <em>ib withdrawal</em> sits in IB Rebate, not in Withdrawals.",
    `IB Rebate is the ${escapeHtml("ib transfer to account")} and ${escapeHtml("ib withdrawal")} settled this week. The Deal Match report derives IB commission from <em>current</em> CRM wallet balances instead, so the two can differ &mdash; this one is fixed for a closed week, that one drifts between runs.`,
    `Total Revenue = markup + client commission &minus; LP commission, from <code>DealMatch/Run</code>. Net Revenue = Total Revenue &minus; IB Rebate.`,
    ...notices.map((n) => escapeHtml(n)),
    `Transaction types seen this week: ${escapeHtml(agg.typesSeen.join(", ") || "none")}.`,
  ];

  return emailShell({
    theme: "light",
    title: "Weekly Business Summary",
    subtitle: "Management Reporting | Money Movement & Account Activity",
    metaLines: [
      `Period: <strong>${escapeHtml(fromYmd)}</strong> to <strong>${escapeHtml(toYmd)}</strong> (UTC)`,
      "Scope: all PSPs, all accounts",
    ],
    body,
    footerLines,
  });
}

// ── orchestration ───────────────────────────────────────────────────────────

export async function runWeeklyBusinessSummary({ fromDate, toDate, recipients: recipientsOverride } = {}) {
  const week = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullWeekUtc();
  const fromYmd = toYmdUtc(week.start);
  const toYmd = toYmdUtc(week.end);

  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : parseRecipients(process.env.SUMMARY_ALERT_RECIPIENTS || "");
  if (!recipients.length) {
    console.warn("[WeeklySummary] No recipients configured. Skipping.");
    return { ok: false, reason: "no-recipients", fromYmd, toYmd };
  }
  if (!crmConfigured()) {
    throw new Error("CRM API token not configured (VITE_API_TOKEN / API_TOKEN)");
  }

  const transactions = await fetchTransactions(fromYmd, toYmd);
  const agg = aggregate(transactions);
  const glance = await fetchGlance(week, fromYmd, toYmd);

  const notices = [];
  // A full segment almost certainly means the window was truncated; say so
  // rather than quietly under-reporting.
  if (transactions.length >= TX_SEGMENT_LIMIT) {
    notices.push(`Transaction list hit the ${TX_SEGMENT_LIMIT}-row cap — figures may be incomplete.`);
  }
  if (agg.currencies.length > 1) {
    notices.push(`More than one currency present (${agg.currencies.join(", ")}); amounts are summed as reported.`);
  }

  let chartUrl = null;
  try {
    const images = await buildDailyChart(agg.byDay, `(${fromYmd} to ${toYmd})`);
    if (images.length) {
      const published = await publishChartImages(images);
      chartUrl = published.urls["daily-money-movement.png"];
    }
  } catch (error) {
    console.warn("[WeeklySummary] chart rendering failed:", error?.message || error);
    notices.push(`Chart unavailable: ${error?.message || error}`);
  }

  const subject = `Weekly Business Summary (${fromYmd} to ${toYmd})`;
  const html = buildSummaryEmailHtml({ fromYmd, toYmd, agg, glance, chartUrl, notices });
  await sendBrevoEmail({ subject, html, recipients, senderName: "Business Summary" });

  console.log(
    `[WeeklySummary] Sent to ${recipients.join(", ")} | net=${agg.netFlow.toFixed(2)} | psps=${agg.byPsp.length} | depositors=${agg.depositors.length} | period=${fromYmd}..${toYmd}`,
  );
  return { ok: true, psps: agg.byPsp.length, depositors: agg.depositors.length, fromYmd, toYmd };
}

export function startWeeklyBusinessSummaryScheduler() {
  const enabled = String(process.env.WEEKLY_SUMMARY_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[WeeklySummary] disabled by WEEKLY_SUMMARY_ENABLED=false");
    return;
  }

  const schedule = String(process.env.WEEKLY_SUMMARY_CRON || DEFAULT_SCHEDULE);
  const timezone = String(process.env.WEEKLY_SUMMARY_TIMEZONE || DEFAULT_TIMEZONE);
  if (!cron.validate(schedule)) {
    console.error(`[WeeklySummary] Invalid cron expression: "${schedule}"`);
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      try {
        await runWeeklyBusinessSummary();
      } catch (error) {
        console.error("[WeeklySummary] run failed:", error?.message || error);
      }
    },
    { timezone },
  );

  console.log(`[WeeklySummary] scheduled with expression "${schedule}" (${timezone})`);

  if (String(process.env.WEEKLY_SUMMARY_RUN_ON_START || "false").toLowerCase() === "true") {
    runWeeklyBusinessSummary().catch((error) => {
      console.error("[WeeklySummary] startup run failed:", error?.message || error);
    });
  }
}
