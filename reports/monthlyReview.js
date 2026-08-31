import {
  toYmdUtc,
  parseRecipients,
  alreadySentFor,
  recordSentFor,
  previousFullMonthUtc,
  fmtNum,
  money,
  escapeHtml,
  sendBrevoEmail,
  publishChartImages,
  crmConfigured,
  dataTable,
  dataCell,
  spanCell,
  resolveRecipients,
} from "./reportShared.js";
import {
  MONTH_NAMES,
  TX_SEGMENT_LIMIT,
  aggregate,
  attachClientNames,
  buildDailyChart,
  fetchClientVolume,
  fetchClosingBalance,
  fetchEquityPosition,
  fetchGlance,
  fetchTransactions,
  findFirstTimeDepositors,
  fmtDayLabel,
  num,
  signCls,
  topInstruments,
} from "./summaryCore.js";
import { buildSummaryEmailHtml, SUMMARY_GUARD_KEYS, SUMMARY_RECIPIENT_VARS } from "./weeklyBusinessSummary.js";

// Monthly review -- everything the weekly Business Summary carries, over a
// calendar month, plus the two things only a month can show: how it compares
// with the month before, and how it moved week by week.
//
// A week is too fine to see a trend. Every weekly email compares its figures to
// nothing, so "is this month better than last" has had no answer anywhere in
// the dashboard.
//
// Sent 10:00 Dubai on the 1st. That lands on a weekend twice a year; it sends
// anyway, because a month-end review is not time-critical to the hour.
//
// Design: docs/superpowers/specs/2026-08-25-daily-and-monthly-reports-design.md

// ── month-over-month arithmetic ─────────────────────────────────────────────

export function pctChange(current, prior) {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null;
  // A percentage against a zero base is either infinite or invented. The figure
  // itself still shows in its own column; only the comparison is withheld.
  if (prior === 0) return null;
  // Divide by the MAGNITUDE of the prior figure, not the signed value. Net flow
  // moving from -100 to +50 is an improvement; (current - prior) / prior would
  // call it -150%, which reads as a collapse.
  return ((current - prior) / Math.abs(prior)) * 100;
}

export function fmtPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "&mdash;";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

// ── week-by-week breakdown ──────────────────────────────────────────────────

// The Saturday on or before a given day. Saturday-to-Friday is the week the
// weekly report uses, so a reader comparing the two emails is comparing the
// same weeks.
function weekStartOf(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 1) % 7));
  return date.toISOString().slice(0, 10);
}

export function weekBuckets(byDay) {
  const weeks = new Map();
  for (const d of byDay || []) {
    if (!d?.day) continue;
    const start = weekStartOf(d.day);
    if (!weeks.has(start)) weeks.set(start, { start, end: start, deposits: 0, withdrawals: 0, ibRebate: 0 });
    const w = weeks.get(start);
    w.deposits += num(d.deposits);
    w.withdrawals += num(d.withdrawals);
    w.ibRebate += num(d.ibRebate);
    // The last day of the month can fall mid-week, so the label ends on the
    // last day actually present rather than a Friday that never happened.
    if (d.day > w.end) w.end = d.day;
  }
  return [...weeks.values()]
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .map((w) => ({ ...w, net: w.deposits - w.withdrawals - w.ibRebate }));
}

