import {
  backendFetch,
  toUnixRange,
  parseRecipients,
  mapWithConcurrency,
  money,
  renderChartBuffer,
  crmPost,
} from "./reportShared.js";

// The summary engine: everything the Business Summary computes, with none of
// the weekly-specific email or schedule around it.
//
// It lives here because three reports now share it -- the daily digest, the
// weekly summary and the monthly review all answer the same questions over
// different windows. Every function below takes its period as arguments and
// holds no opinion about how long that period is.
//
// The alternative was for the daily and monthly to import from a file called
// "weeklyBusinessSummary", or to copy it. The second guarantees the three
// drift, which is exactly how the Deal Match tab and the weekly email came to
// disagree about Net Revenue for weeks.
//
// Design: docs/superpowers/specs/2026-08-25-daily-and-monthly-reports-design.md

export const LARGE_DEPOSIT_THRESHOLD = Number(process.env.SUMMARY_LARGE_DEPOSIT_THRESHOLD || 1000);
export const TX_STATUSES = parseRecipients(process.env.SUMMARY_TX_STATUSES || "approved");

export const num = (v) => Number(v) || 0;

// ── transaction classification ──────────────────────────────────────────────
// The first live send printed the real vocabulary, which is nothing like the
// doc's: credit, deposit, ib transfer to account, ib transfer to account out,
// ib withdrawal, transfer in, transfer out, withdrawal.
//
// Substring matching on "withdrawal" got this badly wrong: "transfer out" does
// not contain the word, so money LEAVING was counted as money arriving, and the
// Unattributed PSP showed $1,282,007.61 of deposits against $0.00 of
// withdrawals across 56 rows. Hence an explicit table.
//
//   deposit    external client money in
//   withdrawal external client money out
//   ib         IB commission (a cost)
//   ib-mirror  the SECOND leg of an IB transfer - same money, ignored
//   internal   client moving money between their own accounts - nets to zero
//   credit     bonus/credit, not cash
export const TX_KINDS = new Map([
  ["deposit", "deposit"],
  ["withdrawal", "withdrawal"],
  ["cashback withdrawal", "withdrawal"],
  ["ib withdrawal", "ib"],
  ["ib transfer to account", "ib"],
  // Booked against the IB wallet for the same event as the line above; both
  // totalled $1,928.92 in the first live send. Counting both doubled the rebate.
  ["ib transfer to account out", "ib-mirror"],
  ["transfer in", "internal"],
  ["transfer out", "internal"],
  ["credit", "credit"],
]);

export function classifyTx(type) {
  const t = String(type || "").trim().toLowerCase();
  if (!t) return "unknown";
  if (TX_KINDS.has(t)) return TX_KINDS.get(t);
  // An unrecognised type is still classified so its money is never dropped, but
  // it is named in the footer so a new type cannot hide the way these did.
  if (t.includes("withdrawal") || t.endsWith(" out")) return "withdrawal";
  return "deposit";
}

export function isKnownTxType(type) {
  return TX_KINDS.has(String(type || "").trim().toLowerCase());
}

export function isWithdrawal(type) {
  return classifyTx(type) === "withdrawal";
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
  return classifyTx(type) === "ib";
}

export const txPsp = (row) => String(row?.psp || "").trim() || "Unattributed";

