import { getMarketingInsights } from "../ga4.js";

const DEFAULT_GROUP = "*";

const BACKEND_BASE_URL = String(process.env.VITE_BACKEND_BASE_URL || process.env.BACKEND_BASE_URL || "").replace(/\/+$/, "");
const PORTAL_TRANSACTIONS_URL = process.env.VITE_API_URL || "https://portal.skylinkscapital.com/rest/transactions";
const PORTAL_VERSION = process.env.VITE_API_VERSION || "";
const PORTAL_TOKEN = process.env.VITE_API_TOKEN || "";
const WALLET_URL = process.env.VITE_WALLET_URL || "";
const WALLET_TOKEN = process.env.VITE_WALLET_TOKEN || process.env.WALLET_API_TOKEN || "";

function toIsoDate(input) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toDdMmYyyy(input) {
  const d = new Date(input);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = String(d.getUTCFullYear());
  return `${day}-${month}-${year}`;
}

function buildRange(input = {}) {
  const now = new Date();
  const from = toIsoDate(input.fromDate) || toIsoDate(now);
  const to = toIsoDate(input.toDate) || toIsoDate(now);
  const fromTs = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
  const toTs = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000);
  return { from, to, fromTs, toTs };
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} from ${url}${text ? `: ${text}` : ""}`);
  }
  return resp.json();
}

function buildBackendUrl(path) {
  if (BACKEND_BASE_URL) return `${BACKEND_BASE_URL}${path}`;
  throw new Error("VITE_BACKEND_BASE_URL is not configured for agent backend calls");
}

function buildPortalUrl(url) {
  if (!PORTAL_VERSION) return url;
  const hasQuery = url.includes("?");
  return `${url}${hasQuery ? "&" : "?"}version=${encodeURIComponent(PORTAL_VERSION)}`;
}

async function postPortal(url, body) {
  if (!PORTAL_TOKEN) throw new Error("VITE_API_TOKEN is not configured");
  return fetchJson(buildPortalUrl(url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${PORTAL_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getDealingSummary(params = {}) {
  const range = buildRange(params);
  const group = params.group || DEFAULT_GROUP;
  const url = new URL(buildBackendUrl("/Report/GetSummaryByGroup"));
  url.searchParams.set("group", group);
  url.searchParams.set("from", toDdMmYyyy(range.from));
  url.searchParams.set("to", toDdMmYyyy(range.to));

  const data = await fetchJson(url.toString(), {
    headers: { accept: "text/plain" },
  });

  return {
    fromDate: range.from,
    toDate: range.to,
    mode: range.from === toIsoDate(new Date()) && range.to === toIsoDate(new Date()) ? "live" : "reports",
    totalEquity: toNumber(data.currentEquity),
    totalCredit: toNumber(data.currentCredit),
    netLots: toNumber(data.netLots),
    buyLots: toNumber(data.netLotsBuy),
    sellLots: toNumber(data.netLotsSell),
    tradingProfit: toNumber(data.tradingProfit),
    totalVolume: null,
    deals: toNumber(data.dealCount),
    raw: data,
  };
}

export async function getCoverageMetrics() {
  const url = buildBackendUrl("/Coverage/position-match-table");
  const data = await fetchJson(url);
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const totals = data?.totals || {};
  const clientNetAbs = Math.abs(toNumber(totals.clientNet));
  const uncoveredAbs = Math.abs(toNumber(totals.uncovered));
  const coveragePct = clientNetAbs > 0 ? ((clientNetAbs - uncoveredAbs) / clientNetAbs) * 100 : 0;
  const topUncovered = [...rows]
    .sort((a, b) => Math.abs(toNumber(b.uncovered)) - Math.abs(toNumber(a.uncovered)))
    .slice(0, 5)
    .map((r) => ({ symbol: r.symbol, uncovered: toNumber(r.uncovered), clientNet: toNumber(r.clientNet) }));
  return {
    lpCount: Array.isArray(data?.lpNames) ? data.lpNames.length : 0,
    symbolCount: rows.length,
    totalUncovered: toNumber(totals.uncovered),
    coveragePct,
    topUncovered,
    raw: data,
  };
}

export async function getLpMetrics() {
  const data = await fetchJson(buildBackendUrl("/Metrics/lp"));
  const items = Array.isArray(data?.items) ? data.items : [];
  const avgMarginLevel =
    items.length > 0 ? items.reduce((sum, item) => sum + toNumber(item.marginLevel), 0) / items.length : 0;
  const lowestMargin = [...items]
    .sort((a, b) => toNumber(a.marginLevel) - toNumber(b.marginLevel))
    .slice(0, 5)
    .map((r) => ({ lp: r.lp, marginLevel: toNumber(r.marginLevel), equity: toNumber(r.equity) }));
  return {
    accountCount: items.length,
    avgMarginLevel,
    totals: {
      equity: toNumber(data?.totals?.equity),
      balance: toNumber(data?.totals?.balance),
      margin: toNumber(data?.totals?.margin),
      freeMargin: toNumber(data?.totals?.freeMargin),
      credit: toNumber(data?.totals?.credit),
    },
    lowestMargin,
    raw: data,
  };
}

export async function getSwapMetrics() {
  const data = await fetchJson(buildBackendUrl("/Swap/positions"));
  const rows = Array.isArray(data) ? data : [];
  return {
    positionCount: rows.length,
    dueTonight: rows.filter((r) => Boolean(r.willChargeTonight)).length,
    negativeSwapPositions: rows.filter((r) => toNumber(r.swap) < 0).length,
    totalSwap: rows.reduce((sum, row) => sum + toNumber(row.swap), 0),
    raw: rows,
  };
}

export async function getHistoryAggregate(params = {}) {
  const range = buildRange(params);
  const url = buildBackendUrl(`/History/aggregate?from=${range.fromTs}&to=${range.toTs}`);
  const data = await fetchJson(url);
  return {
    rowCount: Array.isArray(data?.items) ? data.items.length : 0,
    totals: {
      netPL: toNumber(data?.totals?.netPL),
      realLpPL: toNumber(data?.totals?.realLpPL),
      lpPL: toNumber(data?.totals?.lpPL),
      grossProfit: toNumber(data?.totals?.grossProfit),
    },
    raw: data,
  };
}

export async function getLpAccounts() {
  const data = await fetchJson(buildBackendUrl("/api/LpAccount"));
  const rows = Array.isArray(data) ? data : [];
  return {
    count: rows.length,
    lpNames: rows.map((x) => x.lpName).filter(Boolean),
    raw: rows,
  };
}

export async function getAccountsMetrics(params = {}) {
  const range = buildRange(params);
  const begin = `${range.from} 00:00:00`;
  const end = `${range.to} 23:59:59`;

  const [deposits, withdrawals] = await Promise.all([
    postPortal(PORTAL_TRANSACTIONS_URL, {
      processedAt: { begin, end },
      transactionTypes: ["deposit"],
      statuses: ["approved"],
    }),
    postPortal(PORTAL_TRANSACTIONS_URL, {
      processedAt: { begin, end },
      transactionTypes: ["withdrawal"],
      statuses: ["approved"],
    }),
  ]);

  const safeDeposits = Array.isArray(deposits)
    ? deposits.filter((tx) => !String(tx?.platformComment || "").toLowerCase().includes("negative bal"))
    : [];
  const totalDeposits = safeDeposits.reduce((sum, tx) => sum + toNumber(tx?.processedAmount), 0);
  const totalWithdrawals = Math.abs(
    (Array.isArray(withdrawals) ? withdrawals : []).reduce((sum, tx) => sum + toNumber(tx?.processedAmount), 0),
  );

  let wallet = null;
  if (WALLET_URL && WALLET_TOKEN) {
    const url = WALLET_URL.includes("?")
      ? `${WALLET_URL}&token=${encodeURIComponent(WALLET_TOKEN)}`
      : `${WALLET_URL}?token=${encodeURIComponent(WALLET_TOKEN)}`;
    wallet = await fetchJson(url).catch(() => null);
  }

  return {
    totalDeposits,
    totalWithdrawals,
    netFlow: totalDeposits - totalWithdrawals,
    walletTotal: toNumber(wallet?.data?.total_balance),
    bankReceivable: toNumber(wallet?.data?.bank_receivable),
    cryptoReceivable: toNumber(wallet?.data?.crypto_receivable),
    raw: {
      depositsCount: Array.isArray(safeDeposits) ? safeDeposits.length : 0,
      withdrawalsCount: Array.isArray(withdrawals) ? withdrawals.length : 0,
    },
  };
}

export async function getBackofficeMetrics(params = {}) {
  const range = buildRange(params);
  const begin = `${range.from} 00:00:00`;
  const end = `${range.to} 23:59:59`;
  const usersUrl = PORTAL_TRANSACTIONS_URL.replace("/transactions", "/users");
  const accountsUrl = PORTAL_TRANSACTIONS_URL.replace("/transactions", "/accounts");

  const [users, accounts, deposits, withdrawals, ibWithdrawals] = await Promise.all([
    postPortal(usersUrl, { created: { begin, end } }),
    postPortal(accountsUrl, { createdAt: { begin, end }, segment: { limit: 1000, offset: 0 } }),
    postPortal(PORTAL_TRANSACTIONS_URL, {
      processedAt: { begin, end },
      transactionTypes: ["deposit"],
      statuses: ["approved"],
    }),
    postPortal(PORTAL_TRANSACTIONS_URL, {
      processedAt: { begin, end },
      transactionTypes: ["withdrawal"],
      statuses: ["approved"],
    }),
    postPortal(PORTAL_TRANSACTIONS_URL, {
      processedAt: { begin, end },
      transactionTypes: ["ib withdrawal"],
      statuses: ["approved"],
    }),
  ]);

  const usersList = Array.isArray(users) ? users : [];
  const accountsList = Array.isArray(accounts) ? accounts : [];
  const approvedKyc = usersList.filter((u) => {
    const val = u?.customFields?.custom_compliance_approval;
    return val === "Approved" || val === "Approved with Conditions";
  }).length;
  const pendingKyc = usersList.filter((u) => {
    const val = u?.customFields?.custom_compliance_approval;
    return !val || val === "Pending";
  }).length;
  const rejectedKyc = usersList.filter((u) => u?.customFields?.custom_compliance_approval === "Rejected").length;

  return {
    totalClients: usersList.length,
    totalMt5Accounts: accountsList.length,
    deposits: Array.isArray(deposits) ? deposits.length : 0,
    withdrawals: Array.isArray(withdrawals) ? withdrawals.length : 0,
    ibs: Array.isArray(ibWithdrawals) ? ibWithdrawals.length : 0,
    kyc: { approved: approvedKyc, pending: pendingKyc, rejected: rejectedKyc },
    raw: {
      activeAccounts: accountsList.filter((a) => a?.tradingStatus === "active").length,
    },
  };
}

export async function getMarketingMetrics(params = {}) {
  const range = buildRange(params);
  const data = await getMarketingInsights(range.from, range.to);
  return {
    sessions: toNumber(data?.main?.sessions),
    activeUsers: toNumber(data?.main?.activeUsers),
    newUsers: toNumber(data?.main?.newUsers),
    conversions: toNumber(data?.main?.conversions),
    bounceRate: toNumber(data?.main?.bounceRate),
    engagementDuration: toNumber(data?.main?.engagementDuration),
    topCountries: Array.isArray(data?.activeUsersByCountry) ? data.activeUsersByCountry.slice(0, 5) : [],
    raw: data,
  };
}

export async function getLiveSnapshot(params = {}) {
  const range = buildRange(params);
  const [dealing, coverage, lpMetrics, swap, history] = await Promise.allSettled([
    getDealingSummary(range),
    getCoverageMetrics(),
    getLpMetrics(),
    getSwapMetrics(),
    getHistoryAggregate(range),
  ]);

  const getVal = (r) => (r.status === "fulfilled" ? r.value : null);
  return {
    asOf: new Date().toISOString(),
    range,
    dealing: getVal(dealing),
    coverage: getVal(coverage),
    lpMetrics: getVal(lpMetrics),
    swap: getVal(swap),
    history: getVal(history),
  };
}

export const dateUtils = { buildRange };
