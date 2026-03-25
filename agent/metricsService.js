import { getMarketingInsights } from "../ga4.js";
import { SWAGGER_ENDPOINTS, SWAGGER_META } from "./swaggerCatalog.js";

const DEFAULT_GROUP = "*";

const DEFAULT_BACKEND_BASE_URL = "https://api.skylinkscapital.com";
const BACKEND_BASE_URL = String(
  process.env.VITE_BACKEND_BASE_URL ||
    process.env.BACKEND_BASE_URL ||
    process.env.BACKEND_API_BASE_URL ||
    DEFAULT_BACKEND_BASE_URL,
).replace(/\/+$/, "");
const PORTAL_TRANSACTIONS_URL = process.env.VITE_API_URL || "https://portal.skylinkscapital.com/rest/transactions";
const PORTAL_VERSION = process.env.VITE_API_VERSION || "";
const PORTAL_TOKEN = process.env.VITE_API_TOKEN || "";
const WALLET_URL = process.env.VITE_WALLET_URL || "";
const WALLET_TOKEN = process.env.VITE_WALLET_TOKEN || process.env.WALLET_API_TOKEN || "";
const PORTAL_USERS_URL = PORTAL_TRANSACTIONS_URL.replace("/transactions", "/users");
const PORTAL_ACCOUNTS_URL = PORTAL_TRANSACTIONS_URL.replace("/transactions", "/accounts");

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

function normalizeMethod(method) {
  const m = String(method || "get").toLowerCase();
  return ["get", "post", "put", "delete", "patch", "options", "head", "trace"].includes(m) ? m : "get";
}

function findSwaggerEndpoint(path, method) {
  const wantedPath = String(path || "").trim();
  const wantedMethod = normalizeMethod(method);
  return SWAGGER_ENDPOINTS.find((ep) => ep.path === wantedPath && ep.method === wantedMethod) || null;
}

function resolvePathTemplate(path, pathParams = {}) {
  return String(path || "").replace(/\{([^}]+)\}/g, (_, key) => {
    const val = pathParams?.[key];
    if (val === undefined || val === null) {
      throw new Error(`Missing path param: ${key}`);
    }
    return encodeURIComponent(String(val));
  });
}

const READ_ONLY_APP_ENDPOINTS = [
  {
    id: "report.summary_by_group",
    kind: "swagger",
    method: "get",
    path: "/Report/GetSummaryByGroup",
    tag: "Dealing",
    description: "Dealing summary by account group.",
  },
  {
    id: "coverage.position_match_table",
    kind: "swagger",
    method: "get",
    path: "/Coverage/position-match-table",
    tag: "Coverage",
    description: "Coverage position match table across LPs.",
  },
  {
    id: "coverage.symbol_dashboard",
    kind: "swagger",
    method: "get",
    path: "/Coverage/dashboard/{baseSymbol}",
    tag: "Coverage",
    description: "Coverage dashboard for a specific symbol.",
  },
  {
    id: "coverage.lp_positions",
    kind: "swagger",
    method: "get",
    path: "/Coverage/lp/{lpName}/positions",
    tag: "Coverage",
    description: "Current positions held by a specific LP.",
  },
  {
    id: "metrics.lp",
    kind: "swagger",
    method: "get",
    path: "/Metrics/lp",
    tag: "Metrics",
    description: "LP metrics including equity and margin.",
  },
  {
    id: "metrics.equity_summary",
    kind: "swagger",
    method: "get",
    path: "/Metrics/equity-summary",
    tag: "Metrics",
    description: "LP and client withdrawable equity summary.",
  },
  {
    id: "swap.positions",
    kind: "swagger",
    method: "get",
    path: "/Swap/positions",
    tag: "Swap",
    description: "Swap positions and tonight charge status.",
  },
  {
    id: "history.aggregate",
    kind: "swagger",
    method: "get",
    path: "/History/aggregate",
    tag: "History",
    description: "History aggregate metrics by date range.",
  },
  {
    id: "history.deals",
    kind: "swagger",
    method: "get",
    path: "/History/deals",
    tag: "History",
    description: "History deals for a specific login and period.",
  },
  {
    id: "history.volume",
    kind: "swagger",
    method: "get",
    path: "/History/volume",
    tag: "History",
    description: "History volume metrics by LP/account.",
  },
  {
    id: "deal.by_group",
    kind: "swagger",
    method: "get",
    path: "/Deal/GetDealsByGroup",
    tag: "Deal",
    description: "Deals by account group and date range.",
  },
  {
    id: "account.by_login",
    kind: "swagger",
    method: "get",
    path: "/Account/GetAccountByLogin",
    tag: "Account",
    description: "Account details for a trading login.",
  },
  {
    id: "account.user_info",
    kind: "swagger",
    method: "get",
    path: "/Account/GetUserInfo",
    tag: "Account",
    description: "User information for a trading login.",
  },
  {
    id: "account.user_info_batch",
    kind: "swagger",
    method: "get",
    path: "/Account/GetUserInfoBatch",
    tag: "Account",
    description: "Batch user information by login list.",
  },
  {
    id: "bonus.dashboard",
    kind: "swagger",
    method: "get",
    path: "/Bonus/dashboard",
    tag: "Bonus",
    description: "Bonus dashboard snapshot.",
  },
  {
    id: "bonus.status",
    kind: "swagger",
    method: "get",
    path: "/Bonus/status",
    tag: "Bonus",
    description: "Bonus status snapshot.",
  },
  {
    id: "bonus.pnl_summary",
    kind: "swagger",
    method: "get",
    path: "/Bonus/pnl-summary",
    tag: "Bonus",
    description: "Bonus PnL summary data.",
  },
  {
    id: "bonus.pnl_smart",
    kind: "swagger",
    method: "get",
    path: "/Bonus/pnl-smart",
    tag: "Bonus",
    description: "Bonus daily PnL detail for date range.",
  },
  {
    id: "bonus.pnl_monthly_report",
    kind: "swagger",
    method: "get",
    path: "/Bonus/pnl-monthly-report",
    tag: "Bonus",
    description: "Bonus monthly report by from date.",
  },
  {
    id: "contract_size.list",
    kind: "swagger",
    method: "get",
    path: "/api/ContractSize",
    tag: "ContractSize",
    description: "Contract size mappings.",
  },
  {
    id: "contract_size.detect",
    kind: "swagger",
    method: "get",
    path: "/api/ContractSize/detect/{symbol}",
    tag: "ContractSize",
    description: "Detect client/lp contract size for a symbol.",
  },
  {
    id: "lp.accounts",
    kind: "swagger",
    method: "get",
    path: "/api/LpAccount",
    tag: "LpAccount",
    description: "Configured LP account registry.",
  },
  {
    id: "symbol.mapping",
    kind: "swagger",
    method: "get",
    path: "/api/SymbolMapping",
    tag: "SymbolMapping",
    description: "Symbol mapping rules used by settings.",
  },
  {
    id: "portal.users.search",
    kind: "portal-post",
    target: "users",
    tag: "Portal",
    description: "Portal user search endpoint used for client lookups.",
  },
  {
    id: "portal.accounts.search",
    kind: "portal-post",
    target: "accounts",
    tag: "Portal",
    description: "Portal trading account search endpoint.",
  },
  {
    id: "portal.transactions.search",
    kind: "portal-post",
    target: "transactions",
    tag: "Portal",
    description: "Portal transaction search endpoint.",
  },
  {
    id: "wallet.snapshot",
    kind: "wallet-get",
    tag: "Wallet",
    description: "Wallet and PSP balances snapshot.",
  },
];

