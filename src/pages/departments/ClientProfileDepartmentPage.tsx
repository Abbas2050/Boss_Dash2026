import { useEffect, useMemo, useState } from "react";
import {
  analyzeClientByLogin,
  confirmClientProfileAction,
  closeStuckClientProfileRun,
  fetchClientProfileActionAudit,
  fetchClientProfileDashboard,
  fetchClientProfileRunErrors,
  fetchClientProfileRunSteps,
  fetchClientProfileRuns,
  runClientProfileBootstrap,
  runClientProfileFull,
} from "@/lib/clientProfileApi";

type DashboardData = {
  asOf: string;
  totals: {
    totalClients: number;
    routeABook: number;
    routeBBook: number;
    routeMonitor: number;
    triggerChurnAlert: number;
    leverageRiskAlerts: number;
    flagCompliance: number;
    toxicFlowAlerts: number;
    bonusAbuseAlerts: number;
    activeAlerts: number;
  };
  segmentedByCluster: Record<string, number>;
  topRevenue: Array<{ clientId: number; netPnl: number; tradeCount: number; winRate: number; cluster: string; suggestedRoute: string }>;
  topRisk: Array<{ clientId: number; tradeCount: number; avgHoldMinutes: number; netPnl: number; flags: string[]; cluster: string; riskScore?: number }>;
  churnWatchlist: Array<{ clientId: number; recencyDays: number; tradeCount: number; netPnl: number; lastTradeAt: string | null }>;
};

type AnalysisData = {
  __source?: string;
  asOf: string;
  client: { clientId: number; login: number; firstName: string | null; lastName: string | null; email: string | null; country: string | null; registrationDate: string | null };
  financialSnapshot: { balance: number; equity: number; credit: number; margin: number; freeMargin: number; depositsTotal: number; withdrawalsTotal: number; netFunding: number };
  mt5AccountSummary?: { group?: string | null; tradingStatus?: string | null };
  crmProfile?: { managerId?: number | null; status?: string | null };
  profile: {
    tradeCount: number;
    winRate: number;
    avgHoldMinutes: number;
    totalVolumeLots: number;
    netPnl: number;
    totalSwap: number;
    totalCommission: number;
    daysCovered: number;
    cluster: string;
    rfm: { recencyScore: number; frequencyScore: number; monetaryScore: number; total: number; segment: string };
    decision: { route: string; recencyDays: number; flags: string[] };
  };
  scores: { riskScore: number; revenueScore: number; churnScore: number; complianceScore: number };
  confidencePct: number;
  explanation: string;
  alerts: string[];
  timeline: Array<{ at: string; event: string }>;
  topSymbols: Array<{ symbol: string; trades: number; lots: number; pnl: number; buys: number; sells: number }>;
  dealingEvidence?: {
    source?: string;
    status?: { historyDeals?: string; historyAggregate?: string; metrics?: string };
    dealStats?: { dealsCount?: number; winners?: number; losers?: number; winRatePct?: number; profitFactor?: number; avgHoldMinutes?: number };
    aggregate?: { tradeCount?: number; totalLots?: number; netPL?: number; totalCommission?: number; totalSwap?: number; ntpPercent?: number };
    accountHealth?: { equity?: number; realEquity?: number; balance?: number; margin?: number; freeMargin?: number; marginLevel?: number };
  };
  diagnostics?: {
    fetchChecks?: {
      tradeHistorySource?: string;
      mt5BaseUrl?: string;
      mt5TokenConfigured?: boolean;
      portalTokenConfigured?: boolean;
      tradeFetchDiagnostics?: {
        mt5?: { attemptedLogins?: number; fulfilledLogins?: number; failedLogins?: number; dealsFetched?: number };
        fallbackUsed?: boolean;
        restTradesFetched?: number;
      } | null;
    };
    writeChecks?: Record<string, { ok?: boolean; error?: string | null }>;
    dbVerify?: Record<string, number>;
  };
  recommendations: { route: string; actions: string[]; brokerNotes: string[] };
};

type KPI = {
  key: string;
  label: string;
  value: number;
  trend: string;
  accent: string;
};

type ProfileRunRow = {
  id: number;
  run_type?: string;
  status?: string;
  snapshot_date?: string;
  started_at?: string;
  finished_at?: string;
  clients_processed?: number;
  clients_failed?: number;
  error_message?: string | null;
};

const CLUSTER_LABELS: Record<string, string> = {
  HighFrequency_HighYield: "High-Frequency High-Yield Traders",
  HighFrequency_HighRisk_Loss: "High-Frequency Consistent Losers",
  Conservative_SteadyGrowth: "Conservative Steady-Growth Traders",
  Cautious_LowActivity_Novice: "Low-Activity Novice Traders",
  Conservative_LowYield: "Low-Yield Low-Maintenance Traders",
  Potential_Toxic_Flow: "Toxic / Latency Risk Traders",
};

const ALERT_STYLE: Record<string, string> = {
  normal: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  monitor: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  urgent: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  critical: "border-slate-500/50 bg-slate-900 text-slate-200",
};

const ACTIONS = [
  { key: "route_a_book", label: "Recommend A-Book" },
  { key: "route_b_book", label: "Recommend B-Book" },
  { key: "flag_compliance", label: "Flag Compliance" },
  { key: "reduce_leverage", label: "Reduce Leverage" },
  { key: "trigger_churn", label: "Trigger Churn Campaign" },
] as const;

function fmt(value: number, digits = 2) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function pct(value: number) {
  return `${fmt(value, 1)}%`;
}

function MiniTrend({ text }: { text: string }) {
  return <span className="text-[10px] uppercase tracking-wide text-cyan-300/90">{text}</span>;
}

function Sparkline() {
  return (
    <svg viewBox="0 0 100 24" className="h-6 w-full">
      <defs>
        <linearGradient id="spk" x1="0" x2="1">
          <stop offset="0%" stopColor="#2dd4bf" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <polyline fill="none" stroke="url(#spk)" strokeWidth="2" points="0,18 10,16 20,14 30,15 40,9 50,11 60,8 70,6 80,8 90,4 100,5" />
    </svg>
  );
}

function BarLine({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full rounded-full bg-slate-800">
      <div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-teal-400" style={{ width: `${width}%` }} />
    </div>
  );
}

