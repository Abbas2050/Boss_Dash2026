import cron from "node-cron";
import {
  toYmdUtc,
  parseRecipients,
  alreadySentFor,
  recordSentFor,
  previousFullDayUtc,
  fmtNum,
  money,
  escapeHtml,
  sendBrevoEmail,
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
  TX_STATUSES,
  TX_SEGMENT_LIMIT,
  aggregate,
  attachClientNames,
  dash,
  fetchClientVolume,
  fetchClosingBalance,
  fetchGlance,
  fetchTransactions,
  num,
  orDash,
  signCls,
  topInstruments,
} from "./summaryCore.js";

// Daily digest — yesterday, in five short sections.
//
// A week is too coarse to notice a bad day: a large withdrawal on Monday is
// otherwise invisible until Saturday, by which point it is history rather than
// something to act on.
//
// Sent EVERY morning, including weekends, whether or not anything happened. The
// alternative — sending only when a threshold trips — was rejected because
// silence is ambiguous: a quiet day and a dead scheduler look identical, and
// this project has already had a scheduler fail silently for want of configured
// recipients.
//
// Design: docs/superpowers/specs/2026-08-25-daily-and-monthly-reports-design.md

const DEFAULT_SCHEDULE = "0 8 * * *"; // 08:00 every day (UAE time)
const DEFAULT_TIMEZONE = "Asia/Dubai";

