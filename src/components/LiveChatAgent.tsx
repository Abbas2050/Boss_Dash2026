import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronUp, CircleDot, MessageSquare, RefreshCw, SendHorizontal, X } from "lucide-react";
import { AgentCapabilities, AgentChatMessage, AgentChatResponse, AgentLiveSnapshot, fetchAgentCapabilities, sendAgentChat } from "@/lib/agentApi";
import { getAuthToken, hasAccess } from "@/lib/auth";
import { useNavigate } from "react-router-dom";

const quickPrompts = [
  "What is my current equity?",
  "Show coverage and uncovered exposure.",
  "How many swaps are due tonight?",
  "What is net P/L for this range?",
  "Show deposits, withdrawals, and net flow.",
  "How many new clients and MT5 accounts were created?",
  "Give me marketing sessions for current date range.",
];

const formatSigned = (value?: number | null) => {
  const amount = Number(value) || 0;
  return amount.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
};

type LiveAgentUiMessage = AgentChatMessage & {
  toolsUsed?: string[];
  at?: string;
  toolSummaries?: AgentChatResponse["toolSummaries"];
};

type ParsedAssistantAnswer = {
  asOf?: string;
  dateRange?: string;
  toolsUsed?: string[];
  result: string;
};

type AgentLinkTarget = {
  label: string;
  path: string;
};

type AnomalyBadge = {
  label: string;
  tone: "critical" | "warning" | "info";
};

const parseAssistantAnswer = (content: string): ParsedAssistantAnswer | null => {
  const text = String(content || "").trim();
  if (!text || text.startsWith("Agent error:")) return null;
  const lines = text.split(/\r?\n/);
  const asOfLine = lines.find((line) => line.startsWith("As of:"));
  const dateRangeLine = lines.find((line) => line.startsWith("Date range:"));
  const toolsLine = lines.find((line) => line.startsWith("Tools used:"));
  const resultIndex = lines.findIndex((line) => line.trim() === "Result:");
  if (resultIndex === -1) return null;
  return {
    asOf: asOfLine?.replace(/^As of:\s*/, "").trim(),
    dateRange: dateRangeLine?.replace(/^Date range:\s*/, "").trim(),
    toolsUsed: toolsLine
      ?.replace(/^Tools used:\s*/, "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    result: lines.slice(resultIndex + 1).join("\n").trim(),
  };
};

const buildDeepLinks = (toolsUsed: string[]) => {
  const links: AgentLinkTarget[] = [];
  const available = new Set(toolsUsed || []);
  const add = (label: string, path: string, visible = true) => {
    if (!visible) return;
    if (links.some((entry) => entry.path === path)) return;
    links.push({ label, path });
  };

  if (available.has("get_dealing_metrics") || available.has("get_live_snapshot")) {
    add("Open Dealing", "/departments/dealing?tab=dealing", hasAccess("Dealing") || hasAccess("LiveAgent"));
  }
  if (available.has("get_coverage_metrics")) {
    add("Open Coverage", "/departments/dealing?tab=coverage", hasAccess("Dealing") || hasAccess("LiveAgent"));
    add("Open Risk Exposure", "/departments/dealing?tab=risk-exposure", hasAccess("Dealing") || hasAccess("LiveAgent"));
  }
  if (available.has("get_swap_metrics")) {
    add("Open Swap Tracker", "/departments/dealing?tab=swap-tracker", hasAccess("Dealing") || hasAccess("LiveAgent"));
  }
  if (available.has("get_history_aggregate")) {
    add("Open History", "/departments/dealing?tab=history", hasAccess("Dealing") || hasAccess("LiveAgent"));
  }
  if (available.has("get_accounts_metrics")) {
    add("Open Accounts", "/departments/accounts", hasAccess("Accounts"));
  }
  if (available.has("get_backoffice_metrics")) {
    add("Open Backoffice", "/departments/backoffice", hasAccess("Backoffice"));
  }
  if (available.has("get_marketing_metrics")) {
    add("Open Marketing", "/departments/marketing", hasAccess("Marketing"));
  }
  if (["get_lp_metrics", "get_lp_equity_summary", "get_lp_accounts"].some((tool) => available.has(tool))) {
    add("Open LP Manager", "/settings/lp-manager", hasAccess("Settings"));
  }
  if (available.has("list_swagger_endpoints")) {
    add("Open Coverage Settings", "/settings/coverage", hasAccess("Settings"));
  }

  return links;
};

const formatMetricValue = (value: unknown, percent = false) => {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") {
    const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return percent ? `${formatted}%` : formatted;
  }
  return String(value);
};

