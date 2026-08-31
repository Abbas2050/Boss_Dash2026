import cron from "node-cron";
import {
  BACKEND_BASE_URL,
  toYmdUtc,
  toUnixRange,
  parseRecipients,
  alreadySentFor,
  recordSentFor,
  mapWithConcurrency,
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

import {
  ACCOUNT_HEADERS,
  LARGE_DEPOSIT_THRESHOLD,
  EXCLUDED_LABELS,
  TX_SEGMENT_LIMIT,
  TX_STATUSES,
  aggregate,
  attachClientNames,
  buildDailyChart,
  dash,
  fetchClientVolume,
  fetchClosingBalance,
  fetchEquityPosition,
  fetchGlance,
  fetchTransactions,
  findFirstTimeDepositors,
  fmtDayLabel,
  num,
  orDash,
  signCls,
  topInstruments,
} from "./summaryCore.js";


// Weekly Business Summary — money movement and account activity, with a glance
// strip that also carries the trading headline. Design:
// docs/superpowers/specs/2026-08-07-weekly-business-summary-design.md
//
// Sent Saturday 10:00 Dubai, AFTER Deal Match (09:00) and Slippage (09:30), so
// the glance is never computed before the reports it summarises. The week is
// Saturday->Friday, closed the previous night -- see previousFullWeekUtc().
const DEFAULT_SCHEDULE = "0 10 * * 6"; // 10:00 every Saturday (UAE time)
const DEFAULT_TIMEZONE = "Asia/Dubai";

export function buildSummaryEmailHtml({
  fromYmd, toYmd, agg, glance,
  firstTimers = { rows: [], unverified: 0, checked: 0 },
  instruments = { rows: [], totalLots: 0, instrumentCount: 0 },
  equity = { withdrawable: null, gross: null },
  closingBalance = null,
  chartUrl = null, notices = [],
  // The monthly review carries every section below plus two of its own, so it
  // renders through this function rather than copying it. Defaults reproduce
  // the weekly email exactly; a caller that passes nothing gets what it always
  // got. Verified byte-for-byte, not assumed.
  title = "Weekly Business Summary",
  subtitle = "Management Reporting | Money Movement & Account Activity",
  glanceHeading = "Last Week at a Glance",
  periodNoun = "week",
  footerLead = "Automated Weekly Business Summary.",
  afterGlance = "",
  afterDailyFlow = "",
  footerExtras = [],
}) {
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

  const firstTimerTotal = firstTimers.rows.reduce((s, r) => s + num(r.deposits), 0);
  const firstTimerCount = firstTimers.rows.reduce((s, r) => s + num(r.depositCount), 0);

  const glanceCards = kpiGrid([
    { label: "Net Flow", value: money(agg.netFlow), cls: signCls(agg.netFlow) },
    { label: "Deposits", value: money(agg.deposits), cls: "pos", note: `across ${fmtNum(agg.depositCount, 0)} deposit${agg.depositCount === 1 ? "" : "s"}` },
    { label: "Withdrawals", value: money(agg.withdrawals), cls: "cost" },
    { label: "Active Accounts", value: fmtNum(agg.depositors.length, 0), note: "deposited or received rebate" },
    { label: "Total Revenue", value: orDash(glance.totalRevenue, money) },
    { label: "IB Rebate", value: money(agg.ibRebate), cls: "cost" },
    { label: "Net Revenue", value: orDash(netRevenue, money), cls: signCls(netRevenue), note: "Total Revenue less IB Rebate" },
    { label: "Large Depositors", value: fmtNum(agg.largeDepositors.length, 0), note: `over ${money(LARGE_DEPOSIT_THRESHOLD)}` },
    // The money is the headline; how many clients and deposits it came from is
    // the supporting detail.
    { label: "First-Time Depositors", value: money(firstTimerTotal), cls: "pos", note: `${fmtNum(firstTimers.rows.length, 0)} client${firstTimers.rows.length === 1 ? "" : "s"} over ${fmtNum(firstTimerCount, 0)} deposit${firstTimerCount === 1 ? "" : "s"}` },
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
        ${dataCell("Client", escapeHtml(r.name))}
        ${dataCell("Client ID", r.userId ? escapeHtml(String(r.userId)) : dash, { nowrap: true })}
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

  const firstTimerTotalRow =
    spanCell(`TOTAL (${fmtNum(firstTimers.rows.length, 0)})`, { colspan: 2 }) +
    dataCell("Deposits", money(firstTimerTotal), { align: "right", cls: "pos" }) +
    dataCell("Deposits #", fmtNum(firstTimerCount, 0), { align: "right" }) +
    spanCell("");

  const firstTimerRows = firstTimers.rows
    .map(
      (r) => `<tr>
        ${dataCell("Client", escapeHtml(r.name))}
        ${dataCell("Client ID", r.userId ? escapeHtml(String(r.userId)) : dash, { nowrap: true })}
        ${dataCell("Deposits", money(r.deposits), { align: "right", bold: true, cls: "pos" })}
        ${dataCell("Deposits #", fmtNum(r.depositCount, 0), { align: "right" })}
        ${dataCell("First Seen", escapeHtml(r.lastDate || ""), { nowrap: true })}
      </tr>`,
    )
    .join("");

  const instrumentTotalRow =
    spanCell(`TOTAL (${fmtNum(instruments.instrumentCount, 0)})`) +
    dataCell("Lots", fmtNum(instruments.totalLots, 2), { align: "right" }) +
    dataCell("Share", "100.0%", { align: "right" }) +
    spanCell("", { colspan: 2 });

  const instrumentRows = instruments.rows
    .map(
      (r) => `<tr>
        ${dataCell("Instrument", escapeHtml(r.symbol), { nowrap: true })}
        ${dataCell("Lots", fmtNum(r.lots, 2), { align: "right", bold: true })}
        ${dataCell("Share", `${r.share.toFixed(1)}%`, { align: "right" })}
        ${dataCell("Clients", fmtNum(r.clients, 0), { align: "right" })}
        ${dataCell("Symbols", fmtNum(r.variants, 0), { align: "right" })}
      </tr>`,
    )
    .join("");

  // Six equity tiles. An email has no hover, so each formula sits in the tile's
  // note where the dashboard puts it in a tooltip.
  const wd = equity.withdrawable;
  const gr = equity.gross;
  const equityRowOne = wd
    ? kpiGrid([
        {
          label: "LP Withdrawable Equity",
          value: money(wd.lpWithdrawable),
          note: `${money(wd.lpEquity)} equity less ${money(wd.lpCredit)} credit`,
        },
        {
          label: "Client Withdrawable Equity",
          value: money(wd.clientWithdrawable),
          note: "client equity with credit taken out",
        },
        {
          label: "LP-Client WD Difference",
          value: money(wd.difference),
          cls: signCls(wd.difference),
          note: "negative means clients could withdraw more than the LPs hold",
        },
      ])
    : "";
  const equityRowTwo = gr
    ? kpiGrid([
        {
          label: "LP Equity (incl. credit)",
          value: money(gr.lpEquity),
          note: `includes ${money(gr.lpCredit)} credit`,
        },
        {
          label: "Client Equity (incl. credit)",
          value: money(gr.clientEquity),
          note: `includes ${money(gr.clientCredit)} credit`,
        },
        {
          label: "LP-Client Equity Difference",
          value: money(gr.difference),
          cls: signCls(gr.difference),
          note: "same comparison, counting credit on both sides",
        },
      ])
    : "";

  // Closing balance as tiles, matching every other section. Ordered as the
  // dashboard shows them: what is coming in, what is going out, then the net
  // position. The two LP tiles name their rail in the label rather than only in
  // the note -- stacked on a phone, two identical labels read as a fault.
  // Labels are plain text; kpiGrid escapes them, so an HTML entity written here
  // would render literally.
  const cb = closingBalance;
  const closingBalanceCards = cb
    ? kpiGrid([
        { label: "To be received in BANK", value: money(cb.bankReceivable), cls: "pos" },
        { label: "To be received in CRYPTO", value: money(cb.cryptoReceivable), cls: "pos" },
        { label: "To be deposited into LPs (Bank)", value: money(cb.toLpsBank), cls: "cost", note: "USD" },
        { label: "To be deposited into LPs (Crypto)", value: money(cb.toLpsCrypto), cls: "cost", note: "USDT" },
        {
          label: "Net all Current Balance",
          value: money(cb.netAllCurrentBalance),
          note: "summed from live PSP balances",
        },
        { label: "Net Balance after expected funds", value: money(cb.netAfterExpectedFunds) },
        {
          label: "Difference actual vs expected",
          value: money(cb.differenceActualVsExpected),
          cls: signCls(cb.differenceActualVsExpected),
        },
        { label: "Credit by LPs", value: money(cb.creditByLps) },
      ])
    : "";


  const body = `
          <p class="section-title" style="margin-top:0;">${escapeHtml(glanceHeading)}</p>
          ${glanceCards}${afterGlance}

          <p class="section-title">Equity Position <span style="font-weight:400;">&mdash; as at send time, not for the ${periodNoun}</span></p>
          <p class="note">Credit is the non-withdrawable part of an account. Withdrawable equity is equity with credit removed, which is why the difference can change sign between the two rows. Mirrors the Dealing &rsaquo; Metrics tab.</p>
          ${equityRowOne || `<p class="note">Withdrawable equity unavailable &mdash; Metrics/dashboard did not respond.</p>`}
          ${equityRowTwo || `<p class="note">Credit-inclusive equity unavailable &mdash; EquityOverview/dashboard did not respond.</p>`}

          <p class="section-title">Closing Balance <span style="font-weight:400;">&mdash; as at send time, not for the ${periodNoun}</span></p>
          ${closingBalanceCards || `<p class="note">Closing balance unavailable &mdash; the wallet monitor did not respond.</p>`}

          <p class="section-title">Large Depositors</p>
          <p class="note">Accounts that deposited more than ${money(LARGE_DEPOSIT_THRESHOLD)} this ${periodNoun} &mdash; the subset of Account Activity below.</p>
          ${dataTable({
            headers: ACCOUNT_HEADERS,
            totalRow: agg.largeDepositors.length ? largeTotalRow : "",
            bodyRows: largeRows,
            emptyText: `No accounts deposited more than ${money(LARGE_DEPOSIT_THRESHOLD)} this ${periodNoun}.`,
          })}

          <p class="section-title">First-Time Depositors</p>
          <p class="note">Accounts whose <strong>first ever deposit</strong> landed this ${periodNoun}. Confirmed twice: the CRM&rsquo;s own <em>firstDepositDate</em> on the client record, <em>and</em> that client&rsquo;s transaction history before ${escapeHtml(fromYmd)} containing no earlier deposit. A client is listed only when both agree.</p>
          ${dataTable({
            headers: [
              { label: "Client", width: "34%" },
              { label: "Client ID", width: "12%" },
              { label: "Deposits", width: "18%" },
              { label: "Deposits #", width: "12%" },
              { label: "First Seen", width: "24%" },
            ],
            totalRow: firstTimers.rows.length ? firstTimerTotalRow : "",
            bodyRows: firstTimerRows,
            emptyText: `No first-time depositors this ${periodNoun}.`,
          })}

          <p class="section-title">Top Trading Instruments</p>
          <p class="note">Realized lots by instrument. Symbols are grouped by the part before the dot, so <em>XAUUSD.s</em>, <em>XAUUSD.d</em> and <em>XAUUSD.g5</em> count as one instrument routed through different books.</p>
          ${dataTable({
            headers: [
              { label: "Instrument", width: "26%" },
              { label: "Lots", width: "18%" },
              { label: "Share", width: "18%" },
              { label: "Clients", width: "18%" },
              { label: "Symbols", width: "20%" },
            ],
            totalRow: instruments.rows.length ? instrumentTotalRow : "",
            bodyRows: instrumentRows,
            emptyText: `No traded volume this ${periodNoun}.`,
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
          ${chartUrl ? `<div class="ch-img"><img src="${chartUrl}" alt="Daily money movement" width="100%" /></div>` : ""}${afterDailyFlow}

          <p class="section-title">Account Activity</p>
          <p class="note">Every account that moved money during the ${periodNoun}, largest deposit first. Net = Deposits &minus; Withdrawals &minus; IB Rebate.</p>
          ${dataTable({
            headers: ACCOUNT_HEADERS,
            totalRow: agg.depositors.length ? depositorTotalRow : "",
            bodyRows: depositorRows,
            emptyText: `No deposits this ${periodNoun}.`,
          })}

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
            emptyText: `No settled transactions for this ${periodNoun}.`,
          })}`;

  const footerLines = [
    footerLead,
    `Net = Deposits &minus; Withdrawals &minus; IB Rebate, counting ${escapeHtml(TX_STATUSES.join(", "))} transactions only. Amounts use magnitudes; direction comes from the transaction type.`,
    "Deposits and Withdrawals are <strong>client money only</strong>. IB commission is held in its own column so it is never counted twice &mdash; an <em>ib withdrawal</em> sits in IB Rebate, not in Withdrawals.",
    `IB Rebate is the ${escapeHtml("ib transfer to account")} and ${escapeHtml("ib withdrawal")} settled this ${periodNoun}. The Deal Match report derives IB commission from <em>current</em> CRM wallet balances instead, so the two can differ &mdash; this one is fixed for a closed ${periodNoun}, that one drifts between runs.`,
    `Total Revenue = markup + client commission &minus; LP commission, from <code>DealMatch/Run</code>. Net Revenue = Total Revenue &minus; IB Rebate.`,
    "Closing Balance is a snapshot too, and most of its figures are read from the finance Google Sheet, so they are only as current as that sheet. Net all Current Balance is the exception: it is summed from the live PSP balances.",
    `Equity Position is a snapshot taken when this email was built, not a figure for the reporting ${periodNoun}. The withdrawable row comes from <code>Metrics/dashboard</code> and the credit-inclusive row from <code>EquityOverview/dashboard</code>, so the two are fetched moments apart and can differ by a little price movement.`,
    `IB Rebate by type: ${
      agg.ibByType.length
        ? agg.ibByType.map((t) => `${escapeHtml(t.type)} ${money(t.amount)}`).join(" &middot; ")
        : "none"
    }.`,
    ...(agg.excluded.length
      ? [
          `Excluded from the figures above (not client money in or out): ${agg.excluded
            .map((e) => `${escapeHtml(EXCLUDED_LABELS[e.kind] || e.kind)} ${money(e.amount)} over ${fmtNum(e.count, 0)} row(s)`)
            .join(" &middot; ")}.`,
        ]
      : []),
    ...(agg.unknownTypes.length
      ? [
          `<strong>Unrecognised transaction type(s):</strong> ${agg.unknownTypes
            .map((u) => `${escapeHtml(u.type)} ${money(u.amount)} counted as a ${escapeHtml(u.treatedAs)}`)
            .join(" &middot; ")}. Confirm this is right.`,
        ]
      : []),
    ...(agg.ibSuspectedDoubleCount
      ? [
          `<strong>Check:</strong> ${fmtNum(agg.ibSuspectedDoubleCount, 0)} IB amount(s) appear more than once for the same client on the same day. If those are the two legs of one transfer, IB Rebate is overstated and needs a one-leg rule.`,
        ]
      : []),
    ...footerExtras,
    ...notices.map((n) => escapeHtml(n)),
    `Transaction types seen this ${periodNoun}: ${escapeHtml(agg.typesSeen.join(", ") || "none")}.`,
  ];

  return emailShell({
    theme: "light",
    title,
    subtitle,
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

  // An explicit recipient list means the on-demand test button, which must
  // always send. Everything else is the cron or a RUN_ON_START boot, and a
  // window that already went out must not go again -- an app pool that
  // recycles nightly would otherwise mail this every morning.
  const isScheduledRun = !(Array.isArray(recipientsOverride) && recipientsOverride.length);

  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : parseRecipients(process.env.SUMMARY_ALERT_RECIPIENTS || "");
  if (!recipients.length) {
    console.warn("[WeeklySummary] No recipients configured. Skipping.");
    return { ok: false, reason: "no-recipients", fromYmd, toYmd };
  }

  // Same window, already sent: this is a restart, not a new week.
  const windowKey = `${fromYmd}..${toYmd}`;
  if (isScheduledRun && (await alreadySentFor("summary", windowKey))) {
    console.log(`[WeeklySummary] ${windowKey} already sent; skipping (restart, not a new week).`);
    return { ok: false, reason: "already-sent", fromYmd, toYmd };
  }
  if (!crmConfigured()) {
    throw new Error("CRM API token not configured (VITE_API_TOKEN / API_TOKEN)");
  }

  const transactions = await fetchTransactions(fromYmd, toYmd);
  const agg = aggregate(transactions);
  await attachClientNames(agg.depositors);
  const { glance, failures } = await fetchGlance(week);

  const notices = [...failures];

  // One CRM call per client who deposited. Its own try: a history lookup
  // failing must not cost the whole report.
  let firstTimers = { rows: [], unverified: 0, checked: 0 };
  try {
    firstTimers = await findFirstTimeDepositors(agg.depositors, fromYmd, toYmd);
    if (firstTimers.conflicts) {
      notices.push(
        `${firstTimers.conflicts} client(s) the CRM dated as first depositing this week were found to have an earlier deposit in their own transaction history. They are excluded from First-Time Depositors; the CRM firstDepositDate field disagrees with the ledger and is worth investigating.`,
      );
    }
    if (firstTimers.noCrmDate) {
      notices.push(
        `${firstTimers.noCrmDate} depositing client(s) had no firstDepositDate on their CRM record; those were decided on transaction history alone.`,
      );
    }
    if (firstTimers.unverified) {
      notices.push(
        `${firstTimers.unverified} deposit history/histories could not be read; those accounts are left out of First-Time Depositors rather than guessed at.`,
      );
    }
  } catch (error) {
    console.warn("[WeeklySummary] first-time depositor check failed:", error?.message || error);
    notices.push(`First-Time Depositors unavailable: ${error?.message || error}`);
  }

  // Its own await: a dead equity endpoint costs that section, not the report.
  const equity = await fetchEquityPosition();

  // Same treatment. checkAllBalances polls every PSP, so a single provider being
  // slow or down must not take the whole report with it.
  let closingBalance = null;
  try {
    closingBalance = await fetchClosingBalance();
  } catch (error) {
    console.warn("[WeeklySummary] closing balance lookup failed:", error?.message || error);
    notices.push(`Closing Balance unavailable: ${error?.message || error}`);
  }
  if (!equity.withdrawable && !equity.gross) {
    notices.push("Equity Position unavailable: neither Metrics/dashboard nor EquityOverview/dashboard responded.");
  }

  let instruments = { rows: [], totalLots: 0, instrumentCount: 0 };
  try {
    instruments = topInstruments(await fetchClientVolume(fromYmd, toYmd));
  } catch (error) {
    console.warn("[WeeklySummary] ClientVolume lookup failed:", error?.message || error);
    notices.push(`Top Trading Instruments unavailable: ${error?.message || error}`);
  }
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
  const html = buildSummaryEmailHtml({ fromYmd, toYmd, agg, glance, firstTimers, instruments, equity, closingBalance, chartUrl, notices });
  await sendBrevoEmail({ subject, html, recipients, senderName: "Business Summary" });

  if (isScheduledRun) await recordSentFor("summary", windowKey);

  console.log(
    `[WeeklySummary] Sent to ${recipients.join(", ")} | net=${agg.netFlow.toFixed(2)} | psps=${agg.byPsp.length} | depositors=${agg.depositors.length} | firstTime=${firstTimers.rows.length} | instruments=${instruments.instrumentCount} | period=${fromYmd}..${toYmd}`,
  );
  return { ok: true, psps: agg.byPsp.length, depositors: agg.depositors.length, firstTime: firstTimers.rows.length, instruments: instruments.instrumentCount, fromYmd, toYmd };
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

  // A missing recipient list is otherwise invisible: the schedule fires, one
  // warning goes to the log a week later, and nothing is sent. Say so at BOOT,
  // while someone is watching. The test-send route takes its recipients from
  // the request body, so it keeps working and hides the problem completely.
  if (!parseRecipients(process.env.SUMMARY_ALERT_RECIPIENTS || "").length) {
    console.error(
      "[WeeklySummary] WILL NOT SEND: SUMMARY_ALERT_RECIPIENTS is not set. " +
        "Scheduled runs skip silently; test sends still work because they pass recipients explicitly.",
    );
  }

  if (String(process.env.WEEKLY_SUMMARY_RUN_ON_START || "false").toLowerCase() === "true") {
    runWeeklyBusinessSummary().catch((error) => {
      console.error("[WeeklySummary] startup run failed:", error?.message || error);
    });
  }
}
