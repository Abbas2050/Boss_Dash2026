import { getAuthToken } from "@/lib/auth";

function authHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson(url: string, options: RequestInit = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
        ...authHeaders(),
      },
    });
  } catch (e: any) {
    window.clearTimeout(timer);
    if (e?.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  }
  window.clearTimeout(timer);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Request failed (${resp.status})`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const body = await resp.text().catch(() => "");
    const snippet = body.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new Error(`Expected JSON but received ${contentType || "unknown"} (${resp.status})${snippet ? `: ${snippet}` : ""}`);
  }
  return resp.json();
}

function toNum(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function fetchClientProfileDashboardFallback() {
  const top = await fetchJson("/api/ClientProfile/top-clients?count=10");
  const topByEquity = Array.isArray(top?.topByEquity) ? top.topByEquity : [];
  const topByVolume = Array.isArray(top?.topByVolume) ? top.topByVolume : [];
  const topByDailyVolume = Array.isArray(top?.topByDailyVolume) ? top.topByDailyVolume : [];
  const topByDailyRealized = Array.isArray(top?.topByDailyRealized) ? top.topByDailyRealized : [];
  const ids = new Set<number>();
  for (const row of [...topByEquity, ...topByVolume, ...topByDailyVolume, ...topByDailyRealized]) {
    const id = toNum(row?.login ?? row?.clientId);
    if (id > 0) ids.add(id);
  }
  return {
    __source: "fallback_clientprofile",
    ok: true,
    asOf: new Date().toISOString(),
    totals: {
      totalClients: ids.size,
      routeABook: 0,
      routeBBook: 0,
      routeMonitor: ids.size,
      triggerChurnAlert: 0,
      leverageRiskAlerts: 0,
      flagCompliance: 0,
      toxicFlowAlerts: 0,
      bonusAbuseAlerts: 0,
      activeAlerts: 0,
    },
    segmentedByCluster: { Fallback_Imported_From_ClientProfile: ids.size },
    topRevenue: topByDailyRealized.slice(0, 10).map((row: any) => ({
      clientId: toNum(row?.login),
      netPnl: toNum(row?.dailyRealized),
      tradeCount: toNum(row?.dailyTrades || 0),
      winRate: 0.5,
      cluster: "Fallback_Imported_From_ClientProfile",
      suggestedRoute: "Manual Review",
    })),
    topRisk: topByDailyVolume.slice(0, 10).map((row: any) => ({
      clientId: toNum(row?.login),
      tradeCount: toNum(row?.dailyTrades || 0),
      avgHoldMinutes: 0,
      netPnl: toNum(row?.dailyRealized || 0),
      flags: ["MANUAL_REVIEW"],
      cluster: "Fallback_Imported_From_ClientProfile",
      riskScore: 50,
    })),
    churnWatchlist: [],
    warning: "Loaded fallback dashboard from /api/ClientProfile because advanced CP endpoint is unavailable.",
  };
}

export async function fetchClientProfileDashboard() {
  try {
    return await fetchJson("/api/agent/client-profiles/dashboard");
  } catch {
    return fetchClientProfileDashboardFallback();
  }
}

async function analyzeClientByLoginFallback(login: number) {
  const detail = await fetchJson(`/api/ClientProfile/${encodeURIComponent(String(login))}/detail?days=120`);
  const account = detail?.account || {};
  const summary = detail?.summary || {};
  const topSymbolsRaw = Array.isArray(detail?.topSymbols) ? detail.topSymbols : [];
  const alerts: string[] = [];
  const marginLevel = toNum(account.marginLevel);
  if (marginLevel > 0 && marginLevel < 120) alerts.push("LEVERAGE_REVIEW");
  if (toNum(summary.periodClosedDeals) <= 2) alerts.push("LOW_ACTIVITY");
  return {
    __source: "fallback_clientprofile",
    ok: true,
    asOf: new Date().toISOString(),
    client: {
      clientId: login,
      login,
      firstName: String(detail?.name || `Client ${login}`),
      lastName: "",
      email: null,
      country: null,
      registrationDate: null,
    },
    financialSnapshot: {
      balance: toNum(account.balance),
      equity: toNum(account.equity),
      credit: toNum(account.credit),
      margin: toNum(account.margin),
      freeMargin: toNum(account.marginFree),
      depositsTotal: 0,
      withdrawalsTotal: 0,
      netFunding: 0,
    },
    mt5AccountSummary: {
      group: detail?.group || null,
      tradingStatus: null,
    },
    crmProfile: {
      managerId: null,
      status: null,
    },
    profile: {
      tradeCount: toNum(summary.periodClosedDeals),
      winRate: 0.5,
      avgHoldMinutes: 0,
      totalVolumeLots: toNum(summary.periodTradedLots),
      netPnl: toNum(summary.totalFloatingPnl),
      totalSwap: toNum(summary.totalSwap),
      totalCommission: 0,
      daysCovered: toNum(summary.periodDays || 120),
      cluster: "Fallback_Imported_From_ClientProfile",
      rfm: { recencyScore: 3, frequencyScore: 3, monetaryScore: 3, total: 9, segment: "Fallback" },
      decision: { route: "Manual Review", recencyDays: 0, flags: alerts },
    },
    scores: { riskScore: 50, revenueScore: 50, churnScore: 50, complianceScore: 50 },
    confidencePct: 45,
    explanation: "Fallback analysis from existing ClientProfile endpoint. Full CP engine endpoint is currently unavailable.",
    alerts,
    timeline: [{ at: new Date().toISOString(), event: "Fallback profile analysis loaded" }],
    topSymbols: topSymbolsRaw.map((s: any) => ({
      symbol: String(s.symbol || "-"),
      trades: toNum(s.closedDeals),
      lots: toNum(s.totalLots),
      pnl: toNum(s.realizedPnl),
      buys: 0,
      sells: 0,
    })),
    recommendations: {
      route: "Manual Review",
      actions: ["manual_review"],
      brokerNotes: ["CP fallback mode active; confirm backend CP routes are running for full rule-engine output."],
    },
  };
}

export async function analyzeClientByLogin(login: number) {
  try {
    const live = await fetchJson(`/api/agent/client-profiles/analyze-account/${encodeURIComponent(String(login))}`, {}, 120000);
    return { __source: "cp_engine", ...live };
  } catch {
    return analyzeClientByLoginFallback(login);
  }
}

export async function confirmClientProfileAction(payload: {
  actionKey: string;
  clientId?: number;
  login?: number;
  recommendedBook?: string;
  confidencePct?: number;
  confirmationNote?: string;
  payload?: Record<string, unknown>;
}) {
  return fetchJson("/api/agent/client-profiles/actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...payload,
      confirm: true,
    }),
  });
}

export async function fetchClientProfileActionAudit(limit = 100) {
  return fetchJson(`/api/agent/client-profiles/actions/audit?limit=${encodeURIComponent(String(limit))}`);
}

export async function runClientProfileBootstrap(payload?: {
  runType?: string;
  maxClients?: number;
  dryRun?: boolean;
}) {
  return fetchJson("/api/agent/client-profiles/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      runType: payload?.runType || "bootstrap",
      ...(Number.isFinite(Number(payload?.maxClients)) ? { maxClients: Number(payload?.maxClients) } : {}),
      dryRun: Boolean(payload?.dryRun),
    }),
  }, 10 * 60 * 1000);
}

export async function runClientProfileFull(payload?: {
  maxClients?: number;
  dryRun?: boolean;
}) {
  return fetchJson("/api/agent/client-profiles/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      runType: "manual",
      ...(Number.isFinite(Number(payload?.maxClients)) ? { maxClients: Number(payload?.maxClients) } : {}),
      dryRun: Boolean(payload?.dryRun),
    }),
  }, 10 * 60 * 1000);
}

export async function fetchClientProfileRuns(limit = 20) {
  return fetchJson(`/api/agent/client-profiles/runs?limit=${encodeURIComponent(String(limit))}`);
}

export async function fetchClientProfileRunSteps(runId: number, limit = 100) {
  return fetchJson(
    `/api/agent/client-profiles/runs/${encodeURIComponent(String(runId))}/steps?limit=${encodeURIComponent(String(limit))}`,
  );
}

export async function fetchClientProfileRunErrors(runId: number, limit = 500) {
  return fetchJson(
    `/api/agent/client-profiles/runs/${encodeURIComponent(String(runId))}/errors?limit=${encodeURIComponent(String(limit))}`,
  );
}

export async function closeStuckClientProfileRun(reason?: string) {
  return fetchJson("/api/agent/client-profiles/runs/close-stuck", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reason: reason || "Manually closed stuck run from CP UI",
    }),
  });
}