// `fromLoginSid` is a COMPOSITE ACCOUNT id, not a login: the CRM doc gives the
// pattern \d+-[\w-]+ with example "2-154439". One client owns several of these
// (a trading account and a wallet), so keying rows on it splits one person into
// several rows -- the "1-43" / "2-101939" entries seen in the first live send.
// Group on the CRM user instead.
export function txUserId(row) {
  const value = Number(row?.fromUserId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Falls back to the account id only so money is never dropped from the totals
// when a row has no user attached.
export function txClientKey(row) {
  const userId = txUserId(row);
  if (userId !== null) return String(userId);
  const sid = String(row?.fromLoginSid || "").trim();
  return sid ? `sid:${sid}` : "";
}

// ── aggregation ─────────────────────────────────────────────────────────────

export function aggregate(transactions) {
  const byPsp = new Map();
  const byAccount = new Map();
  const byDay = new Map();
  const typesSeen = new Set();
  const ibByType = new Map();
  const ibLegKeys = new Map();
  const excluded = new Map();
  const unknownTypes = new Map();
  let deposits = 0;
  let withdrawals = 0;
  let ibRebate = 0;
  let depositCount = 0;
  const currencies = new Set();

  for (const row of transactions) {
    const amount = txAmount(row);
    const kind = classifyTx(row?.type);
    if (!isKnownTxType(row?.type)) {
      const label = String(row?.type || "(blank)").toLowerCase();
      unknownTypes.set(label, { type: label, treatedAs: kind, amount: (unknownTypes.get(label)?.amount || 0) + amount });
    }
    // Excluded from the money-movement figures, but never discarded silently:
    // both are reported in the footer so the totals can be reconciled.
    if (kind === "internal" || kind === "credit" || kind === "ib-mirror") {
      const bucket = excluded.get(kind) || { kind, amount: 0, count: 0 };
      bucket.amount += amount;
      bucket.count += 1;
      excluded.set(kind, bucket);
      typesSeen.add(String(row?.type || "unknown"));
      continue;
    }
    const out = kind === "withdrawal";
    const psp = txPsp(row);
    const clientKey = txClientKey(row);
    const day = String(row?.processedAt || "").slice(0, 10);
    typesSeen.add(String(row?.type || "unknown"));
    if (row?.processedCurrency) currencies.add(String(row.processedCurrency));

    // IB commission is its own bucket, kept OUT of deposits/withdrawals. It has
    // to be: the per-account Net subtracts the rebate, and an "ib withdrawal"
    // counted in both Withdrawals and IB Rebate would be deducted twice.
    const isIb = kind === "ib";

    if (kind === "deposit") depositCount += 1;

    if (isIb) {
      ibRebate += amount;
      const key = String(row?.type || "unknown").toLowerCase();
      ibByType.set(key, (ibByType.get(key) || 0) + amount);
      // A transfer booked on BOTH legs (out of the wallet, into the trading
      // account) would appear as two rows of identical value for one client and
      // double the rebate. Same amount + same day + same client is the
      // signature; it is reported, never silently corrected, because two real
      // payouts can legitimately coincide.
      const legKey = `${clientKey}|${day}|${amount.toFixed(2)}`;
      ibLegKeys.set(legKey, (ibLegKeys.get(legKey) || 0) + 1);
    } else if (out) withdrawals += amount;
    else deposits += amount;

    if (!byPsp.has(psp)) byPsp.set(psp, { psp, deposits: 0, withdrawals: 0, ibRebate: 0, count: 0 });
    const p = byPsp.get(psp);
    p.count += 1;
    if (isIb) p.ibRebate += amount;
    else if (out) p.withdrawals += amount;
    else p.deposits += amount;

    if (clientKey) {
      if (!byAccount.has(clientKey)) {
        // TransactionDefinition carries NO name field, so the name is resolved
        // separately from /rest/users and filled in afterwards.
        byAccount.set(clientKey, {
          key: clientKey,
          userId: txUserId(row),
          name: "",
          deposits: 0,
          withdrawals: 0,
          ibRebate: 0,
          depositCount: 0,
          psps: new Set(),
          lastDate: "",
        });
      }
      const a = byAccount.get(clientKey);
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
      key: a.key,
      userId: a.userId,
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
    // How many deposit transactions, not how many depositing clients.
    depositCount,
    txCount: transactions.length,
    byPsp: [...byPsp.values()]
      .map((p) => ({ ...p, net: p.deposits - p.withdrawals - p.ibRebate }))
      .sort((a, b) => b.net - a.net),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    depositors,
    largeDepositors,
    typesSeen: [...typesSeen].sort(),
    ibByType: [...ibByType.entries()].map(([type, amount]) => ({ type, amount })).sort((a, b) => b.amount - a.amount),
    // Client+day+amount groups seen more than once: the fingerprint of a
    // transfer counted on both legs.
    ibSuspectedDoubleCount: [...ibLegKeys.values()].filter((n) => n > 1).length,
    excluded: [...excluded.values()].sort((a, b) => b.amount - a.amount),
    unknownTypes: [...unknownTypes.values()].sort((a, b) => b.amount - a.amount),
    currencies: [...currencies],
  };
}

// ── data fetching ───────────────────────────────────────────────────────────

export const TX_SEGMENT_LIMIT = 5000;

export async function fetchTransactions(fromYmd, toYmd) {
  const rows = await crmPost("transactions", {
    processedAt: { begin: `${fromYmd} 00:00:00`, end: `${toYmd} 23:59:59` },
    statuses: TX_STATUSES,
    segment: { limit: TX_SEGMENT_LIMIT, offset: 0 },
  });
  return dedupeById(rows);
}

// A transaction returned twice (once per leg of a transfer) would be counted
// twice. Rows without an id are kept as-is rather than collapsed together.
export function dedupeById(rows) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const row of rows) {
    const id = row?.id;
    if (id === null || id === undefined) {
      out.push(row);
      continue;
    }
    const key = String(id);
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  if (dropped) console.warn(`[SummaryCore] dropped ${dropped} duplicate transaction id(s)`);
  return out;
}

// ── top trading instruments ─────────────────────────────────────────────────
// ClientVolume/Run returns byClientSymbol[] = { login, name, symbol, lots }.
// Symbols carry a group/route suffix (XAUUSD.s, XAUUSD.d, XAUUSD.g5 ...), so
// the same instrument arrives split across several rows. Everything before the
// first dot is the instrument; the suffix is which book it was routed through.
export function baseSymbol(symbol) {
  const s = String(symbol || "").trim();
  if (!s) return "(unknown)";
  const dot = s.indexOf(".");
  return dot > 0 ? s.slice(0, dot) : s;
}

export function topInstruments(byClientSymbol, limit = 10) {
  const map = new Map();
  let totalLots = 0;

  for (const row of byClientSymbol || []) {
    const lots = Number(row?.lots) || 0;
    if (lots <= 0) continue;
    const key = baseSymbol(row?.symbol);
    totalLots += lots;
    let agg = map.get(key);
    if (!agg) {
      agg = { symbol: key, lots: 0, clients: new Set(), variants: new Set() };
      map.set(key, agg);
    }
    agg.lots += lots;
    if (row?.login !== undefined && row?.login !== null) agg.clients.add(String(row.login));
    agg.variants.add(String(row?.symbol || ""));
  }

  const all = [...map.values()]
    .map((a) => ({
      symbol: a.symbol,
      lots: a.lots,
      clients: a.clients.size,
      variants: a.variants.size,
      share: totalLots > 0 ? (a.lots / totalLots) * 100 : 0,
    }))
    .sort((a, b) => b.lots - a.lots);

  return { rows: all.slice(0, limit), totalLots, instrumentCount: all.length };
}

export async function fetchClientVolume(fromYmd, toYmd) {
  const params = new URLSearchParams({ from: fromYmd, to: toYmd, group: "*" });
  const resp = await backendFetch(`/ClientVolume/Run?${params}`, { timeoutMs: 60_000 });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = await resp.json();
  return Array.isArray(raw?.byClientSymbol) ? raw.byClientSymbol : [];
}

// ── first-time depositors ───────────────────────────────────────────────────
// TWO independent sources must agree before a client is called first-time.
//
//   1. The CRM's own firstDepositDate, already on the user record fetched for
//      names, so it costs nothing. Anyone whose first deposit predates the week
//      is dropped here and never queried again.
//   2. That client's actual transaction history, read back to the beginning and
//      checked for any earlier deposit.
//
// Stage 1 narrows tens of depositors to a handful, so stage 2 is a few calls
// rather than one per depositor. Where the two disagree the client is NOT
// listed and the disagreement is reported -- that is the signal that the CRM
// field cannot be trusted on its own.
//
// Deliberately not the userFtd flag: documented only as "Transaction list by
// first time deposit", it reads two ways and once put a long-standing client
// under a "first ever deposit" heading.
export const HISTORY_LOOKUP_LIMIT = 1000;

async function hasNoDepositBefore(userId, weekStartYmd) {
  const prior = await crmPost("transactions", {
    fromUserId: Number(userId),
    statuses: TX_STATUSES,
    processedAt: { begin: "1970-01-01 00:00:00", end: `${weekStartYmd} 00:00:00` },
    segment: { limit: HISTORY_LOOKUP_LIMIT, offset: 0 },
  });
  // Only a real deposit disqualifies. An earlier withdrawal, internal transfer
  // or credit does not make this week's deposit their second.
  return !dedupeById(prior).some((row) => classifyTx(row?.type) === "deposit");
}

export async function findFirstTimeDepositors(depositors, fromYmd, toYmd) {
  const candidates = depositors.filter((d) => d.deposits > 0 && Number.isFinite(d.userId) && d.userId > 0);

  // Stage 1 — the CRM field, free.
  const shortlist = [];
  let excludedByCrm = 0;
  for (const c of candidates) {
    const crmDay = c.firstDepositDate ? String(c.firstDepositDate).slice(0, 10) : null;
    if (crmDay && (crmDay < fromYmd || crmDay > toYmd)) {
      excludedByCrm += 1;
      continue;
    }
    shortlist.push({ ...c, crmDay });
  }

  // Stage 2 — confirm each survivor against its own transactions.
  const checked = await mapWithConcurrency(
    shortlist,
    async (c) => {
      try {
        const confirmed = await hasNoDepositBefore(c.userId, fromYmd);
        return {
          ...c,
          firstTime: confirmed,
          verified: true,
          // CRM said this week; the ledger disagrees.
          conflict: Boolean(c.crmDay) && !confirmed,
        };
      } catch (error) {
        console.warn(`[SummaryCore] history lookup failed for client ${c.userId}:`, error?.message || error);
        // Unconfirmed is never listed: claiming a long-standing client is new
        // is the exact failure this design exists to prevent.
        return { ...c, firstTime: false, verified: false, conflict: false };
      }
    },
    5,
  );

  return {
    rows: checked.filter((c) => c.firstTime).sort((a, b) => b.deposits - a.deposits),
    unverified: checked.filter((c) => !c.verified).length,
    conflicts: checked.filter((c) => c.conflict).length,
    noCrmDate: shortlist.filter((c) => !c.crmDay).length,
    shortlisted: shortlist.length,
    excludedByCrm,
    checked: candidates.length,
  };
}

// Transactions carry only fromUserId, so names come from /rest/users. Batched:
// one call per 200 clients rather than one per client.
export const USER_BATCH = 200;

export async function attachClientNames(rows) {
  const ids = [...new Set(rows.map((r) => r.userId).filter((v) => Number.isFinite(v) && v > 0))];
  const names = new Map();
  const firstDeposits = new Map();

  for (let i = 0; i < ids.length; i += USER_BATCH) {
    const batch = ids.slice(i, i + USER_BATCH);
    try {
      const users = await crmPost("users", { ids: batch, segment: { limit: batch.length, offset: 0 } });
      for (const user of users) {
        const id = Number(user?.id);
        const name = [user?.firstName, user?.lastName]
          .map((part) => String(part || "").trim())
          .filter(Boolean)
          .join(" ");
        if (!Number.isFinite(id)) continue;
        if (name) names.set(id, name);
        // Same record, no extra call: the CRM's own first-deposit date.
        if (user?.firstDepositDate) firstDeposits.set(id, String(user.firstDepositDate));
      }
    } catch (error) {
      console.warn("[SummaryCore] user name lookup failed:", error?.message || error);
    }
  }

  for (const row of rows) {
    row.name = names.get(row.userId) || (row.userId ? `Client #${row.userId}` : "Unattached account");
    row.firstDepositDate = firstDeposits.get(row.userId) || null;
  }
  return { names: names.size, firstDepositDates: firstDeposits.size };
}

// The glance's trading headline. Fetched in its own try so a backend outage
// renders the tile as a dash rather than losing the whole report.
export async function fetchGlance(week) {
  const glance = { totalRevenue: null };
  // A dash with no explanation is indistinguishable from a genuine zero. Every
  // failure here is surfaced in the footer.
  const failures = [];
  const { from, to } = toUnixRange(week.start, week.end);

  try {
    const params = new URLSearchParams({ group: "*", from: String(from), to: String(to), symbol: "", lite: "true" });
    // A week of deals took longer than the original 45s, which is why Total
    // Revenue came back empty on the first live send.
    const resp = await backendFetch(`/DealMatch/Run?${params}`, { timeoutMs: 180_000 });
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
    console.warn("[SummaryCore] DealMatch lookup failed:", error?.message || error);
    failures.push(`DealMatch unavailable: ${error?.message || error}`);
  }

  // ClientVolume/Run and SlippageReport/Run used to be called here for the
  // Traded Lots and LP Slippage tiles. Those tiles were dropped, so the calls
  // went with them -- both figures still have their own dedicated weekly report.

  return { glance, failures };
}

// ── equity position ─────────────────────────────────────────────────────────
// A SNAPSHOT taken when the email is built, not a figure for the reporting
// week. Everything else in this report covers Sat->Fri; these six do not, and
// the section says so, because a reader will otherwise assume they match.
//
// Two endpoints, mirroring the dealing Metrics tab exactly so the email and the
// dashboard cannot disagree:
//   Metrics/dashboard        the withdrawable trio, ready-made by the backend.
//                            Its totals also carry LP equity and LP credit, so
//                            the LP line reconciles within this payload:
//                            totals.equity - totals.credit == lpWithdrawableEquity.
//                            It reports no client credit.
//   EquityOverview/dashboard the credit-inclusive trio, the only source with
//                            credit for clients as well as LPs.
// They are separate fetches, so the two rows are snapshots seconds apart.
export async function fetchEquityPosition() {
  const position = { withdrawable: null, gross: null };

  try {
    const resp = await backendFetch(`/Metrics/dashboard`, { timeoutMs: 45_000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    position.withdrawable = {
      lpEquity: num(raw?.totals?.equity),
      lpCredit: num(raw?.totals?.credit),
      lpWithdrawable: num(raw?.lpWithdrawableEquity),
      clientWithdrawable: num(raw?.clientWithdrawableEquity),
      difference: num(raw?.difference),
    };
  } catch (error) {
    console.warn("[SummaryCore] Metrics/dashboard lookup failed:", error?.message || error);
  }

  try {
    const resp = await backendFetch(`/EquityOverview/dashboard`, { timeoutMs: 60_000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.json();
    const sum = (group, field) =>
      (Array.isArray(group?.items) ? group.items : []).reduce((total, item) => total + num(item?.[field]), 0);
    const lpEquity = sum(raw?.lps, "equity");
    const clientEquity = sum(raw?.clients, "equity");
    position.gross = {
      lpEquity,
      lpCredit: sum(raw?.lps, "credit"),
      lpWithdrawable: sum(raw?.lps, "withdrawableEquity"),
      clientEquity,
      clientCredit: sum(raw?.clients, "credit"),
      clientWithdrawable: sum(raw?.clients, "withdrawableEquity"),
      difference: lpEquity - clientEquity,
    };
  } catch (error) {
    console.warn("[SummaryCore] EquityOverview/dashboard lookup failed:", error?.message || error);
  }

  return position;
}

// ── closing balance ─────────────────────────────────────────────────────────
// The treasury figures from the Closing Balance Report on the dashboard: what
// is still owed to us, what is due to go out to the LPs, and the net position.
// Another SNAPSHOT, not a figure for the reporting week.
//
// Most of these come from the finance Google Sheet through the cell mapping in
// wallet/googleSheetsMappingConfig.js, so they are only as current as the sheet.
// The exception is Net all Current Balance, which walletMonitor derives from the
// live PSP balances rather than the sheet -- see the note beside it below.
//
// Imported dynamically: the report and the wallet monitor run in the same
// process, so this avoids an HTTP call to our own server, and a resolution
// failure lands in the same catch as any other error rather than breaking the
// module for tests that never need it.
export async function fetchClosingBalance() {
  const { checkAllBalances } = await import("../wallet/walletMonitor.js");
  const report = await checkAllBalances();
  const d = report?.data || {};
  return {
    bankReceivable: num(d.bank_receivable),
    cryptoReceivable: num(d.crypto_receivable),
    toLpsBank: num(d.to_be_deposited_into_lps_k20),
    toLpsCrypto: num(d.to_be_deposited_into_lps_k21),
    netAllCurrentBalance: num(d.net_all_current_balance),
    netAfterExpectedFunds: num(d.net_balance_after_expected_funds),
    differenceActualVsExpected: num(d.difference_between_actual_and_expected),
    creditByLps: num(d.credit_by_lps),
  };
}

// ── chart ───────────────────────────────────────────────────────────────────

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDayLabel(ymd) {
  const parts = String(ymd || "").split("-");
  if (parts.length !== 3) return String(ymd || "");
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  if (Number.isNaN(date.getTime())) return String(ymd);
  return `${DAY_NAMES[date.getUTCDay()]} ${parts[2]} ${MONTH_NAMES[Number(parts[1]) - 1]}`;
}

export const shortMoney = (v) => {
  const n = Math.abs(Number(v) || 0);
  return n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${n.toFixed(0)}`;
};

export async function buildDailyChart(byDay, titleSuffix) {
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

// One row per CRM client. The composite fromLoginSid ("1-43", "2-101939") is
// deliberately not shown: those are per-account wallet/trading ids belonging to
// a client, not separate customers.
export const ACCOUNT_HEADERS = [
  { label: "Client", width: "32%" },
  { label: "Client ID", width: "10%" },
  { label: "Deposits", width: "15%" },
  { label: "Withdrawals", width: "15%" },
  { label: "IB Rebate", width: "14%" },
  { label: "Net", width: "14%" },
];

export const EXCLUDED_LABELS = {
  internal: "internal transfers between a client's own accounts",
  credit: "credit / bonus",
  "ib-mirror": "second leg of IB transfers",
};

export const dash = "&mdash;";
export const orDash = (value, fmt) => (value === null || value === undefined ? dash : fmt(value));
export const signCls = (v) => (num(v) > 0 ? "pos" : num(v) < 0 ? "neg" : "");