export function buildDailyDigestHtml({
  ymd,
  agg,
  glance,
  instruments = { rows: [], totalLots: 0, instrumentCount: 0 },
  closingBalance = null,
  notices = [],
}) {
  const netRevenue = glance.totalRevenue === null || glance.totalRevenue === undefined
    ? null
    : glance.totalRevenue - agg.ibRebate;

  // Deposits | Withdrawals | IB Rebate | Net — the same chain the weekly uses
  // at every level, so a reader moving between the two emails reads one shape.
  const flowCells = (d, net) =>
    dataCell("Deposits", money(d.deposits), { align: "right", cls: "pos" }) +
    dataCell("Withdrawals", money(d.withdrawals), { align: "right", cls: "cost" }) +
    dataCell("IB Rebate", money(d.ibRebate), { align: "right", cls: num(d.ibRebate) > 0 ? "cost" : "" }) +
    dataCell("Net", money(net), { align: "right", bold: true, cls: signCls(net) });

  // Six tiles, not the weekly's nine. Active Accounts, Large Depositors and
  // First-Time Depositors are counts that need a week to mean anything; over a
  // single day they are mostly small integers that crowd out the money.
  const glanceCards = kpiGrid([
    { label: "Net Flow", value: money(agg.netFlow), cls: signCls(agg.netFlow) },
    {
      label: "Deposits",
      value: money(agg.deposits),
      cls: "pos",
      note: `across ${fmtNum(agg.depositCount, 0)} deposit${agg.depositCount === 1 ? "" : "s"}`,
    },
    { label: "Withdrawals", value: money(agg.withdrawals), cls: "cost" },
    { label: "Total Revenue", value: orDash(glance.totalRevenue, money) },
    {
      label: "Net Revenue",
      value: orDash(netRevenue, money),
      cls: signCls(netRevenue),
      note: "Total Revenue less IB Rebate",
    },
    { label: "Lots", value: fmtNum(instruments.totalLots, 2), note: "realized, all instruments" },
  ]);

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

  const accountRow = (r, { bold = false } = {}) =>
    dataCell("Deposits", money(r.deposits), { align: "right", bold, cls: "pos" }) +
    dataCell("Withdrawals", money(r.withdrawals), { align: "right", cls: "cost" }) +
    dataCell("IB Rebate", money(r.ibRebate), { align: "right", cls: num(r.ibRebate) > 0 ? "cost" : "" }) +
    dataCell("Net", money(r.net), { align: "right", bold: true, cls: signCls(r.net) });

  const largeTotals = agg.largeDepositors.reduce(
    (acc, r) => ({
      deposits: acc.deposits + num(r.deposits),
      withdrawals: acc.withdrawals + num(r.withdrawals),
      ibRebate: acc.ibRebate + num(r.ibRebate),
      net: acc.net + num(r.net),
    }),
    { deposits: 0, withdrawals: 0, ibRebate: 0, net: 0 },
  );

  const largeRows = agg.largeDepositors
    .map(
      (r) => `<tr>
        ${dataCell("Client", escapeHtml(r.name))}
        ${dataCell("Client ID", r.userId ? escapeHtml(String(r.userId)) : dash, { nowrap: true })}
        ${accountRow(r, { bold: true })}
      </tr>`,
    )
    .join("");

  const instrumentRows = instruments.rows
    .map(
      (r) => `<tr>
        ${dataCell("Instrument", escapeHtml(r.symbol), { nowrap: true })}
        ${dataCell("Lots", fmtNum(r.lots, 2), { align: "right", bold: true })}
        ${dataCell("Share", `${num(r.share).toFixed(1)}%`, { align: "right" })}
        ${dataCell("Clients", fmtNum(r.clients, 0), { align: "right" })}
        ${dataCell("Symbols", fmtNum(r.variants, 0), { align: "right" })}
      </tr>`,
    )
    .join("");

  const pspRows = agg.byPsp
    .map(
      (p) => `<tr>
        ${dataCell("PSP", escapeHtml(p.psp), { nowrap: true })}
        ${flowCells(p, p.net)}
        ${dataCell("Count", fmtNum(p.count, 0), { align: "right" })}
      </tr>`,
    )
    .join("");

  const body = `
          <p class="section-title" style="margin-top:0;">Yesterday at a Glance</p>
          ${glanceCards}

          <p class="section-title">Closing Balance <span style="font-weight:400;">&mdash; as at send time, not for yesterday</span></p>
          ${closingBalanceCards || `<p class="note">Closing balance unavailable &mdash; the wallet monitor did not respond.</p>`}

          <p class="section-title">Large Deposits</p>
          <p class="note">Accounts that deposited more than ${money(LARGE_DEPOSIT_THRESHOLD)} yesterday.</p>
          ${dataTable({
            headers: ACCOUNT_HEADERS,
            totalRow: agg.largeDepositors.length
              ? spanCell(`TOTAL (${fmtNum(agg.largeDepositors.length, 0)})`, { colspan: 2 }) + accountRow(largeTotals)
              : "",
            bodyRows: largeRows,
            emptyText: `No accounts deposited more than ${money(LARGE_DEPOSIT_THRESHOLD)} yesterday.`,
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
            totalRow: instruments.rows.length
              ? spanCell(`TOTAL (${fmtNum(instruments.instrumentCount, 0)})`) +
                dataCell("Lots", fmtNum(instruments.totalLots, 2), { align: "right" }) +
                dataCell("Share", "100.0%", { align: "right" }) +
                spanCell("", { colspan: 2 })
              : "",
            bodyRows: instrumentRows,
            emptyText: "No traded volume yesterday.",
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
            totalRow:
              spanCell("TOTAL") +
              flowCells(agg, agg.netFlow) +
              dataCell("Count", fmtNum(agg.txCount, 0), { align: "right" }),
            bodyRows: pspRows,
            emptyText: "No settled transactions yesterday.",
          })}`;

  const footerLines = [
    "Automated Daily Digest. Sent every morning, including weekends &mdash; a quiet day and a dead scheduler must not look the same.",
    `Net = Deposits &minus; Withdrawals &minus; IB Rebate, counting ${escapeHtml(TX_STATUSES.join(", "))} transactions only. Amounts use magnitudes; direction comes from the transaction type.`,
    "Deposits and Withdrawals are <strong>client money only</strong>. IB commission is held in its own column so it is never counted twice.",
    "Total Revenue = markup + client commission &minus; LP commission, from <code>DealMatch/Run</code>. Net Revenue = Total Revenue &minus; IB Rebate.",
    "Closing Balance is a snapshot taken when this email was built, not a figure for yesterday. Most of it is read from the finance Google Sheet, so it is only as current as that sheet.",
    "The fuller picture &mdash; equity position, first-time depositors, account-by-account activity &mdash; is in the Weekly Business Summary each Saturday.",
    ...(agg.unknownTypes.length
      ? [
          `<strong>Unrecognised transaction type(s):</strong> ${agg.unknownTypes
            .map((u) => `${escapeHtml(u.type)} ${money(u.amount)} counted as a ${escapeHtml(u.treatedAs)}`)
            .join(" &middot; ")}. Confirm this is right.`,
        ]
      : []),
    ...notices.map((n) => escapeHtml(n)),
  ];

  return emailShell({
    theme: "light",
    title: "Daily Digest",
    subtitle: "Management Reporting | Yesterday's Money Movement",
    metaLines: [
      `Day: <strong>${escapeHtml(ymd)}</strong> (UTC)`,
      "Scope: all PSPs, all accounts",
    ],
    body,
    footerLines,
  });
}

// ── orchestration ───────────────────────────────────────────────────────────