const buildSummaryCards = (toolSummaries: AgentChatResponse["toolSummaries"] = []) => {
  return (toolSummaries || []).flatMap((summary) => {
    const data = summary?.data || {};
    switch (summary?.tool) {
      case "get_dealing_metrics":
        return [
          { tool: summary.tool, label: "Equity", value: formatMetricValue(data.totalEquity) },
          { tool: summary.tool, label: "Credit", value: formatMetricValue(data.totalCredit) },
          { tool: summary.tool, label: "Net Lots", value: formatMetricValue(data.netLots) },
          { tool: summary.tool, label: "Deals", value: formatMetricValue(data.deals) },
        ];
      case "get_coverage_metrics":
        return [
          { tool: summary.tool, label: "Coverage", value: formatMetricValue(data.coveragePct, true) },
          { tool: summary.tool, label: "Uncovered", value: formatMetricValue(data.totalUncovered) },
          { tool: summary.tool, label: "Symbols", value: formatMetricValue(data.symbolCount) },
          { tool: summary.tool, label: "LPs", value: formatMetricValue(data.lpCount) },
        ];
      case "list_app_endpoints":
        return [
          { tool: summary.tool, label: "Matched", value: formatMetricValue(data.totalMatched) },
          { tool: summary.tool, label: "Available", value: formatMetricValue(data.totalAvailable) },
          { tool: summary.tool, label: "First Endpoint", value: formatMetricValue(data.endpoints?.[0]?.id) },
        ];
      case "call_app_endpoint":
        return [
          { tool: summary.tool, label: "Endpoint", value: formatMetricValue(data.endpointId) },
          { tool: summary.tool, label: "Status", value: formatMetricValue(data.status) },
          { tool: summary.tool, label: "OK", value: formatMetricValue(data.ok) },
        ];
      case "get_symbol_coverage":
        return [
          { tool: summary.tool, label: "Symbol", value: formatMetricValue(data.symbol) },
          { tool: summary.tool, label: "Coverage", value: formatMetricValue(data.coveragePct, true) },
          { tool: summary.tool, label: "Client Net", value: formatMetricValue(data.clientNet) },
          { tool: summary.tool, label: "Uncovered", value: formatMetricValue(data.uncovered) },
        ];
      case "get_bonus_metrics":
        return [
          { tool: summary.tool, label: "Gross PnL", value: formatMetricValue(data.grossPnl) },
          { tool: summary.tool, label: "LP Realized", value: formatMetricValue(data.lpRealizedPnl) },
          { tool: summary.tool, label: "LP Unrealized", value: formatMetricValue(data.lpUnrealizedPnl) },
          { tool: summary.tool, label: "Monthly Rows", value: formatMetricValue(data.monthlyRows) },
        ];
      case "get_swap_metrics":
        return [
          { tool: summary.tool, label: "Positions", value: formatMetricValue(data.positionCount) },
          { tool: summary.tool, label: "Due Tonight", value: formatMetricValue(data.dueTonight) },
          { tool: summary.tool, label: "Negative Swap", value: formatMetricValue(data.negativeSwapPositions) },
          { tool: summary.tool, label: "Total Swap", value: formatMetricValue(data.totalSwap) },
        ];
      case "get_trading_activity":
        return [
          { tool: summary.tool, label: "Deals", value: formatMetricValue(data.dealCount) },
          { tool: summary.tool, label: "Symbols", value: formatMetricValue(data.symbolCount) },
          { tool: summary.tool, label: "Lots", value: formatMetricValue(data.totals?.totalLots) },
          { tool: summary.tool, label: "Profit", value: formatMetricValue(data.totals?.totalProfit) },
        ];
      case "get_history_aggregate":
        return [
          { tool: summary.tool, label: "Net P/L", value: formatMetricValue(data.totals?.netPL) },
          { tool: summary.tool, label: "Real LP P/L", value: formatMetricValue(data.totals?.realLpPL) },
          { tool: summary.tool, label: "LP P/L", value: formatMetricValue(data.totals?.lpPL) },
          { tool: summary.tool, label: "Gross Profit", value: formatMetricValue(data.totals?.grossProfit) },
        ];
      case "get_history_deals":
        return [
          { tool: summary.tool, label: "Login", value: formatMetricValue(data.login) },
          { tool: summary.tool, label: "Deals", value: formatMetricValue(data.totalDeals) },
          { tool: summary.tool, label: "Profit", value: formatMetricValue(data.totals?.profit) },
          { tool: summary.tool, label: "Commission", value: formatMetricValue(data.totals?.commission) },
        ];
      case "get_history_volume":
        return [
          { tool: summary.tool, label: "Rows", value: formatMetricValue(data.rowCount) },
          { tool: summary.tool, label: "Trades", value: formatMetricValue(data.totals?.tradeCount) },
          { tool: summary.tool, label: "Lots", value: formatMetricValue(data.totals?.totalLots) },
          { tool: summary.tool, label: "Yards", value: formatMetricValue(data.totals?.volumeYards) },
        ];
      case "get_accounts_metrics":
        return [
          { tool: summary.tool, label: "Deposits", value: formatMetricValue(data.totalDeposits) },
          { tool: summary.tool, label: "Withdrawals", value: formatMetricValue(data.totalWithdrawals) },
          { tool: summary.tool, label: "Net Flow", value: formatMetricValue(data.netFlow) },
          { tool: summary.tool, label: "Wallet", value: formatMetricValue(data.walletTotal) },
        ];
      case "get_backoffice_metrics":
        return [
          { tool: summary.tool, label: "Clients", value: formatMetricValue(data.totalClients) },
          { tool: summary.tool, label: "MT5 Accounts", value: formatMetricValue(data.totalMt5Accounts) },
          { tool: summary.tool, label: "Deposits", value: formatMetricValue(data.deposits) },
          { tool: summary.tool, label: "Withdrawals", value: formatMetricValue(data.withdrawals) },
        ];
      case "get_marketing_metrics":
        return [
          { tool: summary.tool, label: "Sessions", value: formatMetricValue(data.sessions) },
          { tool: summary.tool, label: "Active Users", value: formatMetricValue(data.activeUsers) },
          { tool: summary.tool, label: "New Users", value: formatMetricValue(data.newUsers) },
          { tool: summary.tool, label: "Conversions", value: formatMetricValue(data.conversions) },
        ];
      case "get_lp_metrics":
        return [
          { tool: summary.tool, label: "Accounts", value: formatMetricValue(data.accountCount) },
          { tool: summary.tool, label: "Avg Margin", value: formatMetricValue(data.avgMarginLevel, true) },
          { tool: summary.tool, label: "Equity", value: formatMetricValue(data.totals?.equity) },
          { tool: summary.tool, label: "Free Margin", value: formatMetricValue(data.totals?.freeMargin) },
        ];
      case "get_lp_equity_summary":
        return [
          { tool: summary.tool, label: "LP Withdrawable", value: formatMetricValue(data.lpWithdrawableEquity) },
          { tool: summary.tool, label: "Client Withdrawable", value: formatMetricValue(data.clientWithdrawableEquity) },
          { tool: summary.tool, label: "Difference", value: formatMetricValue(data.difference) },
        ];
      case "get_lp_positions":
        return [
          { tool: summary.tool, label: "LP", value: formatMetricValue(data.lpName) },
          { tool: summary.tool, label: "Positions", value: formatMetricValue(data.positionCount) },
          { tool: summary.tool, label: "Symbols", value: formatMetricValue(data.symbolCount) },
          { tool: summary.tool, label: "Net Lots", value: formatMetricValue(data.totalNetLots) },
        ];
      case "get_account_details":
        return [
          { tool: summary.tool, label: "Login", value: formatMetricValue(data.login) },
          { tool: summary.tool, label: "Equity", value: formatMetricValue(data.account?.equity) },
          { tool: summary.tool, label: "Balance", value: formatMetricValue(data.account?.balance) },
          { tool: summary.tool, label: "Margin %", value: formatMetricValue(data.account?.marginLevel, true) },
        ];
      case "get_user_accounts_by_email":
        return [
          { tool: summary.tool, label: "Email", value: formatMetricValue(data.email) },
          { tool: summary.tool, label: "Users", value: formatMetricValue(data.matchedUsers?.length) },
          { tool: summary.tool, label: "Accounts", value: formatMetricValue(data.tradingAccountsCount) },
          { tool: summary.tool, label: "First Login", value: formatMetricValue(data.logins?.[0]?.login) },
        ];
      case "get_crm_cashflow":
        return [
          { tool: summary.tool, label: "CRM/User", value: formatMetricValue(data.userId) },
          { tool: summary.tool, label: "Deposits", value: formatMetricValue(data.totalDeposits) },
          { tool: summary.tool, label: "Withdrawals", value: formatMetricValue(data.totalWithdrawals) },
          { tool: summary.tool, label: "Net Flow", value: formatMetricValue(data.netFlow) },
        ];
      case "get_contract_sizes":
        return [
          { tool: summary.tool, label: "Symbol", value: formatMetricValue(data.symbol) },
          { tool: summary.tool, label: "Mappings", value: formatMetricValue(data.count) },
          { tool: summary.tool, label: "Detected", value: formatMetricValue(data.detected ? "yes" : "-") },
        ];
      case "get_symbol_mappings":
        return [
          { tool: summary.tool, label: "Mappings", value: formatMetricValue(data.count) },
          { tool: summary.tool, label: "First Raw", value: formatMetricValue(data.items?.[0]?.rawSymbol) },
          { tool: summary.tool, label: "First Mapped", value: formatMetricValue(data.items?.[0]?.mappedSymbol) },
        ];
      default:
        return [];
    }
  });
};