export function monthLabelFor(date) {
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// ── the two extra sections ──────────────────────────────────────────────────

function momSection({ agg, glance, instruments, prior, monthLabel }) {
  const netRevenue = glance.totalRevenue === null || glance.totalRevenue === undefined
    ? null
    : glance.totalRevenue - agg.ibRebate;

  const metrics = [
    { label: "Deposits", current: agg.deposits, prior: prior?.deposits, fmt: money, cls: "pos" },
    { label: "Withdrawals", current: agg.withdrawals, prior: prior?.withdrawals, fmt: money, cls: "cost" },
    { label: "Net Flow", current: agg.netFlow, prior: prior?.netFlow, fmt: money, signed: true },
    { label: "Total Revenue", current: glance.totalRevenue, prior: prior?.totalRevenue, fmt: money },
    { label: "Net Revenue", current: netRevenue, prior: prior?.netRevenue, fmt: money, signed: true },
    { label: "Lots", current: instruments.totalLots, prior: prior?.lots, fmt: (v) => fmtNum(v, 2) },
  ];

  const cell = (value, fmt) =>
    value === null || value === undefined || !Number.isFinite(Number(value)) ? "&mdash;" : fmt(Number(value));

  const rows = metrics
    .map((m) => {
      const change = pctChange(Number(m.current), Number(m.prior));
      return `<tr>
        ${dataCell("Metric", escapeHtml(m.label), { nowrap: true })}
        ${dataCell("This Month", cell(m.current, m.fmt), {
          align: "right",
          bold: true,
          cls: m.signed ? signCls(m.current) : m.cls || "",
        })}
        ${dataCell("Prior Month", cell(m.prior, m.fmt), { align: "right" })}
        ${dataCell("Change", fmtPct(change), { align: "right", cls: change === null ? "" : signCls(change) })}
      </tr>`;
    })
    .join("");

  return `
          <p class="section-title">Month over Month</p>
          <p class="note">${
            prior
              ? `${escapeHtml(monthLabel)} against ${escapeHtml(prior.monthLabel)}. Change is measured against the size of the prior figure, so a net flow moving from negative to positive reads as an improvement rather than a collapse.`
              : "Prior month unavailable &mdash; the comparison could not be fetched, so this month&rsquo;s figures stand alone. A dash is not a zero."
          }</p>
          ${dataTable({
            headers: [
              { label: "Metric", width: "28%" },
              { label: "This Month", width: "24%" },
              { label: "Prior Month", width: "24%" },
              { label: "Change", width: "24%" },
            ],
            bodyRows: rows,
            emptyText: "No figures to compare.",
          })}`;
}

function weekSection(agg) {
  const weeks = weekBuckets(agg.byDay);

  const rows = weeks
    .map(
      (w) => `<tr>
        ${dataCell("Week", `${escapeHtml(fmtDayLabel(w.start))} &ndash; ${escapeHtml(fmtDayLabel(w.end))}`, { nowrap: true })}
        ${dataCell("Deposits", money(w.deposits), { align: "right", cls: "pos" })}
        ${dataCell("Withdrawals", money(w.withdrawals), { align: "right", cls: "cost" })}
        ${dataCell("IB Rebate", money(w.ibRebate), { align: "right", cls: num(w.ibRebate) > 0 ? "cost" : "" })}
        ${dataCell("Net", money(w.net), { align: "right", bold: true, cls: signCls(w.net) })}
      </tr>`,
    )
    .join("");

  // Summed from the same week rows the table shows, so the total line cannot
  // disagree with the rows above it.
  const totals = weeks.reduce(
    (acc, w) => ({
      deposits: acc.deposits + w.deposits,
      withdrawals: acc.withdrawals + w.withdrawals,
      ibRebate: acc.ibRebate + w.ibRebate,
      net: acc.net + w.net,
    }),
    { deposits: 0, withdrawals: 0, ibRebate: 0, net: 0 },
  );

  return `
          <p class="section-title">Week by Week</p>
          <p class="note">Saturday to Friday, the same weeks the Weekly Business Summary reports, so the rows here and the emails you already have line up. A month that ends flat but fell through the middle does not read as steady.</p>
          ${dataTable({
            headers: [
              { label: "Week", width: "32%" },
              { label: "Deposits", width: "17%" },
              { label: "Withdrawals", width: "17%" },
              { label: "IB Rebate", width: "17%" },
              { label: "Net", width: "17%" },
            ],
            totalRow: weeks.length
              ? spanCell(`TOTAL (${fmtNum(weeks.length, 0)} weeks)`) +
                dataCell("Deposits", money(totals.deposits), { align: "right", cls: "pos" }) +
                dataCell("Withdrawals", money(totals.withdrawals), { align: "right", cls: "cost" }) +
                dataCell("IB Rebate", money(totals.ibRebate), { align: "right" }) +
                dataCell("Net", money(totals.net), { align: "right", bold: true, cls: signCls(totals.net) })
              : "",
            bodyRows: rows,
            emptyText: "No movement recorded in any week of the month.",
          })}`;
}

// ── the email ───────────────────────────────────────────────────────────────

export function buildMonthlyReviewHtml({
  fromYmd,
  toYmd,
  monthLabel,
  agg,
  glance,
  firstTimers,
  instruments = { rows: [], totalLots: 0, instrumentCount: 0 },
  equity = { withdrawable: null, gross: null },
  closingBalance = null,
  chartUrl = null,
  prior = null,
  notices = [],
}) {
  return buildSummaryEmailHtml({
    fromYmd,
    toYmd,
    agg,
    glance,
    firstTimers,
    instruments,
    equity,
    closingBalance,
    chartUrl,
    notices,
    title: "Monthly Business Review",
    subtitle: "Management Reporting | Money Movement, Account Activity & Trend",
    glanceHeading: `${monthLabel} at a Glance`,
    periodNoun: "month",
    footerLead: "Automated Monthly Business Review.",
    afterGlance: momSection({ agg, glance, instruments, prior, monthLabel }),
    afterDailyFlow: weekSection(agg),
    footerExtras: [
      "Month over Month compares against the size of the prior figure, not its signed value, so a swing through zero reads in the right direction. A dash means the prior month was zero or could not be fetched &mdash; never that nothing changed.",
      "Week by Week uses Saturday-to-Friday weeks. A month rarely starts or ends on a Saturday, so its first and last rows are usually partial weeks and are labelled with the days they actually cover.",
    ],
  });
}

// ── orchestration ───────────────────────────────────────────────────────────

// The prior month, reduced to the six headline figures the comparison needs.
// Deliberately not the whole report: this is a second pass over DealMatch/Run,
// the slowest call either report makes, and nothing else from last month is
// shown.
async function fetchPriorMonth(monthStart) {
  const prevEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 0));
  prevEnd.setUTCHours(23, 59, 59, 0);
  const prevStart = new Date(Date.UTC(prevEnd.getUTCFullYear(), prevEnd.getUTCMonth(), 1));
  const fromYmd = toYmdUtc(prevStart);
  const toYmd = toYmdUtc(prevEnd);

  const transactions = await fetchTransactions(fromYmd, toYmd);
  const agg = aggregate(transactions);
  const { glance } = await fetchGlance({ start: prevStart, end: prevEnd });

  let lots = null;
  try {
    lots = topInstruments(await fetchClientVolume(fromYmd, toYmd)).totalLots;
  } catch (error) {
    console.warn("[MonthlyReview] prior-month ClientVolume lookup failed:", error?.message || error);
  }

  return {
    monthLabel: monthLabelFor(prevStart),
    fromYmd,
    toYmd,
    deposits: agg.deposits,
    withdrawals: agg.withdrawals,
    netFlow: agg.netFlow,
    totalRevenue: glance.totalRevenue,
    netRevenue:
      glance.totalRevenue === null || glance.totalRevenue === undefined ? null : glance.totalRevenue - agg.ibRebate,
    lots,
  };
}