export async function runDailyDigest({ fromDate, toDate, recipients: recipientsOverride } = {}) {
  const day = fromDate && toDate ? { start: fromDate, end: toDate } : previousFullDayUtc();
  const fromYmd = toYmdUtc(day.start);
  const toYmd = toYmdUtc(day.end);

  // An explicit recipient list is the on-demand test button, which must always
  // send. Everything else is the cron or a RUN_ON_START boot, and a day that
  // already went out must not go again -- an app pool that recycles would
  // otherwise mail this repeatedly.
  const isScheduledRun = !(Array.isArray(recipientsOverride) && recipientsOverride.length);

  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : parseRecipients(process.env.DAILY_DIGEST_RECIPIENTS || process.env.SUMMARY_ALERT_RECIPIENTS || "");
  if (!recipients.length) {
    console.warn("[DailyDigest] No recipients configured. Skipping.");
    return { ok: false, reason: "no-recipients", fromYmd, toYmd };
  }

  // The covered date is the window key: one send per day, however many times
  // the process restarts.
  if (isScheduledRun && (await alreadySentFor("daily", fromYmd))) {
    console.log(`[DailyDigest] ${fromYmd} already sent; skipping (restart, not a new day).`);
    return { ok: false, reason: "already-sent", fromYmd, toYmd };
  }
  if (!crmConfigured()) {
    throw new Error("CRM API token not configured (API_TOKEN)");
  }

  const transactions = await fetchTransactions(fromYmd, toYmd);
  const agg = aggregate(transactions);
  await attachClientNames(agg.largeDepositors);
  const { glance, failures } = await fetchGlance(day);

  const notices = [...failures];

  // Its own try: the wallet monitor polls every PSP, so one slow provider must
  // cost this section rather than the whole email.
  let closingBalance = null;
  try {
    closingBalance = await fetchClosingBalance();
  } catch (error) {
    console.warn("[DailyDigest] closing balance lookup failed:", error?.message || error);
    notices.push(`Closing Balance unavailable: ${error?.message || error}`);
  }

  let instruments = { rows: [], totalLots: 0, instrumentCount: 0 };
  try {
    instruments = topInstruments(await fetchClientVolume(fromYmd, toYmd));
  } catch (error) {
    console.warn("[DailyDigest] ClientVolume lookup failed:", error?.message || error);
    notices.push(`Top Trading Instruments unavailable: ${error?.message || error}`);
  }

  if (transactions.length >= TX_SEGMENT_LIMIT) {
    notices.push(`Transaction list hit the ${TX_SEGMENT_LIMIT}-row cap — figures may be incomplete.`);
  }
  if (agg.currencies.length > 1) {
    notices.push(`More than one currency present (${agg.currencies.join(", ")}); amounts are summed as reported.`);
  }

  const subject = `Daily Digest (${fromYmd})`;
  const html = buildDailyDigestHtml({ ymd: fromYmd, agg, glance, instruments, closingBalance, notices });
  await sendBrevoEmail({ subject, html, recipients, senderName: "Daily Digest" });

  if (isScheduledRun) await recordSentFor("daily", fromYmd);

  console.log(
    `[DailyDigest] Sent to ${recipients.join(", ")} | net=${agg.netFlow.toFixed(2)} | psps=${agg.byPsp.length} | large=${agg.largeDepositors.length} | lots=${instruments.totalLots} | day=${fromYmd}`,
  );
  return {
    ok: true,
    psps: agg.byPsp.length,
    largeDepositors: agg.largeDepositors.length,
    instruments: instruments.instrumentCount,
    fromYmd,
    toYmd,
  };
}

export function startDailyDigestScheduler() {
  const enabled = String(process.env.DAILY_DIGEST_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log("[DailyDigest] disabled by DAILY_DIGEST_ENABLED=false");
    return;
  }

  const schedule = String(process.env.DAILY_DIGEST_CRON || DEFAULT_SCHEDULE);
  const timezone = String(process.env.DAILY_DIGEST_TIMEZONE || DEFAULT_TIMEZONE);
  if (!cron.validate(schedule)) {
    console.error(`[DailyDigest] Invalid cron expression: "${schedule}"`);
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      try {
        await runDailyDigest();
      } catch (error) {
        console.error("[DailyDigest] run failed:", error?.message || error);
      }
    },
    { timezone },
  );

  console.log(`[DailyDigest] scheduled with expression "${schedule}" (${timezone})`);

  // A missing recipient list is otherwise invisible: the schedule fires, one
  // warning goes to the log, and nothing is sent. Say so at BOOT, while someone
  // is watching.
  if (!parseRecipients(process.env.DAILY_DIGEST_RECIPIENTS || process.env.SUMMARY_ALERT_RECIPIENTS || "").length) {
    console.error(
      "[DailyDigest] WILL NOT SEND: neither DAILY_DIGEST_RECIPIENTS nor SUMMARY_ALERT_RECIPIENTS is set. " +
        "Scheduled runs skip silently; test sends still work because they pass recipients explicitly.",
    );
  }

  if (String(process.env.DAILY_DIGEST_RUN_ON_START || "false").toLowerCase() === "true") {
    runDailyDigest().catch((error) => {
      console.error("[DailyDigest] startup run failed:", error?.message || error);
    });
  }
}