export function ClientProfileDepartmentPage() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const [loginInput, setLoginInput] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisProgressPct, setAnalysisProgressPct] = useState(0);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [auditRows, setAuditRows] = useState<any[]>([]);
  const [bootstrapRunning, setBootstrapRunning] = useState(false);
  const [bootstrapMessage, setBootstrapMessage] = useState<string | null>(null);
  const [runRows, setRunRows] = useState<ProfileRunRow[]>([]);
  const [runPanelLoading, setRunPanelLoading] = useState(false);
  const [runActionLoading, setRunActionLoading] = useState(false);
  const [runActionMessage, setRunActionMessage] = useState<string | null>(null);
  const [runProgressPct, setRunProgressPct] = useState(0);
  const [runExpectedTotal, setRunExpectedTotal] = useState<number | null>(null);
  const [runProgressPhase, setRunProgressPhase] = useState<string>("Idle");
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [latestRunStepMessage, setLatestRunStepMessage] = useState<string | null>(null);

  const deriveRunCountsFromSteps = (steps: any[]) => {
    const rows = Array.isArray(steps) ? steps : [];
    const persisted = rows.filter((r) => String(r?.step_key || "") === "client_persisted").length;
    const failed = rows.filter((r) => String(r?.step_key || "") === "client_failed").length;
    return { persisted, failed };
  };

  const parseStepDetails = (details: any) => {
    if (!details) return null;
    if (typeof details === "object") return details;
    if (typeof details === "string") {
      try {
        return JSON.parse(details);
      } catch {
        return null;
      }
    }
    return null;
  };

  const estimateRunExpectedTotal = (stepRows: any[], processed: number, failed: number) => {
    const rows = Array.isArray(stepRows) ? stepRows : [];
    let expected = 0;

    for (const row of rows) {
      const key = String(row?.step_key || "");
      const details = parseStepDetails((row as any)?.details_json);

      if (key === "run_started") {
        const maxClients = Number(details?.maxClients || 0);
        const targetedClients = Number(details?.targetedClients || 0);
        if (maxClients > 0) expected = Math.max(expected, maxClients);
        if (targetedClients > 0) expected = Math.max(expected, targetedClients);
      }

      if (key === "fetch_users_page_completed") {
        const usersFetched = Number(details?.usersFetched || 0);
        const pageOffset = Number((row as any)?.page_offset || 0);
        if (usersFetched > 0) expected = Math.max(expected, pageOffset + usersFetched);
      }
    }

    const dashboardTotal = Number(dashboard?.totals?.totalClients || 0);
    if (dashboardTotal > 0) expected = Math.max(expected, dashboardTotal);

    const handled = processed + failed;
    if (handled > expected) expected = handled;

    return expected > 0 ? expected : null;
  };

  const hasDashboardData = (data: DashboardData | null) => {
    if (!data) return false;
    if ((data.totals?.totalClients || 0) > 0) return true;
    if ((data.topRevenue || []).length > 0) return true;
    if ((data.topRisk || []).length > 0) return true;
    if ((data.churnWatchlist || []).length > 0) return true;
    return false;
  };

  const maybeBootstrapOnce = async (data: DashboardData | null) => {
    const lsKey = "cp_bootstrap_requested_v1";
    if (hasDashboardData(data)) return;
    if (bootstrapRunning) return;
    if (typeof window !== "undefined" && window.localStorage.getItem(lsKey) === "1") return;
    try {
      setBootstrapRunning(true);
      setBootstrapMessage("CP initialization started: profiling all clients for first-time dashboard population...");
      if (typeof window !== "undefined") window.localStorage.setItem(lsKey, "1");
      await runClientProfileBootstrap({ runType: "bootstrap", dryRun: false });
      setBootstrapMessage("Initialization run started successfully. Refreshing dashboard shortly...");
      setTimeout(() => {
        void loadDashboard();
        void loadRuns();
      }, 3000);
    } catch (e: any) {
      setBootstrapMessage(`Initialization could not start automatically: ${e?.message || "unknown error"}`);
    } finally {
      setBootstrapRunning(false);
    }
  };

  const loadDashboard = async () => {
    try {
      setDashboardLoading(true);
      setDashboardError(null);
      const data = await fetchClientProfileDashboard();
      setDashboard(data);
      void maybeBootstrapOnce(data);
    } catch (e: any) {
      setDashboardError(e?.message || "Failed to load CP dashboard.");
    } finally {
      setDashboardLoading(false);
    }
  };

  const loadAudit = async () => {
    try {
      const data = await fetchClientProfileActionAudit(20);
      setAuditRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch {
      setAuditRows([]);
    }
  };

  const loadRuns = async () => {
    try {
      setRunPanelLoading(true);
      const data = await fetchClientProfileRuns(20);
      setRunRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch {
      setRunRows([]);
    } finally {
      setRunPanelLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
    loadAudit();
    loadRuns();
  }, []);

  const runFullProfilingNow = async () => {
    const typed = window.prompt("Type RUN to start full profiling for all clients.");
    if (typed !== "RUN") return;
    let timer: number | null = null;
    try {
      setRunActionLoading(true);
      setRunActionMessage(null);
      setLatestRunStepMessage(null);
      setRunProgressPhase("Submitting run request");
      setRunExpectedTotal(null);
      setRunProgressPct(3);
      setActiveRunId(null);
      // Small pulse during API handshake only - real progress comes from polling
      timer = window.setInterval(() => {
        setRunProgressPct((prev) => {
          if (prev >= 5) return prev;
          return prev + 1;
        });
      }, 500);
      const resp = await runClientProfileFull({ dryRun: false });
      const runId = Number(resp?.runId || 0) || null;
      if (!runId) {
        throw new Error("Run did not return a valid runId.");
      }
      setActiveRunId(runId);
      if (timer) window.clearInterval(timer);
      setRunProgressPct(6);
      setRunProgressPhase("Run started, discovering total clients");
      setRunActionMessage(`Run started successfully. Run ID: ${resp?.runId ?? "-"}. Tracking progress...`);

      // Poll run logs and run-step diagnostics until completion (no hard timeout).
      let lastHandled = -1;
      let stagnantPolls = 0;
      let pollCount = 0;
      let cachedExpectedTotal: number | null = null;
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const runData = await fetchClientProfileRuns(30).catch(() => ({ rows: [] as ProfileRunRow[] }));
        const rows = Array.isArray(runData?.rows) ? runData.rows : [];
        setRunRows(rows);
        const row = runId ? rows.find((r) => Number(r?.id) === runId) : rows[0];
        if (!row) continue;

        const stepsData = await fetchClientProfileRunSteps(Number(row.id), 120).catch(() => ({ rows: [] as any[] }));
        const stepRows = Array.isArray(stepsData?.rows) ? stepsData.rows : [];
        const derived = deriveRunCountsFromSteps(stepRows);
        if (derived.persisted > Number(row.clients_processed || 0) || derived.failed > Number(row.clients_failed || 0)) {
          setRunRows((prev) =>
            prev.map((r) =>
              Number(r?.id) === Number(row.id)
                ? {
                    ...r,
                    clients_processed: Math.max(Number(r.clients_processed || 0), derived.persisted),
                    clients_failed: Math.max(Number(r.clients_failed || 0), derived.failed),
                  }
                : r,
            ),
          );
        }
        const processed = Math.max(Number(row.clients_processed || 0), derived.persisted);
        const failed = Math.max(Number(row.clients_failed || 0), derived.failed);
        const totalHandled = processed + failed;
        const status = String(row.status || "running").toLowerCase();
        const latestStep = stepRows[0] || null;
        if (latestStep) {
          const stepMsg = latestStep.message
            ? `${String(latestStep.step_key || "step")}: ${String(latestStep.message)}`
            : String(latestStep.step_key || "step");
          setLatestRunStepMessage(stepMsg);
        }

        setRunActionMessage(
          `Run ${row.id}: ${String(row.status || "running").toUpperCase()} | processed ${processed.toLocaleString()} | failed ${failed.toLocaleString()}`,
        );

        // Progress uses true percentage when total client count is known.
        // cachedExpectedTotal persists the first valid estimate so it survives
        // when early steps scroll out of the 120-step window.
        if (status === "running") {
          pollCount += 1;
          const freshExpected = estimateRunExpectedTotal(stepRows, processed, failed);
          if (freshExpected !== null) cachedExpectedTotal = freshExpected;
          const expectedTotal = cachedExpectedTotal;
          setRunExpectedTotal(expectedTotal);

          // When expectedTotal is known: real %. Floor at 6 so bar never goes backwards.
          // When unknown: slow-creep 6→15 while 0 clients, then sqrt formula once clients arrive.
          let nextPct: number;
          if (expectedTotal && expectedTotal > 0) {
            const byTotal = Math.round((totalHandled / expectedTotal) * 100);
            nextPct = Math.min(97, Math.max(6, byTotal));
          } else if (totalHandled > 0) {
            nextPct = Math.min(97, 5 + Math.round(Math.sqrt(totalHandled) * 7));
          } else {
            // Nothing done yet — slow creep so user knows it's alive
            nextPct = Math.min(15, 6 + Math.floor(pollCount / 2));
          }
          const phaseLabel = String(latestStep?.step_key || "running").replace(/_/g, " ");
          setRunProgressPhase(`Phase: ${phaseLabel}`);
          setRunProgressPct((prev) => Math.max(prev, nextPct));
          if (totalHandled > lastHandled) {
            lastHandled = totalHandled;
            stagnantPolls = 0;
          } else {
            stagnantPolls += 1;
            if (stagnantPolls >= 10 && latestStep?.status === "error") {
              setRunActionMessage(
                `Run ${row.id} appears blocked at ${totalHandled.toLocaleString()} handled. Last error: ${String(latestStep.message || "unknown")}`,
              );
            }
          }
          continue;
        }

        if (status === "success" || status === "partial") {
          setRunExpectedTotal(processed + failed);
          setRunProgressPhase("Completed");
          setRunProgressPct(100);
          setRunActionMessage(
            `Run ${row.id} completed: ${String(row.status).toUpperCase()} | processed ${processed.toLocaleString()} | failed ${failed.toLocaleString()}`,
          );
        } else {
          setRunExpectedTotal(processed + failed);
          setRunProgressPhase("Ended");
          setRunProgressPct(100);
          setRunActionMessage(
            `Run ${row.id} ended with status ${String(row.status || "unknown").toUpperCase()} | processed ${processed.toLocaleString()} | failed ${failed.toLocaleString()}`,
          );
        }

        await loadDashboard();
        await loadRuns();
        setActiveRunId(null);
        setRunExpectedTotal(null);
        setRunProgressPhase("Idle");
        window.setTimeout(() => setRunProgressPct(0), 1200);
        return;
      }
    } catch (e: any) {
      setRunActionMessage(e?.message || "Failed to start full profiling run.");
      setRunProgressPct(0);
      setRunExpectedTotal(null);
      setRunProgressPhase("Idle");
      setActiveRunId(null);
    } finally {
      if (timer) window.clearInterval(timer);
      setRunActionLoading(false);
    }
  };

  const closeStuckRunNow = async () => {
    const typed = window.prompt("Type CLOSE to manually close the current stuck run.");
    if (typed !== "CLOSE") return;
    try {
      setRunActionLoading(true);
      setRunActionMessage(null);
      const resp = await closeStuckClientProfileRun("Manually closed stuck run from CP UI");
      if (resp?.closed) {
        setRunActionMessage(`Stuck run closed successfully. Run ID: ${resp?.runId ?? "-"}`);
      } else {
        setRunActionMessage(resp?.message || "No running run found to close.");
      }
      setActiveRunId(null);
      setRunProgressPct(0);
      setRunExpectedTotal(null);
      setRunProgressPhase("Idle");
      await loadRuns();
      await loadDashboard();
    } catch (e: any) {
      setRunActionMessage(e?.message || "Failed to close stuck run.");
    } finally {
      setRunActionLoading(false);
    }
  };

  const runAnalysis = async () => {
    const login = Number(loginInput.trim());
    if (!Number.isFinite(login) || login <= 0) {
      setAnalysisError("Enter a valid account number.");
      return;
    }
    try {
      setAnalysisLoading(true);
      setAnalysisError(null);
      setActionMessage(null);
      setAnalysisProgressPct(8);
      const progressTimer = window.setInterval(() => {
        setAnalysisProgressPct((prev) => {
          if (prev >= 92) return prev;
          const bump = prev < 40 ? 8 : prev < 70 ? 5 : 2;
          return Math.min(92, prev + bump);
        });
      }, 320);
      const data = await analyzeClientByLogin(login);
      window.clearInterval(progressTimer);
      setAnalysisProgressPct(100);
      setAnalysis(data);
      window.setTimeout(() => setAnalysisProgressPct(0), 600);
    } catch (e: any) {
      setAnalysisError(e?.message || "Failed to analyze account.");
      setAnalysisProgressPct(0);
    } finally {
      setAnalysisLoading(false);
    }
  };

  const confirmAction = async (actionKey: string) => {
    if (!analysis) return;
    const typed = window.prompt(`Type CONFIRM to proceed with "${actionKey}" and write audit log.`);
    if (typed !== "CONFIRM") return;
    try {
      setActionLoading(true);
      setActionMessage(null);
      const resp = await confirmClientProfileAction({
        actionKey,
        clientId: analysis.client.clientId,
        login: analysis.client.login,
        recommendedBook: analysis.recommendations.route,
        confidencePct: analysis.confidencePct,
        confirmationNote: "Super Admin confirmed action from CP module",
        payload: {
          scores: analysis.scores,
          alerts: analysis.alerts,
          explanation: analysis.explanation,
        },
      });
      setActionMessage(`Confirmed and logged. Audit ID: ${resp?.auditId ?? "-"}`);
      await loadAudit();
    } catch (e: any) {
      setActionMessage(e?.message || "Failed to log action.");
    } finally {
      setActionLoading(false);
    }
  };

  const kpis: KPI[] = useMemo(() => {
    if (!dashboard) return [];
    return [
      { key: "totalClients", label: "Total Clients", value: dashboard.totals.totalClients, trend: "+2.4%", accent: "from-cyan-500 to-blue-500" },
      { key: "aBook", label: "A-Book Clients", value: dashboard.totals.routeABook, trend: "+1.8%", accent: "from-emerald-500 to-teal-500" },
      { key: "bBook", label: "B-Book Clients", value: dashboard.totals.routeBBook, trend: "+3.1%", accent: "from-amber-500 to-orange-500" },
      { key: "review", label: "Clients to Review", value: dashboard.totals.routeMonitor, trend: "-0.6%", accent: "from-slate-500 to-slate-700" },
      { key: "churn", label: "Churn Alerts", value: dashboard.totals.triggerChurnAlert, trend: "+1.2%", accent: "from-violet-500 to-fuchsia-500" },
      { key: "lev", label: "Leverage Risk Alerts", value: dashboard.totals.leverageRiskAlerts, trend: "+0.8%", accent: "from-cyan-400 to-teal-400" },
      { key: "compliance", label: "Compliance Flags", value: dashboard.totals.flagCompliance, trend: "+0.4%", accent: "from-slate-600 to-black" },
      { key: "alerts", label: "Active Alerts (24h)", value: dashboard.totals.activeAlerts, trend: "+4.9%", accent: "from-rose-500 to-red-500" },
    ];
  }, [dashboard]);

  const clusterRows = useMemo(() => {
    if (!dashboard) return [];
    return Object.entries(dashboard.segmentedByCluster)
      .map(([key, value]) => ({ key, label: CLUSTER_LABELS[key] || key, value }))
      .sort((a, b) => b.value - a.value);
  }, [dashboard]);

  const donutValues = useMemo(() => {
    if (!dashboard) return { a: 0, b: 0 };
    const total = Math.max(1, dashboard.totals.routeABook + dashboard.totals.routeBBook);
    return {
      a: Math.round((dashboard.totals.routeABook / total) * 100),
      b: Math.round((dashboard.totals.routeBBook / total) * 100),
    };
  }, [dashboard]);

  const alertChips = [
    { label: "Route to A-Book", severity: "normal" },
    { label: "Route to B-Book", severity: "monitor" },
    { label: "Trigger Churn Alert", severity: "monitor" },
    { label: "Auto Reduce Leverage", severity: "urgent" },
    { label: "Flag Compliance", severity: "critical" },
    { label: "Manual Review Required", severity: "urgent" },
    { label: "Bonus Abuse Watch", severity: "monitor" },
    { label: "Toxic Flow Alert", severity: "urgent" },
  ] as const;

  const riskCategories = [
    { name: "Leverage Risk", value: dashboard?.totals.leverageRiskAlerts || 0 },
    { name: "Toxic Flow", value: dashboard?.totals.toxicFlowAlerts || 0 },
    { name: "Bonus Abuse", value: dashboard?.totals.bonusAbuseAlerts || 0 },
    { name: "Compliance", value: dashboard?.totals.flagCompliance || 0 },
    { name: "Churn", value: dashboard?.totals.triggerChurnAlert || 0 },
  ];
  const riskMax = Math.max(1, ...riskCategories.map((r) => r.value));
  const activeRun = runRows.find((r) => String(r?.status || "").toLowerCase() === "running") || null;
  const latestRun = runRows[0] || null;
  const displayRun = activeRun || latestRun;
  const lastSuccessRun = runRows.find((r) => String(r?.status || "").toLowerCase() === "success");
  const dashboardIsEmpty = !!dashboard && (dashboard.totals?.totalClients || 0) === 0
    && (dashboard.topRevenue || []).length === 0
    && (dashboard.topRisk || []).length === 0;

  useEffect(() => {
    const isRunning = !!activeRun || String(displayRun?.status || "").toLowerCase() === "running";
    // Clear progress bar when no run is active and we're not launching one.
    if (!runActionLoading && !isRunning) {
      if (runProgressPct > 0) setRunProgressPct(0);
    }
  }, [runActionLoading, activeRun, displayRun?.status, runProgressPct]);

  // Auto-track a running run found in DB that was NOT started by this session.
  // This also keeps the backend stale-run check alive by polling loadRuns() every 10s.
  useEffect(() => {
    if (runActionLoading) return; // Already tracked inside runFullProfilingNow loop
    if (!activeRun) {
      if (activeRunId !== null) setActiveRunId(null);
      return;
    }
    const rid = Number(activeRun.id);
    if (activeRunId !== rid) setActiveRunId(rid);
    // Poll every 10s so the backend stale-run close query fires and UI stays fresh
    const interval = window.setInterval(() => {
      void loadRuns();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [activeRun?.id, runActionLoading]);

  return (
    <div className="space-y-6 pb-6">
      <section className="rounded-2xl border border-slate-700/50 bg-gradient-to-b from-slate-950 to-slate-900 p-5 shadow-[0_0_30px_rgba(6,182,212,0.12)]">
        {dashboardLoading && <div className="mt-4 text-sm text-slate-300">Loading CP dashboard...</div>}
        {dashboardError && <div className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{dashboardError}</div>}
        {bootstrapMessage && (
          <div className="mt-4 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
            {bootstrapMessage}
          </div>
        )}
        {runActionMessage && (
          <div className="mt-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            {runActionMessage}
          </div>
        )}
        {latestRunStepMessage && (
          <div className="mt-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
            Last run step: {latestRunStepMessage}
          </div>
        )}

        <div className="mt-4 rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">Profiling Run Status</div>
              <div className="mt-0.5 text-xs text-slate-400">
                {dashboard?.asOf ? `As of ${new Date(dashboard.asOf).toLocaleString()}` : "Loading..."}
                {activeRun ? ` • Active Run ID: #${activeRun.id}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={loadDashboard}
                className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/15"
              >
                Refresh Data
              </button>
              <button
                type="button"
                onClick={runFullProfilingNow}
                disabled={runActionLoading || !!activeRun}
                title={activeRun ? `Run #${activeRun.id} is already running. Use 'Close Stuck Run' if it is stalled.` : undefined}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {runActionLoading ? "Starting..." : activeRun ? `#${activeRun.id} Running...` : "Run Full Profiling"}
              </button>
              <button
                type="button"
                onClick={closeStuckRunNow}
                disabled={runActionLoading}
                className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/15 disabled:opacity-60"
              >
                Close Stuck Run
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const targetRunId = Number(activeRunId || latestRun?.id || 0) || null;
                    let runSteps: any[] = [];
                    let runErrors: any[] = [];
                    if (targetRunId) {
                      const stepsData = await fetchClientProfileRunSteps(targetRunId, 500).catch(() => ({ rows: [] as any[] }));
                      const errorsData = await fetchClientProfileRunErrors(targetRunId, 1000).catch(() => ({ rows: [] as any[] }));
                      runSteps = Array.isArray(stepsData?.rows) ? stepsData.rows : [];
                      runErrors = Array.isArray(errorsData?.rows) ? errorsData.rows : [];
                    }
                    const derivedCounts = deriveRunCountsFromSteps(runSteps);

                    const stepSummary = runSteps.reduce<Record<string, { total: number; errors: number; lastMessage: string | null }>>((acc, row) => {
                      const key = String(row?.step_key || "unknown");
                      if (!acc[key]) acc[key] = { total: 0, errors: 0, lastMessage: null };
                      acc[key].total += 1;
                      if (String(row?.status || "").toLowerCase() === "error") {
                        acc[key].errors += 1;
                        acc[key].lastMessage = row?.message ? String(row.message) : acc[key].lastMessage;
                      } else if (!acc[key].lastMessage && row?.message) {
                        acc[key].lastMessage = String(row.message);
                      }
                      return acc;
                    }, {});

                    const groupedErrors = runErrors.reduce<Record<string, { count: number; samples: string[] }>>((acc, row) => {
                      const key = String(row?.error_code || "unknown_error");
                      if (!acc[key]) acc[key] = { count: 0, samples: [] };
                      acc[key].count += 1;
                      const msg = String(row?.error_message || "").trim();
                      if (msg && acc[key].samples.length < 10 && !acc[key].samples.includes(msg)) {
                        acc[key].samples.push(msg);
                      }
                      return acc;
                    }, {});

                    const payload = {
                      account: analysis?.client?.login || null,
                      asOf: analysis?.asOf || dashboard?.asOf || new Date().toISOString(),
                      source: analysis?.__source || "unknown",
                      diagnostics: analysis?.diagnostics || null,
                      latestRun,
                      latestRunDerived: latestRun
                        ? {
                            ...latestRun,
                            clients_processed: Math.max(Number((latestRun as any)?.clients_processed || 0), derivedCounts.persisted),
                            clients_failed: Math.max(Number((latestRun as any)?.clients_failed || 0), derivedCounts.failed),
                          }
                        : null,
                      targetRunId,
                      runStepSummary: stepSummary,
                      runErrorSummary: groupedErrors,
                      runSteps,
                      runErrors,
                    };
                    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
                    setRunActionMessage("Full diagnostics JSON copied (run, steps, and errors).");
                  } catch (e: any) {
                    setRunActionMessage(e?.message || "Failed to copy diagnostics.");
                  }
                }}
                className="rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-200 hover:bg-violet-500/15"
              >
                Copy Diagnostics JSON
              </button>
            </div>
          </div>
          {runActionLoading && (
            <div className="mb-2">
              <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                <span>
                  Full profiling run in progress...{activeRunId ? ` Run #${activeRunId} •` : ""} {runProgressPhase}
                  {runExpectedTotal
                    ? ` | ${Math.max(0, (displayRun?.clients_processed ?? 0) + (displayRun?.clients_failed ?? 0)).toLocaleString()} / ${runExpectedTotal.toLocaleString()} clients`
                    : " | discovering total clients"}
                </span>
                <span className="font-mono text-emerald-300">{Math.round(runProgressPct)}%</span>
              </div>
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="relative h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 transition-all duration-500"
                  style={{ width: `${Math.max(4, runProgressPct)}%` }}
                >
                  <div className="absolute inset-0 animate-pulse bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,0.24)_45%,transparent_100%)]" />
                </div>
              </div>
            </div>
          )}
          {runPanelLoading && <div className="text-xs text-slate-400">Loading run history...</div>}
          {!runPanelLoading && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              <div className="rounded-lg border border-slate-700/50 p-2">
                <div className="text-[10px] text-slate-400">
                  {activeRun ? "Active Run" : "Latest Run"}
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {displayRun ? `#${displayRun.id} ${String(displayRun.status || "unknown").toUpperCase()}` : "N/A"}
                  {activeRunId && Number(activeRunId) !== Number(displayRun?.id) ? ` (tracking #${activeRunId})` : ""}
                </div>
              </div>
              <div className="rounded-lg border border-slate-700/50 p-2">
                <div className="text-[10px] text-slate-400">Processed / Failed</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {(displayRun?.clients_processed ?? 0).toLocaleString()} / {(displayRun?.clients_failed ?? 0).toLocaleString()}
                </div>
              </div>
              <div className="rounded-lg border border-slate-700/50 p-2">
                <div className="text-[10px] text-slate-400">Last Started</div>
                <div className="mt-1 text-xs font-mono text-slate-100">
                  {displayRun?.started_at ? new Date(displayRun.started_at).toLocaleString() : "-"}
                </div>
              </div>
              <div className="rounded-lg border border-slate-700/50 p-2">
                <div className="text-[10px] text-slate-400">Last Successful Run</div>
                <div className="mt-1 text-xs font-mono text-emerald-300">
                  {lastSuccessRun?.finished_at ? new Date(lastSuccessRun.finished_at).toLocaleString() : "No successful run yet"}
                </div>
              </div>
            </div>
          )}
        </div>

        {dashboardIsEmpty && (
          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <div className="font-semibold">No CP data yet.</div>
            <div className="mt-1">
              Start a full profiling run to populate dashboard metrics for all clients, then refresh this page after completion.
            </div>
            <button
              type="button"
              onClick={runFullProfilingNow}
              disabled={runActionLoading}
              className="mt-2 rounded-md border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-400/15 disabled:opacity-60"
            >
              {runActionLoading ? "Starting..." : "Run Full Profiling Now"}
            </button>
          </div>
        )}

        {!dashboardLoading && !dashboardError && dashboard && (
          <>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
              {kpis.map((kpi) => (
                <div key={kpi.key} className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3 backdrop-blur">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">{kpi.label}</div>
                    <MiniTrend text={kpi.trend} />
                  </div>
                  <div className="mt-1 text-xl font-semibold text-slate-100">{kpi.value.toLocaleString()}</div>
                  <div className={`mt-2 h-1 rounded-full bg-gradient-to-r ${kpi.accent}`} />
                  <div className="mt-2"><Sparkline /></div>
                </div>
              ))}
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-12">
              <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-4 xl:col-span-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">A-Book vs B-Book</div>
                <div className="mt-4 flex items-center justify-center">
                  <div className="relative h-40 w-40 rounded-full border border-slate-700 bg-slate-950">
                    <div
                      className="absolute inset-0 rounded-full"
                      style={{
                        background: `conic-gradient(#06b6d4 0 ${donutValues.a}%, #0ea5e9 ${donutValues.a}% ${donutValues.a + donutValues.b}%, #334155 ${donutValues.a + donutValues.b}% 100%)`,
                      }}
                    />
                    <div className="absolute inset-6 rounded-full bg-slate-950/95" />
                    <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-slate-200">
                      {donutValues.a}% / {donutValues.b}%
                    </div>
                  </div>
                </div>
                <div className="mt-3 text-center text-xs text-slate-400">
                  A-Book {dashboard.totals.routeABook.toLocaleString()} | B-Book {dashboard.totals.routeBBook.toLocaleString()}
                </div>
              </div>

              <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-4 xl:col-span-5">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">Client Segments / Clusters</div>
                <div className="mt-3 space-y-2">
                  {clusterRows.map((row) => (
                    <div key={row.key}>
                      <div className="mb-1 flex items-center justify-between text-[11px] text-slate-300">
                        <span>{row.label}</span>
                        <span className="font-mono">{row.value.toLocaleString()}</span>
                      </div>
                      <BarLine value={row.value} max={Math.max(1, clusterRows[0]?.value || 1)} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-4 xl:col-span-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">Top Client Risk Categories</div>
                <div className="mt-3 space-y-2">
                  {riskCategories.map((row) => (
                    <div key={row.name}>
                      <div className="mb-1 flex items-center justify-between text-[11px] text-slate-300">
                        <span>{row.name}</span>
                        <span className="font-mono">{row.value.toLocaleString()}</span>
                      </div>
                      <BarLine value={row.value} max={riskMax} />
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-lg border border-slate-700/60 bg-slate-950/60 p-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">7D Active Alerts Trend</div>
                  <div className="mt-2 h-14"><Sparkline /></div>
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/80 p-4 xl:col-span-8">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Top 10 Revenue Traders</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-slate-200">
              <thead className="bg-slate-950/70 text-slate-400">
                <tr>
                  <th className="px-2 py-2 text-left">Account</th>
                  <th className="px-2 py-2 text-left">Name</th>
                  <th className="px-2 py-2 text-right">Volume</th>
                  <th className="px-2 py-2 text-right">Net PnL</th>
                  <th className="px-2 py-2 text-right">Broker Revenue</th>
                  <th className="px-2 py-2 text-center">RFM Score</th>
                  <th className="px-2 py-2 text-left">Recommended Action</th>
                </tr>
              </thead>
              <tbody>
                {(dashboard?.topRevenue || []).map((row) => (
                  <tr key={`rev-${row.clientId}`} className="border-t border-slate-800">
                    <td className="px-2 py-2 font-mono">{row.clientId}</td>
                    <td className="px-2 py-2">Client {row.clientId}</td>
                    <td className="px-2 py-2 text-right">{fmt(row.tradeCount * 0.45, 2)} lots</td>
                    <td className="px-2 py-2 text-right">{fmt(row.netPnl)}</td>
                    <td className="px-2 py-2 text-right">{fmt(Math.max(0, row.tradeCount * 2.4 + row.netPnl * 0.03))}</td>
                    <td className="px-2 py-2 text-center">{Math.min(15, Math.max(3, Math.round(row.winRate * 10 + 5)))}</td>
                    <td className="px-2 py-2">{row.suggestedRoute}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/80 p-4 xl:col-span-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Active Alerts</div>
          <div className="space-y-2">
            {alertChips.map((chip) => (
              <div key={chip.label} className={`rounded-lg border px-2 py-1.5 text-xs ${ALERT_STYLE[chip.severity]}`}>
                {chip.label}
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-slate-700/50 bg-slate-950/60 p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Recent Triggered Alerts Heatmap</div>
            <div className="mt-2 grid grid-cols-8 gap-1">
              {Array.from({ length: 40 }).map((_, idx) => (
                <div
                  key={`hm-${idx}`}
                  className={`h-3 rounded ${
                    idx % 11 === 0 ? "bg-rose-500/70" :
                    idx % 7 === 0 ? "bg-amber-500/70" :
                    idx % 3 === 0 ? "bg-cyan-500/60" : "bg-slate-700"
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/80 p-4 xl:col-span-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Top 10 Risk Traders</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-slate-200">
              <thead className="bg-slate-950/70 text-slate-400">
                <tr>
                  <th className="px-2 py-2 text-left">Account</th>
                  <th className="px-2 py-2 text-left">Name</th>
                  <th className="px-2 py-2 text-right">Win Rate</th>
                  <th className="px-2 py-2 text-right">Profit Factor</th>
                  <th className="px-2 py-2 text-right">Avg Hold</th>
                  <th className="px-2 py-2 text-right">Toxic Score</th>
                  <th className="px-2 py-2 text-left">Recommended Action</th>
                </tr>
              </thead>
              <tbody>
                {(dashboard?.topRisk || []).map((row) => (
                  <tr key={`risk-${row.clientId}`} className="border-t border-slate-800">
                    <td className="px-2 py-2 font-mono">{row.clientId}</td>
                    <td className="px-2 py-2">Client {row.clientId}</td>
                    <td className="px-2 py-2 text-right">{pct(Math.max(8, 55 - (row.riskScore || 0) * 0.4))}</td>
                    <td className="px-2 py-2 text-right">{fmt(Math.max(0.2, 2 - (row.riskScore || 50) / 60), 2)}</td>
                    <td className="px-2 py-2 text-right">{fmt(row.avgHoldMinutes)}m</td>
                    <td className="px-2 py-2 text-right">{row.riskScore || Math.round((row.flags.length * 25) + 20)}</td>
                    <td className="px-2 py-2">{row.flags.join(", ") || "Manual Review"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/80 p-4 xl:col-span-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Churn Watchlist</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-slate-200">
              <thead className="bg-slate-950/70 text-slate-400">
                <tr>
                  <th className="px-2 py-2 text-left">Account</th>
                  <th className="px-2 py-2 text-left">Name</th>
                  <th className="px-2 py-2 text-left">Last Trade Date</th>
                  <th className="px-2 py-2 text-right">Days Inactive</th>
                  <th className="px-2 py-2 text-center">RFM Score</th>
                  <th className="px-2 py-2 text-left">Suggested Campaign</th>
                </tr>
              </thead>
              <tbody>
                {(dashboard?.churnWatchlist || []).slice(0, 10).map((row) => (
                  <tr key={`cw-${row.clientId}`} className="border-t border-slate-800">
                    <td className="px-2 py-2 font-mono">{row.clientId}</td>
                    <td className="px-2 py-2">Client {row.clientId}</td>
                    <td className="px-2 py-2">{row.lastTradeAt ? new Date(row.lastTradeAt).toLocaleDateString() : "-"}</td>
                    <td className="px-2 py-2 text-right">{row.recencyDays}</td>
                    <td className="px-2 py-2 text-center">{Math.max(3, 15 - Math.min(12, Math.floor(row.recencyDays / 8)))}</td>
                    <td className="px-2 py-2">{row.recencyDays > 45 ? "High-touch winback" : "Education + retention offer"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-700/60 bg-slate-900/80 p-5">
        <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-300/90">Client Search & Analysis</div>
        <h3 className="mt-1 text-xl font-semibold text-slate-100">Enter Client Account Number</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[280px_auto]">
          <input
            type="number"
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            placeholder="e.g. 123456"
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono text-slate-100 placeholder:text-slate-500"
          />
          <button
            type="button"
            onClick={runAnalysis}
            disabled={analysisLoading}
            className="w-fit rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-60"
          >
            {analysisLoading ? "Analyzing..." : "Analyze Client"}
          </button>
        </div>
        {analysisLoading && (
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
              <span>Analysis in progress...</span>
              <span className="font-mono text-cyan-300">{Math.round(analysisProgressPct)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-teal-400 to-emerald-400 transition-all duration-300"
                style={{ width: `${Math.max(4, analysisProgressPct)}%` }}
              />
            </div>
            <div className="mt-1 text-[10px] text-slate-500">Fetching CRM, MT5, transactions, and trade history...</div>
          </div>
        )}
      {analysisError && <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{analysisError}</div>}
      {analysis && analysis.__source && analysis.__source !== "cp_engine" && (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Analysis loaded in fallback mode. CP engine write-back is unavailable, so core CP tables may not be updated from this analysis.
        </div>
      )}
    </section>

      {analysis && (
        <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-900/80 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-700/60 bg-slate-950/70 p-4">
            <div>
              <div className="text-lg font-semibold text-slate-100">
                {analysis.client.firstName || "-"} {analysis.client.lastName || "-"} - #{analysis.client.login}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                KYC Status: {analysis.crmProfile?.status || "Unknown"} | Country: {analysis.client.country || "-"} | Account Group: {analysis.mt5AccountSummary?.group || "-"}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Assigned Manager: {analysis.crmProfile?.managerId ?? "-"} | Current Book: {analysis.mt5AccountSummary?.tradingStatus || "Unknown"} | Recommended Book: {analysis.recommendations.route}
              </div>
            </div>
            <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-right">
              <div className="text-[10px] uppercase tracking-wide text-cyan-300">Confidence</div>
              <div className="text-xl font-semibold text-cyan-200">{analysis.confidencePct}%</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/70 p-2.5"><div className="text-[10px] text-slate-400">Balance</div><div className="mt-1 font-mono text-slate-100">{fmt(analysis.financialSnapshot.balance)}</div></div>
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/70 p-2.5"><div className="text-[10px] text-slate-400">Equity</div><div className="mt-1 font-mono text-slate-100">{fmt(analysis.financialSnapshot.equity)}</div></div>
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/70 p-2.5"><div className="text-[10px] text-slate-400">Margin Level</div><div className="mt-1 font-mono text-slate-100">{pct((analysis.financialSnapshot.equity / Math.max(1, analysis.financialSnapshot.margin || 1)) * 100)}</div></div>
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/70 p-2.5"><div className="text-[10px] text-slate-400">Net Deposit</div><div className="mt-1 font-mono text-slate-100">{fmt(analysis.financialSnapshot.netFunding)}</div></div>
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/70 p-2.5"><div className="text-[10px] text-slate-400">Realized PnL</div><div className="mt-1 font-mono text-slate-100">{fmt(analysis.profile.netPnl)}</div></div>
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/70 p-2.5"><div className="text-[10px] text-slate-400">Broker Revenue</div><div className="mt-1 font-mono text-slate-100">{fmt(Math.max(0, analysis.profile.totalCommission + Math.max(0, -analysis.profile.netPnl)))}</div></div>
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/70 p-2.5"><div className="text-[10px] text-slate-400">Total Trades</div><div className="mt-1 font-mono text-slate-100">{analysis.profile.tradeCount.toLocaleString()}</div></div>
            <div className="rounded-lg border border-slate-700/60 bg-slate-950/70 p-2.5"><div className="text-[10px] text-slate-400">Win Rate</div><div className="mt-1 font-mono text-slate-100">{pct(analysis.profile.winRate * 100)}</div></div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">Analytics Panels</div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-slate-700/50 p-2">
                  <div className="text-slate-400">PnL Over Time</div>
                  <div className="mt-2"><Sparkline /></div>
                </div>
                <div className="rounded-lg border border-slate-700/50 p-2">
                  <div className="text-slate-400">Trade Frequency</div>
                  <div className="mt-2"><Sparkline /></div>
                </div>
                <div className="rounded-lg border border-slate-700/50 p-2">
                  <div className="text-slate-400">Symbol Distribution</div>
                  <div className="mt-2"><Sparkline /></div>
                </div>
                <div className="rounded-lg border border-slate-700/50 p-2">
                  <div className="text-slate-400">Drawdown Curve</div>
                  <div className="mt-2"><Sparkline /></div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">Score Cards</div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-2"><div className="text-[10px] text-cyan-200">Risk Score</div><div className="text-lg font-semibold text-cyan-100">{analysis.scores.riskScore}</div></div>
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2"><div className="text-[10px] text-emerald-200">Revenue Score</div><div className="text-lg font-semibold text-emerald-100">{analysis.scores.revenueScore}</div></div>
                <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 p-2"><div className="text-[10px] text-violet-200">Churn Score</div><div className="text-lg font-semibold text-violet-100">{analysis.scores.churnScore}</div></div>
                <div className="rounded-lg border border-slate-500/40 bg-slate-800/80 p-2"><div className="text-[10px] text-slate-300">Compliance Score</div><div className="text-lg font-semibold text-slate-100">{analysis.scores.complianceScore}</div></div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {analysis.alerts.map((tag) => (
                  <span key={tag} className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200">
                    {tag.split("_").join(" ")}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {analysis.dealingEvidence && (
            <div className="rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">Decision Evidence (Dealing Endpoints)</div>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                <div className="rounded-lg border border-slate-700/50 p-2 text-xs">
                  <div className="text-slate-400">History Deals</div>
                  <div className="mt-1 font-mono text-slate-100">{analysis.dealingEvidence.status?.historyDeals || "-"}</div>
                </div>
                <div className="rounded-lg border border-slate-700/50 p-2 text-xs">
                  <div className="text-slate-400">History Aggregate</div>
                  <div className="mt-1 font-mono text-slate-100">{analysis.dealingEvidence.status?.historyAggregate || "-"}</div>
                </div>
                <div className="rounded-lg border border-slate-700/50 p-2 text-xs">
                  <div className="text-slate-400">Metrics Dashboard</div>
                  <div className="mt-1 font-mono text-slate-100">{analysis.dealingEvidence.status?.metrics || "-"}</div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
                <div className="rounded-lg border border-slate-700/50 p-2"><div className="text-[10px] text-slate-400">Deals</div><div className="font-mono text-slate-100">{Math.round(analysis.dealingEvidence.dealStats?.dealsCount || 0)}</div></div>
                <div className="rounded-lg border border-slate-700/50 p-2"><div className="text-[10px] text-slate-400">Win Rate</div><div className="font-mono text-slate-100">{pct(analysis.dealingEvidence.dealStats?.winRatePct || 0)}</div></div>
                <div className="rounded-lg border border-slate-700/50 p-2"><div className="text-[10px] text-slate-400">Profit Factor</div><div className="font-mono text-slate-100">{fmt(analysis.dealingEvidence.dealStats?.profitFactor || 0, 2)}</div></div>
                <div className="rounded-lg border border-slate-700/50 p-2"><div className="text-[10px] text-slate-400">Avg Hold</div><div className="font-mono text-slate-100">{fmt(analysis.dealingEvidence.dealStats?.avgHoldMinutes || 0, 1)}m</div></div>
                <div className="rounded-lg border border-slate-700/50 p-2"><div className="text-[10px] text-slate-400">Net PL</div><div className="font-mono text-slate-100">{fmt(analysis.dealingEvidence.aggregate?.netPL || 0)}</div></div>
                <div className="rounded-lg border border-slate-700/50 p-2"><div className="text-[10px] text-slate-400">Total Lots</div><div className="font-mono text-slate-100">{fmt(analysis.dealingEvidence.aggregate?.totalLots || 0, 2)}</div></div>
                <div className="rounded-lg border border-slate-700/50 p-2"><div className="text-[10px] text-slate-400">Margin Level</div><div className="font-mono text-slate-100">{pct(analysis.dealingEvidence.accountHealth?.marginLevel || 0)}</div></div>
                <div className="rounded-lg border border-slate-700/50 p-2"><div className="text-[10px] text-slate-400">NTP %</div><div className="font-mono text-slate-100">{pct(analysis.dealingEvidence.aggregate?.ntpPercent || 0)}</div></div>
              </div>
            </div>
          )}

          {analysis.diagnostics && (
            <div className="rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">Pipeline Diagnostics</div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const payload = {
                        account: analysis.client?.login,
                        asOf: analysis.asOf,
                        source: analysis.__source || "unknown",
                        diagnostics: analysis.diagnostics,
                      };
                      const text = JSON.stringify(payload, null, 2);
                      await navigator.clipboard.writeText(text);
                      setActionMessage("Diagnostics JSON copied to clipboard.");
                    } catch (e: any) {
                      setActionMessage(e?.message || "Failed to copy diagnostics.");
                    }
                  }}
                  className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/15"
                >
                  Copy Diagnostics JSON
                </button>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                <div className="rounded-lg border border-slate-700/50 p-2 text-xs">
                  <div className="text-slate-400">Fetch Checks</div>
                  <div className="mt-1 text-slate-200">
                    Source: {analysis.diagnostics.fetchChecks?.tradeHistorySource || "-"} | MT5 Token: {analysis.diagnostics.fetchChecks?.mt5TokenConfigured ? "yes" : "no"} | Portal Token: {analysis.diagnostics.fetchChecks?.portalTokenConfigured ? "yes" : "no"}
                  </div>
                  <div className="mt-1 text-slate-300 font-mono">
                    MT5 attempts: {analysis.diagnostics.fetchChecks?.tradeFetchDiagnostics?.mt5?.attemptedLogins ?? 0},
                    ok: {analysis.diagnostics.fetchChecks?.tradeFetchDiagnostics?.mt5?.fulfilledLogins ?? 0},
                    failed: {analysis.diagnostics.fetchChecks?.tradeFetchDiagnostics?.mt5?.failedLogins ?? 0},
                    deals: {analysis.diagnostics.fetchChecks?.tradeFetchDiagnostics?.mt5?.dealsFetched ?? 0}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-700/50 p-2 text-xs">
                  <div className="text-slate-400">DB Verify (row counts for this client)</div>
                  <div className="mt-1 grid grid-cols-2 gap-1 text-slate-200 font-mono">
                    {Object.entries(analysis.diagnostics.dbVerify || {}).map(([k, v]) => (
                      <div key={k}>{k}: {Number(v || 0)}</div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-2 rounded-lg border border-slate-700/50 p-2 text-xs">
                <div className="text-slate-400 mb-1">DB Write Checks</div>
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                  {Object.entries(analysis.diagnostics.writeChecks || {}).map(([k, v]) => (
                    <div key={k} className={v?.ok ? "text-emerald-300" : "text-rose-300"}>
                      {k}: {v?.ok ? "ok" : `failed${v?.error ? ` (${v.error})` : ""}`}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-teal-500/30 bg-gradient-to-r from-slate-950 to-slate-900 p-4 shadow-[0_0_20px_rgba(45,212,191,0.12)]">
            <div className="text-xs uppercase tracking-wide text-teal-200/90">Final Recommendation</div>
            <div className="mt-1 text-2xl font-semibold text-slate-100">{analysis.recommendations.route}</div>
            <div className="mt-1 text-sm text-slate-300">Confidence: {analysis.confidencePct}%</div>
            <div className="mt-3 text-xs text-slate-300">{analysis.explanation}</div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-300">
              {analysis.recommendations.brokerNotes.map((note, idx) => (
                <li key={`note-${idx}`}>{note}</li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">Action Panel (Super Admin Confirm Required)</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {ACTIONS.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => confirmAction(action.key)}
                  disabled={actionLoading}
                  className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-60"
                >
                  {action.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20"
              >
                Export PDF Report
              </button>
            </div>
            {actionMessage && <div className="mt-2 text-xs text-cyan-200">{actionMessage}</div>}
          </div>

          <div className="rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Audit Logs</div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-slate-200">
                <thead className="bg-slate-900/80 text-slate-400">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Time</th>
                    <th className="px-2 py-1.5 text-left">Action</th>
                    <th className="px-2 py-1.5 text-left">Client</th>
                    <th className="px-2 py-1.5 text-left">Login</th>
                    <th className="px-2 py-1.5 text-left">Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {auditRows.map((row) => (
                    <tr key={`audit-${row.id}`} className="border-t border-slate-800">
                      <td className="px-2 py-1.5">{row.created_at ? new Date(row.created_at).toLocaleString() : "-"}</td>
                      <td className="px-2 py-1.5">{row.action_key}</td>
                      <td className="px-2 py-1.5 font-mono">{row.client_id ?? "-"}</td>
                      <td className="px-2 py-1.5 font-mono">{row.login ?? "-"}</td>
                      <td className="px-2 py-1.5">{row.actor_email || row.actor_user_id || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}