export async function runMonthlyReview({ fromDate, toDate, recipients: recipientsOverride } = {}) {
  const month = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullMonthUtc();
  const fromYmd = toYmdUtc(month.start);
  const toYmd = toYmdUtc(month.end);
  const monthLabel = monthLabelFor(month.start);

  const isScheduledRun = !(Array.isArray(recipientsOverride) && recipientsOverride.length);

  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : resolveRecipients(SUMMARY_RECIPIENT_VARS.monthly);
  if (!recipients.length) {
    console.warn("[MonthlyReview] No recipients configured. Skipping.");
    return { ok: false, reason: "no-recipients", fromYmd, toYmd };
  }

  // YYYY-MM is the window key: one send per month, however many times the
  // process restarts on the 1st.
  const windowKey = fromYmd.slice(0, 7);
  if (isScheduledRun && (await alreadySentFor(SUMMARY_GUARD_KEYS.monthly, windowKey))) {
    console.log(`[MonthlyReview] ${windowKey} already sent; skipping (restart, not a new month).`);
    return { ok: false, reason: "already-sent", fromYmd, toYmd };
  }
  if (!crmConfigured()) {
    throw new Error("CRM API token not configured (API_TOKEN)");
  }

  const transactions = await fetchTransactions(fromYmd, toYmd);
  const agg = aggregate(transactions);
  await attachClientNames(agg.depositors);
  const { glance, failures } = await fetchGlance(month);

  const notices = [...failures];

  let firstTimers = { rows: [], unverified: 0, checked: 0 };
  try {
    firstTimers = await findFirstTimeDepositors(agg.depositors, fromYmd, toYmd);
    if (firstTimers.conflicts) {
      notices.push(
        `${firstTimers.conflicts} client(s) the CRM dated as first depositing this month were found to have an earlier deposit in their own transaction history. They are excluded from First-Time Depositors.`,
      );
    }
    if (firstTimers.unverified) {
      notices.push(
        `${firstTimers.unverified} deposit history/histories could not be read; those accounts are left out of First-Time Depositors rather than guessed at.`,
      );
    }
  } catch (error) {
    console.warn("[MonthlyReview] first-time depositor check failed:", error?.message || error);
    notices.push(`First-Time Depositors unavailable: ${error?.message || error}`);
  }

  const equity = await fetchEquityPosition();
  if (!equity.withdrawable && !equity.gross) {
    notices.push("Equity Position unavailable: neither Metrics/dashboard nor EquityOverview/dashboard responded.");
  }

  let closingBalance = null;
  try {
    closingBalance = await fetchClosingBalance();
  } catch (error) {
    console.warn("[MonthlyReview] closing balance lookup failed:", error?.message || error);
    notices.push(`Closing Balance unavailable: ${error?.message || error}`);
  }

  let instruments = { rows: [], totalLots: 0, instrumentCount: 0 };
  try {
    instruments = topInstruments(await fetchClientVolume(fromYmd, toYmd));
  } catch (error) {
    console.warn("[MonthlyReview] ClientVolume lookup failed:", error?.message || error);
    notices.push(`Top Trading Instruments unavailable: ${error?.message || error}`);
  }

  // Its own try: without the prior month the review still stands, it just has
  // nothing to compare against. That is a dash in one section, not a dead send.
  let prior = null;
  try {
    prior = await fetchPriorMonth(month.start);
  } catch (error) {
    console.warn("[MonthlyReview] prior-month lookup failed:", error?.message || error);
    notices.push(`Month-over-month comparison unavailable: ${error?.message || error}`);
  }

  if (transactions.length >= TX_SEGMENT_LIMIT) {
    notices.push(`Transaction list hit the ${TX_SEGMENT_LIMIT}-row cap — figures may be incomplete.`);
  }
  if (agg.currencies.length > 1) {
    notices.push(`More than one currency present (${agg.currencies.join(", ")}); amounts are summed as reported.`);
  }

  let chartUrl = null;
  try {
    const images = await buildDailyChart(agg.byDay, `(${monthLabel})`);
    if (images.length) {
      const published = await publishChartImages(images);
      chartUrl = published.urls["daily-money-movement.png"];
    }
  } catch (error) {
    console.warn("[MonthlyReview] chart rendering failed:", error?.message || error);
    notices.push(`Chart unavailable: ${error?.message || error}`);
  }

  const subject = `Monthly Business Review (${monthLabel})`;
  const html = buildMonthlyReviewHtml({
    fromYmd, toYmd, monthLabel, agg, glance, firstTimers,
    instruments, equity, closingBalance, chartUrl, prior, notices,
  });
  await sendBrevoEmail({ subject, html, recipients, senderName: "Monthly Review" });

  if (isScheduledRun) await recordSentFor(SUMMARY_GUARD_KEYS.monthly, windowKey);

  console.log(
    `[MonthlyReview] Sent to ${recipients.join(", ")} | net=${agg.netFlow.toFixed(2)} | depositors=${agg.depositors.length} | weeks=${weekBuckets(agg.byDay).length} | prior=${prior ? prior.monthLabel : "unavailable"} | month=${monthLabel}`,
  );
  return {
    ok: true,
    depositors: agg.depositors.length,
    weeks: weekBuckets(agg.byDay).length,
    comparedWith: prior ? prior.monthLabel : null,
    fromYmd,
    toYmd,
  };
}