const toYmd = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export function LiveChatAgent() {
  const navigate = useNavigate();
  const today = useMemo(() => toYmd(new Date()), []);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<LiveAgentUiMessage[]>([
    {
      role: "assistant",
      content: "Sky Links Agent is online. Ask about Dealing, LP, Backoffice, Accounts, or Marketing metrics.",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [capabilityLabel, setCapabilityLabel] = useState("standby");
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [live, setLive] = useState<AgentLiveSnapshot | null>(null);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "live" | "error">("connecting");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [draftFromDate, setDraftFromDate] = useState(today);
  const [draftToDate, setDraftToDate] = useState(today);
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const hasPendingRangeChange = draftFromDate !== fromDate || draftToDate !== toDate;
  const lastNoticeRef = useRef("");

  const anomalyBadges = useMemo<AnomalyBadge[]>(() => {
    const badges: AnomalyBadge[] = [];
    if (liveStatus === "error") {
      badges.push({ label: "Live stream disconnected", tone: "critical" });
    }
    const coveragePct = Number(live?.coverage?.coveragePct);
    if (Number.isFinite(coveragePct)) {
      if (coveragePct < 95) badges.push({ label: `Coverage ${coveragePct.toFixed(2)}%`, tone: "critical" });
      else if (coveragePct < 98) badges.push({ label: `Coverage ${coveragePct.toFixed(2)}%`, tone: "warning" });
    }
    const avgMarginLevel = Number(live?.lpMetrics?.avgMarginLevel);
    if (Number.isFinite(avgMarginLevel)) {
      if (avgMarginLevel < 120) badges.push({ label: `LP margin ${avgMarginLevel.toFixed(1)}%`, tone: "critical" });
      else if (avgMarginLevel < 150) badges.push({ label: `LP margin ${avgMarginLevel.toFixed(1)}%`, tone: "warning" });
    }
    if ((live?.swap?.dueTonight || 0) > 0) {
      badges.push({ label: `${live?.swap?.dueTonight} swap charges due`, tone: "info" });
    }
    if ((live?.history?.totals?.netPL || 0) < 0) {
      badges.push({ label: `Net P/L ${formatSigned(live?.history?.totals?.netPL)}`, tone: "warning" });
    }
    if ((live?.accounts?.netFlow || 0) < 0) {
      badges.push({ label: `Net flow ${formatSigned(live?.accounts?.netFlow)}`, tone: "warning" });
    }
    const missingDomains = [live?.dealing, live?.coverage, live?.lpMetrics, live?.swap].filter((entry) => !entry).length;
    if (missingDomains > 0) {
      badges.push({ label: `${missingDomains} live feed gap${missingDomains === 1 ? "" : "s"}`, tone: "info" });
    }
    return badges.slice(0, 4);
  }, [live, liveStatus]);

  useEffect(() => {
    if (!open) return;
    fetchAgentCapabilities()
      .then((c) => {
        setCapabilities(c);
        setCapabilityLabel(c.model);
      })
      .catch(() => setCapabilityLabel("fallback"));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const token = getAuthToken();
    if (!token) {
      setLiveStatus("error");
      return;
    }
    setLiveStatus("connecting");
    const es = new EventSource(`/api/agent/live?fromDate=${fromDate}&toDate=${toDate}&token=${encodeURIComponent(token)}`);
    es.addEventListener("snapshot", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as AgentLiveSnapshot;
        setLive(parsed);
        setLiveStatus("live");
      } catch {
        setLiveStatus("error");
      }
    });
    es.addEventListener("error", () => setLiveStatus("error"));
    return () => es.close();
  }, [open, fromDate, toDate]);

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages, open, loading]);

  const send = async (question: string) => {
    const content = question.trim();
    if (!content || loading) return;
    const nextMessages = [...messages, { role: "user", content } as LiveAgentUiMessage];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    try {
      const resp = await sendAgentChat({
        message: content,
        fromDate,
        toDate,
        history: nextMessages.slice(-8).map((message) => ({ role: message.role, content: message.content })),
      });
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: resp.answer || "No response",
          toolsUsed: resp.toolsUsed || [],
          at: resp.at,
          toolSummaries: resp.toolSummaries || [],
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Agent error: ${e?.message || "request failed"}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const applyRange = () => {
    setFromDate(draftFromDate);
    setToDate(draftToDate);
  };

  const resetToToday = () => {
    setDraftFromDate(today);
    setDraftToDate(today);
    setFromDate(today);
    setToDate(today);
  };

  const rangeLabel = fromDate === toDate ? fromDate : `${fromDate} to ${toDate}`;

  useEffect(() => {
    if (!open || anomalyBadges.length === 0) return;
    const actionable = anomalyBadges.filter((badge) => badge.tone === "critical" || badge.tone === "warning");
    if (!actionable.length) return;
    const noticeKey = `${rangeLabel}:${actionable.map((badge) => badge.label).join("|")}`;
    if (lastNoticeRef.current === noticeKey) return;
    lastNoticeRef.current = noticeKey;
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `Operational notice: ${actionable.map((badge) => badge.label).join("; ")}.`,
        toolsUsed: ["get_live_snapshot"],
        at: new Date().toISOString(),
        toolSummaries: [
          {
            tool: "get_live_snapshot",
            data: {
              dealing: live?.dealing || null,
              coverage: live?.coverage || null,
              lpMetrics: live?.lpMetrics || null,
              swap: live?.swap || null,
            },
          },
        ],
      },
    ]);
  }, [anomalyBadges, live, open, rangeLabel]);

  const renderAssistantContent = (message: LiveAgentUiMessage) => {
    const parsed = parseAssistantAnswer(message.content);
    const toolsUsed = message.toolsUsed?.length ? message.toolsUsed : parsed?.toolsUsed || [];
    const deepLinks = buildDeepLinks(toolsUsed);
    const summaryCards = buildSummaryCards(message.toolSummaries);

    if (!parsed) {
      return (
        <div className="space-y-2">
          {summaryCards.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {summaryCards.map((card, index) => (
                <div key={`${card.tool}-${card.label}-${index}`} className="rounded-lg border border-slate-200 bg-white/80 px-2.5 py-2 dark:border-slate-700 dark:bg-slate-950/70">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{card.label}</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">{card.value}</div>
                </div>
              ))}
            </div>
          )}
          <div className="whitespace-pre-wrap">{message.content}</div>
          {deepLinks.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {deepLinks.map((link) => (
                <button
                  key={link.path}
                  type="button"
                  onClick={() => navigate(link.path)}
                  className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-700 hover:bg-cyan-500/20 dark:text-cyan-200"
                >
                  {link.label}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    const resultLines = parsed.result.split(/\r?\n/).filter(Boolean);

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {parsed.dateRange && <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-700 dark:text-cyan-200">{parsed.dateRange}</span>}
          {parsed.asOf && <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">As of {new Date(parsed.asOf).toLocaleTimeString()}</span>}
          {message.at && <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">Reply {new Date(message.at).toLocaleTimeString()}</span>}
        </div>
        {summaryCards.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">KPI Snapshot</div>
            <div className="grid grid-cols-2 gap-2">
              {summaryCards.map((card, index) => (
                <div key={`${card.tool}-${card.label}-${index}`} className="rounded-lg border border-slate-200 bg-white/80 px-2.5 py-2 dark:border-slate-700 dark:bg-slate-950/70">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{card.label}</div>
                  <div className="mt-1 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">{card.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="rounded-xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-950/70 dark:text-slate-100">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Answer</div>
          <div className="space-y-1.5">
            {resultLines.length ? resultLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>) : <div>{parsed.result}</div>}
          </div>
        </div>
        {toolsUsed.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Sources</div>
            <div className="flex flex-wrap gap-1.5">
              {toolsUsed.map((tool) => (
                <span
                  key={tool}
                  className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        )}
        {deepLinks.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Open Related Page</div>
            <div className="flex flex-wrap gap-2">
              {deepLinks.map((link) => (
                <button
                  key={link.path}
                  type="button"
                  onClick={() => navigate(link.path)}
                  className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-700 hover:bg-cyan-500/20 dark:text-cyan-200"
                >
                  {link.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed bottom-5 right-5 z-[80]">
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group inline-flex items-center gap-2 rounded-full border border-cyan-500/50 bg-gradient-to-r from-cyan-600 to-emerald-600 px-4 py-3 text-white shadow-lg shadow-cyan-900/25"
        >
          <Bot className="h-4 w-4" />
          <span className="text-sm font-semibold">Live Agent</span>
          <span className={`h-2 w-2 rounded-full ${liveStatus === "live" ? "bg-emerald-300" : liveStatus === "connecting" ? "bg-amber-300" : "bg-rose-300"}`} />
        </button>
      )}

      {open && (
        <div className="w-[min(92vw,460px)] overflow-hidden rounded-2xl border border-cyan-500/30 bg-white/95 text-slate-900 shadow-2xl shadow-cyan-900/20 backdrop-blur dark:bg-slate-950/95 dark:text-slate-100">
          <div className="border-b border-cyan-500/20 bg-gradient-to-r from-slate-900 via-cyan-900 to-emerald-900 px-4 py-3 text-white">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-cyan-200" />
                <div>
                  <div className="text-sm font-semibold">Sky Links Live Agent</div>
                  <div className="text-[11px] text-cyan-100/90">Model: {capabilityLabel} | Range: {rangeLabel}</div>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded border border-white/30 p-1 text-white/90 hover:bg-white/10">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-[11px] dark:border-slate-800 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-slate-500 dark:text-slate-400">
                <span>From</span>
                <input
                  type="date"
                  value={draftFromDate}
                  max={draftToDate}
                  onChange={(e) => setDraftFromDate(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
              <label className="flex flex-col gap-1 text-slate-500 dark:text-slate-400">
                <span>To</span>
                <input
                  type="date"
                  value={draftToDate}
                  min={draftFromDate}
                  onChange={(e) => setDraftToDate(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
              <button
                type="button"
                onClick={applyRange}
                disabled={!hasPendingRangeChange}
                className="inline-flex items-center gap-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] font-medium text-cyan-700 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-cyan-200"
              >
                <RefreshCw className="h-3 w-3" />
                Apply Range
              </button>
              <button
                type="button"
                onClick={resetToToday}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600"
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => setShowCapabilities((value) => !value)}
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600"
              >
                {showCapabilities ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Capabilities {capabilities?.tools?.length ? `(${capabilities.tools.length})` : ""}
              </button>
            </div>
            {anomalyBadges.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {anomalyBadges.map((badge) => (
                  <span
                    key={badge.label}
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                      badge.tone === "critical"
                        ? "border-rose-400/40 bg-rose-500/10 text-rose-700 dark:text-rose-200"
                        : badge.tone === "warning"
                          ? "border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-200"
                          : "border-cyan-400/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200"
                    }`}
                  >
                    {badge.label}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <div className="text-slate-500 dark:text-slate-400">Equity</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.dealing?.totalEquity?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "-"}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Coverage %</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.coverage?.coveragePct?.toFixed(2) ?? "-"}%</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">LP Accounts</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.lpMetrics?.accountCount?.toLocaleString() ?? "-"}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Swap Due Tonight</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.swap?.dueTonight?.toLocaleString() ?? "-"}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">History Net P/L</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{formatSigned(live?.history?.totals?.netPL)}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Accounts Net Flow</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{formatSigned(live?.accounts?.netFlow)}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">New Clients</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.backoffice?.totalClients?.toLocaleString() ?? "-"}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Marketing Sessions</div>
              <div className="font-mono text-slate-900 dark:text-slate-100">{live?.marketing?.sessions?.toLocaleString() ?? "-"}</div>
            </div>
            </div>
            {showCapabilities && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white/80 px-3 py-2 dark:border-slate-700 dark:bg-slate-950/70">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Available Read-Only Tools
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(capabilities?.tools || []).map((tool) => (
                    <span
                      key={tool}
                      className="rounded-full border border-slate-300 bg-slate-100 px-2 py-1 text-[10px] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div ref={scrollerRef} className="max-h-[48vh] space-y-3 overflow-y-auto px-4 py-3">
            {messages.map((m, idx) => (
              <div key={`${idx}-${m.role}`} className={`max-w-[92%] rounded-xl border px-3 py-2 text-sm ${
                m.role === "user"
                  ? "ml-auto border-cyan-500/30 bg-cyan-500/10 text-slate-900 dark:text-slate-100"
                  : "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
              }`}>
                <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {m.role === "user" ? "You" : "Agent"} {m.role === "assistant" && <CircleDot className="h-3 w-3" />}
                </div>
                {m.role === "assistant" ? renderAssistantContent(m) : <div className="whitespace-pre-wrap">{m.content}</div>}
              </div>
            ))}
            {loading && (
              <div className="max-w-[92%] rounded-xl border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300">
                Agent is calculating...
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            <div className="mb-2 flex flex-wrap gap-2">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => send(prompt)}
                  className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[11px] text-slate-600 hover:border-cyan-500/40 hover:text-cyan-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:text-cyan-300"
                >
                  {prompt}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send(input);
                }}
                placeholder="Ask anything about your live operations..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-cyan-500/40 placeholder:text-slate-400 focus:ring dark:border-slate-700 dark:bg-slate-900 dark:placeholder:text-slate-500"
              />
              <button
                type="button"
                onClick={() => send(input)}
                disabled={loading || !input.trim()}
                className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-700 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-cyan-200"
              >
                <SendHorizontal className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
