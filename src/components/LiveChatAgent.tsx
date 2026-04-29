import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleDot, MessageSquare, SendHorizontal, X } from "lucide-react";
import { AgentChatMessage, AgentChatResponse, sendAgentChat } from "@/lib/agentApi";
import { getCurrentUser, hasAccess } from "@/lib/auth";
import { getVisibleDepartmentItems, getVisibleSettingsMenuItems } from "@/lib/permissions";
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

const LIVE_AGENT_FAB_WIDTH = 168;
const LIVE_AGENT_FAB_HEIGHT = 56;
const LIVE_AGENT_FAB_MARGIN = 16;
const LIVE_AGENT_CLICK_DRAG_THRESHOLD = 5;
const LIVE_AGENT_STORAGE_KEY = "live_agent_fab_position_v1";

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

const buildDeepLinks = (toolsUsed: string[], options: { departmentPaths: Set<string>; settingsPaths: Set<string>; canUseLiveAgent: boolean }) => {
  const links: AgentLinkTarget[] = [];
  const available = new Set(toolsUsed || []);
  const canVisit = (path: string) => options.departmentPaths.has(path) || options.settingsPaths.has(path);
  const add = (label: string, path: string, visible = true) => {
    if (!visible) return;
    if (links.some((entry) => entry.path === path)) return;
    links.push({ label, path });
  };

  if (available.has("get_dealing_metrics") || available.has("get_live_snapshot")) {
    add("Open Dealing", "/departments/dealing?tab=dealing", canVisit("/departments/dealing") || options.canUseLiveAgent);
  }
  if (available.has("get_coverage_metrics")) {
    add("Open Coverage", "/departments/dealing?tab=coverage", canVisit("/departments/dealing") || options.canUseLiveAgent);
    add("Open Risk Exposure", "/departments/dealing?tab=risk-exposure", canVisit("/departments/dealing") || options.canUseLiveAgent);
  }
  if (available.has("get_swap_metrics")) {
    add("Open Swap Tracker", "/departments/dealing?tab=swap-tracker", canVisit("/departments/dealing") || options.canUseLiveAgent);
  }
  if (available.has("get_history_aggregate")) {
    add("Open History", "/departments/dealing?tab=history", canVisit("/departments/dealing") || options.canUseLiveAgent);
  }
  if (available.has("get_accounts_metrics")) {
    add("Open Accounts", "/departments/accounts", canVisit("/departments/accounts"));
  }
  if (available.has("get_backoffice_metrics")) {
    add("Open Backoffice", "/departments/backoffice", canVisit("/departments/backoffice"));
  }
  if (available.has("get_marketing_metrics")) {
    add("Open Marketing", "/departments/marketing", canVisit("/departments/marketing"));
  }
  if (["get_lp_metrics", "get_lp_equity_summary", "get_lp_accounts"].some((tool) => available.has(tool))) {
    add("Open LP Manager", "/settings/lp-manager", options.settingsPaths.has("/settings/lp-manager"));
  }
  if (available.has("list_swagger_endpoints")) {
    add("Open Coverage Settings", "/settings/coverage", options.settingsPaths.has("/settings/coverage"));
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

type SummaryCard = {
  tool: string;
  label: string;
  value: string;
};

const buildSummaryCards = (toolSummaries: AgentChatResponse["toolSummaries"] = []) => {
  return ((toolSummaries || []) as Array<{ tool?: string; data?: Record<string, any> }>).flatMap<SummaryCard>((summary) => {
    const data = summary?.data || {};
    const toolName = String(summary?.tool || "unknown");
    switch (summary?.tool) {
      case "get_dealing_metrics":
        return [
          { tool: toolName, label: "Equity", value: formatMetricValue(data.totalEquity) },
          { tool: toolName, label: "Credit", value: formatMetricValue(data.totalCredit) },
          { tool: toolName, label: "Net Lots", value: formatMetricValue(data.netLots) },
          { tool: toolName, label: "Deals", value: formatMetricValue(data.deals) },
        ];
      case "get_coverage_metrics":
        return [
          { tool: toolName, label: "Coverage", value: formatMetricValue(data.coveragePct, true) },
          { tool: toolName, label: "Uncovered", value: formatMetricValue(data.totalUncovered) },
          { tool: toolName, label: "Symbols", value: formatMetricValue(data.symbolCount) },
          { tool: toolName, label: "LPs", value: formatMetricValue(data.lpCount) },
        ];
      case "list_app_endpoints":
        return [
          { tool: toolName, label: "Matched", value: formatMetricValue(data.totalMatched) },
          { tool: toolName, label: "Available", value: formatMetricValue(data.totalAvailable) },
          { tool: toolName, label: "First Endpoint", value: formatMetricValue(data.endpoints?.[0]?.id) },
        ];
      case "call_app_endpoint":
        return [
          { tool: toolName, label: "Endpoint", value: formatMetricValue(data.endpointId) },
          { tool: toolName, label: "Status", value: formatMetricValue(data.status) },
          { tool: toolName, label: "OK", value: formatMetricValue(data.ok) },
        ];
      case "get_symbol_coverage":
        return [
          { tool: toolName, label: "Symbol", value: formatMetricValue(data.symbol) },
          { tool: toolName, label: "Coverage", value: formatMetricValue(data.coveragePct, true) },
          { tool: toolName, label: "Client Net", value: formatMetricValue(data.clientNet) },
          { tool: toolName, label: "Uncovered", value: formatMetricValue(data.uncovered) },
        ];
      case "get_bonus_metrics":
        return [
          { tool: toolName, label: "Gross PnL", value: formatMetricValue(data.grossPnl) },
          { tool: toolName, label: "LP Realized", value: formatMetricValue(data.lpRealizedPnl) },
          { tool: toolName, label: "LP Unrealized", value: formatMetricValue(data.lpUnrealizedPnl) },
          { tool: toolName, label: "Monthly Rows", value: formatMetricValue(data.monthlyRows) },
        ];
      case "get_swap_metrics":
        return [
          { tool: toolName, label: "Positions", value: formatMetricValue(data.positionCount) },
          { tool: toolName, label: "Due Tonight", value: formatMetricValue(data.dueTonight) },
          { tool: toolName, label: "Negative Swap", value: formatMetricValue(data.negativeSwapPositions) },
          { tool: toolName, label: "Total Swap", value: formatMetricValue(data.totalSwap) },
        ];
      case "get_trading_activity":
        return [
          { tool: toolName, label: "Deals", value: formatMetricValue(data.dealCount) },
          { tool: toolName, label: "Symbols", value: formatMetricValue(data.symbolCount) },
          { tool: toolName, label: "Lots", value: formatMetricValue(data.totals?.totalLots) },
          { tool: toolName, label: "Profit", value: formatMetricValue(data.totals?.totalProfit) },
        ];
      case "get_history_aggregate":
        return [
          { tool: toolName, label: "Net P/L", value: formatMetricValue(data.totals?.netPL) },
          { tool: toolName, label: "Real LP P/L", value: formatMetricValue(data.totals?.realLpPL) },
          { tool: toolName, label: "LP P/L", value: formatMetricValue(data.totals?.lpPL) },
          { tool: toolName, label: "Gross Profit", value: formatMetricValue(data.totals?.grossProfit) },
        ];
      case "get_history_deals":
        return [
          { tool: toolName, label: "Login", value: formatMetricValue(data.login) },
          { tool: toolName, label: "Deals", value: formatMetricValue(data.totalDeals) },
          { tool: toolName, label: "Profit", value: formatMetricValue(data.totals?.profit) },
          { tool: toolName, label: "Commission", value: formatMetricValue(data.totals?.commission) },
        ];
      case "get_history_volume":
        return [
          { tool: toolName, label: "Rows", value: formatMetricValue(data.rowCount) },
          { tool: toolName, label: "Trades", value: formatMetricValue(data.totals?.tradeCount) },
          { tool: toolName, label: "Lots", value: formatMetricValue(data.totals?.totalLots) },
          { tool: toolName, label: "Yards", value: formatMetricValue(data.totals?.volumeYards) },
        ];
      case "get_accounts_metrics":
        return [
          { tool: toolName, label: "Deposits", value: formatMetricValue(data.totalDeposits) },
          { tool: toolName, label: "Withdrawals", value: formatMetricValue(data.totalWithdrawals) },
          { tool: toolName, label: "Net Flow", value: formatMetricValue(data.netFlow) },
          { tool: toolName, label: "Wallet", value: formatMetricValue(data.walletTotal) },
        ];
      case "get_backoffice_metrics":
        return [
          { tool: toolName, label: "Clients", value: formatMetricValue(data.totalClients) },
          { tool: toolName, label: "MT5 Accounts", value: formatMetricValue(data.totalMt5Accounts) },
          { tool: toolName, label: "Deposits", value: formatMetricValue(data.deposits) },
          { tool: toolName, label: "Withdrawals", value: formatMetricValue(data.withdrawals) },
        ];
      case "get_marketing_metrics":
        return [
          { tool: toolName, label: "Sessions", value: formatMetricValue(data.sessions) },
          { tool: toolName, label: "Active Users", value: formatMetricValue(data.activeUsers) },
          { tool: toolName, label: "New Users", value: formatMetricValue(data.newUsers) },
          { tool: toolName, label: "Conversions", value: formatMetricValue(data.conversions) },
        ];
      case "get_lp_metrics":
        return [
          { tool: toolName, label: "Accounts", value: formatMetricValue(data.accountCount) },
          { tool: toolName, label: "Avg Margin", value: formatMetricValue(data.avgMarginLevel, true) },
          { tool: toolName, label: "Equity", value: formatMetricValue(data.totals?.equity) },
          { tool: toolName, label: "Free Margin", value: formatMetricValue(data.totals?.freeMargin) },
        ];
      case "get_lp_equity_summary":
        return [
          { tool: toolName, label: "LP Withdrawable", value: formatMetricValue(data.lpWithdrawableEquity) },
          { tool: toolName, label: "Client Withdrawable", value: formatMetricValue(data.clientWithdrawableEquity) },
          { tool: toolName, label: "Difference", value: formatMetricValue(data.difference) },
        ];
      case "get_lp_positions":
        return [
          { tool: toolName, label: "LP", value: formatMetricValue(data.lpName) },
          { tool: toolName, label: "Positions", value: formatMetricValue(data.positionCount) },
          { tool: toolName, label: "Symbols", value: formatMetricValue(data.symbolCount) },
          { tool: toolName, label: "Net Lots", value: formatMetricValue(data.totalNetLots) },
        ];
      case "get_account_details":
        return [
          { tool: toolName, label: "Login", value: formatMetricValue(data.login) },
          { tool: toolName, label: "Equity", value: formatMetricValue(data.account?.equity) },
          { tool: toolName, label: "Balance", value: formatMetricValue(data.account?.balance) },
          { tool: toolName, label: "Margin %", value: formatMetricValue(data.account?.marginLevel, true) },
        ];
      case "get_user_accounts_by_email":
        return [
          { tool: toolName, label: "Email", value: formatMetricValue(data.email) },
          { tool: toolName, label: "Users", value: formatMetricValue(data.matchedUsers?.length) },
          { tool: toolName, label: "Accounts", value: formatMetricValue(data.tradingAccountsCount) },
          { tool: toolName, label: "First Login", value: formatMetricValue(data.logins?.[0]?.login) },
        ];
      case "get_crm_cashflow":
        return [
          { tool: toolName, label: "CRM/User", value: formatMetricValue(data.userId) },
          { tool: toolName, label: "Deposits", value: formatMetricValue(data.totalDeposits) },
          { tool: toolName, label: "Withdrawals", value: formatMetricValue(data.totalWithdrawals) },
          { tool: toolName, label: "Net Flow", value: formatMetricValue(data.netFlow) },
        ];
      case "get_contract_sizes":
        return [
          { tool: toolName, label: "Symbol", value: formatMetricValue(data.symbol) },
          { tool: toolName, label: "Mappings", value: formatMetricValue(data.count) },
          { tool: toolName, label: "Detected", value: formatMetricValue(data.detected ? "yes" : "-") },
        ];
      case "get_symbol_mappings":
        return [
          { tool: toolName, label: "Mappings", value: formatMetricValue(data.count) },
          { tool: toolName, label: "First Raw", value: formatMetricValue(data.items?.[0]?.rawSymbol) },
          { tool: toolName, label: "First Mapped", value: formatMetricValue(data.items?.[0]?.mappedSymbol) },
        ];
      default:
        return [];
    }
  });
};

const extractEndpointIdsFromText = (text: string) => {
  const ids = new Set<string>();
  const re = /(?:^|[\s|,])([a-z][a-z0-9_]*(?:[.:][a-z0-9_]+)+)/gi;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    ids.add(String(m[1]));
  }
  return [...ids].slice(0, 5);
};

const getEndpointChoices = (message: LiveAgentUiMessage) => {
  const fromTool = (message.toolSummaries || [])
    .filter((summary) => summary?.tool === "auto_resolve_and_call_endpoint")
    .flatMap((summary) => (Array.isArray(summary?.data?.topCandidates) ? summary.data.topCandidates : []))
    .map((item: any) => String(item?.id || "").trim())
    .filter(Boolean);

  if (fromTool.length > 0) return [...new Set(fromTool)].slice(0, 5);
  return extractEndpointIdsFromText(message.content);
};

export function LiveChatAgent() {
  const navigate = useNavigate();
  const currentUser = getCurrentUser();
  const visibleDepartmentPaths = useMemo(() => new Set(getVisibleDepartmentItems(currentUser).map((item) => item.path)), [currentUser]);
  const visibleSettingsPaths = useMemo(() => new Set(getVisibleSettingsMenuItems(currentUser).map((item) => item.path)), [currentUser]);
  const canUseLiveAgent = hasAccess("LiveAgent") || hasAccess("Backoffice");
  const [open, setOpen] = useState(false);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const [fabPosition, setFabPosition] = useState<{ x: number; y: number }>(() => {
    if (typeof window === "undefined") return { x: 0, y: 0 };
    const defaultPos = {
      x: window.innerWidth - LIVE_AGENT_FAB_WIDTH - 20,
      y: window.innerHeight - LIVE_AGENT_FAB_HEIGHT - 20,
    };
    try {
      const raw = window.localStorage.getItem(LIVE_AGENT_STORAGE_KEY);
      if (!raw) return defaultPos;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") return defaultPos;
      return parsed;
    } catch {
      return defaultPos;
    }
  });
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<LiveAgentUiMessage[]>([
    {
      role: "assistant",
      content: "Sky Links Agent is online. Ask about Dealing, LP, Backoffice, Accounts, or Marketing metrics.",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages, open, loading]);

  const clampFabPosition = (x: number, y: number) => {
    const maxX = Math.max(LIVE_AGENT_FAB_MARGIN, window.innerWidth - LIVE_AGENT_FAB_WIDTH - LIVE_AGENT_FAB_MARGIN);
    const maxY = Math.max(LIVE_AGENT_FAB_MARGIN, window.innerHeight - LIVE_AGENT_FAB_HEIGHT - LIVE_AGENT_FAB_MARGIN);
    return {
      x: Math.min(Math.max(LIVE_AGENT_FAB_MARGIN, x), maxX),
      y: Math.min(Math.max(LIVE_AGENT_FAB_MARGIN, y), maxY),
    };
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      setFabPosition((prev) => clampFabPosition(prev.x, prev.y));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LIVE_AGENT_STORAGE_KEY, JSON.stringify(fabPosition));
  }, [fabPosition]);

  const send = async (question: string) => {
    const content = question.trim();
    if (!content || loading) return;
    const nextMessages = [...messages, { role: "user", content } as LiveAgentUiMessage];
    setMessages(nextMessages);
    setLoading(true);
    try {
      const resp = await sendAgentChat({
        message: content,
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

  const renderAssistantContent = (message: LiveAgentUiMessage) => {
    const parsed = parseAssistantAnswer(message.content);
    const toolsUsed = message.toolsUsed?.length ? message.toolsUsed : parsed?.toolsUsed || [];
    const deepLinks = buildDeepLinks(toolsUsed, {
      departmentPaths: visibleDepartmentPaths,
      settingsPaths: visibleSettingsPaths,
      canUseLiveAgent,
    });
    const summaryCards = buildSummaryCards(message.toolSummaries);
    const endpointChoices = getEndpointChoices(message);

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
          {endpointChoices.length > 0 && /multiple possible endpoints|confirm one endpoint id|confirm endpoint id|low_confidence_match/i.test(message.content) && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Choose Endpoint</div>
              <div className="flex flex-wrap gap-2">
                {endpointChoices.map((endpointId) => (
                  <button
                    key={endpointId}
                    type="button"
                    onClick={() => send(`Use endpoint id ${endpointId}`)}
                    className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-200"
                  >
                    {endpointId}
                  </button>
                ))}
              </div>
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
        {endpointChoices.length > 0 && /multiple possible endpoints|confirm one endpoint id|confirm endpoint id|low_confidence_match/i.test(message.content) && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Choose Endpoint</div>
            <div className="flex flex-wrap gap-2">
              {endpointChoices.map((endpointId) => (
                <button
                  key={endpointId}
                  type="button"
                  onClick={() => send(`Use endpoint id ${endpointId}`)}
                  className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-200"
                >
                  {endpointId}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="fixed z-[80]"
      style={{ left: `${fabPosition.x}px`, top: `${fabPosition.y}px` }}
    >
      {!open && (
        <button
          type="button"
          onPointerDown={(e) => {
            suppressClickRef.current = false;
            dragRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startY: e.clientY,
              originX: fabPosition.x,
              originY: fabPosition.y,
              moved: false,
            };
            (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            const deltaX = e.clientX - drag.startX;
            const deltaY = e.clientY - drag.startY;
            if (!drag.moved && Math.hypot(deltaX, deltaY) > LIVE_AGENT_CLICK_DRAG_THRESHOLD) {
              drag.moved = true;
              suppressClickRef.current = true;
            }
            setFabPosition(clampFabPosition(drag.originX + deltaX, drag.originY + deltaY));
          }}
          onPointerUp={(e) => {
            if (dragRef.current?.pointerId === e.pointerId) {
              (e.currentTarget as HTMLButtonElement).releasePointerCapture(e.pointerId);
              dragRef.current = null;
            }
          }}
          onPointerCancel={(e) => {
            if (dragRef.current?.pointerId === e.pointerId) {
              (e.currentTarget as HTMLButtonElement).releasePointerCapture(e.pointerId);
              dragRef.current = null;
            }
          }}
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            setOpen(true);
          }}
          className="group inline-flex items-center gap-2 rounded-full border border-cyan-500/50 bg-gradient-to-r from-cyan-600 to-emerald-600 px-4 py-3 text-white shadow-lg shadow-cyan-900/25"
        >
          <Bot className="h-4 w-4" />
          <span className="text-sm font-semibold">Live Agent</span>
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
                  <div className="text-[11px] text-cyan-100/90">Quick Questions</div>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded border border-white/30 p-1 text-white/90 hover:bg-white/10">
                <X className="h-4 w-4" />
              </button>
            </div>
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

          <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && input.trim()) {
                    e.preventDefault();
                    send(input.trim());
                    setInput("");
                  }
                }}
                placeholder="Ask a question..."
                disabled={loading}
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 disabled:opacity-50"
              />
              <button
                type="button"
                disabled={loading || !input.trim()}
                onClick={() => { send(input.trim()); setInput(""); }}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-40"
              >
                <SendHorizontal className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
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
          </div>
        </div>
      )}
    </div>
  );
}