const ENDPOINT_PARAM_CONTRACTS = {
  "history.deals": {
    query: ["login"],
  },
  "account.by_login": {
    query: ["login"],
  },
  "account.user_info": {
    query: ["login"],
  },
  "coverage.symbol_dashboard": {
    pathParams: ["baseSymbol"],
  },
  "coverage.lp_positions": {
    pathParams: ["lpName"],
  },
  "contract_size.detect": {
    pathParams: ["symbol"],
  },
};

function findAppEndpoint(endpointId) {
  return READ_ONLY_APP_ENDPOINTS.find((endpoint) => endpoint.id === endpointId) || null;
}

function listReadableSwaggerEndpoints() {
  return SWAGGER_ENDPOINTS.filter((ep) => ["get", "head", "options"].includes(String(ep.method || "").toLowerCase())).map((ep) => ({
    id: `swagger:${ep.id}`,
    kind: "swagger-catalog",
    method: String(ep.method || "get"),
    path: ep.path,
    tag: ep.tag || "General",
    description: ep.summary || `Swagger endpoint ${ep.method?.toUpperCase?.() || "GET"} ${ep.path}`,
  }));
}

function getPortalTargetUrl(target) {
  if (target === "users") return PORTAL_USERS_URL;
  if (target === "accounts") return PORTAL_ACCOUNTS_URL;
  return PORTAL_TRANSACTIONS_URL;
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

export async function getCoverageBySymbol(params = {}) {
  const symbol = String(params.symbol || params.baseSymbol || "").trim().toUpperCase();
  if (!symbol) throw new Error("symbol is required");
  const data = await fetchJson(buildBackendUrl(`/Coverage/dashboard/${encodeURIComponent(symbol)}`));
  const rows = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
  const totals = data?.totals || {};
  return {
    symbol,
    rowCount: rows.length,
    clientNet: toNumber(totals.clientNet ?? data?.clientNet),
    uncovered: toNumber(totals.uncovered ?? data?.uncovered),
    lpCount: Array.isArray(data?.lpNames) ? data.lpNames.length : 0,
    coveragePct: Math.abs(toNumber(totals.clientNet ?? data?.clientNet)) > 0
      ? ((Math.abs(toNumber(totals.clientNet ?? data?.clientNet)) - Math.abs(toNumber(totals.uncovered ?? data?.uncovered))) /
          Math.abs(toNumber(totals.clientNet ?? data?.clientNet))) *
        100
      : 0,
    lpBreakdown: Array.isArray(data?.lpNames)
      ? data.lpNames.map((lp) => ({ lp, net: toNumber(totals.lpNets?.[lp]) }))
      : [],
    raw: data,
  };
}

export async function getLpPositions(params = {}) {
  const lpName = String(params.lpName || params.lp || "").trim();
  if (!lpName) throw new Error("lpName is required");
  const rows = await fetchJson(buildBackendUrl(`/Coverage/lp/${encodeURIComponent(lpName)}/positions`));
  const items = Array.isArray(rows) ? rows : [];
  const grouped = new Map();
  for (const row of items) {
    const symbol = String(row?.symbol || row?.baseSymbol || "").toUpperCase() || "UNKNOWN";
    const current = grouped.get(symbol) || { symbol, positions: 0, netLots: 0, buyLots: 0, sellLots: 0 };
    const lots = toNumber(row?.lots ?? row?.volume ?? row?.netLots);
    const side = String(row?.side || row?.direction || row?.action || "").toUpperCase();
    current.positions += 1;
    current.netLots += lots;
    if (side.includes("BUY") || side === "0") current.buyLots += Math.abs(lots);
    if (side.includes("SELL") || side === "1") current.sellLots += Math.abs(lots);
    grouped.set(symbol, current);
  }
  const symbols = [...grouped.values()].sort((a, b) => Math.abs(b.netLots) - Math.abs(a.netLots));
  return {
    lpName,
    positionCount: items.length,
    symbolCount: symbols.length,
    totalNetLots: symbols.reduce((sum, row) => sum + row.netLots, 0),
    topSymbols: symbols.slice(0, 10),
    raw: items,
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

export async function getLpEquitySummary() {
  const data = await fetchJson(buildBackendUrl("/Metrics/equity-summary"));
  return {
    lpWithdrawableEquity: toNumber(data?.lpWithdrawableEquity),
    clientWithdrawableEquity: toNumber(data?.clientWithdrawableEquity),
    difference: toNumber(data?.difference),
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

export async function getHistoryDeals(params = {}) {
  const range = buildRange(params);
  const login = Number(params.login);
  if (!Number.isFinite(login) || login <= 0) throw new Error("login is required");
  const url = new URL(buildBackendUrl("/History/deals"));
  url.searchParams.set("login", String(login));
  url.searchParams.set("from", String(range.fromTs));
  url.searchParams.set("to", String(range.toTs));
  const data = await fetchJson(url.toString());
  const deals = Array.isArray(data?.deals) ? data.deals : Array.isArray(data) ? data : [];
  return {
    login,
    totalDeals: toNumber(data?.totalDeals ?? deals.length),
    totals: {
      profit: deals.reduce((sum, row) => sum + toNumber(row?.profit), 0),
      commission: deals.reduce((sum, row) => sum + toNumber(row?.commission), 0),
      swap: deals.reduce((sum, row) => sum + toNumber(row?.swap ?? row?.storage), 0),
      volume: deals.reduce((sum, row) => sum + toNumber(row?.volume), 0),
    },
    sampleDeals: deals.slice(0, 20),
    raw: data,
  };
}

export async function getHistoryVolume(params = {}) {
  const range = buildRange(params);
  const url = new URL(buildBackendUrl("/History/volume"));
  url.searchParams.set("from", String(range.fromTs));
  url.searchParams.set("to", String(range.toTs));
  const data = await fetchJson(url.toString());
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  return {
    rowCount: items.length,
    totals: {
      tradeCount: items.reduce((sum, row) => sum + toNumber(row?.tradeCount), 0),
      totalLots: items.reduce((sum, row) => sum + toNumber(row?.totalLots), 0),
      notionalUsd: items.reduce((sum, row) => sum + toNumber(row?.notionalUsd), 0),
      volumeYards: items.reduce((sum, row) => sum + toNumber(row?.volumeYards), 0),
    },
    topByYards: [...items]
      .sort((a, b) => toNumber(b?.volumeYards) - toNumber(a?.volumeYards))
      .slice(0, 10),
    raw: data,
  };
}

export async function getBonusMetrics(params = {}) {
  const range = buildRange(params);
  const from = range.from;
  const to = range.to;
  const dashboardUrl = buildBackendUrl("/Bonus/dashboard");
  const statusUrl = buildBackendUrl("/Bonus/status");
  const pnlSummaryUrl = buildBackendUrl("/Bonus/pnl-summary");
  const pnlSmartUrl = `${buildBackendUrl("/Bonus/pnl-smart")}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const pnlMonthlyUrl = `${buildBackendUrl("/Bonus/pnl-monthly-report")}?from=${encodeURIComponent(from)}`;

  const [dashboard, status, pnlSummary, pnlSmart, monthly] = await Promise.allSettled([
    fetchJson(dashboardUrl),
    fetchJson(statusUrl),
    fetchJson(pnlSummaryUrl),
    fetchJson(pnlSmartUrl),
    fetchJson(pnlMonthlyUrl),
  ]);

  const getValue = (entry) => (entry.status === "fulfilled" ? entry.value : null);
  const dashboardVal = getValue(dashboard);
  const statusVal = getValue(status);
  const summaryVal = getValue(pnlSummary);
  const smartVal = getValue(pnlSmart);
  const monthlyVal = getValue(monthly);

  return {
    range: { from, to },
    grossPnl: toNumber(summaryVal?.grossPnl ?? smartVal?.grossPnl),
    totalEquity: toNumber(statusVal?.totalEquity ?? dashboardVal?.equity?.client?.totalEquity),
    lpRealizedPnl: toNumber(summaryVal?.lpRealizedPnl ?? smartVal?.lp?.realizedPnl),
    lpUnrealizedPnl: toNumber(summaryVal?.lpUnrealizedPnl ?? smartVal?.lp?.unrealizedPnl),
    creditSettled: toNumber(summaryVal?.creditSettled),
    creditUnsettled: toNumber(summaryVal?.creditUnsettled),
    monthlyRows: Array.isArray(monthlyVal?.months) ? monthlyVal.months.length : 0,
    raw: {
      dashboard: dashboardVal,
      status: statusVal,
      pnlSummary: summaryVal,
      pnlSmart: smartVal,
      monthlyReport: monthlyVal,
    },
  };
}

export async function getContractSizes(params = {}) {
  const symbol = String(params.symbol || "").trim().toUpperCase();
  if (symbol) {
    const detectUrl = buildBackendUrl(`/api/ContractSize/detect/${encodeURIComponent(symbol)}`);
    const detected = await fetchJson(detectUrl);
    return {
      symbol,
      detected,
      raw: detected,
    };
  }
  const data = await fetchJson(buildBackendUrl("/api/ContractSize"));
  const rows = Array.isArray(data) ? data : [];
  return {
    count: rows.length,
    sample: rows.slice(0, 25),
    raw: rows,
  };
}

export async function getCrmCashflow(params = {}) {
  const userId = Number(params.userId ?? params.crmId);
  if (!Number.isFinite(userId) || userId <= 0) throw new Error("userId (or crmId) is required");
  const range = buildRange(params);
  const begin = `${range.from} 00:00:00`;
  const end = `${range.to} 23:59:59`;

  const [deposits, withdrawals, accounts] = await Promise.all([
    postPortal(PORTAL_TRANSACTIONS_URL, {
      fromUserId: userId,
      processedAt: { begin, end },
      transactionTypes: ["deposit"],
      statuses: ["approved"],
    }).catch(() => []),
    postPortal(PORTAL_TRANSACTIONS_URL, {
      fromUserId: userId,
      processedAt: { begin, end },
      transactionTypes: ["withdrawal"],
      statuses: ["approved"],
    }).catch(() => []),
    postPortal(PORTAL_ACCOUNTS_URL, { userId }).catch(() => []),
  ]);

  const depRows = Array.isArray(deposits) ? deposits : [];
  const wdrRows = Array.isArray(withdrawals) ? withdrawals : [];
  const accountRows = Array.isArray(accounts) ? accounts : [];

  const totalDeposits = depRows.reduce((sum, row) => sum + toNumber(row?.processedAmount), 0);
  const totalWithdrawals = Math.abs(wdrRows.reduce((sum, row) => sum + toNumber(row?.processedAmount), 0));
  return {
    userId,
    fromDate: range.from,
    toDate: range.to,
    depositsCount: depRows.length,
    withdrawalsCount: wdrRows.length,
    totalDeposits,
    totalWithdrawals,
    netFlow: totalDeposits - totalWithdrawals,
    tradingAccountsCount: accountRows.length,
    logins: accountRows.map((row) => row?.login).filter(Boolean),
    raw: {
      deposits: depRows,
      withdrawals: wdrRows,
      accounts: accountRows,
    },
  };
}

export async function getTradingActivity(params = {}) {
  const range = buildRange(params);
  const group = String(params.group || "*");
  const symbolFilter = String(params.symbol || "").trim().toUpperCase();
  const limit = Math.max(1, Math.min(25, Number(params.limit) || 10));
  const url = new URL(buildBackendUrl("/Deal/GetDealsByGroup"));
  url.searchParams.set("group", group);
  url.searchParams.set("from", toDdMmYyyy(range.from));
  url.searchParams.set("to", toDdMmYyyy(range.to));
  const data = await fetchJson(url.toString(), {
    headers: { accept: "text/plain" },
  });
  const deals = (Array.isArray(data) ? data : []).filter((row) => {
    const symbol = String(row?.symbol || "").toUpperCase();
    return !symbolFilter || symbol === symbolFilter;
  });
  const grouped = new Map();
  for (const deal of deals) {
    const symbol = String(deal?.symbol || "UNKNOWN").toUpperCase();
    const current = grouped.get(symbol) || {
      symbol,
      dealCount: 0,
      totalLots: 0,
      totalProfit: 0,
      totalCommission: 0,
      totalSwap: 0,
      uniqueLogins: new Set(),
    };
    current.dealCount += 1;
    current.totalLots += toNumber(deal?.lots);
    current.totalProfit += toNumber(deal?.profit);
    current.totalCommission += toNumber(deal?.commission);
    current.totalSwap += toNumber(deal?.storage ?? deal?.swap);
    current.uniqueLogins.add(String(deal?.login || ""));
    grouped.set(symbol, current);
  }
  const bySymbol = [...grouped.values()]
    .map((row) => ({
      symbol: row.symbol,
      dealCount: row.dealCount,
      totalLots: row.totalLots,
      totalProfit: row.totalProfit,
      totalCommission: row.totalCommission,
      totalSwap: row.totalSwap,
      uniqueLogins: row.uniqueLogins.size,
    }))
    .sort((a, b) => b.totalLots - a.totalLots);
  return {
    fromDate: range.from,
    toDate: range.to,
    group,
    symbol: symbolFilter || null,
    dealCount: deals.length,
    symbolCount: bySymbol.length,
    topSymbolsByLots: bySymbol.slice(0, limit),
    topSymbolsByDeals: [...bySymbol].sort((a, b) => b.dealCount - a.dealCount).slice(0, limit),
    totals: {
      totalLots: bySymbol.reduce((sum, row) => sum + row.totalLots, 0),
      totalProfit: bySymbol.reduce((sum, row) => sum + row.totalProfit, 0),
      totalCommission: bySymbol.reduce((sum, row) => sum + row.totalCommission, 0),
      totalSwap: bySymbol.reduce((sum, row) => sum + row.totalSwap, 0),
    },
    raw: deals,
  };
}

export async function getAccountDetails(params = {}) {
  const login = Number(params.login);
  if (!Number.isFinite(login) || login <= 0) throw new Error("login is required");
  const accountUrl = new URL(buildBackendUrl("/Account/GetAccountByLogin"));
  accountUrl.searchParams.set("login", String(login));
  const userUrl = new URL(buildBackendUrl("/Account/GetUserInfo"));
  userUrl.searchParams.set("login", String(login));
  const [accountResp, userResp] = await Promise.allSettled([
    fetchJson(accountUrl.toString(), { headers: { accept: "text/plain" } }),
    fetchJson(userUrl.toString(), { headers: { accept: "text/plain" } }),
  ]);
  const account = accountResp.status === "fulfilled" ? accountResp.value : null;
  const user = userResp.status === "fulfilled" ? userResp.value : null;
  return {
    login,
    account: {
      balance: toNumber(account?.balance ?? account?.currentBalance),
      equity: toNumber(account?.equity ?? account?.currentEquity),
      credit: toNumber(account?.credit ?? account?.currentCredit),
      margin: toNumber(account?.margin),
      freeMargin: toNumber(account?.freeMargin),
      marginLevel: toNumber(account?.marginLevel),
      group: account?.group ?? account?.accountGroup ?? null,
    },
    user: {
      name: user?.name ?? user?.fullName ?? null,
      email: user?.email ?? null,
      country: user?.country ?? null,
      status: user?.status ?? user?.tradingStatus ?? null,
      ibId: user?.ibId ?? null,
    },
    raw: {
      account,
      user,
    },
  };
}

export async function getUserAccountsByEmail(params = {}) {
  const email = String(params.email || "").trim().toLowerCase();
  if (!email) throw new Error("email is required");

  const users = await postPortal(PORTAL_USERS_URL, params.userFilter && typeof params.userFilter === "object" ? params.userFilter : {}).catch(() => []);
  const matchedUsers = (Array.isArray(users) ? users : []).filter((user) => {
    const primary = String(user?.email || "").trim().toLowerCase();
    const secondary = String(user?.secondaryEmail || "").trim().toLowerCase();
    return primary === email || secondary === email;
  });

  const userIds = [...new Set(matchedUsers.map((user) => toNumber(user?.id)).filter((id) => id > 0))];
  let accounts = [];
  if (userIds.length) {
    accounts = await postPortal(PORTAL_ACCOUNTS_URL, { userIds, segment: { limit: 1000, offset: 0 } }).catch(() => []);
  }

  const accountItems = Array.isArray(accounts) ? accounts : [];
  return {
    email,
    matchedUsers: matchedUsers.map((user) => ({
      id: toNumber(user?.id),
      firstName: user?.firstName ?? null,
      lastName: user?.lastName ?? null,
      email: user?.email ?? null,
      secondaryEmail: user?.secondaryEmail ?? null,
    })),
    tradingAccountsCount: accountItems.length,
    logins: accountItems.map((account) => ({
      login: account?.login ?? null,
      group: account?.group ?? account?.groupName ?? null,
      balance: toNumber(account?.balance),
      credit: toNumber(account?.credit),
      equity: toNumber(account?.equity),
      userId: toNumber(account?.userId),
    })),
    raw: {
      users: matchedUsers,
      accounts: accountItems,
    },
  };
}

export async function getSymbolMappings(params = {}) {
  const search = String(params.symbol || params.search || "").trim().toUpperCase();
  const data = await fetchJson(buildBackendUrl("/api/SymbolMapping"));
  const rows = (Array.isArray(data) ? data : []).filter((row) => {
    if (!search) return true;
    const raw = String(row?.rawSymbol || row?.sourceSymbol || row?.symbol || "").toUpperCase();
    const mapped = String(row?.mappedSymbol || row?.targetSymbol || "").toUpperCase();
    return raw.includes(search) || mapped.includes(search);
  });
  return {
    count: rows.length,
    items: rows.slice(0, 25).map((row) => ({
      id: row?.id,
      rawSymbol: row?.rawSymbol || row?.sourceSymbol || row?.symbol || null,
      mappedSymbol: row?.mappedSymbol || row?.targetSymbol || null,
    })),
    raw: rows,
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
  const [dealing, coverage, lpMetrics, swap, history, accounts, backoffice, marketing] = await Promise.allSettled([
    getDealingSummary(range),
    getCoverageMetrics(),
    getLpMetrics(),
    getSwapMetrics(),
    getHistoryAggregate(range),
    getAccountsMetrics(range),
    getBackofficeMetrics(range),
    getMarketingMetrics(range),
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
    accounts: getVal(accounts),
    backoffice: getVal(backoffice),
    marketing: getVal(marketing),
  };
}

export async function listSwaggerEndpoints(params = {}) {
  const tag = String(params.tag || "").toLowerCase();
  const method = String(params.method || "").toLowerCase();
  const search = String(params.search || "").toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));

  const filtered = SWAGGER_ENDPOINTS.filter((ep) => {
    if (tag && String(ep.tag || "").toLowerCase() !== tag) return false;
    if (method && ep.method !== method) return false;
    if (search) {
      const hay = `${ep.path} ${ep.tag || ""} ${ep.summary || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }).slice(0, limit);

  return {
    meta: SWAGGER_META,
    totalMatched: filtered.length,
    endpoints: filtered.map((ep) => ({
      method: ep.method.toUpperCase(),
      path: ep.path,
      tag: ep.tag,
      summary: ep.summary,
      parameters: ep.parameters,
      requestBody: ep.requestBody,
      responses: ep.responses,
    })),
  };
}

export async function listAppEndpoints(params = {}) {
  const tag = String(params.tag || "").toLowerCase();
  const search = String(params.search || "").toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));

  const combinedEndpoints = [...READ_ONLY_APP_ENDPOINTS, ...listReadableSwaggerEndpoints()];
  const endpoints = combinedEndpoints.filter((endpoint) => {
    if (tag && String(endpoint.tag || "").toLowerCase() !== tag) return false;
    if (search) {
      const hay = `${endpoint.id} ${endpoint.tag || ""} ${endpoint.description || ""} ${endpoint.path || endpoint.target || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }).slice(0, limit);

  return {
    totalMatched: endpoints.length,
    totalAvailable: combinedEndpoints.length,
    endpoints: endpoints.map((endpoint) => ({
      id: endpoint.id,
      kind: endpoint.kind,
      tag: endpoint.tag,
      method: endpoint.method?.toUpperCase?.() || (endpoint.kind === "portal-post" ? "POST" : endpoint.kind === "wallet-get" ? "GET" : "GET"),
      path: endpoint.path || endpoint.target || null,
      description: endpoint.description,
    })),
  };
}

export async function callAppEndpoint(params = {}) {
  const endpointId = String(params.endpointId || "").trim();
  if (!endpointId) throw new Error("endpointId is required");
  const endpoint = findAppEndpoint(endpointId);
  const swaggerCatalogEndpoint = String(endpointId).startsWith("swagger:")
    ? listReadableSwaggerEndpoints().find((entry) => entry.id === endpointId)
    : null;
  const resolvedEndpoint = endpoint || swaggerCatalogEndpoint;
  if (!resolvedEndpoint) throw new Error(`Unknown app endpoint: ${endpointId}`);

  if (resolvedEndpoint.kind === "swagger" || resolvedEndpoint.kind === "swagger-catalog") {
    return {
      endpointId,
      ...(await callSwaggerEndpoint({
        path: resolvedEndpoint.path,
        method: resolvedEndpoint.method,
        query: params.query || {},
        pathParams: params.pathParams || {},
        body: params.body || {},
      })),
    };
  }

  if (resolvedEndpoint.kind === "portal-post") {
    const data = await postPortal(getPortalTargetUrl(resolvedEndpoint.target), params.body && typeof params.body === "object" ? params.body : {});
    return {
      endpointId,
      request: {
        method: "POST",
        target: resolvedEndpoint.target,
        body: params.body || {},
      },
      response: {
        ok: true,
        status: 200,
        data,
      },
    };
  }

  if (resolvedEndpoint.kind === "wallet-get") {
    if (!WALLET_URL || !WALLET_TOKEN) throw new Error("wallet endpoint is not configured");
    const url = WALLET_URL.includes("?")
      ? `${WALLET_URL}&token=${encodeURIComponent(WALLET_TOKEN)}`
      : `${WALLET_URL}?token=${encodeURIComponent(WALLET_TOKEN)}`;
    const data = await fetchJson(url);
    return {
      endpointId,
      request: {
        method: "GET",
        url,
      },
      response: {
        ok: true,
        status: 200,
        data,
      },
    };
  }

  throw new Error(`Unsupported endpoint kind for ${endpointId}`);
}

function tokenizeSearchText(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreEndpointForQuestion(endpoint, questionTokens) {
  if (!endpoint || !questionTokens.length) return 0;
  const hay = `${endpoint.id || ""} ${endpoint.tag || ""} ${endpoint.description || ""} ${endpoint.path || ""}`.toLowerCase();
  let score = 0;
  for (const token of questionTokens) {
    if (!hay.includes(token)) continue;
    score += 1;
    if (String(endpoint.id || "").toLowerCase().includes(token)) score += 2;
    if (String(endpoint.tag || "").toLowerCase().includes(token)) score += 1;
  }
  return score;
}

function extractPathTemplateKeys(path) {
  const keys = [];
  const re = /\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(String(path || ""))) !== null) {
    const key = String(m[1] || "").trim();
    if (key) keys.push(key);
  }
  return keys;
}

function inferStructuredParamsFromQuestion(question) {
  const text = String(question || "");
  const lower = text.toLowerCase();

  const loginMatch = lower.match(/\blogin\D{0,6}(\d{4,})\b/) || text.match(/\b(\d{5,})\b/);
  const userIdMatch = lower.match(/\b(?:user\s*id|userid|crm\s*id)\D{0,6}(\d{2,})\b/);
  const emailMatch = lower.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  const symbolMatch = text.match(/\b([A-Z]{3,10})\b/);
  const lpMatch = text.match(/\blp\s+([A-Za-z0-9._-]{2,30})\b/i);

  return {
    login: loginMatch ? Number(loginMatch[1]) : null,
    userId: userIdMatch ? Number(userIdMatch[1]) : null,
    email: emailMatch ? emailMatch[0] : null,
    symbol: symbolMatch ? symbolMatch[1].toUpperCase() : null,
    lpName: lpMatch ? lpMatch[1] : null,
  };
}

function fillMissingParamValue(paramName, inferred) {
  const key = String(paramName || "").toLowerCase();
  if (key === "login") return inferred.login;
  if (key === "userid" || key === "crmid") return inferred.userId;
  if (key === "symbol" || key === "basesymbol") return inferred.symbol;
  if (key === "lpname" || key === "lp") return inferred.lpName;
  if (key === "email") return inferred.email;
  return null;
}

function resolveEndpointContract(endpoint) {
  const contract = ENDPOINT_PARAM_CONTRACTS[String(endpoint?.id || "")] || {};
  const templateParams = extractPathTemplateKeys(endpoint?.path || "");
  const pathParams = [...new Set([...(contract.pathParams || []), ...templateParams])];
  const query = [...new Set([...(contract.query || [])])];
  const body = [...new Set([...(contract.body || [])])];
  return { pathParams, query, body };
}

function withInferredParams(endpoint, params, inferred) {
  const query = { ...(params.query || {}) };
  const pathParams = { ...(params.pathParams || {}) };
  const body = { ...(params.body || {}) };
  const contract = resolveEndpointContract(endpoint);

  for (const name of contract.pathParams) {
    if (pathParams[name] !== undefined && pathParams[name] !== null && String(pathParams[name]).trim() !== "") continue;
    const inferredVal = fillMissingParamValue(name, inferred);
    if (inferredVal !== null && inferredVal !== undefined && String(inferredVal).trim() !== "") {
      pathParams[name] = inferredVal;
    }
  }

  for (const name of contract.query) {
    if (query[name] !== undefined && query[name] !== null && String(query[name]).trim() !== "") continue;
    const inferredVal = fillMissingParamValue(name, inferred);
    if (inferredVal !== null && inferredVal !== undefined && String(inferredVal).trim() !== "") {
      query[name] = inferredVal;
    }
  }

  for (const name of contract.body) {
    if (body[name] !== undefined && body[name] !== null && String(body[name]).trim() !== "") continue;
    const inferredVal = fillMissingParamValue(name, inferred);
    if (inferredVal !== null && inferredVal !== undefined && String(inferredVal).trim() !== "") {
      body[name] = inferredVal;
    }
  }

  return { query, pathParams, body, contract };
}

function computeMissingParams(callArgs) {
  const missing = [];
  for (const name of callArgs.contract.pathParams || []) {
    const val = callArgs.pathParams?.[name];
    if (val === undefined || val === null || String(val).trim() === "") missing.push({ scope: "pathParams", name });
  }
  for (const name of callArgs.contract.query || []) {
    const val = callArgs.query?.[name];
    if (val === undefined || val === null || String(val).trim() === "") missing.push({ scope: "query", name });
  }
  for (const name of callArgs.contract.body || []) {
    const val = callArgs.body?.[name];
    if (val === undefined || val === null || String(val).trim() === "") missing.push({ scope: "body", name });
  }
  return missing;
}

function buildClarificationQuestion(missingList) {
  const unique = [...new Set((missingList || []).map((x) => String(x.name || "").trim()).filter(Boolean))];
  if (!unique.length) return "Please provide more details for this request.";
  const labels = unique.map((name) => {
    if (name === "login") return "login (example: 123456)";
    if (name === "baseSymbol" || name === "symbol") return "symbol (example: XAUUSD)";
    if (name === "lpName") return "LP name (example: ATFX)";
    if (name === "userId") return "user id";
    return name;
  });
  return `Please provide ${labels.join(", ")} so I can call the correct endpoint.`;
}

function shouldRequireEndpointConfirmation(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length < 2) return false;
  const top = Number(candidates[0]?.score || 0);
  const second = Number(candidates[1]?.score || 0);
  if (top <= 0) return true;
  // Ask user confirmation when confidence is weak or candidates are too close.
  return top <= 3 || top - second <= 1;
}

function buildEndpointConfirmationQuestion(candidates = []) {
  const choices = (candidates || []).slice(0, 3);
  if (!choices.length) return "I found multiple possible endpoints. Please confirm which endpoint I should call.";
  const labels = choices.map((row) => {
    const id = row?.endpoint?.id || "unknown";
    const desc = row?.endpoint?.description || row?.endpoint?.path || "";
    return `${id}${desc ? ` (${desc})` : ""}`;
  });
  return `I found multiple possible endpoints. Please confirm one endpoint id: ${labels.join(" | ")}.`;
}

export async function autoResolveAndCallEndpoint(params = {}) {
  const question = String(params.question || params.message || "").trim();
  if (!question) throw new Error("question is required");

  const questionTokens = tokenizeSearchText(question);
  const limit = Math.max(5, Math.min(120, Number(params.limit) || 60));
  const catalog = await listAppEndpoints({ limit });
  const candidates = (catalog.endpoints || [])
    .map((endpoint) => ({
      endpoint,
      score: scoreEndpointForQuestion(endpoint, questionTokens),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const explicitEndpointId = String(params.confirmEndpointId || params.endpointId || "").trim();
  if (explicitEndpointId) {
    const selected = candidates.find((row) => row.endpoint?.id === explicitEndpointId);
    if (!selected) {
      return {
        ok: false,
        question,
        reason: "confirmed_endpoint_not_found",
        requestedEndpointId: explicitEndpointId,
        topCandidates: candidates.map((c) => ({ id: c.endpoint.id, score: c.score })),
        response: null,
      };
    }
    candidates.splice(0, candidates.length, selected);
  }

  if (!candidates.length) {
    return {
      ok: false,
      question,
      reason: "no_endpoint_match",
      totalAvailable: catalog.totalAvailable,
      topCandidates: [],
      response: null,
    };
  }

  const skipConfirmation = Boolean(params.skipConfirmation || explicitEndpointId);
  if (!skipConfirmation && shouldRequireEndpointConfirmation(candidates)) {
    return {
      ok: false,
      question,
      reason: "low_confidence_match",
      topCandidates: candidates.map((c) => ({ id: c.endpoint.id, score: c.score, description: c.endpoint.description || "" })),
      clarificationQuestion: buildEndpointConfirmationQuestion(candidates),
      response: null,
    };
  }

  const errors = [];
  const missingByEndpoint = [];
  const inferred = inferStructuredParamsFromQuestion(question);
  for (const row of candidates) {
    const endpointId = row.endpoint.id;
    const callArgs = withInferredParams(
      row.endpoint,
      {
        query: params.query || {},
        pathParams: params.pathParams || {},
        body: params.body || {},
      },
      inferred,
    );
    const missing = computeMissingParams(callArgs);
    if (missing.length) {
      missingByEndpoint.push({ endpointId, missing });
      continue;
    }

    try {
      const result = await callAppEndpoint({
        endpointId,
        query: callArgs.query,
        pathParams: callArgs.pathParams,
        body: callArgs.body,
      });
      return {
        ok: true,
        question,
        selectedEndpointId: endpointId,
        selectedScore: row.score,
        topCandidates: candidates.map((c) => ({ id: c.endpoint.id, score: c.score })),
        response: result.response || null,
        request: result.request || null,
        result,
      };
    } catch (error) {
      errors.push({ endpointId, error: error?.message || String(error) });
    }
  }

  if (!errors.length && missingByEndpoint.length) {
    const mergedMissing = missingByEndpoint.flatMap((item) => item.missing || []);
    return {
      ok: false,
      question,
      reason: "missing_required_params",
      topCandidates: candidates.map((c) => ({ id: c.endpoint.id, score: c.score })),
      missingByEndpoint,
      clarificationQuestion: buildClarificationQuestion(mergedMissing),
      response: null,
    };
  }

  return {
    ok: false,
    question,
    reason: "all_candidates_failed",
    topCandidates: candidates.map((c) => ({ id: c.endpoint.id, score: c.score })),
    missingByEndpoint,
    errors,
    response: null,
  };
}

export async function callSwaggerEndpoint(params = {}) {
  const path = String(params.path || "");
  const method = normalizeMethod(params.method);
  const query = params.query && typeof params.query === "object" ? params.query : {};
  const pathParams = params.pathParams && typeof params.pathParams === "object" ? params.pathParams : {};
  const body = params.body && typeof params.body === "object" ? params.body : undefined;

  const endpoint = findSwaggerEndpoint(path, method);
  if (!endpoint) {
    throw new Error(`Endpoint not found in imported swagger: ${method.toUpperCase()} ${path}`);
  }

  const resolvedPath = resolvePathTemplate(path, pathParams);
  const url = new URL(buildBackendUrl(resolvedPath));
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      v.forEach((item) => url.searchParams.append(k, String(item)));
    } else {
      url.searchParams.set(k, String(v));
    }
  }

  const isBodyMethod = ["post", "put", "patch"].includes(method);
  const headers = {
    Accept: "application/json, text/json, text/plain, */*",
  };

  const resp = await fetch(url.toString(), {
    method: method.toUpperCase(),
    headers: isBodyMethod ? { ...headers, "Content-Type": "application/json" } : headers,
    body: isBodyMethod ? JSON.stringify(body || {}) : undefined,
  });

  const contentType = String(resp.headers.get("content-type") || "");
  const rawText = await resp.text();
  let parsed;
  if (contentType.includes("json")) {
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }
  } else {
    parsed = rawText;
  }

  return {
    request: {
      method: method.toUpperCase(),
      path,
      resolvedPath,
      url: url.toString(),
      query,
      pathParams,
      hasBody: Boolean(isBodyMethod),
    },
    response: {
      ok: resp.ok,
      status: resp.status,
      contentType,
      data: parsed,
    },
  };
}

export const dateUtils = { buildRange };
