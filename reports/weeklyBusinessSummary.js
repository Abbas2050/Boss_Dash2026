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

// Weekly Business Summary — money movement and account activity, with a glance
// strip that also carries the trading headline. Design:
// docs/superpowers/specs/2026-08-07-weekly-business-summary-design.md
//
// Sent Saturday 10:00 Dubai, AFTER Deal Match (09:00) and Slippage (09:30), so
// the glance is never computed before the reports it summarises. The week is
// Saturday->Friday, closed the previous night -- see previousFullWeekUtc().
const DEFAULT_SCHEDULE = "0 10 * * 6"; // 10:00 every Saturday (UAE time)
const DEFAULT_TIMEZONE = "Asia/Dubai";

const LARGE_DEPOSIT_THRESHOLD = Number(process.env.SUMMARY_LARGE_DEPOSIT_THRESHOLD || 1000);
const TX_STATUSES = parseRecipients(process.env.SUMMARY_TX_STATUSES || "approved");

const num = (v) => Number(v) || 0;

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
const TX_KINDS = new Map([
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

const txPsp = (row) => String(row?.psp || "").trim() || "Unattributed";

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

const TX_SEGMENT_LIMIT = 5000;

async function fetchTransactions(fromYmd, toYmd) {
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
  if (dropped) console.warn(`[WeeklySummary] dropped ${dropped} duplicate transaction id(s)`);
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

async function fetchClientVolume(fromYmd, toYmd) {
  const params = new URLSearchParams({ from: fromYmd, to: toYmd, group: "*" });
  const resp = await fetch(`${BACKEND_BASE_URL}/ClientVolume/Run?${params}`, {
    signal: AbortSignal.timeout(60_000),
  });
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
const HISTORY_LOOKUP_LIMIT = 1000;

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
        console.warn(`[WeeklySummary] history lookup failed for client ${c.userId}:`, error?.message || error);
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
const USER_BATCH = 200;

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
      console.warn("[WeeklySummary] user name lookup failed:", error?.message || error);
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
async function fetchGlance(week) {
  const glance = { totalRevenue: null };
  // A dash with no explanation is indistinguishable from a genuine zero. Every
  // failure here is surfaced in the footer.
  const failures = [];
  const { from, to } = toUnixRange(week.start, week.end);

  try {
    const params = new URLSearchParams({ group: "*", from: String(from), to: String(to), symbol: "", lite: "true" });
    // A week of deals took longer than the original 45s, which is why Total
    // Revenue came back empty on the first live send.
    const resp = await fetch(`${BACKEND_BASE_URL}/DealMatch/Run?${params}`, { signal: AbortSignal.timeout(180_000) });
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
    failures.push(`DealMatch unavailable: ${error?.message || error}`);
  }

  // ClientVolume/Run and SlippageReport/Run used to be called here for the
  // Traded Lots and LP Slippage tiles. Those tiles were dropped, so the calls
  // went with them -- both figures still have their own dedicated weekly report.

  return { glance, failures };
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

// One row per CRM client. The composite fromLoginSid ("1-43", "2-101939") is
// deliberately not shown: those are per-account wallet/trading ids belonging to
// a client, not separate customers.
const ACCOUNT_HEADERS = [
  { label: "Client", width: "32%" },
  { label: "Client ID", width: "10%" },
  { label: "Deposits", width: "15%" },
  { label: "Withdrawals", width: "15%" },
  { label: "IB Rebate", width: "14%" },
  { label: "Net", width: "14%" },
];

const EXCLUDED_LABELS = {
  internal: "internal transfers between a client's own accounts",
  credit: "credit / bonus",
  "ib-mirror": "second leg of IB transfers",
};

const dash = "&mdash;";
const orDash = (value, fmt) => (value === null || value === undefined ? dash : fmt(value));
const signCls = (v) => (num(v) > 0 ? "pos" : num(v) < 0 ? "neg" : "");

export function buildSummaryEmailHtml({
  fromYmd, toYmd, agg, glance,
  firstTimers = { rows: [], unverified: 0, checked: 0 },
  instruments = { rows: [], totalLots: 0, instrumentCount: 0 },
  chartUrl = null, notices = [],
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
    { label: "First-Time Depositors", value: fmtNum(firstTimers.rows.length, 0), cls: "pos", note: `${money(firstTimerTotal)} over ${fmtNum(firstTimerCount, 0)} deposit${firstTimerCount === 1 ? "" : "s"}` },
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

  const body = `
          <p class="section-title" style="margin-top:0;">Last Week at a Glance</p>
          ${glanceCards}

          <p class="section-title">Large Depositors</p>
          <p class="note">Accounts that deposited more than ${money(LARGE_DEPOSIT_THRESHOLD)} this week &mdash; the subset of Account Activity below.</p>
          ${dataTable({
            headers: ACCOUNT_HEADERS,
            totalRow: agg.largeDepositors.length ? largeTotalRow : "",
            bodyRows: largeRows,
            emptyText: `No accounts deposited more than ${money(LARGE_DEPOSIT_THRESHOLD)} this week.`,
          })}

          <p class="section-title">First-Time Depositors</p>
          <p class="note">Accounts whose <strong>first ever deposit</strong> landed this week. Confirmed twice: the CRM&rsquo;s own <em>firstDepositDate</em> on the client record, <em>and</em> that client&rsquo;s transaction history before ${escapeHtml(fromYmd)} containing no earlier deposit. A client is listed only when both agree.</p>
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
            emptyText: "No first-time depositors this week.",
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
            emptyText: "No traded volume this week.",
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

          <p class="section-title">Account Activity</p>
          <p class="note">Every account that moved money during the week, largest deposit first. Net = Deposits &minus; Withdrawals &minus; IB Rebate.</p>
          ${dataTable({
            headers: ACCOUNT_HEADERS,
            totalRow: agg.depositors.length ? depositorTotalRow : "",
            bodyRows: depositorRows,
            emptyText: "No deposits this week.",
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
            emptyText: "No settled transactions for this week.",
          })}`;

  const footerLines = [
    "Automated Weekly Business Summary.",
    `Net = Deposits &minus; Withdrawals &minus; IB Rebate, counting ${escapeHtml(TX_STATUSES.join(", "))} transactions only. Amounts use magnitudes; direction comes from the transaction type.`,
    "Deposits and Withdrawals are <strong>client money only</strong>. IB commission is held in its own column so it is never counted twice &mdash; an <em>ib withdrawal</em> sits in IB Rebate, not in Withdrawals.",
    `IB Rebate is the ${escapeHtml("ib transfer to account")} and ${escapeHtml("ib withdrawal")} settled this week. The Deal Match report derives IB commission from <em>current</em> CRM wallet balances instead, so the two can differ &mdash; this one is fixed for a closed week, that one drifts between runs.`,
    `Total Revenue = markup + client commission &minus; LP commission, from <code>DealMatch/Run</code>. Net Revenue = Total Revenue &minus; IB Rebate.`,
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
  const html = buildSummaryEmailHtml({ fromYmd, toYmd, agg, glance, firstTimers, instruments, chartUrl, notices });
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
