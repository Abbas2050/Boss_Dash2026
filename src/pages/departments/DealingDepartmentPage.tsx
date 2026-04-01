import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bell, Camera, ChevronDown, ChevronRight, Info, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { HubConnection, HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import { getDealsByGroup, getPositionsByGroup, getSummaryByGroup } from "@/lib/dealingApi";
import { SignalRConnectionManager } from "@/lib/signalRConnectionManager";
import { fetchAccountsByUserId, fetchDealsByLogin, fetchIbTree } from "@/lib/rebateApi";
import { hasAccess } from "@/lib/auth";
import { BONUS_SUB_TABS, DEALING_TABS } from "@/lib/permissions";
import { getRateForSymbol, normalizeRebateSymbol, REBATE_RULES_SAMPLE_CSV } from "@/pages/departments/dealing/rebateUtils";
import { ClientProfilingTab } from "@/pages/departments/dealing/ClientProfilingTab";
import { DealMatchingTab } from "@/pages/departments/dealing/DealMatchingTab";
import { EquityOverviewTab } from "@/pages/departments/dealing/EquityOverviewTab";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import { UnauthorizedPage } from "@/components/UnauthorizedPage";
import {
  ALERT_EVENT_KEYS,
  ALERT_EVENT_META,
  AlertEventKey,
  AlertPreferences,
  onAlertPreferencesChanged,
  readAlertPreferences,
} from "@/lib/alertPreferences";

type DealingMetrics = {
  totalEquity: number;
  totalCredit: number;
  clientsWithCredit: number;
  netLots: number;
  buyLots: number;
  sellLots: number;
  totalVolume: number | null;
  tradingProfit: number;
  dealCount: number;
};

type SymbolActivity = {
  symbol: string;
  positions: number;
  netExposureLots: number;
  subSymbols: Array<{ symbol: string; netExposureLots: number }>;
};

type CoverageRow = {
  symbol: string;
  direction?: "BUY" | "SELL" | "";
  clientNet: number;
  uncovered: number;
  contractSizeMultiplier?: number;
  lpNets?: Record<string, number>;
  isSubtotalRow?: boolean;
};

type CoverageData = {
  rows: CoverageRow[];
  lpNames: string[];
  totals: {
    clientNet: number;
    uncovered: number;
    clientPositions?: number;
    lpPositions?: number;
    lpNets?: Record<string, number>;
  };
};

const DEALING_MENU_QUERY_MAP: Record<string, string> = {
  dealing: "Dealing",
  coverage: "Coverage",
  risk: "Risk Exposure",
  "risk-exposure": "Risk Exposure",
  metrics: "Metrics",
  equity: "Equity Overview",
  "equity-overview": "Equity Overview",
  bonus: "Bonus",
  contracts: "Contract Sizes",
  "contract-sizes": "Contract Sizes",
  deal: "Deal Matching",
  "deal-matching": "Deal Matching",
  swap: "Swap Tracker",
  "swap-tracker": "Swap Tracker",
  history: "History",
  clients: "Clients NOP",
  "clients-nop": "Clients NOP",
  profiling: "Client Profiling",
  "client-profiling": "Client Profiling",
  rebate: "Rebate Calculator",
  "rebate-calculator": "Rebate Calculator",
};

const DEALING_MENU_REVERSE_QUERY_MAP = Object.entries(DEALING_MENU_QUERY_MAP).reduce<Record<string, string>>((acc, [key, value]) => {
  if (!acc[value]) acc[value] = key;
  return acc;
}, {});

type BonusDashboardResponse = {
  positionMatchTable?: CoverageData;
  PositionMatchTable?: CoverageData;
  equity?: {
    client?: {
      totalEquity?: number;
      totalBalance?: number;
      totalCredit?: number;
      totalMargin?: number;
      accounts?: Array<{
        login?: number | string;
        equity?: number;
        balance?: number;
        credit?: number;
        margin?: number;
        marginFree?: number;
        marginLevel?: number;
      }>;
    };
    lp?: {
      equity?: number;
      balance?: number;
      margin?: number;
      freeMargin?: number;
      marginLevel?: number;
    };
    difference?: number;
  };
};

type BonusStatusResponse = {
  xtbConnected?: boolean;
  bonusManagerConnected?: boolean;
};

type BonusPnlSummaryResponse = {
  grossPnl?: number;
  lpReceivable?: number;
  lpReceivableHwm?: number;
  lpRealizedPnl?: number;
  lpRealizedSwap?: number;
  lpUnrealizedPnl?: number;
  watermarkIn?: number;
  fromUtc?: string;
  toUtc?: string;
};

type BonusPnlMonthlyReportMonth = {
  grossPnl?: number;
  watermarkIn?: number;
  watermarkOut?: number;
  effectiveLpTotal?: number;
  lpRawTotal?: number;
};

type BonusPnlMonthlyReportResponse = {
  months?: BonusPnlMonthlyReportMonth[];
};

type BonusPnlDailyResponse = {
  fromUtc?: string;
  toUtc?: string;
  grossPnl?: number;
  client?: {
    total?: number;
    realizedPnl?: number;
    realizedSwap?: number;
    unrealizedPnl?: number;
    unrealizedSwap?: number;
    closedDealCount?: number;
    openPositionCount?: number;
  };
  lp?: {
    total?: number;
    rawTotal?: number;
    realizedPnl?: number;
    realizedSwap?: number;
    realizedCommission?: number;
    unrealizedPnl?: number;
    unrealizedSwap?: number;
    closedDealCount?: number;
    openPositionCount?: number;
    closedDeals?: Array<{
      deal?: number | string;
      symbol?: string;
      direction?: string;
      volume?: number;
      profit?: number;
      swap?: number;
      commission?: number;
      comment?: string;
      time?: string;
    }>;
    openPositions?: Array<{
      ticket?: number | string;
      time?: string;
      symbol?: string;
      direction?: string;
      volume?: number;
      openPrice?: number;
      currentPrice?: number;
      profit?: number;
      swap?: number;
    }>;
  };
  cost?: {
    creditCost?: number;
    creditSettled?: number;
    creditUnsettled?: number;
    withdrawalCharges?: number;
    withdrawalTotal?: number;
    withdrawalCount?: number;
    settledTransactionCount?: number;
    unsettledAccountCount?: number;
    settledDetails?: Array<{
      login?: number | string;
      dealTicket?: number | string;
      actionType?: string;
      amount?: number;
      comment?: string;
      time?: string;
    }>;
    unsettledDetails?: Array<{
      login?: number | string;
      balance?: number;
      equity?: number;
      margin?: number;
    }>;
  };
};

type ContractSizeEntry = {
  id: number;
  symbol: string;
  clientContractSize: number;
  lpContractSize: number;
  multiplier: number;
};

type ContractSizeDetectResponse = {
  symbol?: string;
  clientContractSize: number;
  lpContractSize: number;
  multiplier?: number;
};

type MetricsItem = {
  lp: string;
  login: number | string;
  equity: number;
  realEquity: number;
  credit: number;
  balance: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
};

type MetricsData = {
  items: MetricsItem[];
  totals: {
    equity: number;
    realEquity: number;
    credit: number;
    balance: number;
    margin: number;
    freeMargin: number;
  };
};

type EquitySummaryData = {
  lpWithdrawableEquity: number;
  clientWithdrawableEquity: number;
  difference: number;
};

type SwapPosition = {
  lpName: string;
  ticket: number | string;
  symbol: string;
  side: "Buy" | "Sell" | string;
  volume: number;
  swap: number;
  swapFreeDays: number | null;
  daysUsed: number;
  daysLeft: number;
  willChargeTonight: boolean;
};

type LpAccount = {
  lpName: string;
  mt5Login: number | string;
  source?: string;
};

type HistoryAggregateItem = {
  lpName: string;
  login: number | string;
  source?: string;
  isError?: boolean;
  errorMessage?: string;
  effectiveFrom?: number;
  startEquity: number;
  endEquity: number;
  credit: number;
  deposit: number;
  withdrawal: number;
  netDeposits: number;
  grossProfit: number;
  totalCommission: number;
  totalSwap: number;
  netPL: number;
  realLpPL: number;
  ntpPercent: number;
  lpPL: number;
};

type HistoryAggregateData = {
  items: HistoryAggregateItem[];
  totals: Omit<HistoryAggregateItem, "lpName" | "login" | "source" | "isError" | "errorMessage">;
};

type HistoryDeal = {
  dealTicket: number | string;
  symbol: string;
  timeString: string;
  direction: string;
  entry: string;
  volume: number;
  price: number;
  contractSize: number;
  marketValue: number;
  profit: number;
  commission: number;
  fee: number;
  swap: number;
  lpCommission: number;
  lpCommPerLot: number;
};

type HistoryDealsData = {
  lpName: string;
  totalDeals: number;
  deals: HistoryDeal[];
};

type HistoryVolumeItem = {
  lpName: string;
  login: number | string;
  source?: string;
  isError?: boolean;
  errorMessage?: string;
  tradeCount: number;
  totalLots: number;
  notionalUsd: number;
  volumeYards: number;
};

type HistoryVolumeData = {
  items: HistoryVolumeItem[];
  totals: {
    tradeCount: number;
    totalLots: number;
    notionalUsd: number;
    volumeYards: number;
  };
};

type RebateComparisonRow = {
  login: string;
  symbol: string;
  trades: number;
  tradedLots: number;
  eligibleLots: number;
  ineligibleLots: number;
  rebatePerLot: number;
  mt5CommissionUsd: number;
};

type RebateRule = {
  symbolPattern: string;
  ratePerLot: number;
};

type DealingOverviewData = {
  coverage: CoverageData | null;
  lpMetrics: MetricsData | null;
  equitySummary: EquitySummaryData | null;
  swaps: SwapPosition[];
  historyAggregate: HistoryAggregateData | null;
};

type LiveNotification = {
  id: string;
  type: "info" | "warning" | "success";
  eventName: AlertEventKey;
  title: string;
  message: string;
  at: string;
};

type NopClient = {
  login: number | string;
  name: string;
  volume: number;
  realLimit?: string | number | null;
  mt5Limit?: number | null;
  equity: number;
  credit: number;
  balance: number;
  marginFree: number;
  margin: number;
  marginLevel: number;
};

type NopSymbolGroup = {
  symbol: string;
  netTotal: number;
  buyClients: NopClient[];
  sellClients: NopClient[];
  buyTotal: number;
  sellTotal: number;
};

type NopReportData = {
  timestamp: string;
  accountsReporting: number;
  collectedLogins: number;
  symbols: NopSymbolGroup[];
};

type FullscreenTableKey = "coverage" | "risk" | "metrics" | "swap" | "history";

const csvEscape = (value: string) => {
  const v = String(value ?? "");
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

const exportRowsToCsv = (filePrefix: string, headers: string[], rows: string[][]) => {
  const lines = [headers.map(csvEscape).join(","), ...rows.map((row) => row.map(csvEscape).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  link.href = URL.createObjectURL(blob);
  link.download = `${filePrefix}-${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
};

const DEFAULT_METRICS: DealingMetrics = {
  totalEquity: 0,
  totalCredit: 0,
  clientsWithCredit: 0,
  netLots: 0,
  buyLots: 0,
  sellLots: 0,
  totalVolume: null,
  tradingProfit: 0,
  dealCount: 0,
};

const DEAL_VOLUME_DIVISOR = 10_000;
const DEAL_VOLUME_EXT_DIVISOR = 100_000_000;

const getUtcDayStartFromLocalDate = (date: Date) =>
  new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0));

const getUtcDayEndFromLocalDate = (date: Date) =>
  new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999));

const addUtcDays = (date: Date, days: number) => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const isUtcTodaySelection = (from?: Date, to?: Date) => {
  const now = new Date();
  const todayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const todayEndUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const selectedFromUtc = getUtcDayStartFromLocalDate(from ?? new Date());
  const selectedToUtc = getUtcDayEndFromLocalDate(to ?? new Date());
  return selectedFromUtc.getTime() === todayStartUtc.getTime() && selectedToUtc.getTime() === todayEndUtc.getTime();
};

const normalizeSymbol = (symbol: string) => {
  const trimmed = symbol.trim();
  const dotIndex = trimmed.indexOf(".");
  return dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
};

const getDealLots = (lots: number, volume: number, volumeExt: number) => {
  if (lots > 0) return lots;
  if (volumeExt > 0) return volumeExt / DEAL_VOLUME_EXT_DIVISOR;
  return volume / DEAL_VOLUME_DIVISOR;
};

const getDealVolume = (deal: {
  value: number;
  lots: number;
  volume: number;
  volumeExt: number;
  price: number;
  contractSize: number;
}) => {
  if (deal.value > 0) return deal.value;
  const lots = getDealLots(deal.lots, deal.volume, deal.volumeExt);
  if (deal.price > 0 && deal.contractSize > 0) return lots * deal.price * deal.contractSize;
  return 0;
};

const toYmd = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const toReadable = (date: Date) =>
  date.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });

const pickProp = <T,>(obj: any, camel: string, pascal: string, fallback: T): T => {
  if (obj == null || typeof obj !== "object") return fallback;
  const value = obj[camel] ?? obj[pascal];
  return (value ?? fallback) as T;
};

const isGoldSymbol = (symbol: string) => {
  const s = String(symbol || "").toUpperCase();
  return s === "XAUUSD" || s.startsWith("GOLD");
};

const isZeroish = (value: number | null | undefined, epsilon = 0.000001) => Math.abs(Number(value) || 0) <= epsilon;

const formatCoverageVal = (value: number) => {
  if (value === 0) return <span className="text-slate-500">0.00</span>;
  if (value > 0) return <span className="text-emerald-700 dark:text-emerald-300">{value.toFixed(2)}</span>;
  return <span className="text-rose-700 dark:text-rose-300">{value.toFixed(2)}</span>;
};

const renderContractSizeBadge = (multiplier?: number) => {
  const m = Number(multiplier);
  if (!Number.isFinite(m) || m === 0 || Math.abs(m - 1) < 0.000001) return null;
  return (
    <span className="ml-1 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
      x{m.toFixed(4)}
    </span>
  );
};

const formatPctClass = (value: number) => {
  if (!Number.isFinite(value)) return "text-slate-500";
  if (value >= 90) return "text-emerald-700 dark:text-emerald-300";
  if (value >= 50) return "text-amber-700 dark:text-amber-300";
  return "text-rose-700 dark:text-rose-300";
};

const formatDollar = (value: number) => {
  const abs = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value === 0) return <span className="text-slate-500">$0.00</span>;
  if (value > 0) return <span className="text-emerald-700 dark:text-emerald-300">${abs}</span>;
  return <span className="text-rose-700 dark:text-rose-300">-${abs}</span>;
};

const formatMaybeNumber = (value: unknown, digits = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const signedValueClass = (value: number) => {
  if (value > 0.005) return "text-emerald-700 dark:text-emerald-300";
  if (value < -0.005) return "text-rose-700 dark:text-rose-300";
  return "text-slate-700 dark:text-slate-300";
};

const signedValueText = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const getPositionLots = (position: { lots?: number; volume?: number; volumeExt?: number }) => {
  const lots = Number(position.lots) || 0;
  if (lots > 0) return lots;
  const volumeExt = Number(position.volumeExt) || 0;
  if (volumeExt > 0) return volumeExt / 100_000_000;
  const volume = Number(position.volume) || 0;
  return volume > 0 ? volume / 10_000 : 0;
};

const toInputDate = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const epochSecondsToInputDate = (epochSeconds?: number | null) => {
  const ts = Number(epochSeconds);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return toInputDate(new Date(ts * 1000));
};

const inputDateToUtcEpochSeconds = (value: string) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const parsed = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed / 1000);
};

const escapeCsv = (value: string | number | null | undefined) => {
  const raw = value === null || value === undefined ? "" : String(value);
  if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

const ALERT_EVENT_SET = new Set<string>(ALERT_EVENT_KEYS as readonly string[]);
type BonusSubTab = (typeof BONUS_SUB_TABS)[number];
const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

const getAlertsHubConfig = () => {
  const explicitTokenUrl = (import.meta as any).env?.VITE_SIGNALR_TOKEN_URL || "";
  const tokenBase = String(explicitTokenUrl).trim();
  return {
    hubUrl: `${BACKEND_BASE_URL}/ws/dashboard`,
    tokenUrls: tokenBase ? [tokenBase] : [],
  };
};

const buildAlertDescription = (eventName: AlertEventKey, payload: any): string => {
  if (eventName === "UserChangeAlert") {
    return `${payload?.eventType || "Update"}: ${payload?.name || "Client"} (Login ${payload?.login ?? "-"}) in ${payload?.group || "unknown group"}`;
  }
  if (eventName === "AccountAlert") {
    return `${payload?.alertType || "Risk"} for account ${payload?.account?.login ?? "-"} in ${payload?.group || "unknown group"} | Equity ${payload?.account?.equity ?? "-"} | Balance ${payload?.account?.balance ?? "-"}`;
  }
  if (eventName === "PositionMatchTableUpdate") {
    const symbols = Array.isArray(payload?.rows) ? payload.rows.length : 0;
    const lps = Array.isArray(payload?.lpNames) ? payload.lpNames.length : 0;
    return `Position match table refreshed for ${symbols} symbols across ${lps} LPs.`;
  }
  if (eventName === "DealUpdate") {
    return `Client ${payload?.login ?? "-"} deal ${payload?.deal ?? payload?.dealId ?? "-"} on ${payload?.symbol ?? "-"} at ${payload?.price ?? "-"}.`;
  }
  if (eventName === "PositionUpdate") {
    return `Client ${payload?.login ?? "-"} position ${payload?.position ?? payload?.positionId ?? "-"} on ${payload?.symbol ?? "-"}.`;
  }
  if (eventName === "OrderUpdate") {
    return `Order ${payload?.order ?? payload?.orderId ?? "-"} for client ${payload?.login ?? "-"} changed to ${payload?.state ?? payload?.status ?? "updated"}.`;
  }
  if (eventName === "TransactionAlert") {
    return `${payload?.transactionType || "Transaction"} for client ${payload?.login ?? "-"} amount ${payload?.amount ?? "-"} ${payload?.currency ?? ""}.`;
  }
  return JSON.stringify(payload ?? {});
};

const alertTypeForEvent = (eventName: AlertEventKey): LiveNotification["type"] => {
  if (eventName === "AccountAlert" || eventName === "TransactionAlert") return "warning";
  if (eventName === "UserChangeAlert") return "success";
  return "info";
};

export function DealingDepartmentPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [fromDate, setFromDate] = useState<Date>(() => new Date());
  const [toDate, setToDate] = useState<Date>(() => new Date());
  const [selectedFromDate, setSelectedFromDate] = useState<Date>(() => new Date());
  const [selectedToDate, setSelectedToDate] = useState<Date>(() => new Date());
  const [isLoading, setIsLoading] = useState(false);
  const [metrics, setMetrics] = useState<DealingMetrics>(DEFAULT_METRICS);
  const [topSymbols, setTopSymbols] = useState<SymbolActivity[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // URL is the single source of truth for the active tab — no useState needed
  const activeMenu =
    DEALING_MENU_QUERY_MAP[String(searchParams.get("tab") || "").trim().toLowerCase()] || "Dealing";
  const setActiveMenu = useCallback(
    (menu: string) => {
      const tab = DEALING_MENU_REVERSE_QUERY_MAP[menu] || "dealing";
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("tab", tab);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const [coverageData, setCoverageData] = useState<CoverageData | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [coverageStatus, setCoverageStatus] = useState<"connected" | "connecting" | "disconnected">("disconnected");
  const [coverageLastUpdated, setCoverageLastUpdated] = useState<Date | null>(null);
  const [coverageRefreshKey, setCoverageRefreshKey] = useState(0);
  const [coverageShowZeroData, setCoverageShowZeroData] = useState(false);
  const [riskShowZeroData, setRiskShowZeroData] = useState(false);
  const [overviewRiskExpandedSymbol, setOverviewRiskExpandedSymbol] = useState<string | null>(null);
  const [fullscreenTable, setFullscreenTable] = useState<FullscreenTableKey | null>(null);
  const [snapshottingTable, setSnapshottingTable] = useState<FullscreenTableKey | null>(null);
  const coverageSignalRRef = useRef<SignalRConnectionManager | null>(null);
  const dealingRootRef = useRef<HTMLDivElement | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsData | null>(null);
  const [metricsEquitySummary, setMetricsEquitySummary] = useState<EquitySummaryData | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLastUpdated, setMetricsLastUpdated] = useState<Date | null>(null);
  const [metricsRefreshKey, setMetricsRefreshKey] = useState(0);
  const [metricsGoldQuote, setMetricsGoldQuote] = useState<{ bid: number; ask: number; spreadPoints: number; dir: "up" | "down" | "flat" } | null>(null);
  const metricsLastBidRef = useRef<number | null>(null);
  const metricsPriceSignalRRef = useRef<HubConnection | null>(null);
  const metricsRequestRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const [bonusSubTab, setBonusSubTab] = useState<BonusSubTab>("Bonus Coverage");
  const [bonusShowOverview, setBonusShowOverview] = useState(true);
  const [bonusDashboard, setBonusDashboard] = useState<BonusDashboardResponse | null>(null);
  const [bonusStatus, setBonusStatus] = useState<BonusStatusResponse | null>(null);
  const [bonusPnlSummary, setBonusPnlSummary] = useState<BonusPnlSummaryResponse | null>(null);
  const [bonusPnlDaily, setBonusPnlDaily] = useState<BonusPnlDailyResponse | null>(null);
  const [bonusPnlMonthlyReport, setBonusPnlMonthlyReport] = useState<BonusPnlMonthlyReportResponse | null>(null);
  const [bonusPnlExpanded, setBonusPnlExpanded] = useState<{
    lpClosedDeals: boolean;
    lpOpenPositions: boolean;
    creditSettled: boolean;
    creditUnsettled: boolean;
  }>({
    lpClosedDeals: false,
    lpOpenPositions: false,
    creditSettled: false,
    creditUnsettled: false,
  });
  const [bonusEquityClientTableExpanded, setBonusEquityClientTableExpanded] = useState(true);
  const [bonusLoading, setBonusLoading] = useState(false);
  const [bonusError, setBonusError] = useState<string | null>(null);
  const [bonusLastUpdated, setBonusLastUpdated] = useState<Date | null>(null);
  const [bonusRefreshKey, setBonusRefreshKey] = useState(0);
  // Bonus table search/sort/page state
  const [bonusCoverageSearch, setBonusCoverageSearch] = useState("");
  const [bonusCoverageSort, setBonusCoverageSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "symbol", dir: "asc" });
  const [bonusCoveragePage, setBonusCoveragePage] = useState(0);
  const [bonusRiskSearch, setBonusRiskSearch] = useState("");
  const [bonusRiskSort, setBonusRiskSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "uncovered", dir: "desc" });
  const [bonusRiskPage, setBonusRiskPage] = useState(0);
  const [bonusPnlDealsSearch, setBonusPnlDealsSearch] = useState("");
  const [bonusPnlDealsSort, setBonusPnlDealsSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "profit", dir: "asc" });
  const [bonusPnlDealsPage, setBonusPnlDealsPage] = useState(0);
  const [bonusPnlPosSearch, setBonusPnlPosSearch] = useState("");
  const [bonusPnlPosSort, setBonusPnlPosSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "profit", dir: "asc" });
  const [bonusPnlPosPage, setBonusPnlPosPage] = useState(0);
  const [bonusEquitySearch, setBonusEquitySearch] = useState("");
  const [bonusEquitySort, setBonusEquitySort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "equity", dir: "desc" });
  const [bonusEquityPage, setBonusEquityPage] = useState(0);
  const [contractSizes, setContractSizes] = useState<ContractSizeEntry[]>([]);
  const [contractSizesLoading, setContractSizesLoading] = useState(false);
  const [contractSizesError, setContractSizesError] = useState<string | null>(null);
  const [contractSizesLastUpdated, setContractSizesLastUpdated] = useState<Date | null>(null);
  const [contractSizesRefreshKey, setContractSizesRefreshKey] = useState(0);
  const [contractSymbolInput, setContractSymbolInput] = useState("");
  const [contractClientCsInput, setContractClientCsInput] = useState("");
  const [contractLpCsInput, setContractLpCsInput] = useState("");
  const [contractFormMessage, setContractFormMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [contractEditingId, setContractEditingId] = useState<number | null>(null);
  const [contractEditClientCs, setContractEditClientCs] = useState("");
  const [contractEditLpCs, setContractEditLpCs] = useState("");
  const [swapRows, setSwapRows] = useState<SwapPosition[]>([]);
  const [swapLoading, setSwapLoading] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [swapLastUpdated, setSwapLastUpdated] = useState<Date | null>(null);
  const [swapRefreshKey, setSwapRefreshKey] = useState(0);
  const [historyTab, setHistoryTab] = useState<"aggregate" | "deals" | "volume">("aggregate");
  const [historyLpAccounts, setHistoryLpAccounts] = useState<LpAccount[]>([]);
  const [historySelectedLogin, setHistorySelectedLogin] = useState<string>("");
  const [historyAggregateData, setHistoryAggregateData] = useState<HistoryAggregateData | null>(null);
  const [historyDealsData, setHistoryDealsData] = useState<HistoryDealsData | null>(null);
  const [historyVolumeData, setHistoryVolumeData] = useState<HistoryVolumeData | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLastUpdated, setHistoryLastUpdated] = useState<Date | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [historyShowLowNtpRows, setHistoryShowLowNtpRows] = useState(false);
  const [historySavingLp, setHistorySavingLp] = useState<string | null>(null);
  const [historyStartPeriodEdits, setHistoryStartPeriodEdits] = useState<Record<string, string>>({});
  const historyRequestRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const [nopData, setNopData] = useState<NopReportData | null>(null);
  const [nopLoading, setNopLoading] = useState(false);
  const [nopError, setNopError] = useState<string | null>(null);
  const [nopLastUpdated, setNopLastUpdated] = useState<Date | null>(null);
  const [nopRefreshKey, setNopRefreshKey] = useState(0);
  const [equityOverviewRefreshKey, setEquityOverviewRefreshKey] = useState(0);
  const [nopSymbol, setNopSymbol] = useState("");
  const [nopSymbolsAll, setNopSymbolsAll] = useState<string[]>([]);
  const [rebateIbId, setRebateIbId] = useState("10342");
  const [rebateDefaultRate, setRebateDefaultRate] = useState("0");
  const [rebateFromDate, setRebateFromDate] = useState(() => toInputDate(new Date()));
  const [rebateToDate, setRebateToDate] = useState(() => toInputDate(new Date()));
  const [rebateRules, setRebateRules] = useState<RebateRule[]>([]);
  const [rebateRulesError, setRebateRulesError] = useState<string | null>(null);
  const [rebateCalcRows, setRebateCalcRows] = useState<RebateComparisonRow[]>([]);
  const [rebateCalcLoading, setRebateCalcLoading] = useState(false);
  const [rebateCalcError, setRebateCalcError] = useState<string | null>(null);
  const [rebateLastUpdated, setRebateLastUpdated] = useState<Date | null>(null);
  const [rebateLoginsCount, setRebateLoginsCount] = useState(0);
  const [overviewData, setOverviewData] = useState<DealingOverviewData>({
    coverage: null,
    lpMetrics: null,
    equitySummary: null,
    swaps: [],
    historyAggregate: null,
  });
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewLastUpdated, setOverviewLastUpdated] = useState<Date | null>(null);
  const [liveNotifications, setLiveNotifications] = useState<LiveNotification[]>([]);
  const liveAlertsSignalRRef = useRef<SignalRConnectionManager | null>(null);
  const liveAlertDedupRef = useRef<Record<string, number>>({});
  const livePrefsRef = useRef<AlertPreferences>(readAlertPreferences());
  const [livePrefs, setLivePrefs] = useState<AlertPreferences>(livePrefsRef.current);
  const liveEnabledEvents = useMemo(
    () => ALERT_EVENT_KEYS.filter((key) => livePrefs[key] && hasAccess(`Notifications:${key}`)),
    [livePrefs]
  );

  const parseDateInput = (value: string, fallback: Date) => {
    const next = new Date(`${value}T00:00:00`);
    return Number.isNaN(next.getTime()) ? fallback : next;
  };

  const modeLabel = isUtcTodaySelection(fromDate, toDate) ? "Live" : "Reports";
  const menuLoading =
    activeMenu === "Coverage" || activeMenu === "Risk Exposure"
      ? coverageLoading
      : activeMenu === "Metrics"
        ? metricsLoading
      : activeMenu === "Equity Overview"
        ? false
      : activeMenu === "Bonus"
        ? bonusLoading
      : activeMenu === "Contract Sizes"
        ? contractSizesLoading
      : activeMenu === "Swap Tracker"
        ? swapLoading
        : activeMenu === "History"
          ? historyLoading
          : activeMenu === "Clients NOP"
            ? nopLoading
          : activeMenu === "Rebate Calculator"
            ? rebateCalcLoading
          : isLoading;

  useEffect(() => {
    const off = onAlertPreferencesChanged((next) => {
      livePrefsRef.current = next;
      setLivePrefs(next);
    });
    return off;
  }, []);

  useEffect(() => {
    if (activeMenu !== "Dealing") {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const fetchData = async () => {
      if (cancelled) return;
      setIsLoading(true);
      setError(null);

      try {
        const fromUtc = getUtcDayStartFromLocalDate(fromDate);
        const toUtc = getUtcDayEndFromLocalDate(toDate);
        const apiToUtcExclusive = addUtcDays(getUtcDayStartFromLocalDate(toDate), 1);
        const isToday = isUtcTodaySelection(fromDate, toDate);
        const group = "*";

        const summaryPromise = getSummaryByGroup({ group, from: fromUtc, to: apiToUtcExclusive });
        const positionsPromise = isToday ? getPositionsByGroup({ group }) : Promise.resolve([]);
        const dealsPromise = isToday ? getDealsByGroup({ group, from: fromUtc, to: apiToUtcExclusive }) : Promise.resolve([]);

        const [summary, positions, deals] = await Promise.all([summaryPromise, positionsPromise, dealsPromise]);
        if (cancelled) return;

        const symbolPositionsMap = new Map<string, { positions: number; netExposureLots: number; subSymbols: Map<string, number> }>();
        positions.forEach((position) => {
          const rawSymbol = position.symbol || "UNKNOWN";
          const symbol = normalizeSymbol(rawSymbol);
          const lots = position.lots;
          const signedLots = Number(position.action) === 1 ? -lots : lots;
          const existing = symbolPositionsMap.get(symbol) || { positions: 0, netExposureLots: 0, subSymbols: new Map() };
          existing.subSymbols.set(rawSymbol, (existing.subSymbols.get(rawSymbol) || 0) + signedLots);
          symbolPositionsMap.set(symbol, {
            positions: existing.positions + 1,
            netExposureLots: existing.netExposureLots + signedLots,
            subSymbols: existing.subSymbols,
          });
        });

        const topSymbolsData = Array.from(symbolPositionsMap.entries())
          .map(([symbol, data]) => ({
            symbol,
            positions: data.positions,
            netExposureLots: data.netExposureLots,
            subSymbols: Array.from(data.subSymbols.entries())
              .map(([subSymbol, netExposureLots]) => ({ symbol: subSymbol, netExposureLots }))
              .sort((a, b) => Math.abs(b.netExposureLots) - Math.abs(a.netExposureLots)),
          }))
          .sort((a, b) => Math.abs(b.netExposureLots) - Math.abs(a.netExposureLots))
          .slice(0, 10);

        const buyLots = isToday
          ? deals.reduce((sum, deal) => (deal.action === 0 ? sum + getDealLots(deal.lots, deal.volume, deal.volumeExt) : sum), 0)
          : summary.netLotsBuy;
        const sellLots = isToday
          ? deals.reduce((sum, deal) => (deal.action === 1 ? sum + getDealLots(deal.lots, deal.volume, deal.volumeExt) : sum), 0)
          : summary.netLotsSell;

        setMetrics({
          totalEquity: summary.currentEquity,
          totalCredit: summary.currentCredit,
          clientsWithCredit: summary.creditCount,
          netLots: isToday ? buyLots - sellLots : summary.netLots,
          buyLots,
          sellLots,
          totalVolume: isToday ? deals.reduce((sum, deal) => sum + getDealVolume(deal), 0) : null,
          tradingProfit: summary.tradingProfit,
          dealCount: isToday ? deals.length : summary.dealCount,
        });
        setTopSymbols(topSymbolsData);
        setLastUpdated(new Date());
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "Failed to load dealing analytics.");
          setMetrics(DEFAULT_METRICS);
          setTopSymbols([]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchData();
    const iv = setInterval(fetchData, 60000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [activeMenu, fromDate, toDate, refreshKey]);

  const menuItems = DEALING_TABS as readonly string[];
  const bonusRootAccess = hasAccess("Dealing:Bonus");
  const allowedBonusSubTabs = useMemo(
    () => BONUS_SUB_TABS.filter((tab) => bonusRootAccess || hasAccess(`Dealing:${tab}`)),
    [bonusRootAccess]
  );
  const allowedMenuItems = useMemo(
    () =>
      menuItems.filter((item) => {
        if (item === "Bonus") {
          return bonusRootAccess || allowedBonusSubTabs.length > 0;
        }
        return hasAccess(`Dealing:${item}`);
      }),
    [menuItems, bonusRootAccess, allowedBonusSubTabs]
  );

  useEffect(() => {
    if (!allowedMenuItems.length) return;
    if (!allowedMenuItems.includes(activeMenu)) {
      setActiveMenu(allowedMenuItems[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedMenuItems]); // re-check only when permissions change, not on every tab switch

  useEffect(() => {
    if (activeMenu !== "Bonus") return;
    if (!allowedBonusSubTabs.length) return;
    if (!allowedBonusSubTabs.includes(bonusSubTab)) {
      setBonusSubTab(allowedBonusSubTabs[0]);
    }
  }, [activeMenu, allowedBonusSubTabs, bonusSubTab]);

  useEffect(() => {
    if (activeMenu !== "Bonus") return;
    if (bonusSubTab !== "Bonus PNL") {
      setBonusPnlExpanded({
        lpClosedDeals: false,
        lpOpenPositions: false,
        creditSettled: false,
        creditUnsettled: false,
      });
    }
  }, [activeMenu, bonusSubTab]);

  const handlePageRefresh = () => {
    const nextFrom = new Date(selectedFromDate);
    const nextTo = new Date(selectedToDate);
    setFromDate(nextFrom);
    setToDate(nextTo);

    if (activeMenu === "Coverage" || activeMenu === "Risk Exposure") {
      setCoverageRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Metrics") {
      setMetricsRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Equity Overview") {
      setEquityOverviewRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Bonus") {
      setBonusRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Contract Sizes") {
      setContractSizesRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Swap Tracker") {
      setSwapRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "History") {
      setHistoryRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Clients NOP") {
      setNopRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Rebate Calculator") {
      return;
    }
    setRefreshKey((k) => k + 1);
  };

  const downloadRebateSampleCsv = () => {
    const blob = new Blob([REBATE_RULES_SAMPLE_CSV], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = "rebate_rules_sample.csv";
    a.click();
    URL.revokeObjectURL(href);
  };

  const parseRebateRulesCsv = (csvText: string) => {
    const lines = csvText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) throw new Error("CSV is empty. Expected header + rows.");
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const symbolIdx = headers.findIndex((h) => h === "symbol" || h === "symbol_pattern");
    const rateIdx = headers.findIndex((h) => h === "rate_per_lot" || h === "rate");
    if (symbolIdx === -1 || rateIdx === -1) {
      throw new Error("CSV must contain columns: symbol (or symbol_pattern) and rate_per_lot.");
    }

    const parsed: RebateRule[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const cols = lines[i].split(",").map((v) => v.trim());
      const symbolPattern = normalizeRebateSymbol(cols[symbolIdx] || "");
      const ratePerLot = Number(cols[rateIdx] || 0);
      if (!symbolPattern) continue;
      if (!Number.isFinite(ratePerLot)) {
        throw new Error(`Invalid rate_per_lot on line ${i + 1}.`);
      }
      parsed.push({ symbolPattern, ratePerLot });
    }
    if (!parsed.length) throw new Error("No valid rule rows found in CSV.");
    parsed.sort((a, b) => (a.symbolPattern === "*" ? 1 : b.symbolPattern === "*" ? -1 : a.symbolPattern.localeCompare(b.symbolPattern)));
    return parsed;
  };

  const handleRebateCsvUpload = async (file?: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseRebateRulesCsv(text);
      setRebateRules(parsed);
      setRebateRulesError(null);
    } catch (e: any) {
      setRebateRules([]);
      setRebateRulesError(e?.message || "Failed to parse CSV rules.");
    }
  };

  const runRebateCalculation = async () => {
    const ibIdNum = Number(rebateIbId);
    const defaultRateNum = Number(rebateDefaultRate);
    const fromDate = new Date(`${rebateFromDate}T00:00:00`);
    const toDate = new Date(`${rebateToDate}T00:00:00`);
    if (!Number.isFinite(ibIdNum) || ibIdNum <= 0) {
      setRebateCalcError("Enter a valid IB ID.");
      return;
    }
    if (!rebateFromDate || !rebateToDate || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      setRebateCalcError("Select valid from and to dates.");
      return;
    }
    if (fromDate.getTime() > toDate.getTime()) {
      setRebateCalcError("From date cannot be after to date.");
      return;
    }
    if (rebateRules.length === 0 && (!Number.isFinite(defaultRateNum) || defaultRateNum <= 0)) {
      setRebateCalcError("Upload rebate rules CSV or set a default rebate rate per lot.");
      return;
    }

    setRebateCalcLoading(true);
    setRebateCalcError(null);
    setRebateCalcRows([]);
    setRebateLoginsCount(0);
    try {
      const tree = await fetchIbTree(ibIdNum);
      const ids = new Set<number>();
      tree.forEach((node) => {
        if (node.ibId) ids.add(Number(node.ibId));
        if (node.referralIbId) ids.add(Number(node.referralIbId));
      });
      if (!ids.size) throw new Error("No users returned from IB tree.");

      const accountResults = await Promise.allSettled(Array.from(ids).map((userId) => fetchAccountsByUserId(userId)));
      const allAccounts = accountResults
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchAccountsByUserId>>> => r.status === "fulfilled")
        .flatMap((r) => r.value || []);

      const logins = Array.from(
        new Set(
          allAccounts
            .filter((acc) => acc.login && (acc.isEnabled === undefined || Number(acc.isEnabled) === 1))
            .map((acc) => String(acc.login).trim())
            .filter(Boolean),
        ),
      );
      setRebateLoginsCount(logins.length);
      if (!logins.length) throw new Error("No MT5 logins found for this IB tree.");

      const dealsResults = await Promise.allSettled(logins.map((login) => fetchDealsByLogin({ login, from: fromDate, to: toDate })));
      const aggregated = new Map<string, RebateComparisonRow>();

      dealsResults.forEach((result, idx) => {
        if (result.status !== "fulfilled") return;
        const login = logins[idx];
        (result.value || []).forEach((deal) => {
          const symbol = normalizeRebateSymbol(String(deal.symbol || ""));
          if (!symbol) return;
          const lots = getPositionLots(deal);
          if (!Number.isFinite(lots) || lots <= 0) return;
          const rate = getRateForSymbol(symbol, rebateRules, defaultRateNum);
          const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 0;

          const key = `${login}|${symbol}`;
          const existing = aggregated.get(key);
          const eligibleLots = safeRate > 0 ? lots : 0;
          const ineligibleLots = safeRate > 0 ? 0 : lots;
          if (!existing) {
            aggregated.set(key, {
              login,
              symbol,
              trades: 1,
              tradedLots: lots,
              eligibleLots,
              ineligibleLots,
              rebatePerLot: safeRate,
              mt5CommissionUsd: lots * safeRate,
            });
            return;
          }
          existing.trades += 1;
          existing.tradedLots += lots;
          existing.eligibleLots += eligibleLots;
          existing.ineligibleLots += ineligibleLots;
          existing.mt5CommissionUsd += lots * safeRate;
          if (existing.rebatePerLot !== safeRate) {
            existing.rebatePerLot = existing.eligibleLots > 0 ? existing.mt5CommissionUsd / existing.eligibleLots : 0;
          }
        });
      });

      const rows = Array.from(aggregated.values()).sort((a, b) => b.mt5CommissionUsd - a.mt5CommissionUsd);
      setRebateCalcRows(rows);
      setRebateLastUpdated(new Date());
      if (!rows.length) setRebateCalcError("No trades found for the selected date range.");
    } catch (e: any) {
      setRebateCalcError(e?.message || "Failed to run rebate calculation.");
    } finally {
      setRebateCalcLoading(false);
    }
  };

  const downloadTableSnapshot = ({
    filePrefix,
    title,
    updatedAt,
    headers,
    rows,
  }: {
    filePrefix: string;
    title: string;
    updatedAt?: Date | null;
    headers: string[];
    rows: Array<Array<string | number>>;
  }) => {
    if (!headers.length || !rows.length) return;
    const normalize = (v: string | number) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v));
    const normalizedRows = rows.map((r) => headers.map((_, i) => normalize(r[i] ?? "")));
    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d");
    if (!measureCtx) throw new Error("Canvas context unavailable");
    measureCtx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    const colWidths = headers.map((header, colIdx) => {
      const headerWidth = measureCtx.measureText(header).width;
      const rowWidth = normalizedRows.reduce((max, row) => Math.max(max, measureCtx.measureText(row[colIdx] ?? "").width), 0);
      return Math.ceil(Math.max(headerWidth, rowWidth) + 24);
    });

    const tableWidth = colWidths.reduce((sum, w) => sum + w, 0);
    const rowHeight = 24;
    const titleHeight = 56;
    const headerHeight = 28;
    const footerPad = 14;
    const imageWidth = Math.max(920, tableWidth + 24);
    const imageHeight = titleHeight + headerHeight + normalizedRows.length * rowHeight + footerPad;
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = imageWidth * scale;
    canvas.height = imageHeight * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable");
    ctx.scale(scale, scale);

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, imageWidth, imageHeight);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, imageWidth, titleHeight);
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "600 18px ui-sans-serif, system-ui, -apple-system, Segoe UI";
    ctx.fillText(title, 12, 24);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`Updated: ${(updatedAt || new Date()).toLocaleString()}`, 12, 44);

    const tableX = 12;
    const tableY = titleHeight;
    let x = tableX;
    ctx.fillStyle = "#1f2937";
    ctx.fillRect(tableX, tableY, tableWidth, headerHeight);
    ctx.strokeStyle = "#334155";
    ctx.strokeRect(tableX, tableY, tableWidth, headerHeight);
    ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    headers.forEach((header, idx) => {
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(header, x + 8, tableY + 18);
      x += colWidths[idx];
    });

    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    normalizedRows.forEach((row, rowIdx) => {
      const y = tableY + headerHeight + rowIdx * rowHeight;
      const rowLabel = row[0] || "";
      const isTotal = rowLabel === "TOTAL" || rowLabel === "GOLD TOTAL";
      ctx.fillStyle = isTotal ? "#1e293b" : rowIdx % 2 === 0 ? "#0f172a" : "#111827";
      ctx.fillRect(tableX, y, tableWidth, rowHeight);
      ctx.strokeStyle = "#334155";
      ctx.strokeRect(tableX, y, tableWidth, rowHeight);

      let colX = tableX;
      row.forEach((cell, colIdx) => {
        const alignRight = colIdx >= 2;
        const txt = cell ?? "";
        ctx.fillStyle = alignRight ? "#cbd5e1" : "#e2e8f0";
        const txtWidth = measureCtx.measureText(txt).width;
        const textX = alignRight ? colX + colWidths[colIdx] - txtWidth - 8 : colX + 8;
        ctx.fillText(txt, textX, y + 16);
        colX += colWidths[colIdx];
      });
    });

    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
    link.href = canvas.toDataURL("image/png");
    link.download = `${filePrefix}-${stamp}.png`;
    link.click();
  };

  const runSnapshot = (table: FullscreenTableKey, fn: () => void) => {
    setSnapshottingTable(table);
    try {
      fn();
    } catch (e: any) {
      const msg = e?.message || "Failed to capture snapshot.";
      if (table === "coverage" || table === "risk") setCoverageError(msg);
      if (table === "metrics") setMetricsError(msg);
      if (table === "swap") setSwapError(msg);
      if (table === "history") setHistoryError(msg);
    } finally {
      setSnapshottingTable(null);
    }
  };

  const handleCoverageSnapshot = () =>
    runSnapshot("coverage", () => {
      if (!coverageTableRows.length) return;
      const lpNames = visibleCoverageLpNames;
      const headers = ["Symbol", "Buy/Sell", "Client Net", "Uncovered", ...lpNames];
      const rows: Array<Array<string | number>> = [];
      [...coverageRows.gold, ...coverageRows.rest].forEach((row, idx) => {
        rows.push([row.symbol, row.direction || "-", row.clientNet, row.uncovered, ...lpNames.map((lp) => row.lpNets?.[lp] || 0)]);
        const isGoldEnd = isGoldSymbol(row.symbol) && idx === coverageRows.gold.length - 1 && coverageRows.gold.length > 0;
        if (isGoldEnd) {
          rows.push(["GOLD TOTAL", "", coverageGoldTotals.clientNet, coverageGoldTotals.uncovered, ...lpNames.map((lp) => coverageGoldTotals.lpTotals[lp] || 0)]);
        }
      });
      rows.push(["TOTAL", "", coverageData?.totals?.clientNet || 0, coverageData?.totals?.uncovered || 0, ...lpNames.map((lp) => coverageData?.totals?.lpNets?.[lp] || 0)]);
      downloadTableSnapshot({ filePrefix: "coverage-snapshot", title: "Coverage Snapshot - Position Match Table", updatedAt: coverageLastUpdated, headers, rows });
    });

  const handleRiskSnapshot = () =>
    runSnapshot("risk", () => {
      if (!riskVisibleRows.length) return;
      const headers = ["Symbol", "Direction", "Client Net", "LP Coverage", "Uncovered", "Coverage %"];
      const rows: Array<Array<string | number>> = riskVisibleRows.map((row) => {
        const lpCoverage = row.clientNet - row.uncovered;
        const pct = row.clientNet === 0 ? "-" : `${(((row.clientNet - row.uncovered) / row.clientNet) * 100).toFixed(1)}%`;
        return [row.isSubtotalRow ? "GOLD NET (GOLDFT + XAUUSD)" : row.symbol, row.direction || "-", row.clientNet, lpCoverage, row.uncovered, pct];
      });
      const tClient = coverageData?.totals?.clientNet || 0;
      const tUncovered = coverageData?.totals?.uncovered || 0;
      const tCoverage = tClient - tUncovered;
      const tPct = tClient === 0 ? "-" : `${((tCoverage / tClient) * 100).toFixed(1)}%`;
      rows.push(["TOTAL", "", tClient, tCoverage, tUncovered, tPct]);
      downloadTableSnapshot({ filePrefix: "risk-exposure-snapshot", title: "Risk Exposure Snapshot", updatedAt: coverageLastUpdated, headers, rows });
    });

  const handleMetricsSnapshot = () =>
    runSnapshot("metrics", () => {
      const items = metricsData?.items || [];
      if (!items.length) return;
      const headers = ["LP", "Login", "Equity", "Real Equity", "Credit", "Balance", "Margin", "Free Margin", "Margin Level %"];
      const rows: Array<Array<string | number>> = items.map((item) => [
        item.lp,
        String(item.login),
        item.equity,
        item.realEquity,
        item.credit,
        item.balance,
        item.margin,
        item.freeMargin,
        `${item.marginLevel.toFixed(2)}%`,
      ]);
      rows.push([
        "TOTAL",
        "",
        metricsData?.totals?.equity || 0,
        metricsData?.totals?.realEquity || 0,
        metricsData?.totals?.credit || 0,
        metricsData?.totals?.balance || 0,
        metricsData?.totals?.margin || 0,
        metricsData?.totals?.freeMargin || 0,
        "-",
      ]);
      downloadTableSnapshot({ filePrefix: "metrics-snapshot", title: "LP Metrics Snapshot", updatedAt: metricsLastUpdated, headers, rows });
    });

  const handleSwapSnapshot = () =>
    runSnapshot("swap", () => {
      if (!swapRows.length) return;
      const headers = ["LP", "Ticket", "Symbol", "Side", "Volume", "Swap ($)", "Swap Free Days", "Days Used", "Days Left", "Charge Tonight"];
      const rows: Array<Array<string | number>> = swapRows.map((row) => [
        row.lpName,
        String(row.ticket),
        row.symbol,
        row.side,
        row.volume,
        row.swap,
        row.swapFreeDays === null ? "-" : row.swapFreeDays,
        row.daysUsed,
        row.daysLeft,
        row.willChargeTonight ? "YES" : "No",
      ]);
      downloadTableSnapshot({ filePrefix: "swap-tracker-snapshot", title: "Swap Tracker Snapshot", updatedAt: swapLastUpdated, headers, rows });
    });

  const handleHistorySnapshot = () =>
    runSnapshot("history", () => {
      if (historyTab === "aggregate") {
        const items = historyAggregateVisibleItems;
        if (!items.length) return;
        const headers = ["LP Name", "Login", "Source", "Start Period", "Start Equity", "End Equity", "Credit", "Deposit", "Withdrawal", "Net Deposits", "Gross P/L", "Commission", "Swap", "Net P/L", "Real LP P/L", "NTP %", "LP P/L (Rev Share)"];
        const rows: Array<Array<string | number>> = items.map((item) =>
          item.isError
            ? [item.lpName, String(item.login), item.source || "-", "", `ERROR: ${item.errorMessage || "Error"}`, "", "", "", "", "", "", "", "", "", "", "", ""]
            : [
                item.lpName,
                String(item.login),
                item.source || "-",
                epochSecondsToInputDate(item.effectiveFrom ?? historyTimestamps.from),
                item.startEquity,
                item.endEquity,
                item.credit,
                item.deposit,
                item.withdrawal,
                item.netDeposits,
                item.grossProfit,
                item.totalCommission,
                item.totalSwap,
                item.netPL,
                item.realLpPL,
                `${item.ntpPercent.toFixed(1)}%`,
                item.lpPL,
              ],
        );
        if (historyAggregateVisibleTotals) {
          const t = historyAggregateVisibleTotals;
          rows.push(["TOTAL", "", "", "", t.startEquity, t.endEquity, t.credit, t.deposit, t.withdrawal, t.netDeposits, t.grossProfit, t.totalCommission, t.totalSwap, t.netPL, t.realLpPL, "", t.lpPL]);
        }
        downloadTableSnapshot({ filePrefix: "history-aggregate-snapshot", title: "History Snapshot - Revenue Share", updatedAt: historyLastUpdated, headers, rows });
        return;
      }
      if (historyTab === "deals") {
        const deals = historyDealsData?.deals || [];
        if (!deals.length) return;
        const headers = ["Ticket", "Symbol", "Time", "Direction", "Entry", "Volume", "Price", "Contract Size", "Market Value", "Profit", "Commission", "Fee", "Swap", "LP Comm", "LP Comm/Lot"];
        const rows: Array<Array<string | number>> = deals.map((d) => [String(d.dealTicket), d.symbol, d.timeString, d.direction, d.entry, d.volume, d.price, d.contractSize, d.marketValue, d.profit, d.commission, d.fee, d.swap, d.lpCommission, d.lpCommPerLot]);
        downloadTableSnapshot({ filePrefix: "history-deals-snapshot", title: "History Snapshot - Trade Deals", updatedAt: historyLastUpdated, headers, rows });
        return;
      }
      const items = historyVolumeData?.items || [];
      if (!items.length) return;
      const headers = ["LP Name", "Login", "Source", "Trade Count", "Total Lots", "Notional (USD)", "Volume (Yards)"];
      const rows: Array<Array<string | number>> = items.map((item) =>
        item.isError
          ? [item.lpName, String(item.login), item.source || "-", `ERROR: ${item.errorMessage || "Error"}`, "", "", ""]
          : [item.lpName, String(item.login), item.source || "-", item.tradeCount, item.totalLots, item.notionalUsd, item.volumeYards],
      );
      if (historyVolumeData?.totals) {
        rows.push(["TOTAL", "", "", historyVolumeData.totals.tradeCount, historyVolumeData.totals.totalLots, historyVolumeData.totals.notionalUsd, historyVolumeData.totals.volumeYards]);
      }
      downloadTableSnapshot({ filePrefix: "history-volume-snapshot", title: "History Snapshot - Volume (Yards)", updatedAt: historyLastUpdated, headers, rows });
    });

  useEffect(() => {
    if (!fullscreenTable) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setFullscreenTable(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fullscreenTable]);

  useEffect(() => {
    if (activeMenu !== "Coverage" && activeMenu !== "Risk Exposure") {
      setCoverageStatus("disconnected");
      setCoverageError(null);
      if (coverageSignalRRef.current) {
        coverageSignalRRef.current.disconnect().catch(() => undefined);
        coverageSignalRRef.current = null;
      }
      return;
    }

    const coverageEndpoint = `${BACKEND_BASE_URL}/Coverage/position-match-table`;
    const hubUrl = `${BACKEND_BASE_URL}/ws/dashboard`;
    let cancelled = false;

    const fetchCoverage = async () => {
      if (cancelled) return;
      setCoverageLoading(true);
      try {
        const resp = await fetch(coverageEndpoint);
        if (!resp.ok) {
          throw new Error(`Coverage API ${resp.status}`);
        }
        const data = (await resp.json()) as CoverageData;
        if (cancelled) return;
        setCoverageData(data);
        setCoverageLastUpdated(new Date());
        setCoverageError(null);
      } catch (e: any) {
        if (!cancelled) {
          setCoverageError(e?.message || "Failed to load coverage data.");
        }
      } finally {
        if (!cancelled) setCoverageLoading(false);
      }
    };

    fetchCoverage();

    const manager = new SignalRConnectionManager({
      hubUrl,
      trackedEvents: ["PositionMatchTableUpdate"],
      accessTokenFactory: async () => null,
    });

    coverageSignalRRef.current = manager;
    setCoverageStatus("connecting");

    const unsubStatus = manager.onStatusChange((status) => {
      if (status === "connected") setCoverageStatus("connected");
      else if (status === "connecting" || status === "reconnecting") setCoverageStatus("connecting");
      else setCoverageStatus("disconnected");
    });

    const unsubError = manager.onError((message) => {
      setCoverageError(message);
    });

    const unsubEvent = manager.onEvent((payload, eventName) => {
      if (eventName !== "PositionMatchTableUpdate") return;
      const data = payload as CoverageData;
      if (!data || !Array.isArray(data.rows)) return;
      setCoverageData(data);
      setCoverageLastUpdated(new Date());
      setCoverageError(null);
    });

    manager.connect().catch(() => undefined);

    return () => {
      cancelled = true;
      unsubStatus();
      unsubError();
      unsubEvent();
      manager.disconnect().catch(() => undefined);
      if (coverageSignalRRef.current === manager) {
        coverageSignalRRef.current = null;
      }
    };
  }, [activeMenu, coverageRefreshKey]);

  useEffect(() => {
    if (activeMenu !== "Metrics") {
      setMetricsError(null);
      return;
    }

    const metricsDashboardEndpoint = `${BACKEND_BASE_URL}/Metrics/dashboard`;
    let cancelled = false;

    const describeRateLimit = (resp: Response, label: string) => {
      if (resp.status !== 429) return `${label} ${resp.status}`;
      const retryAfter = resp.headers.get("Retry-After");
      return retryAfter
        ? `Rate limit reached (429) for ${label}. Retry after ${retryAfter}s.`
        : `Rate limit reached (429) for ${label}. Please wait a few seconds and try again.`;
    };

    const fetchMetrics = async () => {
      if (cancelled) return;
      const requestKey = `metrics|${metricsRefreshKey}`;
      const now = Date.now();
      if (metricsRequestRef.current.key === requestKey && now - metricsRequestRef.current.at < 1200) {
        return;
      }
      metricsRequestRef.current = { key: requestKey, at: now };

      setMetricsLoading(true);
      try {
        const resp = await fetch(metricsDashboardEndpoint);
        if (!resp.ok) throw new Error(describeRateLimit(resp, "Metrics dashboard"));

        const dashboard = (await resp.json()) as Partial<MetricsData & EquitySummaryData>;
        if (cancelled) return;
        setMetricsData({
          items: Array.isArray(dashboard.items) ? dashboard.items : [],
          totals: {
            equity: Number(dashboard.totals?.equity) || 0,
            realEquity: Number(dashboard.totals?.realEquity) || 0,
            credit: Number(dashboard.totals?.credit) || 0,
            balance: Number(dashboard.totals?.balance) || 0,
            margin: Number(dashboard.totals?.margin) || 0,
            freeMargin: Number(dashboard.totals?.freeMargin) || 0,
          },
        });
        setMetricsEquitySummary({
          lpWithdrawableEquity: Number(dashboard.lpWithdrawableEquity) || 0,
          clientWithdrawableEquity: Number(dashboard.clientWithdrawableEquity) || 0,
          difference: Number(dashboard.difference) || 0,
        });
        setMetricsLastUpdated(new Date());
        setMetricsError(null);
      } catch (e: any) {
        if (!cancelled) setMetricsError(e?.message || "Failed to load LP metrics.");
      } finally {
        if (!cancelled) setMetricsLoading(false);
      }
    };

    fetchMetrics();
    const iv = setInterval(fetchMetrics, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [activeMenu, metricsRefreshKey]);

  useEffect(() => {
    if (activeMenu !== "Metrics") {
      if (metricsPriceSignalRRef.current) {
        metricsPriceSignalRRef.current.stop().catch(() => undefined);
        metricsPriceSignalRRef.current = null;
      }
      return;
    }

    const connection = new HubConnectionBuilder()
      .withUrl(`${BACKEND_BASE_URL}/ws/dashboard`)
      .withAutomaticReconnect([0, 1000, 2000, 5000])
      .configureLogging(LogLevel.None)
      .build();

    connection.on("PriceUpdate", (payload: { symbol?: string; bid?: number; ask?: number }) => {
      const symbol = String(payload?.symbol || "").toUpperCase();
      if (!symbol.includes("XAUUSD")) return;
      const bid = Number(payload?.bid);
      const ask = Number(payload?.ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;

      const prevBid = metricsLastBidRef.current;
      const dir: "up" | "down" | "flat" = prevBid == null ? "flat" : bid > prevBid ? "up" : bid < prevBid ? "down" : "flat";
      metricsLastBidRef.current = bid;
      setMetricsGoldQuote({ bid, ask, spreadPoints: (ask - bid) * 100, dir });
    });

    connection.onreconnected(async () => {
      try {
        await connection.invoke("SubscribeToSymbol", "XAUUSD");
      } catch {
        // ignore subscription errors
      }
    });

    (async () => {
      try {
        await connection.start();
        await connection.invoke("SubscribeToSymbol", "XAUUSD");
      } catch {
        // ignore connection errors
      }
    })();

    metricsPriceSignalRRef.current = connection;

    return () => {
      connection.off("PriceUpdate");
      connection.stop().catch(() => undefined);
      if (metricsPriceSignalRRef.current === connection) {
        metricsPriceSignalRRef.current = null;
      }
    };
  }, [activeMenu]);

  useEffect(() => {
    if (activeMenu !== "Contract Sizes") {
      setContractSizesError(null);
      return;
    }
    const endpoint = `${BACKEND_BASE_URL}/api/ContractSize`;
    let cancelled = false;
    const load = async () => {
      setContractSizesLoading(true);
      setContractSizesError(null);
      try {
        const resp = await fetch(endpoint);
        if (!resp.ok) throw new Error(`ContractSize ${resp.status}`);
        const data = (await resp.json()) as ContractSizeEntry[];
        if (cancelled) return;
        setContractSizes(Array.isArray(data) ? data : []);
        setContractSizesLastUpdated(new Date());
      } catch (e: any) {
        if (!cancelled) setContractSizesError(e?.message || "Failed to load contract size multipliers.");
      } finally {
        if (!cancelled) setContractSizesLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, contractSizesRefreshKey]);

  const contractMultiplierValue = useMemo(() => {
    const clientCs = Number(contractClientCsInput);
    const lpCs = Number(contractLpCsInput);
    if (!Number.isFinite(clientCs) || !Number.isFinite(lpCs) || lpCs <= 0) return null;
    return clientCs / lpCs;
  }, [contractClientCsInput, contractLpCsInput]);

  const detectContractSizes = async () => {
    const symbol = contractSymbolInput.trim().toUpperCase();
    if (!symbol) {
      setContractFormMessage({ text: "Enter a symbol first.", ok: false });
      return;
    }
    const endpoint = `${BACKEND_BASE_URL}/api/ContractSize/detect/${encodeURIComponent(symbol)}`;
    try {
      const resp = await fetch(endpoint);
      if (!resp.ok) throw new Error(`Detect ${resp.status}`);
      const data = (await resp.json()) as Partial<ContractSizeDetectResponse>;
      setContractClientCsInput(Number(data.clientContractSize || 0) > 0 ? String(data.clientContractSize) : "");
      setContractLpCsInput(Number(data.lpContractSize || 0) > 0 ? String(data.lpContractSize) : "");
      const ok = Number(data.clientContractSize || 0) > 0 && Number(data.lpContractSize || 0) > 0;
      setContractFormMessage({
        text: `Detected: Client CS=${Number(data.clientContractSize || 0)}, LP CS=${Number(data.lpContractSize || 0)}`,
        ok,
      });
    } catch (e: any) {
      setContractFormMessage({ text: e?.message || "Detection failed.", ok: false });
    }
  };

  const addContractSizeEntry = async () => {
    const symbol = contractSymbolInput.trim().toUpperCase();
    const clientContractSize = Number(contractClientCsInput);
    const lpContractSize = Number(contractLpCsInput);
    if (!symbol || !Number.isFinite(clientContractSize) || !Number.isFinite(lpContractSize) || lpContractSize <= 0) {
      setContractFormMessage({ text: "Symbol, client CS, and LP CS (> 0) are required.", ok: false });
      return;
    }
    const endpoint = `${BACKEND_BASE_URL}/api/ContractSize`;
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, clientContractSize, lpContractSize }),
      });
      if (!resp.ok) throw new Error(await resp.text().catch(() => `Add ${resp.status}`));
      setContractFormMessage({ text: `Added ${symbol}.`, ok: true });
      setContractSymbolInput("");
      setContractClientCsInput("");
      setContractLpCsInput("");
      setContractSizesRefreshKey((k) => k + 1);
    } catch (e: any) {
      setContractFormMessage({ text: e?.message || "Failed to add multiplier.", ok: false });
    }
  };

  const saveContractSizeEdit = async (id: number) => {
    const clientContractSize = Number(contractEditClientCs);
    const lpContractSize = Number(contractEditLpCs);
    if (!Number.isFinite(clientContractSize) || !Number.isFinite(lpContractSize) || lpContractSize <= 0) {
      setContractSizesError("Invalid values. LP CS must be > 0.");
      return;
    }
    const endpoint = `${BACKEND_BASE_URL}/api/ContractSize/${id}`;
    try {
      const resp = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "", clientContractSize, lpContractSize }),
      });
      if (!resp.ok) throw new Error(await resp.text().catch(() => `Update ${resp.status}`));
      setContractEditingId(null);
      setContractSizesRefreshKey((k) => k + 1);
    } catch (e: any) {
      setContractSizesError(e?.message || "Failed to update multiplier.");
    }
  };

  const deleteContractSizeEntry = async (id: number) => {
    const endpoint = `${BACKEND_BASE_URL}/api/ContractSize/${id}`;
    try {
      const resp = await fetch(endpoint, { method: "DELETE" });
      if (!resp.ok) throw new Error(`Delete ${resp.status}`);
      setContractSizesRefreshKey((k) => k + 1);
    } catch (e: any) {
      setContractSizesError(e?.message || "Failed to delete multiplier.");
    }
  };

  useEffect(() => {
    if (activeMenu !== "Swap Tracker") {
      setSwapError(null);
      return;
    }

    const endpoint = `${BACKEND_BASE_URL}/Swap/positions`;
    let cancelled = false;

    const fetchSwap = async () => {
      if (cancelled) return;
      setSwapLoading(true);
      try {
        const resp = await fetch(endpoint);
        if (!resp.ok) throw new Error(`Swap API ${resp.status}`);
        const data = (await resp.json()) as SwapPosition[];
        if (cancelled) return;
        setSwapRows(Array.isArray(data) ? data : []);
        setSwapLastUpdated(new Date());
        setSwapError(null);
      } catch (e: any) {
        if (!cancelled) setSwapError(e?.message || "Failed to load swap tracker.");
      } finally {
        if (!cancelled) setSwapLoading(false);
      }
    };

    fetchSwap();
    const iv = setInterval(fetchSwap, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [activeMenu, swapRefreshKey]);

  const visibleCoverageLpNames = useMemo(() => {
    const lpNames = coverageData?.lpNames || [];
    if (coverageShowZeroData || !coverageData?.rows?.length) return lpNames;
    return lpNames.filter((lp) => coverageData.rows.some((row) => !isZeroish(row.lpNets?.[lp] || 0)));
  }, [coverageData, coverageShowZeroData]);

  const coverageRows = useMemo(() => {
    if (!coverageData?.rows) return { gold: [] as CoverageRow[], rest: [] as CoverageRow[] };
    const filteredRows = coverageShowZeroData
      ? coverageData.rows
      : coverageData.rows.filter((row) => {
          const hasVisibleLpValue = visibleCoverageLpNames.some((lp) => !isZeroish(row.lpNets?.[lp] || 0));
          return !isZeroish(row.clientNet) || !isZeroish(row.uncovered) || hasVisibleLpValue;
        });
    const gold = filteredRows.filter((row) => isGoldSymbol(row.symbol)).sort((a, b) => a.symbol.localeCompare(b.symbol));
    const rest = filteredRows.filter((row) => !isGoldSymbol(row.symbol)).sort((a, b) => a.symbol.localeCompare(b.symbol));
    return { gold, rest };
  }, [coverageData, coverageShowZeroData, visibleCoverageLpNames]);

  const coverageGoldTotals = useMemo(() => {
    const gold = coverageRows.gold;
    const lpTotals: Record<string, number> = {};
    visibleCoverageLpNames.forEach((lp) => {
      lpTotals[lp] = gold.reduce((sum, row) => sum + (row.lpNets?.[lp] || 0), 0);
    });
    return {
      clientNet: gold.reduce((sum, row) => sum + row.clientNet, 0),
      uncovered: gold.reduce((sum, row) => sum + row.uncovered, 0),
      lpTotals,
    };
  }, [coverageRows.gold, visibleCoverageLpNames]);

  const historyAggregateVisibleItems = useMemo(() => {
    const items = historyAggregateData?.items || [];
    return items.filter((item) => item.isError || historyShowLowNtpRows || !isZeroish(item.ntpPercent));
  }, [historyAggregateData, historyShowLowNtpRows]);

  const historyAggregateHiddenRowsCount = useMemo(() => {
    if (!historyAggregateData?.items?.length) return 0;
    return historyAggregateData.items.filter((item) => !item.isError && isZeroish(item.ntpPercent)).length;
  }, [historyAggregateData]);

  const historyAggregateVisibleTotals = useMemo(() => {
    const validItems = historyAggregateVisibleItems.filter((item) => !item.isError);
    if (!validItems.length) return null;

    return validItems.reduce<HistoryAggregateData["totals"]>(
      (totals, item) => ({
        ...totals,
        startEquity: totals.startEquity + (Number(item.startEquity) || 0),
        endEquity: totals.endEquity + (Number(item.endEquity) || 0),
        credit: totals.credit + (Number(item.credit) || 0),
        deposit: totals.deposit + (Number(item.deposit) || 0),
        withdrawal: totals.withdrawal + (Number(item.withdrawal) || 0),
        netDeposits: totals.netDeposits + (Number(item.netDeposits) || 0),
        grossProfit: totals.grossProfit + (Number(item.grossProfit) || 0),
        totalCommission: totals.totalCommission + (Number(item.totalCommission) || 0),
        totalSwap: totals.totalSwap + (Number(item.totalSwap) || 0),
        netPL: totals.netPL + (Number(item.netPL) || 0),
        realLpPL: totals.realLpPL + (Number(item.realLpPL) || 0),
        ntpPercent: 0,
        lpPL: totals.lpPL + (Number(item.lpPL) || 0),
      }),
      {
        effectiveFrom: 0,
        startEquity: 0,
        endEquity: 0,
        credit: 0,
        deposit: 0,
        withdrawal: 0,
        netDeposits: 0,
        grossProfit: 0,
        totalCommission: 0,
        totalSwap: 0,
        netPL: 0,
        realLpPL: 0,
        ntpPercent: 0,
        lpPL: 0,
      },
    );
  }, [historyAggregateVisibleItems]);

  const historyTimestamps = useMemo(() => {
    const from = Math.floor(getUtcDayStartFromLocalDate(fromDate).getTime() / 1000);
    const to = Math.floor(getUtcDayEndFromLocalDate(toDate).getTime() / 1000);
    return { from, to };
  }, [fromDate, toDate]);

  const applyHistoryLpStartPeriod = async (lpName: string, dateValue: string, options?: { refresh?: boolean }) => {
    const customStartDate = String(dateValue || "").trim();
    const parsedTs = inputDateToUtcEpochSeconds(customStartDate);
    if (!parsedTs) {
      setHistoryError("Invalid Start Period date.");
      return;
    }
    const endpoint = `${BACKEND_BASE_URL}/History/lp-config/${encodeURIComponent(lpName)}`;

    setHistorySavingLp(lpName);
    setHistoryError(null);
    try {
      const resp = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customStartDate: `${customStartDate}T00:00:00Z`,
        }),
      });
      if (!resp.ok) throw new Error(`History lp-config ${resp.status}`);
      setHistoryAggregateData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: (prev.items || []).map((item) => (item.lpName === lpName ? { ...item, effectiveFrom: parsedTs } : item)),
        };
      });
      if (options?.refresh !== false) {
        setHistoryRefreshKey((k) => k + 1);
      }
    } catch (e: any) {
      setHistoryError(e?.message || `Failed to update Start Period for ${lpName}.`);
    } finally {
      setHistorySavingLp((current) => (current === lpName ? null : current));
    }
  };

  const handleHistoryLoad = async () => {
    if (historyTab === "aggregate") {
      const edits = Object.entries(historyStartPeriodEdits).filter(([, value]) => String(value || "").trim().length > 0);
      if (edits.length) {
        for (const [lpName, dateValue] of edits) {
          // Save each LP override first, then refresh once at the end.
          // eslint-disable-next-line no-await-in-loop
          await applyHistoryLpStartPeriod(lpName, dateValue, { refresh: false });
        }
        setHistoryStartPeriodEdits({});
      }
    }
    setHistoryRefreshKey((k) => k + 1);
  };

  useEffect(() => {
    if (activeMenu !== "Dealing") {
      setOverviewError(null);
      return;
    }

    let cancelled = false;

    const loadOverview = async () => {
      setOverviewLoading(true);
      setOverviewError(null);
      try {
        const coverageEndpoint = `${BACKEND_BASE_URL}/Coverage/position-match-table`;
        const metricsDashboardEndpoint = `${BACKEND_BASE_URL}/Metrics/dashboard`;
        const swapEndpoint = `${BACKEND_BASE_URL}/Swap/positions`;
        const historyEndpoint = `${BACKEND_BASE_URL}/History/aggregate?from=${historyTimestamps.from}&to=${historyTimestamps.to}`;

        const [coverageResp, metricsDashboardResp, swapResp, historyResp] = await Promise.allSettled([
          fetch(coverageEndpoint),
          fetch(metricsDashboardEndpoint),
          fetch(swapEndpoint),
          fetch(historyEndpoint),
        ]);

        const nextData: DealingOverviewData = {
          coverage: null,
          lpMetrics: null,
          equitySummary: null,
          swaps: [],
          historyAggregate: null,
        };

        if (coverageResp.status === "fulfilled" && coverageResp.value.ok) {
          nextData.coverage = (await coverageResp.value.json()) as CoverageData;
        }
        if (metricsDashboardResp.status === "fulfilled" && metricsDashboardResp.value.ok) {
          const dashboard = (await metricsDashboardResp.value.json()) as Partial<MetricsData & EquitySummaryData>;
          nextData.lpMetrics = {
            items: Array.isArray(dashboard.items) ? dashboard.items : [],
            totals: {
              equity: Number(dashboard.totals?.equity) || 0,
              realEquity: Number(dashboard.totals?.realEquity) || 0,
              credit: Number(dashboard.totals?.credit) || 0,
              balance: Number(dashboard.totals?.balance) || 0,
              margin: Number(dashboard.totals?.margin) || 0,
              freeMargin: Number(dashboard.totals?.freeMargin) || 0,
            },
          };
          nextData.equitySummary = {
            lpWithdrawableEquity: Number(dashboard.lpWithdrawableEquity) || 0,
            clientWithdrawableEquity: Number(dashboard.clientWithdrawableEquity) || 0,
            difference: Number(dashboard.difference) || 0,
          };
        }
        if (swapResp.status === "fulfilled" && swapResp.value.ok) {
          const data = (await swapResp.value.json()) as SwapPosition[];
          nextData.swaps = Array.isArray(data) ? data : [];
        }
        if (historyResp.status === "fulfilled" && historyResp.value.ok) {
          nextData.historyAggregate = (await historyResp.value.json()) as HistoryAggregateData;
        }

        if (cancelled) return;
        setOverviewData(nextData);
        setOverviewLastUpdated(new Date());

        if (!nextData.coverage && !nextData.lpMetrics && !nextData.equitySummary && nextData.swaps.length === 0 && !nextData.historyAggregate) {
          setOverviewError("Unable to load summary sources.");
        }
      } catch (e: any) {
        if (!cancelled) setOverviewError(e?.message || "Failed to load summary.");
      } finally {
        if (!cancelled) setOverviewLoading(false);
      }
    };

    loadOverview();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, historyTimestamps.from, historyTimestamps.to, refreshKey]);

  const exportHistoryDealsCsv = () => {
    const rows = historyDealsData?.deals || [];
    if (!rows.length) return;

    const headers = [
      "Ticket",
      "Symbol",
      "Time",
      "Direction",
      "Entry",
      "Volume",
      "Price",
      "Contract Size",
      "Market Value",
      "Profit",
      "Commission",
      "Fee",
      "Swap",
      "LP Comm",
      "LP Comm/Lot",
    ];

    const csvRows = [
      headers.join(","),
      ...rows.map((d) =>
        [
          d.dealTicket,
          d.symbol,
          d.timeString,
          d.direction,
          d.entry,
          d.volume,
          d.price,
          d.contractSize,
          d.marketValue,
          d.profit,
          d.commission,
          d.fee,
          d.swap,
          d.lpCommission,
          d.lpCommPerLot,
        ]
          .map(escapeCsv)
          .join(","),
      ),
    ];

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const lp = historyDealsData?.lpName || historySelectedLogin || "lp";
    a.href = url;
    a.download = `history-deals-${lp}-${toYmd(fromDate)}-to-${toYmd(toDate)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const riskRows = useMemo(() => {
    if (!coverageData?.rows) return [] as CoverageRow[];
    const targetGoldSymbols = ["GOLDFT", "XAUUSD"] as const;
    const targetGoldRows = targetGoldSymbols
      .map((symbol) => coverageData.rows.find((row) => String(row.symbol || "").toUpperCase() === symbol))
      .filter((row): row is CoverageRow => Boolean(row));
    const targetGoldSet = new Set(targetGoldSymbols);
    const otherGold = coverageData.rows
      .filter((row) => isGoldSymbol(row.symbol) && !targetGoldSet.has(String(row.symbol || "").toUpperCase() as (typeof targetGoldSymbols)[number]))
      .sort((a, b) => Math.abs(b.uncovered) - Math.abs(a.uncovered));
    const rest = coverageData.rows.filter((row) => !isGoldSymbol(row.symbol)).sort((a, b) => Math.abs(b.uncovered) - Math.abs(a.uncovered));
    const goldSubtotal = targetGoldRows.length
      ? [{
          symbol: "GOLD NET",
          direction: "",
          clientNet: targetGoldRows.reduce((sum, row) => sum + (Number(row.clientNet) || 0), 0),
          uncovered: targetGoldRows.reduce((sum, row) => sum + (Number(row.uncovered) || 0), 0),
          lpNets: (coverageData.lpNames || []).reduce<Record<string, number>>((acc, lp) => {
            acc[lp] = targetGoldRows.reduce((sum, row) => sum + (Number(row.lpNets?.[lp]) || 0), 0);
            return acc;
          }, {}),
          isSubtotalRow: true,
        } satisfies CoverageRow]
      : [];
    return [...targetGoldRows, ...goldSubtotal, ...otherGold, ...rest];
  }, [coverageData]);

  const riskVisibleRows = useMemo(() => {
    if (riskShowZeroData) return riskRows;
    return riskRows.filter((row) => !isZeroish(row.clientNet) || !isZeroish(row.uncovered));
  }, [riskRows, riskShowZeroData]);

  const riskHiddenRowsCount = useMemo(() => {
    if (riskShowZeroData) return 0;
    return Math.max(0, riskRows.length - riskVisibleRows.length);
  }, [riskRows, riskVisibleRows, riskShowZeroData]);

  const riskKpis = useMemo(() => {
    const rows = coverageData?.rows || [];
    const activeLps = coverageData?.lpNames?.length || 0;
    const symbolCount = rows.length;
    const goldRows = rows.filter((row) => isGoldSymbol(row.symbol));
    const nonGoldRows = rows.filter((row) => !isGoldSymbol(row.symbol));
    const goldNetUncovered = goldRows.reduce((sum, row) => sum + row.uncovered, 0);
    const totalUncovered = Math.abs(goldNetUncovered) + nonGoldRows.reduce((sum, row) => sum + Math.abs(row.uncovered), 0);
    let largestSymbol = "-";
    let largestExposure = 0;
    if (Math.abs(goldNetUncovered) > largestExposure) {
      largestExposure = Math.abs(goldNetUncovered);
      largestSymbol = "GOLD (net)";
    }
    nonGoldRows.forEach((row) => {
      const abs = Math.abs(row.uncovered);
      if (abs > largestExposure) {
        largestExposure = abs;
        largestSymbol = row.symbol;
      }
    });
    const clientPositions = Number(coverageData?.totals?.clientPositions || 0);
    const lpPositions = Number(coverageData?.totals?.lpPositions || 0);
    return { activeLps, symbolCount, totalUncovered, largestExposure, largestSymbol, clientPositions, lpPositions };
  }, [coverageData]);

  useEffect(() => {
    if (activeMenu !== "History") {
      setHistoryError(null);
      return;
    }

    const endpoint = `${BACKEND_BASE_URL}/api/LpAccount`;
    let cancelled = false;

    const loadLpAccounts = async () => {
      try {
        const resp = await fetch(endpoint);
        if (!resp.ok) return;
        const data = (await resp.json()) as LpAccount[];
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        setHistoryLpAccounts(list);
        if (!historySelectedLogin && list.length > 0) {
          setHistorySelectedLogin(String(list[0].mt5Login));
        }
      } catch {
        // optional data
      }
    };

    loadLpAccounts();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, historySelectedLogin]);

  useEffect(() => {
    if (activeMenu !== "History") return;

    let cancelled = false;
    const requestKey = `${historyTab}|${historySelectedLogin}|${historyTimestamps.from}|${historyTimestamps.to}|${historyRefreshKey}`;
    const now = Date.now();
    if (historyRequestRef.current.key === requestKey && now - historyRequestRef.current.at < 1200) {
      return;
    }
    historyRequestRef.current = { key: requestKey, at: now };

    const describeRateLimit = (resp: Response, label: string) => {
      if (resp.status !== 429) return `${label} ${resp.status}`;
      const retryAfter = resp.headers.get("Retry-After");
      return retryAfter
        ? `Rate limit reached (429) for ${label}. Retry after ${retryAfter}s.`
        : `Rate limit reached (429) for ${label}. Please wait a few seconds and try again.`;
    };

    const loadHistory = async () => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        if (historyTab === "aggregate") {
          const endpoint = `${BACKEND_BASE_URL}/History/aggregate?from=${historyTimestamps.from}&to=${historyTimestamps.to}`;
          const resp = await fetch(endpoint);
          if (!resp.ok) throw new Error(describeRateLimit(resp, "History aggregate"));
          const data = (await resp.json()) as HistoryAggregateData;
          if (cancelled) return;
          setHistoryAggregateData(data);
          setHistoryLastUpdated(new Date());
          return;
        }

        if (historyTab === "deals") {
          if (!historySelectedLogin) {
            setHistoryDealsData(null);
            return;
          }
          const endpoint = `${BACKEND_BASE_URL}/History/deals?login=${historySelectedLogin}&from=${historyTimestamps.from}&to=${historyTimestamps.to}`;
          const resp = await fetch(endpoint);
          if (!resp.ok) throw new Error(describeRateLimit(resp, "History deals"));
          const data = (await resp.json()) as HistoryDealsData;
          if (cancelled) return;
          setHistoryDealsData(data);
          setHistoryLastUpdated(new Date());
          return;
        }

        const endpoint = `${BACKEND_BASE_URL}/History/volume?from=${historyTimestamps.from}&to=${historyTimestamps.to}`;
        const resp = await fetch(endpoint);
        if (!resp.ok) throw new Error(describeRateLimit(resp, "History volume"));
        const data = (await resp.json()) as HistoryVolumeData;
        if (cancelled) return;
        setHistoryVolumeData(data);
        setHistoryLastUpdated(new Date());
      } catch (e: any) {
        if (!cancelled) setHistoryError(e?.message || "Failed to load history.");
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    };

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, historyTab, historySelectedLogin, historyTimestamps.from, historyTimestamps.to, historyRefreshKey]);

  useEffect(() => {
    if (activeMenu !== "Clients NOP") return;
    let cancelled = false;

    const loadNop = async () => {
      setNopLoading(true);
      setNopError(null);
      try {
        const endpoint = nopSymbol
          ? `/NopReport?symbol=${encodeURIComponent(nopSymbol)}`
          : "/NopReport";
        const resp = await fetch(endpoint);
        if (!resp.ok) throw new Error(`NopReport ${resp.status}`);
        const payload = (await resp.json()) as Partial<NopReportData>;
        const symbols = Array.isArray(payload?.symbols) ? payload.symbols : [];
        const normalized: NopReportData = {
          timestamp: String(payload?.timestamp || new Date().toISOString()),
          accountsReporting: Number(payload?.accountsReporting || 0),
          collectedLogins: Number(payload?.collectedLogins || 0),
          symbols,
        };
        if (cancelled) return;
        setNopData(normalized);
        setNopLastUpdated(new Date());
        setNopSymbolsAll(Array.from(new Set(symbols.map((s) => String(s?.symbol || "")).filter(Boolean))).sort((a, b) => a.localeCompare(b)));
      } catch (e: any) {
        if (!cancelled) setNopError(e?.message || "Failed to load clients NOP.");
      } finally {
        if (!cancelled) setNopLoading(false);
      }
    };

    loadNop();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, nopRefreshKey]);

  useEffect(() => {
    if (activeMenu !== "Bonus") {
      setBonusError(null);
      return;
    }

    const dashboardEndpoint = `${BACKEND_BASE_URL}/Bonus/dashboard`;
    const statusEndpoint = `${BACKEND_BASE_URL}/Bonus/status`;
    const pnlSummaryEndpoint = `${BACKEND_BASE_URL}/Bonus/pnl-summary`;

    let cancelled = false;

    const loadBonus = async () => {
      setBonusLoading(true);
      setBonusError(null);
      try {
        const requests: Promise<Response>[] = [fetch(dashboardEndpoint)];
        if (bonusSubTab === "Bonus Equity") {
          requests.push(fetch(statusEndpoint));
          requests.push(fetch(pnlSummaryEndpoint));
        }
        if (bonusSubTab === "Bonus PNL") {
          requests.push(fetch(pnlSummaryEndpoint));
          const params = new URLSearchParams({
            from: toYmd(fromDate),
            to: toYmd(toDate),
          });
          const pnlSmartEndpoint = `${BACKEND_BASE_URL}/Bonus/pnl-smart?${params}`;
          requests.push(fetch(pnlSmartEndpoint));
        }

        const settled = await Promise.allSettled(requests);
        if (cancelled) return;

        const dashboardResp = settled[0];
        if (dashboardResp.status !== "fulfilled" || !dashboardResp.value.ok) {
          const code = dashboardResp.status === "fulfilled" ? dashboardResp.value.status : "network";
          throw new Error(`Bonus dashboard ${code}`);
        }

        const dashboardJson = (await dashboardResp.value.json()) as BonusDashboardResponse;
        if (cancelled) return;
        setBonusDashboard(dashboardJson || null);

        let ptr = 1;
        if (bonusSubTab === "Bonus Equity") {
          const statusResp = settled[ptr++];
          if (statusResp?.status === "fulfilled" && statusResp.value.ok) {
            setBonusStatus((await statusResp.value.json()) as BonusStatusResponse);
          } else {
            setBonusStatus(null);
          }

          const pnlSummaryResp = settled[ptr++];
          if (pnlSummaryResp?.status === "fulfilled" && pnlSummaryResp.value.ok) {
            setBonusPnlSummary((await pnlSummaryResp.value.json()) as BonusPnlSummaryResponse);
          } else {
            setBonusPnlSummary(null);
          }
        }

        if (bonusSubTab === "Bonus PNL") {
          const pnlSummaryResp = settled[ptr++];
          if (pnlSummaryResp?.status === "fulfilled" && pnlSummaryResp.value.ok) {
            setBonusPnlSummary((await pnlSummaryResp.value.json()) as BonusPnlSummaryResponse);
          } else {
            setBonusPnlSummary(null);
          }

          const pnlSmartResp = settled[ptr++];
          if (pnlSmartResp?.status === "fulfilled" && pnlSmartResp.value.ok) {
            setBonusPnlDaily((await pnlSmartResp.value.json()) as BonusPnlDailyResponse);
            // Background fetch HWM monthly-report for HWM-adjusted values
            setBonusPnlMonthlyReport(null);
            const hwmEndpoint = `${BACKEND_BASE_URL}/Bonus/pnl-monthly-report?from=${toYmd(fromDate)}`;
            fetch(hwmEndpoint)
              .then((r) => (r.ok ? r.json() : null))
              .then((hwmData) => {
                if (!cancelled && hwmData?.months?.length > 0) {
                  setBonusPnlMonthlyReport(hwmData as BonusPnlMonthlyReportResponse);
                }
              })
              .catch(() => undefined);
          } else {
            const code = pnlSmartResp?.status === "fulfilled" ? pnlSmartResp.value.status : "network";
            throw new Error(`Bonus PNL ${code}`);
          }
        } else {
          setBonusPnlDaily(null);
          setBonusPnlMonthlyReport(null);
          if (bonusSubTab !== "Bonus Equity") {
            setBonusPnlSummary(null);
          }
        }

        setBonusLastUpdated(new Date());
      } catch (e: any) {
        if (!cancelled) setBonusError(e?.message || "Failed to load bonus data.");
      } finally {
        if (!cancelled) setBonusLoading(false);
      }
    };

    void loadBonus();
    const iv = bonusSubTab === "Bonus PNL" ? null : setInterval(() => void loadBonus(), 15000);

    return () => {
      cancelled = true;
      if (iv) clearInterval(iv);
    };
  }, [activeMenu, bonusSubTab, bonusRefreshKey, fromDate, toDate]);

  const bonusPositionMatchTable = useMemo(
    () => pickProp<CoverageData | null>(bonusDashboard, "positionMatchTable", "PositionMatchTable", null),
    [bonusDashboard]
  );

  const bonusCoverageRows = useMemo(() => {
    const rows = Array.isArray(bonusPositionMatchTable?.rows) ? bonusPositionMatchTable.rows : [];
    return [...rows]
      .filter((row) => String(row.symbol || "").trim())
      .sort((a, b) => String(a.symbol || "").localeCompare(String(b.symbol || "")));
  }, [bonusPositionMatchTable]);

  const bonusRiskRows = useMemo(() => {
    return [...bonusCoverageRows].sort((a, b) => Math.abs(Number(b.uncovered) || 0) - Math.abs(Number(a.uncovered) || 0));
  }, [bonusCoverageRows]);

  const bonusLpNames = bonusPositionMatchTable?.lpNames || [];
  const bonusTotals = bonusPositionMatchTable?.totals || { clientNet: 0, uncovered: 0, clientPositions: 0, lpPositions: 0, lpNets: {} };

  const bonusRiskTotalUncoveredAbs = useMemo(
    () => bonusRiskRows.reduce((sum, row) => sum + Math.abs(Number(row.uncovered) || 0), 0),
    [bonusRiskRows]
  );

  const bonusRiskUncoveredSymbols = useMemo(
    () => bonusRiskRows.filter((row) => Math.abs(Number(row.uncovered) || 0) > 0.001).length,
    [bonusRiskRows]
  );

  const bonusRiskLargest = bonusRiskRows[0] || null;

  const bonusEquityClient = bonusDashboard?.equity?.client || {};
  const bonusEquityLp = bonusDashboard?.equity?.lp || {};
  const bonusEquityClientAccounts = Array.isArray(bonusEquityClient.accounts) ? bonusEquityClient.accounts : [];
  const bonusEquityVisibleAccounts = useMemo(
    () => bonusEquityClientAccounts.filter((account) => Math.abs(Number(account?.equity) || 0) > 0),
    [bonusEquityClientAccounts]
  );

  const bonusEquityClientWithdrawable = useMemo(() => {
    return bonusEquityClientAccounts.reduce((sum, account) => {
      const balance = Number(account?.balance) || 0;
      if (balance < 0) return sum;
      const equity = Number(account?.equity) || 0;
      const credit = Number(account?.credit) || 0;
      return sum + (equity - credit);
    }, 0);
  }, [bonusEquityClientAccounts]);

  const bonusEquityLpWithdrawable = Number(bonusEquityLp.equity) || 0;
  const bonusEquityWithdrawableDifference = bonusEquityLpWithdrawable - bonusEquityClientWithdrawable;

  const bonusClientMarginLevel = useMemo(() => {
    const totalMargin = Number(bonusEquityClient.totalMargin) || 0;
    const totalEquity = Number(bonusEquityClient.totalEquity) || 0;
    if (totalMargin <= 0) return null;
    return (totalEquity / totalMargin) * 100;
  }, [bonusEquityClient.totalMargin, bonusEquityClient.totalEquity]);

  const bonusPnlClient = bonusPnlDaily?.client || {};
  const bonusPnlLp = bonusPnlDaily?.lp || {};
  const bonusPnlCost = bonusPnlDaily?.cost || {};

  const summaryCards = useMemo(() => {
    if (activeMenu === "Rebate Calculator") {
      const totals = rebateCalcRows.reduce(
        (acc, row) => {
          return {
            trades: acc.trades + row.trades,
            tradedLots: acc.tradedLots + row.tradedLots,
            eligibleLots: acc.eligibleLots + row.eligibleLots,
            ineligibleLots: acc.ineligibleLots + row.ineligibleLots,
            totalCommission: acc.totalCommission + row.mt5CommissionUsd,
          };
        },
        { trades: 0, tradedLots: 0, eligibleLots: 0, ineligibleLots: 0, totalCommission: 0 },
      );
      return [
        { label: "Logins", value: rebateLoginsCount.toLocaleString() },
        { label: "Symbol Rows", value: rebateCalcRows.length.toLocaleString() },
        { label: "Trades", value: totals.trades.toLocaleString() },
        { label: "Traded Lots", value: totals.tradedLots.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
        { label: "Eligible Lots", value: totals.eligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
        { label: "Non-Eligible Lots", value: totals.ineligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
        { label: "MT5 Commission", value: `$${totals.totalCommission.toLocaleString(undefined, { maximumFractionDigits: 2 })}` },
      ];
    }

    if (activeMenu === "Coverage") {
      const rows = coverageData?.rows || [];
      const goldCount = rows.filter((r) => isGoldSymbol(r.symbol)).length;
      return [
        { label: "LPs", value: (coverageData?.lpNames?.length || 0).toLocaleString() },
        { label: "Symbols", value: rows.length.toLocaleString() },
        { label: "Gold Symbols", value: goldCount.toLocaleString() },
        { label: "Total Uncovered", value: (coverageData?.totals?.uncovered || 0).toFixed(2) },
      ];
    }

    if (activeMenu === "Risk Exposure") {
      return [
        { label: "Active LPs", value: riskKpis.activeLps.toLocaleString() },
        { label: "Symbols", value: riskKpis.symbolCount.toLocaleString() },
        { label: "Client Positions", value: riskKpis.clientPositions.toLocaleString() },
        { label: "LP Positions", value: riskKpis.lpPositions.toLocaleString() },
        { label: "Total Uncovered", value: riskKpis.totalUncovered.toFixed(2) },
        { label: "Largest Exposure", value: riskKpis.largestExposure > 0 ? `${riskKpis.largestExposure.toFixed(2)} (${riskKpis.largestSymbol})` : "-" },
      ];
    }

    if (activeMenu === "Metrics") {
      return [];
    }

    if (activeMenu === "Equity Overview") {
      return [];
    }

    if (activeMenu === "Bonus") {
      if (bonusSubTab === "Bonus Coverage") {
        return [
          { label: "LPs", value: String(bonusPositionMatchTable?.lpNames?.length || 0) },
          { label: "Symbols", value: String(bonusCoverageRows.length) },
          { label: "Client Net", value: (Number(bonusPositionMatchTable?.totals?.clientNet || 0)).toFixed(2) },
          { label: "Uncovered", value: (Number(bonusPositionMatchTable?.totals?.uncovered || 0)).toFixed(2) },
        ];
      }

      if (bonusSubTab === "Bonus Risk") {
        const totalUncovered = bonusRiskRows.reduce((sum, row) => sum + Math.abs(Number(row.uncovered) || 0), 0);
        const largest = bonusRiskRows[0];
        return [
          { label: "LPs", value: String(bonusPositionMatchTable?.lpNames?.length || 0) },
          { label: "Symbols", value: String(bonusRiskRows.length) },
          { label: "Total Uncovered", value: totalUncovered.toFixed(2) },
          { label: "Largest Exposure", value: largest ? `${largest.symbol} (${Math.abs(Number(largest.uncovered) || 0).toFixed(2)})` : "-" },
        ];
      }

      if (bonusSubTab === "Bonus PNL") {
        return [
          { label: "Gross PnL", value: formatMaybeNumber(bonusPnlDaily?.grossPnl, 2) },
          { label: "Client Total", value: formatMaybeNumber(bonusPnlDaily?.client?.total, 2) },
          { label: "LP Total", value: formatMaybeNumber(bonusPnlDaily?.lp?.total, 2) },
          { label: "LP Receivable", value: formatMaybeNumber(bonusPnlSummary?.lpReceivable, 2) },
        ];
      }

      const bonusClient = bonusDashboard?.equity?.client || {};
      const bonusLp = bonusDashboard?.equity?.lp || {};
      return [
        { label: "Client Equity", value: formatMaybeNumber(bonusClient.totalEquity, 2) },
        { label: "LP Equity", value: formatMaybeNumber(bonusLp.equity, 2) },
        { label: "Difference", value: formatMaybeNumber(bonusDashboard?.equity?.difference, 2) },
        { label: "LP Receivable", value: formatMaybeNumber(bonusPnlSummary?.lpReceivable, 2) },
      ];
    }

    if (activeMenu === "Contract Sizes") {
      const total = contractSizes.length;
      const avgMultiplier = total
        ? contractSizes.reduce((sum, item) => sum + (Number.isFinite(item.multiplier) ? item.multiplier : 0), 0) / total
        : 0;
      return [
        { label: "Multipliers", value: total.toLocaleString() },
        { label: "Avg Multiplier", value: avgMultiplier.toFixed(4) },
        { label: "Max Multiplier", value: (total ? Math.max(...contractSizes.map((item) => Number(item.multiplier) || 0)) : 0).toFixed(4) },
        { label: "Min Multiplier", value: (total ? Math.min(...contractSizes.map((item) => Number(item.multiplier) || 0)) : 0).toFixed(4) },
      ];
    }

    if (activeMenu === "Swap Tracker") {
      const total = swapRows.length;
      const chargeTonight = swapRows.filter((r) => r.willChargeTonight).length;
      const totalSwap = swapRows.reduce((sum, row) => sum + (Number.isFinite(row.swap) ? row.swap : 0), 0);
      const avgDaysLeft = total > 0 ? swapRows.reduce((sum, row) => sum + (Number.isFinite(row.daysLeft) ? row.daysLeft : 0), 0) / total : 0;
      return [
        { label: "Positions", value: total.toLocaleString() },
        { label: "Charge Tonight", value: chargeTonight.toLocaleString() },
        { label: "Total Swap", value: totalSwap.toFixed(2) },
        { label: "Avg Days Left", value: avgDaysLeft.toFixed(1) },
      ];
    }

    if (activeMenu === "History") {
      if (historyTab === "aggregate") {
        const totals = historyAggregateVisibleTotals;
        return [
          { label: "LP Rows", value: historyAggregateVisibleItems.length.toLocaleString() },
          { label: "Net P/L", value: totals ? totals.netPL.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "-" },
          { label: "Real LP P/L", value: totals ? totals.realLpPL.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "-" },
          { label: "Rev Share P/L", value: totals ? totals.lpPL.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "-" },
        ];
      }
      if (historyTab === "deals") {
        const deals = historyDealsData?.deals || [];
        const volume = deals.reduce((sum, d) => sum + (Number.isFinite(d.volume) ? d.volume : 0), 0);
        const pnl = deals.reduce((sum, d) => sum + (Number.isFinite(d.profit) ? d.profit : 0), 0);
        return [
          { label: "LP", value: historyDealsData?.lpName || "-" },
          { label: "Deals", value: (historyDealsData?.totalDeals || 0).toLocaleString() },
          { label: "Total Volume", value: volume.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
          { label: "Total Profit", value: pnl.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
        ];
      }
      return [
        { label: "LP Rows", value: (historyVolumeData?.items?.length || 0).toLocaleString() },
        { label: "Trade Count", value: (historyVolumeData?.totals?.tradeCount || 0).toLocaleString() },
        { label: "Total Lots", value: (historyVolumeData?.totals?.totalLots || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) },
        { label: "Volume (Yards)", value: (historyVolumeData?.totals?.volumeYards || 0).toLocaleString(undefined, { maximumFractionDigits: 4 }) },
      ];
    }

    if (activeMenu === "Clients NOP") {
      return [];
    }

    if (activeMenu === "Deal Matching") {
      return [];
    }

    return [
      { label: "Swap Due Tonight", value: overviewData.swaps.filter((row) => row.willChargeTonight).length.toLocaleString() },
      { label: "LP Withdrawable Equity", value: formatDollar(overviewData.equitySummary?.lpWithdrawableEquity || 0) },
      { label: "Client Withdrawable Equity", value: formatDollar(overviewData.equitySummary?.clientWithdrawableEquity || 0) },
      { label: "LP-Client WD Equity Difference", value: formatDollar(overviewData.equitySummary?.difference || 0) },
    ];
  }, [activeMenu, coverageData, riskKpis, metricsData, swapRows, metrics, historyTab, historyAggregateData, historyAggregateVisibleItems, historyAggregateVisibleTotals, historyDealsData, historyVolumeData, overviewData, rebateCalcRows, rebateLoginsCount, nopData, contractSizes, bonusSubTab, bonusPositionMatchTable, bonusCoverageRows, bonusRiskRows, bonusPnlDaily, bonusPnlSummary, bonusDashboard]);

  const rebateSymbolTotals = useMemo(() => {
    const bySymbol = new Map<
      string,
      { symbol: string; trades: number; tradedLots: number; eligibleLots: number; ineligibleLots: number; commission: number }
    >();
    rebateCalcRows.forEach((row) => {
      const existing = bySymbol.get(row.symbol);
      if (!existing) {
        bySymbol.set(row.symbol, {
          symbol: row.symbol,
          trades: row.trades,
          tradedLots: row.tradedLots,
          eligibleLots: row.eligibleLots,
          ineligibleLots: row.ineligibleLots,
          commission: row.mt5CommissionUsd,
        });
        return;
      }
      existing.trades += row.trades;
      existing.tradedLots += row.tradedLots;
      existing.eligibleLots += row.eligibleLots;
      existing.ineligibleLots += row.ineligibleLots;
      existing.commission += row.mt5CommissionUsd;
    });
    return Array.from(bySymbol.values()).sort((a, b) => b.commission - a.commission);
  }, [rebateCalcRows]);

  const rebateCalcTotals = useMemo(
    () =>
      rebateCalcRows.reduce(
        (acc, row) => ({
          trades: acc.trades + row.trades,
          tradedLots: acc.tradedLots + row.tradedLots,
          eligibleLots: acc.eligibleLots + row.eligibleLots,
          ineligibleLots: acc.ineligibleLots + row.ineligibleLots,
          commission: acc.commission + row.mt5CommissionUsd,
        }),
        { trades: 0, tradedLots: 0, eligibleLots: 0, ineligibleLots: 0, commission: 0 }
      ),
    [rebateCalcRows]
  );

  const riskCoverageRows = useMemo(() => {
    const coverageRows = Array.isArray(overviewData.coverage?.rows) ? overviewData.coverage.rows : [];
    const coverageMap = new Map(
      coverageRows.map((row) => [normalizeSymbol(row.symbol), { uncovered: Number(row.uncovered) || 0, clientNet: Number(row.clientNet) || 0 }]),
    );
    const isGoldPriority = (symbol: string) => {
      const s = String(symbol || "").toUpperCase();
      return s === "XAUUSD" || s.includes("GOLD");
    };

    const toDisplayRow = (row: SymbolActivity) => {
      const coverage = coverageMap.get(normalizeSymbol(row.symbol)) || { uncovered: 0, clientNet: 0 };
      return {
        symbol: row.symbol,
        positions: row.positions,
        lots: row.netExposureLots,
        uncovered: coverage.uncovered,
        clientNet: coverage.clientNet,
        subSymbols: row.subSymbols || [],
      };
    };

    const source = [...topSymbols];
    const priority = source.filter((r) => isGoldPriority(r.symbol)).map(toDisplayRow);
    const others = source
      .filter((r) => !isGoldPriority(r.symbol))
      .sort((a, b) => Math.abs(b.netExposureLots) - Math.abs(a.netExposureLots))
      .slice(0, 3)
      .map(toDisplayRow);
    return [...priority, ...others];
  }, [overviewData.coverage?.rows, topSymbols]);

  const riskCoverageSummary = useMemo(() => {
    const symbols = riskCoverageRows.length;
    const totalAbsoluteUncovered = riskCoverageRows.reduce((sum, row) => sum + Math.abs(Number(row.uncovered) || 0), 0);
    const totalAbsoluteClientNet = riskCoverageRows.reduce((sum, row) => sum + Math.abs(Number(row.clientNet) || 0), 0);
    const totalAbsoluteLpCoverage = riskCoverageRows.reduce(
      (sum, row) => sum + Math.abs((Number(row.clientNet) || 0) - (Number(row.uncovered) || 0)),
      0,
    );
    const worstRow = riskCoverageRows.reduce<(typeof riskCoverageRows)[number] | null>((current, row) => {
      if (!current) return row;
      return Math.abs(Number(row.uncovered) || 0) > Math.abs(Number(current.uncovered) || 0) ? row : current;
    }, null);
    const goldWatchCount = riskCoverageRows.filter((row) => isGoldSymbol(row.symbol)).length;
    const coveragePct = totalAbsoluteClientNet > 0 ? Math.min((totalAbsoluteLpCoverage / totalAbsoluteClientNet) * 100, 999) : 0;
    return {
      symbols,
      goldWatchCount,
      totalAbsoluteUncovered,
      totalAbsoluteLpCoverage,
      coveragePct,
      worstSymbol: worstRow?.symbol || "-",
      worstUncovered: Number(worstRow?.uncovered) || 0,
    };
  }, [riskCoverageRows]);

  const coverageTableRows = useMemo(() => [...coverageRows.gold, ...coverageRows.rest], [coverageRows]);

  const coverageHiddenRowsCount = useMemo(() => {
    if (!coverageData?.rows?.length) return 0;
    return Math.max(coverageData.rows.length - coverageTableRows.length, 0);
  }, [coverageData, coverageTableRows]);

  const coverageHiddenLpColumnsCount = useMemo(() => {
    if (!coverageData?.lpNames?.length) return 0;
    return Math.max(coverageData.lpNames.length - visibleCoverageLpNames.length, 0);
  }, [coverageData, visibleCoverageLpNames]);

  const coverageHasHiddenZeroData = coverageHiddenRowsCount > 0 || coverageHiddenLpColumnsCount > 0;

  const coverageHiddenZeroDataLabel = useMemo(() => {
    const parts: string[] = [];
    if (coverageHiddenRowsCount > 0) {
      parts.push(`${coverageHiddenRowsCount} row${coverageHiddenRowsCount === 1 ? "" : "s"}`);
    }
    if (coverageHiddenLpColumnsCount > 0) {
      parts.push(`${coverageHiddenLpColumnsCount} LP column${coverageHiddenLpColumnsCount === 1 ? "" : "s"}`);
    }
    return parts.join(", ");
  }, [coverageHiddenRowsCount, coverageHiddenLpColumnsCount]);

  const coverageTableColumns = useMemo<SortableTableColumn<CoverageRow>[]>(() => {
    const lpNames = visibleCoverageLpNames;
    const base: SortableTableColumn<CoverageRow>[] = [
      {
        key: "symbol",
        label: "Symbol",
        hideable: false,
        sortValue: (row) => row.symbol,
        searchValue: (row) => row.symbol,
        cellClassName: "font-mono text-slate-900 dark:text-slate-100",
        render: (row) => row.symbol,
      },
      {
        key: "direction",
        label: "Buy/Sell",
        sortValue: (row) => row.direction || "",
        searchValue: (row) => row.direction || "",
        render: (row) =>
          row.direction === "BUY" ? (
            <span className="font-semibold text-emerald-700 dark:text-emerald-300">BUY</span>
          ) : row.direction === "SELL" ? (
            <span className="font-semibold text-rose-700 dark:text-rose-300">SELL</span>
          ) : (
            <span className="text-slate-500">-</span>
          ),
      },
      {
        key: "clientNet",
        label: "Client Net",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => Number(row.clientNet) || 0,
        searchValue: (row) => String(row.clientNet),
        render: (row) => (
          <>
            {formatCoverageVal(row.clientNet)}
            {renderContractSizeBadge(row.contractSizeMultiplier)}
          </>
        ),
      },
      {
        key: "uncovered",
        label: "Uncovered",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => Number(row.uncovered) || 0,
        searchValue: (row) => String(row.uncovered),
        render: (row) => formatCoverageVal(row.uncovered),
      },
    ];

    const dynamicLpCols: SortableTableColumn<CoverageRow>[] = lpNames.map((lp) => ({
      key: `lp_${lp}`,
      label: lp,
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (row) => Number(row.lpNets?.[lp]) || 0,
      searchValue: (row) => String(row.lpNets?.[lp] || 0),
      render: (row) => formatCoverageVal(row.lpNets?.[lp] || 0),
    }));

    return [...base, ...dynamicLpCols];
  }, [visibleCoverageLpNames]);

  const riskTableColumns = useMemo<SortableTableColumn<CoverageRow>[]>(
    () => [
      {
        key: "symbol",
        label: "Symbol",
        hideable: false,
        sortValue: (row) => row.symbol,
        searchValue: (row) => row.symbol,
        cellClassName: "font-mono text-slate-900 dark:text-slate-100",
        render: (row) =>
          row.isSubtotalRow ? (
            <span className="inline-flex items-center rounded-md bg-amber-200/70 px-2 py-1 font-sans text-[11px] font-bold uppercase tracking-wide text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
              Gold Net
            </span>
          ) : (
            row.symbol
          ),
      },
      {
        key: "direction",
        label: "Direction",
        sortValue: (row) => row.direction || "",
        searchValue: (row) => row.direction || "",
        render: (row) =>
          row.isSubtotalRow ? (
            <span className="text-amber-700 dark:text-amber-300">GOLDFT + XAUUSD</span>
          ) : row.direction === "BUY" ? (
            <span className="font-semibold text-emerald-700 dark:text-emerald-300">BUY</span>
          ) : row.direction === "SELL" ? (
            <span className="font-semibold text-rose-700 dark:text-rose-300">SELL</span>
          ) : (
            <span className="text-slate-500">-</span>
          ),
      },
      {
        key: "clientNet",
        label: "Client Net",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => Number(row.clientNet) || 0,
        searchValue: (row) => String(row.clientNet),
        render: (row) => (
          <>
            {formatCoverageVal(row.clientNet)}
            {!row.isSubtotalRow ? renderContractSizeBadge(row.contractSizeMultiplier) : null}
          </>
        ),
      },
      {
        key: "lpCoverage",
        label: "LP Coverage",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (Number(row.clientNet) || 0) - (Number(row.uncovered) || 0),
        searchValue: (row) => String((Number(row.clientNet) || 0) - (Number(row.uncovered) || 0)),
        render: (row) => formatCoverageVal((Number(row.clientNet) || 0) - (Number(row.uncovered) || 0)),
      },
      {
        key: "uncovered",
        label: "Uncovered",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => Number(row.uncovered) || 0,
        searchValue: (row) => String(row.uncovered),
        render: (row) => formatCoverageVal(row.uncovered),
      },
      {
        key: "coveragePct",
        label: "Coverage %",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => {
          const clientNet = Number(row.clientNet) || 0;
          if (clientNet === 0) return NaN;
          return ((clientNet - (Number(row.uncovered) || 0)) / clientNet) * 100;
        },
        searchValue: (row) => {
          const clientNet = Number(row.clientNet) || 0;
          if (clientNet === 0) return "-";
          return (((clientNet - (Number(row.uncovered) || 0)) / clientNet) * 100).toFixed(1);
        },
        render: (row) => {
          const clientNet = Number(row.clientNet) || 0;
          const pct = clientNet === 0 ? NaN : ((clientNet - (Number(row.uncovered) || 0)) / clientNet) * 100;
          return <span className={formatPctClass(pct)}>{Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "-"}</span>;
        },
      },
    ],
    []
  );

  const metricsTableColumns = useMemo<SortableTableColumn<MetricsItem>[]>(
    () => [
      {
        key: "lp",
        label: "LP",
        hideable: false,
        sortValue: (row) => row.lp,
        searchValue: (row) => `${row.lp} ${row.login}`,
        cellClassName: "font-mono text-slate-900 dark:text-slate-100",
        render: (row) => row.lp,
      },
      {
        key: "login",
        label: "Login",
        sortValue: (row) => String(row.login),
        searchValue: (row) => String(row.login),
        cellClassName: "text-slate-500 dark:text-slate-400",
        render: (row) => row.login,
      },
      { key: "equity", label: "Equity", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.equity, searchValue: (row) => String(row.equity), render: (row) => formatDollar(row.equity) },
      { key: "realEquity", label: "Real Equity", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.realEquity, searchValue: (row) => String(row.realEquity), render: (row) => formatDollar(row.realEquity) },
      { key: "credit", label: "Credit", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.credit, searchValue: (row) => String(row.credit), render: (row) => formatDollar(row.credit) },
      { key: "balance", label: "Balance", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.balance, searchValue: (row) => String(row.balance), render: (row) => formatDollar(row.balance) },
      { key: "margin", label: "Margin", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.margin, searchValue: (row) => String(row.margin), render: (row) => formatDollar(row.margin) },
      { key: "freeMargin", label: "Free Margin", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.freeMargin, searchValue: (row) => String(row.freeMargin), render: (row) => formatDollar(row.freeMargin) },
      {
        key: "marginLevel",
        label: "Margin Level %",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => row.marginLevel,
        searchValue: (row) => String(row.marginLevel),
        render: (row) => (
          <span
            className={
              row.marginLevel === 0
                ? "text-slate-500"
                : row.marginLevel >= 100
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-rose-700 dark:text-rose-300"
            }
          >
            {row.marginLevel.toFixed(2)}%
          </span>
        ),
      },
    ],
    []
  );

  const historyDealsColumns = useMemo<SortableTableColumn<HistoryDeal>[]>(
    () => [
      { key: "dealTicket", label: "Ticket", hideable: false, sortValue: (row) => Number(row.dealTicket) || 0, searchValue: (row) => String(row.dealTicket), render: (row) => row.dealTicket },
      { key: "symbol", label: "Symbol", sortValue: (row) => row.symbol, searchValue: (row) => row.symbol, cellClassName: "font-mono", render: (row) => row.symbol },
      { key: "timeString", label: "Time", sortValue: (row) => row.timeString, searchValue: (row) => row.timeString, cellClassName: "text-slate-500 dark:text-slate-400", render: (row) => row.timeString },
      { key: "direction", label: "Direction", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.direction, searchValue: (row) => row.direction, render: (row) => <span className={row.direction === "Buy" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>{row.direction}</span> },
      { key: "entry", label: "Entry", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.entry, searchValue: (row) => row.entry, render: (row) => row.entry },
      { key: "volume", label: "Volume", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.volume, searchValue: (row) => String(row.volume), render: (row) => row.volume.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
      { key: "price", label: "Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.price, searchValue: (row) => String(row.price), render: (row) => row.price.toLocaleString(undefined, { maximumFractionDigits: 5 }) },
      { key: "contractSize", label: "Contract Size", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.contractSize, searchValue: (row) => String(row.contractSize), render: (row) => row.contractSize.toLocaleString() },
      { key: "marketValue", label: "Market Value", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.marketValue, searchValue: (row) => String(row.marketValue), render: (row) => row.marketValue.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
      { key: "profit", label: "Profit", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.profit, searchValue: (row) => String(row.profit), render: (row) => <span className={signedValueClass(row.profit)}>{row.profit.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> },
      { key: "commission", label: "Commission", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.commission, searchValue: (row) => String(row.commission), render: (row) => <span className={signedValueClass(row.commission)}>{row.commission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> },
      { key: "fee", label: "Fee", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.fee, searchValue: (row) => String(row.fee), render: (row) => <span className={signedValueClass(row.fee)}>{row.fee.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> },
      { key: "swap", label: "Swap", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.swap, searchValue: (row) => String(row.swap), render: (row) => <span className={signedValueClass(row.swap)}>{row.swap.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> },
      { key: "lpCommission", label: "LP Comm", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.lpCommission, searchValue: (row) => String(row.lpCommission), render: (row) => row.lpCommission.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
      { key: "lpCommPerLot", label: "LP Comm/Lot", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.lpCommPerLot, searchValue: (row) => String(row.lpCommPerLot), render: (row) => row.lpCommPerLot.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
    ],
    []
  );

  const historyVolumeColumns = useMemo<SortableTableColumn<HistoryVolumeItem>[]>(
    () => [
      { key: "lpName", label: "LP Name", hideable: false, sortValue: (row) => row.lpName, searchValue: (row) => row.lpName, cellClassName: "font-mono", render: (row) => row.lpName },
      { key: "login", label: "Login", sortValue: (row) => String(row.login), searchValue: (row) => String(row.login), render: (row) => row.login },
      { key: "source", label: "Source", sortValue: (row) => row.source || "", searchValue: (row) => row.source || "", cellClassName: "text-slate-500 dark:text-slate-400", render: (row) => row.source || "-" },
      { key: "tradeCount", label: "Trade Count", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.tradeCount, searchValue: (row) => String(row.tradeCount), render: (row) => row.tradeCount.toLocaleString() },
      { key: "totalLots", label: "Total Lots", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.totalLots, searchValue: (row) => String(row.totalLots), render: (row) => row.totalLots.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
      { key: "notionalUsd", label: "Notional (USD)", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.notionalUsd, searchValue: (row) => String(row.notionalUsd), render: (row) => row.notionalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
      { key: "volumeYards", label: "Volume (Yards)", headerClassName: "text-right", cellClassName: "text-right", sortValue: (row) => row.volumeYards, searchValue: (row) => String(row.volumeYards), render: (row) => row.volumeYards.toLocaleString(undefined, { maximumFractionDigits: 4 }) },
    ],
    []
  );

  const historyAggregateColumns = useMemo<SortableTableColumn<HistoryAggregateItem>[]>(
    () => [
      {
        key: "lpName",
        label: "LP Name",
        hideable: false,
        sortValue: (row) => row.lpName,
        searchValue: (row) => `${row.lpName} ${row.login} ${row.source || ""}`,
        cellClassName: "font-mono text-slate-900 dark:text-slate-100",
        render: (row) => row.lpName,
      },
      {
        key: "login",
        label: "Login",
        sortValue: (row) => String(row.login),
        searchValue: (row) => String(row.login),
        render: (row) => row.login,
      },
      {
        key: "source",
        label: "Source",
        sortValue: (row) => row.source || "",
        searchValue: (row) => row.source || "",
        cellClassName: "text-slate-500 dark:text-slate-400",
        render: (row) => row.source || "-",
      },
      {
        key: "startPeriod",
        label: "Start Period",
        sortValue: (row) => Number(row.effectiveFrom) || 0,
        searchValue: (row) =>
          (historyStartPeriodEdits[row.lpName] ?? epochSecondsToInputDate(row.effectiveFrom ?? historyTimestamps.from)) || toYmd(fromDate),
        render: (row) =>
          row.isError ? (
            <span className="text-rose-700 dark:text-rose-300">{row.errorMessage || "Error"}</span>
          ) : (
            <input
              type="date"
              value={(historyStartPeriodEdits[row.lpName] ?? epochSecondsToInputDate(row.effectiveFrom ?? historyTimestamps.from)) || toYmd(fromDate)}
              onChange={(e) =>
                setHistoryStartPeriodEdits((prev) => ({
                  ...prev,
                  [row.lpName]: e.target.value,
                }))
              }
              disabled={historySavingLp === row.lpName}
              className="w-[132px] rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
            />
          ),
      },
      {
        key: "startEquity",
        label: "Start Equity",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.startEquity),
        searchValue: (row) => String(row.startEquity || ""),
        render: (row) => (row.isError ? "-" : row.startEquity.toLocaleString()),
      },
      {
        key: "endEquity",
        label: "End Equity",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.endEquity),
        searchValue: (row) => String(row.endEquity || ""),
        render: (row) => (row.isError ? "-" : row.endEquity.toLocaleString()),
      },
      {
        key: "credit",
        label: "Credit",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.credit),
        searchValue: (row) => String(row.credit || ""),
        render: (row) => (row.isError ? "-" : row.credit.toLocaleString()),
      },
      {
        key: "deposit",
        label: "Deposit",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.deposit),
        searchValue: (row) => String(row.deposit || ""),
        render: (row) => (row.isError ? "-" : <span className={signedValueClass(row.deposit)}>{row.deposit.toLocaleString()}</span>),
      },
      {
        key: "withdrawal",
        label: "Withdrawal",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.withdrawal),
        searchValue: (row) => String(row.withdrawal || ""),
        render: (row) => (row.isError ? "-" : <span className={signedValueClass(row.withdrawal)}>{row.withdrawal.toLocaleString()}</span>),
      },
      {
        key: "netDeposits",
        label: "Net Deposits",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.netDeposits),
        searchValue: (row) => String(row.netDeposits || ""),
        render: (row) => (row.isError ? "-" : <span className={signedValueClass(row.netDeposits)}>{row.netDeposits.toLocaleString()}</span>),
      },
      {
        key: "grossProfit",
        label: "Gross P/L",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.grossProfit),
        searchValue: (row) => String(row.grossProfit || ""),
        render: (row) => (row.isError ? "-" : <span className={signedValueClass(row.grossProfit)}>{row.grossProfit.toLocaleString()}</span>),
      },
      {
        key: "totalCommission",
        label: "Commission",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.totalCommission),
        searchValue: (row) => String(row.totalCommission || ""),
        render: (row) => (row.isError ? "-" : <span className={signedValueClass(row.totalCommission)}>{row.totalCommission.toLocaleString()}</span>),
      },
      {
        key: "totalSwap",
        label: "Swap",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.totalSwap),
        searchValue: (row) => String(row.totalSwap || ""),
        render: (row) => (row.isError ? "-" : <span className={signedValueClass(row.totalSwap)}>{row.totalSwap.toLocaleString()}</span>),
      },
      {
        key: "netPL",
        label: "Net P/L",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.netPL),
        searchValue: (row) => String(row.netPL || ""),
        render: (row) => (row.isError ? "-" : <span className={signedValueClass(row.netPL)}>{row.netPL.toLocaleString()}</span>),
      },
      {
        key: "realLpPL",
        label: "Real LP P/L",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.realLpPL),
        searchValue: (row) => String(row.realLpPL || ""),
        render: (row) => (row.isError ? "-" : <span className={signedValueClass(row.realLpPL)}>{row.realLpPL.toLocaleString()}</span>),
      },
      {
        key: "ntpPercent",
        label: "NTP %",
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.ntpPercent),
        searchValue: (row) => String(row.ntpPercent || ""),
        render: (row) => (row.isError ? "-" : <span className="text-amber-700 dark:text-amber-300">{row.ntpPercent.toFixed(1)}%</span>),
      },
      {
        key: "lpPL",
        label: "LP P/L (Rev Share)",
        headerClassName: "sticky right-0 z-20 bg-cyan-100 text-right text-cyan-900 shadow-[-10px_0_14px_-12px_rgba(8,145,178,0.65)] dark:bg-cyan-950 dark:text-cyan-100",
        cellClassName: "sticky right-0 z-10 bg-cyan-50/95 text-right font-semibold shadow-[-10px_0_14px_-12px_rgba(8,145,178,0.45)] dark:bg-cyan-950/95",
        sortValue: (row) => (row.isError ? Number.NEGATIVE_INFINITY : row.lpPL),
        searchValue: (row) => String(row.lpPL || ""),
        render: (row) => {
          if (row.isError) return "-";
          const value = Number(row.lpPL) || 0;
          const toneClass =
            value > 0.005
              ? "border-emerald-300/70 bg-emerald-500/15 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-200"
              : value < -0.005
                ? "border-rose-300/70 bg-rose-500/15 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/20 dark:text-rose-200"
                : "border-cyan-300/70 bg-cyan-500/15 text-cyan-800 dark:border-cyan-500/40 dark:bg-cyan-500/20 dark:text-cyan-200";
          return (
            <span className={`inline-flex min-w-[110px] items-center justify-end rounded-md border px-2.5 py-1 tabular-nums ${toneClass}`}>
              {value.toLocaleString()}
            </span>
          );
        },
      },
    ],
    [fromDate, historySavingLp, historyStartPeriodEdits, historyTimestamps.from]
  );

  useEffect(() => {
    if (activeMenu !== "Dealing" || liveEnabledEvents.length === 0) {
      if (liveAlertsSignalRRef.current) {
        liveAlertsSignalRRef.current.disconnect().catch(() => undefined);
        liveAlertsSignalRRef.current = null;
      }
      return;
    }

    if (liveAlertsSignalRRef.current) {
      liveAlertsSignalRRef.current.disconnect().catch(() => undefined);
      liveAlertsSignalRRef.current = null;
    }

    const { hubUrl, tokenUrls } = getAlertsHubConfig();
    const manager = new SignalRConnectionManager({
      hubUrl,
      trackedEvents: liveEnabledEvents,
      accessTokenFactory: async () => {
        if (tokenUrls.length === 0) return null;
        for (const tokenUrl of tokenUrls) {
          try {
            const res = await fetch(tokenUrl);
            if (!res.ok) continue;
            const j = await res.json();
            if (j?.token) return j.token;
          } catch {
            // Try next token URL.
          }
        }
        return null;
      },
    });

    const unsubEvent = manager.onEvent((payload: unknown, eventName: string) => {
      if (!ALERT_EVENT_SET.has(eventName)) return;
      const key = eventName as AlertEventKey;
      if (!livePrefsRef.current[key]) return;

      const now = Date.now();
      const sig = `${eventName}:${JSON.stringify(payload ?? {})}`;
      const last = liveAlertDedupRef.current[sig] || 0;
      if (now - last < 800) return;
      liveAlertDedupRef.current[sig] = now;

      const meta = ALERT_EVENT_META[key];
      const item: LiveNotification = {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        type: alertTypeForEvent(key),
        eventName: key,
        title: meta?.title || key,
        message: buildAlertDescription(key, payload as any),
        at: new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      };
      setLiveNotifications((prev) => [item, ...prev].slice(0, 50));
    });

    manager.connect().catch(() => undefined);
    liveAlertsSignalRRef.current = manager;

    return () => {
      unsubEvent();
      manager.disconnect().catch(() => undefined);
      if (liveAlertsSignalRRef.current === manager) {
        liveAlertsSignalRRef.current = null;
      }
    };
  }, [activeMenu, liveEnabledEvents]);

  return (
    !allowedMenuItems.length ? (
      <UnauthorizedPage title="No Dealing Tabs Authorized" />
    ) : (
    <div ref={dealingRootRef} className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="h-fit rounded-2xl border border-slate-200 bg-gradient-to-b from-white via-slate-50 to-slate-100 p-4 dark:border-cyan-500/20 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 lg:sticky lg:top-6">
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300/80">Dealing Menu</div>
          <div className="mt-3 space-y-1.5">
            {allowedMenuItems.map((item) => {
              const active = activeMenu === item;
              if (item === "Bonus") {
                return (
                  <div key={item}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveMenu("Bonus");
                        setBonusShowOverview(true);
                      }}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
                        active
                          ? "border-violet-500/40 bg-violet-500/10 text-violet-800 dark:border-violet-400/50 dark:bg-violet-500/15 dark:text-violet-100"
                          : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:text-slate-100"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${bonusStatus?.xtbConnected && bonusStatus?.bonusManagerConnected ? "bg-emerald-400" : "bg-amber-400"}`} />
                        Bonus
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${active ? "rotate-0" : "-rotate-90"} ${active ? "text-violet-500 dark:text-violet-400" : "text-slate-400"}`} />
                    </button>
                    {active && allowedBonusSubTabs.length > 0 && (
                      <div className="ml-3 mt-1 space-y-1 border-l-2 border-violet-500/20 pl-3">
                        <button
                          type="button"
                          onClick={() => {
                            setBonusSubTab("Bonus Coverage");
                            setBonusShowOverview(false);
                          }}
                          className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs transition ${
                            bonusSubTab === "Bonus Coverage"
                              ? "bg-violet-500/15 font-semibold text-violet-700 dark:text-violet-200"
                              : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                          }`}
                        >
                          Coverage
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setBonusSubTab("Bonus Risk");
                            setBonusShowOverview(false);
                          }}
                          className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs transition ${
                            bonusSubTab === "Bonus Risk"
                              ? "bg-violet-500/15 font-semibold text-violet-700 dark:text-violet-200"
                              : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                          }`}
                        >
                          Risk
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setBonusSubTab("Bonus PNL");
                            setBonusShowOverview(false);
                          }}
                          className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs transition ${
                            bonusSubTab === "Bonus PNL"
                              ? "bg-violet-500/15 font-semibold text-violet-700 dark:text-violet-200"
                              : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                          }`}
                        >
                          P&amp;L
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setBonusSubTab("Bonus Equity");
                            setBonusShowOverview(false);
                          }}
                          className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs transition ${
                            bonusSubTab === "Bonus Equity"
                              ? "bg-violet-500/15 font-semibold text-violet-700 dark:text-violet-200"
                              : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                          }`}
                        >
                          Equity
                        </button>
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => setActiveMenu(item)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                    active
                      ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-800 dark:border-cyan-400/50 dark:bg-cyan-500/15 dark:text-cyan-100"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:text-slate-100"
                  }`}
                >
                  {item}
                </button>
              );
            })}
          </div>
        </aside>

        <div className="space-y-5">
          {activeMenu === "Dealing" ? (
            <section className="relative overflow-hidden rounded-2xl border border-cyan-300/40 bg-gradient-to-br from-slate-50 via-white to-cyan-50 p-5 dark:border-cyan-500/20 dark:from-slate-950 dark:via-slate-900 dark:to-cyan-950/40">
              <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-cyan-500/10 dark:bg-cyan-400/10 blur-3xl" />
              <div className="pointer-events-none absolute -left-10 -bottom-10 h-52 w-52 rounded-full bg-emerald-500/10 dark:bg-emerald-400/10 blur-3xl" />
              <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-cyan-700 dark:text-cyan-300/80">Dealing Department</div>
                  <h1 className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100 md:text-3xl">Sky Links Dealing Command Center</h1>
                  <div className="mt-2 text-sm text-slate-700 dark:text-slate-300">
                    {toReadable(fromDate)} - {toReadable(toDate)} <span className="mx-2 text-slate-500">|</span> Mode:{" "}
                    <span className="font-mono text-cyan-700 dark:text-cyan-300">{modeLabel}</span>
                    <span className="mx-2 text-slate-500">|</span>
                    Focus: <span className="font-mono text-cyan-700 dark:text-cyan-200">{activeMenu}</span>
                    {lastUpdated && (
                      <>
                        <span className="mx-2 text-slate-500">|</span>
                        Last update: {lastUpdated.toLocaleTimeString()}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-700 dark:text-slate-300">
                    From
                    <input
                      type="date"
                      value={toYmd(selectedFromDate)}
                      onChange={(e) => setSelectedFromDate(parseDateInput(e.target.value, selectedFromDate))}
                      className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    />
                  </label>
                  <label className="text-xs text-slate-700 dark:text-slate-300">
                    To
                    <input
                      type="date"
                      value={toYmd(selectedToDate)}
                      onChange={(e) => setSelectedToDate(parseDateInput(e.target.value, selectedToDate))}
                      className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    />
                  </label>
                  <button
                    onClick={handlePageRefresh}
                    className="inline-flex items-center gap-2 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-500/20 dark:text-cyan-200"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${menuLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                </div>
              </div>
            </section>
          ) : activeMenu !== "Bonus" && activeMenu !== "Client Profiling" ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-slate-600 dark:text-slate-400">
                  {toReadable(fromDate)} - {toReadable(toDate)} <span className="mx-2 text-slate-500 dark:text-slate-400">|</span> Focus:{" "}
                  <span className="font-mono text-cyan-700 dark:text-cyan-300">{activeMenu}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-700 dark:text-slate-300">
                    From
                    <input
                      type="date"
                      value={toYmd(selectedFromDate)}
                      onChange={(e) => setSelectedFromDate(parseDateInput(e.target.value, selectedFromDate))}
                      className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    />
                  </label>
                  <label className="text-xs text-slate-700 dark:text-slate-300">
                    To
                    <input
                      type="date"
                      value={toYmd(selectedToDate)}
                      onChange={(e) => setSelectedToDate(parseDateInput(e.target.value, selectedToDate))}
                      className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    />
                  </label>
                  <button
                    onClick={handlePageRefresh}
                    className="inline-flex items-center gap-2 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-500/20 dark:text-cyan-200"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${menuLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {error && (
            <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
          )}

          {activeMenu !== "Bonus" && activeMenu !== "Client Profiling" && summaryCards.length > 0 && (
            <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {summaryCards.map((card) => (
                <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                  <div className="text-xs text-slate-500 dark:text-slate-400">{card.label}</div>
                  <div className="mt-2 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">{card.value}</div>
                </div>
              ))}
            </section>
          )}

          {activeMenu === "Equity Overview" ? (
            <EquityOverviewTab refreshKey={equityOverviewRefreshKey} />
          ) : activeMenu === "Coverage" ? (
            <section
              className={`rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 ${
                fullscreenTable === "coverage" ? "fixed inset-3 z-50 flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-950" : ""
              }`}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Position Match Table</h2>
                  <span className={`h-2 w-2 rounded-full ${coverageStatus === "connected" ? "bg-emerald-400" : coverageStatus === "connecting" ? "bg-amber-400" : "bg-rose-400"}`} />
                  <span className="text-xs text-slate-500 dark:text-slate-400">{coverageStatus}</span>
                </div>
                <div className="flex items-center gap-2">
                  {(coverageShowZeroData || coverageHasHiddenZeroData) && (
                    <button
                      type="button"
                      onClick={() => setCoverageShowZeroData((value) => !value)}
                      className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-500/20 dark:text-slate-200"
                    >
                      {coverageShowZeroData ? "Hide Hidden Rows" : coverageHiddenZeroDataLabel ? `Show Hidden Rows (${coverageHiddenZeroDataLabel})` : "Show Hidden Rows"}
                    </button>
                  )}
                  {coverageLastUpdated && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">Updated {coverageLastUpdated.toLocaleTimeString()}</span>
                  )}
                  <button
                    type="button"
                    onClick={handleCoverageSnapshot}
                    disabled={snapshottingTable === "coverage" || coverageLoading || !coverageTableRows.length}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Camera className={`h-3.5 w-3.5 ${snapshottingTable === "coverage" ? "animate-pulse" : ""}`} />
                    {snapshottingTable === "coverage" ? "Capturing..." : "Snapshot"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFullscreenTable((v) => (v === "coverage" ? null : "coverage"))}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20"
                  >
                    {fullscreenTable === "coverage" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    {fullscreenTable === "coverage" ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                  <button
                    type="button"
                    onClick={handlePageRefresh}
                    className="inline-flex items-center gap-2 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 dark:text-cyan-200 hover:bg-cyan-500/20"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${coverageLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                </div>
              </div>

              {coverageError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  {coverageError}
                </div>
              )}

              {!coverageShowZeroData && coverageHasHiddenZeroData ? (
                <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                  {coverageHiddenZeroDataLabel} hidden (all values are 0).
                </div>
              ) : null}

              <div className={`${fullscreenTable === "coverage" ? "min-h-0 flex-1 overflow-auto" : ""}`}>
                <SortableTable
                  tableId="dealing-coverage-table"
                  enableColumnVisibility
                  rows={coverageTableRows}
                  columns={coverageTableColumns}
                  exportFilePrefix="dealing-coverage"
                  emptyText="No coverage rows available."
                  rowClassName={(row) => (isGoldSymbol(row.symbol) ? "bg-amber-100/50 dark:bg-amber-500/5" : "bg-slate-50 dark:bg-slate-950/30")}
                />
              </div>
              <div className="mt-2 rounded-lg border border-slate-800 bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40">
                <span className="font-semibold text-slate-600 dark:text-slate-300">Totals:</span>{" "}
                <span className="text-slate-500 dark:text-slate-400">Client Net {formatCoverageVal(coverageData?.totals?.clientNet || 0)} | Uncovered {formatCoverageVal(coverageData?.totals?.uncovered || 0)}</span>
                {coverageRows.gold.length > 0 && (
                  <span className="ml-3 text-amber-700 dark:text-amber-300">Gold Total: {formatCoverageVal(coverageGoldTotals.clientNet)} / {formatCoverageVal(coverageGoldTotals.uncovered)}</span>
                )}
              </div>
              {!coverageLoading && !coverageTableRows.length && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">No coverage rows available.</div>
              )}
            </section>
          ) : activeMenu === "Risk Exposure" ? (
            <section className="space-y-4">
              <section
                className={`rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 ${
                  fullscreenTable === "risk" ? "fixed inset-3 z-50 flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-950" : ""
                }`}
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Risk Exposure Table</h2>
                    <span className={`h-2 w-2 rounded-full ${coverageStatus === "connected" ? "bg-emerald-400" : coverageStatus === "connecting" ? "bg-amber-400" : "bg-rose-400"}`} />
                    <span className="text-xs text-slate-500 dark:text-slate-400">{coverageStatus}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {coverageLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {coverageLastUpdated.toLocaleTimeString()}</span>}
                    {riskHiddenRowsCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setRiskShowZeroData((value) => !value)}
                        className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20"
                      >
                        {riskShowZeroData ? "Hide Hidden Rows" : `Show Hidden Rows (${riskHiddenRowsCount})`}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleRiskSnapshot}
                      disabled={snapshottingTable === "risk" || coverageLoading || !riskVisibleRows.length}
                      className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Camera className={`h-3.5 w-3.5 ${snapshottingTable === "risk" ? "animate-pulse" : ""}`} />
                      {snapshottingTable === "risk" ? "Capturing..." : "Snapshot"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFullscreenTable((v) => (v === "risk" ? null : "risk"))}
                      className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20"
                    >
                      {fullscreenTable === "risk" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                      {fullscreenTable === "risk" ? "Exit Fullscreen" : "Fullscreen"}
                    </button>
                  </div>
                </div>

                {coverageError && (
                  <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{coverageError}</div>
                )}

                {!riskShowZeroData && riskHiddenRowsCount > 0 && (
                  <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                    {riskHiddenRowsCount} row{riskHiddenRowsCount === 1 ? " is" : "s are"} hidden (all key values are 0).
                  </div>
                )}

                <div className={`${fullscreenTable === "risk" ? "min-h-0 flex-1 overflow-auto" : ""}`}>
                  <SortableTable
                    tableId="dealing-risk-table"
                    enableColumnVisibility
                    rows={riskVisibleRows}
                    columns={riskTableColumns}
                    exportFilePrefix="dealing-risk"
                    emptyText="No risk rows available."
                    rowClassName={(row) =>
                      row.isSubtotalRow
                        ? "border-y-2 border-amber-400/50 bg-amber-200/60 dark:border-amber-500/40 dark:bg-amber-500/10"
                        : isGoldSymbol(row.symbol)
                          ? "bg-amber-100/50 dark:bg-amber-500/5"
                          : "bg-slate-50 dark:bg-slate-950/30"
                    }
                  />
                </div>
                <div className="mt-2 rounded-lg border border-slate-800 bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Totals:</span>{" "}
                  <span className="text-slate-500 dark:text-slate-400">
                    Client Net {formatCoverageVal(coverageData?.totals?.clientNet || 0)} | LP Coverage {formatCoverageVal((coverageData?.totals?.clientNet || 0) - (coverageData?.totals?.uncovered || 0))} | Uncovered {formatCoverageVal(coverageData?.totals?.uncovered || 0)}
                  </span>
                </div>
                {!coverageLoading && !riskVisibleRows.length && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">No risk rows available.</div>
                )}
              </section>
            </section>
          ) : activeMenu === "Metrics" ? (
            <section
              className={`rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 ${
                fullscreenTable === "metrics" ? "fixed inset-3 z-50 flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-950" : ""
              }`}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">LP Metrics</h2>
                <div className="flex items-center gap-2">
                  {metricsLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {metricsLastUpdated.toLocaleTimeString()}</span>}
                  <button
                    type="button"
                    onClick={handleMetricsSnapshot}
                    disabled={snapshottingTable === "metrics" || metricsLoading || !(metricsData?.items || []).length}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Camera className={`h-3.5 w-3.5 ${snapshottingTable === "metrics" ? "animate-pulse" : ""}`} />
                    {snapshottingTable === "metrics" ? "Capturing..." : "Snapshot"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFullscreenTable((v) => (v === "metrics" ? null : "metrics"))}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20"
                  >
                    {fullscreenTable === "metrics" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    {fullscreenTable === "metrics" ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/60">
                <span className="font-semibold text-amber-700 dark:text-amber-300">XAUUSD</span>
                <span>
                  Bid: <span className="font-mono text-rose-700 dark:text-rose-300">{metricsGoldQuote ? metricsGoldQuote.bid.toFixed(2) : "--"}</span>
                </span>
                <span>
                  Ask: <span className="font-mono text-emerald-700 dark:text-emerald-300">{metricsGoldQuote ? metricsGoldQuote.ask.toFixed(2) : "--"}</span>
                </span>
                <span
                  className={`font-mono text-sm font-semibold ${
                    !metricsGoldQuote || metricsGoldQuote.dir === "flat"
                      ? "text-slate-500"
                      : metricsGoldQuote.dir === "up"
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-rose-700 dark:text-rose-300"
                  }`}
                >
                  {metricsGoldQuote ? metricsGoldQuote.bid.toFixed(2) : "--"}
                </span>
                <span className="text-slate-500 dark:text-slate-400">
                  Spread: {metricsGoldQuote ? `${metricsGoldQuote.spreadPoints.toFixed(1)} pts` : "--"}
                </span>
              </div>
              {metricsError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{metricsError}</div>
              )}
              <div className={`${fullscreenTable === "metrics" ? "min-h-0 flex-1 overflow-auto" : ""}`}>
                <SortableTable
                  tableId="dealing-metrics-table"
                  enableColumnVisibility
                  rows={metricsData?.items || []}
                  columns={metricsTableColumns}
                  exportFilePrefix="dealing-metrics"
                  emptyText="No LP accounts found."
                />
              </div>
              {(metricsData?.totals || null) && (
                <div className="mt-2 rounded-lg border border-slate-800 bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40">
                  <span className="font-semibold text-slate-600 dark:text-slate-300">Totals:</span>{" "}
                  <span className="text-slate-500 dark:text-slate-400">Equity {formatDollar(metricsData?.totals?.equity || 0)} | Real Equity {formatDollar(metricsData?.totals?.realEquity || 0)} | Credit {formatDollar(metricsData?.totals?.credit || 0)} | Balance {formatDollar(metricsData?.totals?.balance || 0)} | Margin {formatDollar(metricsData?.totals?.margin || 0)} | Free Margin {formatDollar(metricsData?.totals?.freeMargin || 0)}</span>
                </div>
              )}
              {!metricsLoading && !(metricsData?.items || []).length && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">No LP accounts found.</div>
              )}
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center dark:border-slate-800 dark:bg-slate-900/50">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">LP Withdrawable Equity</div>
                  <div className="mt-2 text-xl font-semibold">{formatDollar(metricsEquitySummary?.lpWithdrawableEquity || 0)}</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center dark:border-slate-800 dark:bg-slate-900/50">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Client Withdrawable Equity</div>
                  <div className="mt-2 text-xl font-semibold">{formatDollar(metricsEquitySummary?.clientWithdrawableEquity || 0)}</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center dark:border-slate-800 dark:bg-slate-900/50">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">LP-Client WD Equity Difference</div>
                  <div
                    className={`mt-2 text-xl font-semibold ${
                      (metricsEquitySummary?.difference || 0) === 0
                        ? "text-slate-500"
                        : (metricsEquitySummary?.difference || 0) > 0
                          ? "text-emerald-700 dark:text-emerald-300"
                          : "text-rose-700 dark:text-rose-300"
                    }`}
                  >
                    {formatDollar(metricsEquitySummary?.difference || 0)}
                  </div>
                </div>
              </div>
            </section>
          ) : activeMenu === "Bonus" ? (() => {
            // ── shared helpers for bonus tables ──────────────────────────────
            const TABLE_PAGE_SIZE = 20;
            const bonusSortFn = (arr: Array<Record<string, any>>, key: string, dir: "asc" | "desc") =>
              [...arr].sort((a, b) => {
                const av = a[key]; const bv = b[key];
                const an = Number(av); const bn = Number(bv);
                const cmp = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : String(av ?? "").localeCompare(String(bv ?? ""));
                return dir === "asc" ? cmp : -cmp;
              });

            const SortTh = ({ col, label, sortState, onSort, className = "" }: { col: string; label: string; sortState: { key: string; dir: "asc" | "desc" }; onSort: (k: string) => void; className?: string }) => (
              <th
                className={`cursor-pointer select-none px-3 py-2.5 text-xs font-semibold uppercase tracking-wide transition hover:text-violet-400 ${className}`}
                onClick={() => onSort(col)}
              >
                <span className="inline-flex items-center gap-1">
                  {label}
                  {sortState.key === col ? (sortState.dir === "asc" ? " ↑" : " ↓") : <span className="text-slate-600 dark:text-slate-600">⇅</span>}
                </span>
              </th>
            );

            const Pagination = ({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) => {
              const pages = Math.ceil(total / pageSize);
              if (pages <= 1) return null;
              return (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-slate-500 dark:text-slate-400">
                  <button disabled={page === 0} onClick={() => onPage(0)} className="rounded px-1.5 py-0.5 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-800">«</button>
                  <button disabled={page === 0} onClick={() => onPage(page - 1)} className="rounded px-1.5 py-0.5 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-800">‹</button>
                  <span>Page {page + 1} / {pages}</span>
                  <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)} className="rounded px-1.5 py-0.5 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-800">›</button>
                  <button disabled={page >= pages - 1} onClick={() => onPage(pages - 1)} className="rounded px-1.5 py-0.5 hover:bg-slate-200 disabled:opacity-30 dark:hover:bg-slate-800">»</button>
                  <span className="ml-2 text-slate-400">{total} rows</span>
                </div>
              );
            };

            // ── status badge ──────────────────────────────────────────────────
            const connXtb = bonusStatus?.xtbConnected;
            const connMgr = bonusStatus?.bonusManagerConnected;
            const grossPnlVal = Number(bonusPnlDaily?.grossPnl ?? bonusPnlSummary?.grossPnl) || 0;
            const clientEquity = Number(bonusEquityClient.totalEquity) || 0;
            const lpEquity = Number(bonusEquityLp.equity) || 0;
            const equityDiff = Number(bonusDashboard?.equity?.difference) || 0;
            const totalClientPos = Number(bonusTotals.clientPositions) || 0;
            const totalLpPos = Number(bonusTotals.lpPositions) || 0;

            // ── OVERVIEW page ─────────────────────────────────────────────────
            const OverviewPage = () => (
              <div className="space-y-5">
                {/* Header hero */}
                <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-violet-900 via-violet-800 to-indigo-900 p-6 text-white shadow-xl">
                  <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-white/5 blur-3xl" />
                  <div className="pointer-events-none absolute -left-10 bottom-0 h-48 w-48 rounded-full bg-violet-400/10 blur-2xl" />
                  <div className="relative">
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div>
                        <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-violet-300">Bonus Department</div>
                        <h2 className="mt-1 text-2xl font-bold">Bonus Manager Dashboard</h2>
                        <p className="mt-1 text-sm text-violet-200">XTB / XOpenHub 50% profit-share model • Real-time exposure tracking</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${connXtb ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40" : "bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/40"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${connXtb ? "bg-emerald-400" : "bg-rose-400"} animate-pulse`} />
                          XTB API {connXtb ? "Live" : "Offline"}
                        </div>
                        <div className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${connMgr ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40" : "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${connMgr ? "bg-emerald-400" : "bg-amber-400"} animate-pulse`} />
                          Bonus Mgr {connMgr ? "Active" : "Standby"}
                        </div>
                        {bonusLastUpdated && <span className="text-xs text-violet-300">Updated {bonusLastUpdated.toLocaleTimeString()}</span>}
                        <button type="button" onClick={handlePageRefresh} className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white hover:bg-white/20 transition">
                          <RefreshCw className={`h-3 w-3 ${bonusLoading ? "animate-spin" : ""}`} />
                          Refresh
                        </button>
                      </div>
                    </div>
                    {/* Gross PnL hero metric */}
                    <div className="mt-5 flex flex-wrap gap-4">
                      <div className="rounded-xl bg-white/10 px-5 py-3 backdrop-blur-sm">
                        <div className="text-[10px] uppercase tracking-widest text-violet-300">Monthly Gross PnL</div>
                        <div className={`mt-1 text-3xl font-bold tabular-nums ${grossPnlVal >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{signedValueText(grossPnlVal)}</div>
                        <div className="mt-0.5 text-[10px] text-violet-300">{bonusPnlSummary?.fromUtc && `${bonusPnlSummary.fromUtc?.slice(0, 10)} – ${bonusPnlSummary.toUtc?.slice(0, 10)}`}</div>
                      </div>
                      <div className="rounded-xl bg-white/10 px-5 py-3 backdrop-blur-sm">
                        <div className="text-[10px] uppercase tracking-widest text-violet-300">LP Receivable (×0.5)</div>
                        <div className={`mt-1 text-3xl font-bold tabular-nums ${(Number(bonusPnlSummary?.lpReceivable) || 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{signedValueText(Number(bonusPnlSummary?.lpReceivable) || 0)}</div>
                        <div className="mt-0.5 text-[10px] text-violet-300">PnL {signedValueText(Number(bonusPnlSummary?.lpRealizedPnl) || 0)} + Swap {signedValueText(Number(bonusPnlSummary?.lpRealizedSwap) || 0)}</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* KPI grid */}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {[
                    { label: "Client Equity", value: formatDollar(clientEquity), sub: `Bal ${formatDollar(Number(bonusEquityClient.totalBalance) || 0)}`, accent: "text-violet-600 dark:text-violet-300" },
                    { label: "LP Equity (XTB)", value: formatDollar(lpEquity), sub: `Free ${formatDollar(Number(bonusEquityLp.freeMargin) || 0)}`, accent: "text-indigo-600 dark:text-indigo-300" },
                    { label: "Equity Diff (LP−Client)", value: formatDollar(equityDiff), sub: equityDiff >= 0 ? "LP surplus" : "Client surplus", accent: equityDiff >= 0 ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300" },
                    { label: "Uncovered Exposure", value: `${bonusRiskTotalUncoveredAbs.toFixed(2)} lots`, sub: `${bonusRiskUncoveredSymbols} symbol${bonusRiskUncoveredSymbols !== 1 ? "s" : ""}`, accent: bonusRiskTotalUncoveredAbs > 0 ? "text-rose-600 dark:text-rose-300" : "text-emerald-600 dark:text-emerald-300" },
                  ].map((kpi) => (
                    <div key={kpi.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{kpi.label}</div>
                      <div className={`mt-1.5 text-xl font-bold tabular-nums ${kpi.accent}`}>{kpi.value}</div>
                      <div className="mt-0.5 text-xs text-slate-500">{kpi.sub}</div>
                    </div>
                  ))}
                </div>

                {/* Positions + Coverage row */}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {/* Open positions card */}
                  <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Open Positions</div>
                        <div className="text-[11px] text-slate-500">Client vs LP</div>
                      </div>
                      <button type="button" onClick={() => { setBonusSubTab("Bonus Risk"); setBonusShowOverview(false); }} className="rounded-md bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-100 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50">View Risk →</button>
                    </div>
                    <div className="grid grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800">
                      <div className="p-5 text-center">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400">Client</div>
                        <div className="mt-2 text-3xl font-bold text-violet-700 dark:text-violet-300">{totalClientPos.toLocaleString()}</div>
                        <div className="mt-1 text-xs text-slate-500">{bonusCoverageRows.length} symbols</div>
                      </div>
                      <div className="p-5 text-center">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400">LP</div>
                        <div className="mt-2 text-3xl font-bold text-indigo-700 dark:text-indigo-300">{totalLpPos.toLocaleString()}</div>
                        <div className="mt-1 text-xs text-slate-500">{bonusLpNames.length} LP{bonusLpNames.length !== 1 ? "s" : ""}</div>
                      </div>
                    </div>
                    {/* Coverage bar */}
                    {(Number(bonusTotals.clientNet) || 0) !== 0 && (
                      <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
                        <div className="mb-1 flex justify-between text-[10px] text-slate-500">
                          <span>Coverage</span>
                          <span className="font-semibold">{(() => { const cn = Number(bonusTotals.clientNet) || 0; const uc = Number(bonusTotals.uncovered) || 0; return cn === 0 ? "-" : `${(((cn - uc) / cn) * 100).toFixed(1)}%`; })()}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500"
                            style={{ width: `${Math.min(100, Math.max(0, (() => { const cn = Number(bonusTotals.clientNet) || 0; const uc = Number(bonusTotals.uncovered) || 0; return cn === 0 ? 0 : ((cn - uc) / cn) * 100; })()))}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Equity balance card */}
                  <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Equity Balance</div>
                        <div className="text-[11px] text-slate-500">Client vs LP withdrawable</div>
                      </div>
                      <button type="button" onClick={() => { setBonusSubTab("Bonus Equity"); setBonusShowOverview(false); }} className="rounded-md bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-100 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50">View Equity →</button>
                    </div>
                    <div className="grid grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800">
                      <div className="p-5">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400">Client Withdrawable</div>
                        <div className="mt-2 text-2xl font-bold text-violet-700 dark:text-violet-300">{formatDollar(bonusEquityClientWithdrawable)}</div>
                        <div className="mt-1 text-xs text-slate-500">Equity − Credit − Margin</div>
                      </div>
                      <div className="p-5">
                        <div className="text-[10px] uppercase tracking-wider text-slate-400">LP Withdrawable</div>
                        <div className="mt-2 text-2xl font-bold text-indigo-700 dark:text-indigo-300">{formatDollar(bonusEquityLpWithdrawable)}</div>
                        <div className="mt-1 text-xs text-slate-500">Equity − Margin</div>
                      </div>
                    </div>
                    <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">Withdrawable difference (LP − Client)</span>
                        <span className={`text-sm font-semibold ${bonusEquityWithdrawableDifference >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{formatDollar(bonusEquityWithdrawableDifference)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Top risk symbols */}
                {bonusRiskRows.length > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Top Risk Exposures</div>
                        <div className="text-[11px] text-slate-500">Symbols with largest uncovered lots</div>
                      </div>
                      <button type="button" onClick={() => { setBonusSubTab("Bonus Coverage"); setBonusShowOverview(false); }} className="rounded-md bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-100 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50">Full Coverage →</button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-xs">
                        <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
                          <tr>
                            <th className="px-4 py-2.5 text-left font-semibold uppercase">Symbol</th>
                            <th className="px-4 py-2.5 text-left font-semibold uppercase">Dir</th>
                            <th className="px-4 py-2.5 text-right font-semibold uppercase">Client Net</th>
                            <th className="px-4 py-2.5 text-right font-semibold uppercase">Uncovered</th>
                            <th className="px-4 py-2.5 text-right font-semibold uppercase">Coverage %</th>
                            <th className="px-4 py-2.5 text-right font-semibold uppercase">Risk Bar</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                          {bonusRiskRows.slice(0, 8).map((row, idx) => {
                            const cn = Number(row.clientNet) || 0;
                            const uc = Number(row.uncovered) || 0;
                            const pct = cn === 0 ? NaN : ((cn - uc) / cn) * 100;
                            const barW = Math.min(100, Math.max(0, !Number.isFinite(pct) ? 0 : pct));
                            return (
                              <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                                <td className="px-4 py-2.5 font-mono font-semibold text-violet-700 dark:text-violet-200">{row.symbol}</td>
                                <td className="px-4 py-2.5">{row.direction === "BUY" ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">BUY</span> : row.direction === "SELL" ? <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">SELL</span> : "-"}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{cn.toFixed(2)}</td>
                                <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${Math.abs(uc) > 0.001 ? "text-rose-600 dark:text-rose-400" : "text-slate-400"}`}>{uc.toFixed(2)}</td>
                                <td className={`px-4 py-2.5 text-right ${!Number.isFinite(pct) ? "text-slate-400" : pct >= 95 ? "text-emerald-600 dark:text-emerald-400" : pct >= 70 ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400"}`}>{Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "—"}</td>
                                <td className="px-4 py-2.5">
                                  <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                                    <div className={`h-full rounded-full ${barW >= 95 ? "bg-emerald-500" : barW >= 70 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${barW}%` }} />
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {bonusError && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-600 dark:text-rose-300">{bonusError}</div>}
                {bonusLoading && <div className="text-center text-xs text-violet-500 py-4">Loading bonus data…</div>}
              </div>
            );

            // ── COVERAGE subtab ───────────────────────────────────────────────
            const CoverageTab = () => {
              const q = bonusCoverageSearch.toLowerCase();
              const filtered = bonusCoverageRows.filter((r) => !q || String(r.symbol || "").toLowerCase().includes(q));
              const sorted = bonusSortFn(filtered, bonusCoverageSort.key, bonusCoverageSort.dir);
              const page = Math.min(bonusCoveragePage, Math.max(0, Math.ceil(sorted.length / TABLE_PAGE_SIZE) - 1));
              const pageRows = sorted.slice(page * TABLE_PAGE_SIZE, (page + 1) * TABLE_PAGE_SIZE);
              const onSort = (k: string) => { setBonusCoverageSort((prev) => ({ key: k, dir: prev.key === k ? (prev.dir === "asc" ? "desc" : "asc") : "asc" })); setBonusCoveragePage(0); };
              const s = bonusCoverageSort;
              return (
                <div className="space-y-4">
                  {/* KPI strip */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {[
                      { label: "Symbols", value: String(bonusCoverageRows.length), accent: "text-violet-700 dark:text-violet-300" },
                      { label: "Client Net (total)", value: `${(Number(bonusTotals.clientNet) || 0).toFixed(2)} lots`, accent: "text-slate-700 dark:text-slate-200" },
                      { label: "Uncovered", value: `${bonusRiskTotalUncoveredAbs.toFixed(2)} lots`, accent: bonusRiskTotalUncoveredAbs > 0 ? "text-rose-600 dark:text-rose-300" : "text-emerald-600 dark:text-emerald-300" },
                      { label: "Active LPs", value: String(bonusLpNames.length), accent: "text-indigo-700 dark:text-indigo-300" },
                    ].map((c) => (
                      <div key={c.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
                        <div className="text-[11px] uppercase tracking-wide text-slate-400">{c.label}</div>
                        <div className={`mt-1 text-lg font-bold ${c.accent}`}>{c.value}</div>
                      </div>
                    ))}
                  </div>
                  {/* Table */}
                  <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/40">
                      <span className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Position Match Table</span>
                      <input value={bonusCoverageSearch} onChange={(e) => { setBonusCoverageSearch(e.target.value); setBonusCoveragePage(0); }} placeholder="Search symbol…" className="w-44 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-xs">
                        <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
                          <tr>
                            <SortTh col="symbol" label="Symbol" sortState={s} onSort={onSort} className="text-left" />
                            <SortTh col="direction" label="Side" sortState={s} onSort={onSort} className="text-left" />
                            <SortTh col="clientNet" label="Client Net" sortState={s} onSort={onSort} className="text-right" />
                            <SortTh col="uncovered" label="Uncovered" sortState={s} onSort={onSort} className="text-right" />
                            {bonusLpNames.map((lp) => <SortTh key={lp} col={`lp_${lp}`} label={lp} sortState={s} onSort={onSort} className="text-right" />)}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                          {pageRows.map((row, idx) => (
                            <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/40 transition-colors">
                              <td className="px-3 py-2.5 font-mono font-semibold text-violet-700 dark:text-violet-200">{row.symbol}</td>
                              <td className="px-3 py-2.5">{row.direction === "BUY" ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">BUY</span> : row.direction === "SELL" ? <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">SELL</span> : <span className="text-slate-400">—</span>}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums">{(Number(row.clientNet) || 0).toFixed(2)}</td>
                              <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${Math.abs(Number(row.uncovered) || 0) > 0.001 ? "text-rose-600 dark:text-rose-400" : "text-slate-400"}`}>{(Number(row.uncovered) || 0).toFixed(2)}</td>
                              {bonusLpNames.map((lp) => <td key={lp} className="px-3 py-2.5 text-right tabular-nums text-indigo-700 dark:text-indigo-300">{(Number(row.lpNets?.[lp]) || 0).toFixed(2)}</td>)}
                            </tr>
                          ))}
                          {!pageRows.length && <tr><td colSpan={4 + bonusLpNames.length} className="px-4 py-8 text-center text-slate-400">No matching symbols</td></tr>}
                        </tbody>
                        <tfoot className="bg-violet-50 text-violet-800 dark:bg-violet-900/20 dark:text-violet-200 font-semibold">
                          <tr>
                            <td className="px-3 py-2.5 uppercase text-xs tracking-wide">TOTAL</td>
                            <td />
                            <td className="px-3 py-2.5 text-right tabular-nums">{(Number(bonusTotals.clientNet) || 0).toFixed(2)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{(Number(bonusTotals.uncovered) || 0).toFixed(2)}</td>
                            {bonusLpNames.map((lp) => <td key={lp} className="px-3 py-2.5 text-right tabular-nums">{(Number(bonusTotals.lpNets?.[lp]) || 0).toFixed(2)}</td>)}
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    <Pagination page={page} total={sorted.length} pageSize={TABLE_PAGE_SIZE} onPage={setBonusCoveragePage} />
                  </div>
                </div>
              );
            };

            // ── RISK subtab ───────────────────────────────────────────────────
            const RiskTab = () => {
              const q = bonusRiskSearch.toLowerCase();
              const filtered = bonusRiskRows.filter((r) => !q || String(r.symbol || "").toLowerCase().includes(q));
              const sorted = bonusSortFn(filtered as any[], bonusRiskSort.key, bonusRiskSort.dir);
              const page = Math.min(bonusRiskPage, Math.max(0, Math.ceil(sorted.length / TABLE_PAGE_SIZE) - 1));
              const pageRows = sorted.slice(page * TABLE_PAGE_SIZE, (page + 1) * TABLE_PAGE_SIZE);
              const onSort = (k: string) => { setBonusRiskSort((prev) => ({ key: k, dir: prev.key === k ? (prev.dir === "asc" ? "desc" : "asc") : "asc" })); setBonusRiskPage(0); };
              const s = bonusRiskSort;

              const maxUncovered = Math.max(...bonusRiskRows.map((r) => Math.abs(Number(r.uncovered) || 0)), 1);
              return (
                <div className="space-y-4">
                  {/* KPI strip */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                    {[
                      { label: "Active LPs", value: bonusLpNames.length, sub: bonusLpNames.join(", ") || "—", accent: "border-violet-500/30 bg-violet-50 dark:bg-violet-900/20", vClass: "text-violet-700 dark:text-violet-300" },
                      { label: "Symbols Tracked", value: bonusRiskRows.length, sub: `${bonusRiskUncoveredSymbols} at risk`, accent: "border-indigo-500/30 bg-indigo-50 dark:bg-indigo-900/20", vClass: "text-indigo-700 dark:text-indigo-300" },
                      { label: "Client Positions", value: totalClientPos.toLocaleString(), sub: `${(Number(bonusTotals.clientNet) || 0).toFixed(2)} lots net`, accent: "border-slate-200 bg-slate-50 dark:bg-slate-900/40", vClass: "text-slate-700 dark:text-slate-200" },
                      { label: "LP Positions", value: totalLpPos.toLocaleString(), sub: `${((Number(bonusTotals.clientNet) || 0) - (Number(bonusTotals.uncovered) || 0)).toFixed(2)} lots covered`, accent: "border-slate-200 bg-slate-50 dark:bg-slate-900/40", vClass: "text-slate-700 dark:text-slate-200" },
                      { label: "Total Uncovered", value: bonusRiskTotalUncoveredAbs.toFixed(2), sub: `${bonusRiskUncoveredSymbols} symbol${bonusRiskUncoveredSymbols !== 1 ? "s" : ""} exposed`, accent: bonusRiskTotalUncoveredAbs > 0 ? "border-rose-400/30 bg-rose-50 dark:bg-rose-900/20" : "border-emerald-400/30 bg-emerald-50 dark:bg-emerald-900/20", vClass: bonusRiskTotalUncoveredAbs > 0 ? "text-rose-600 dark:text-rose-300" : "text-emerald-600 dark:text-emerald-300" },
                      { label: "Largest Exposure", value: bonusRiskLargest && Math.abs(Number(bonusRiskLargest.uncovered) || 0) > 0 ? bonusRiskLargest.symbol : "None", sub: bonusRiskLargest && Math.abs(Number(bonusRiskLargest.uncovered) || 0) > 0 ? `${Math.abs(Number(bonusRiskLargest.uncovered) || 0).toFixed(2)} lots` : "Fully hedged", accent: bonusRiskLargest && Math.abs(Number(bonusRiskLargest.uncovered) || 0) > 0 ? "border-orange-400/30 bg-orange-50 dark:bg-orange-900/20" : "border-emerald-400/30 bg-emerald-50 dark:bg-emerald-900/20", vClass: bonusRiskLargest && Math.abs(Number(bonusRiskLargest.uncovered) || 0) > 0 ? "text-orange-600 dark:text-orange-300" : "text-emerald-600 dark:text-emerald-300" },
                    ].map((c) => (
                      <div key={c.label} className={`rounded-xl border p-3 ${c.accent}`}>
                        <div className="text-[11px] uppercase tracking-wide text-slate-500">{c.label}</div>
                        <div className={`mt-1.5 text-xl font-bold ${c.vClass}`}>{c.value}</div>
                        <div className="mt-0.5 text-[11px] text-slate-400 truncate">{c.sub}</div>
                      </div>
                    ))}
                  </div>

                  {/* Risk heatmap bar + table */}
                  <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/40">
                      <span className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Risk Exposure Table</span>
                      <input value={bonusRiskSearch} onChange={(e) => { setBonusRiskSearch(e.target.value); setBonusRiskPage(0); }} placeholder="Search symbol…" className="w-44 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-xs">
                        <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
                          <tr>
                            <SortTh col="symbol" label="Symbol" sortState={s} onSort={onSort} className="text-left" />
                            <SortTh col="direction" label="Side" sortState={s} onSort={onSort} className="text-left" />
                            <SortTh col="clientNet" label="Client Net" sortState={s} onSort={onSort} className="text-right" />
                            <SortTh col="lpCoverage" label="LP Coverage" sortState={s} onSort={onSort} className="text-right" />
                            <SortTh col="uncovered" label="Uncovered" sortState={s} onSort={onSort} className="text-right" />
                            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide">Coverage %</th>
                            <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide">Risk Bar</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                          {pageRows.map((row, idx) => {
                            const cn = Number(row.clientNet) || 0;
                            const uc = Number(row.uncovered) || 0;
                            const lpCov = cn - uc;
                            const pct = cn === 0 ? NaN : ((cn - uc) / cn) * 100;
                            const barRisk = Math.min(100, Math.max(0, (Math.abs(uc) / maxUncovered) * 100));
                            return (
                              <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/40 transition-colors">
                                <td className="px-3 py-2.5 font-mono font-semibold text-violet-700 dark:text-violet-200">{row.symbol}</td>
                                <td className="px-3 py-2.5">{row.direction === "BUY" ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">BUY</span> : row.direction === "SELL" ? <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">SELL</span> : <span className="text-slate-400">—</span>}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{cn.toFixed(2)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-indigo-600 dark:text-indigo-300">{lpCov.toFixed(2)}</td>
                                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${Math.abs(uc) > 0.001 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>{uc.toFixed(2)}</td>
                                <td className={`px-3 py-2.5 text-right font-medium ${!Number.isFinite(pct) ? "text-slate-400" : pct >= 95 ? "text-emerald-600 dark:text-emerald-400" : pct >= 70 ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400"}`}>{Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "—"}</td>
                                <td className="px-3 py-2.5 w-28">
                                  <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                                    <div className={`h-full rounded-full ${barRisk <= 20 ? "bg-emerald-500" : barRisk <= 60 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${barRisk}%` }} />
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                          {!pageRows.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No matching symbols</td></tr>}
                        </tbody>
                        <tfoot className="bg-violet-50 text-violet-800 dark:bg-violet-900/20 dark:text-violet-200 font-semibold">
                          <tr>
                            <td className="px-3 py-2.5 text-xs uppercase tracking-wide">TOTAL</td>
                            <td />
                            <td className="px-3 py-2.5 text-right tabular-nums">{(Number(bonusTotals.clientNet) || 0).toFixed(2)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{((Number(bonusTotals.clientNet) || 0) - (Number(bonusTotals.uncovered) || 0)).toFixed(2)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{(Number(bonusTotals.uncovered) || 0).toFixed(2)}</td>
                            <td className="px-3 py-2.5 text-right">{(Number(bonusTotals.clientNet) || 0) === 0 ? "—" : `${((((Number(bonusTotals.clientNet) || 0) - (Number(bonusTotals.uncovered) || 0)) / (Number(bonusTotals.clientNet) || 1)) * 100).toFixed(1)}%`}</td>
                            <td />
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    <Pagination page={page} total={sorted.length} pageSize={TABLE_PAGE_SIZE} onPage={setBonusRiskPage} />
                  </div>
                </div>
              );
            };

            // ── PNL subtab ────────────────────────────────────────────────────
            const PnlTab = () => {
              // Deals table
              const deals = Array.isArray(bonusPnlLp.closedDeals) ? bonusPnlLp.closedDeals : [];
              const dq = bonusPnlDealsSearch.toLowerCase();
              const dFiltered = deals.filter((d) => !dq || String(d.symbol || "").toLowerCase().includes(dq) || String(d.deal || "").includes(dq));
              const dSorted = bonusSortFn(dFiltered as any[], bonusPnlDealsSort.key, bonusPnlDealsSort.dir);
              const dPage = Math.min(bonusPnlDealsPage, Math.max(0, Math.ceil(dSorted.length / TABLE_PAGE_SIZE) - 1));
              const dRows = dSorted.slice(dPage * TABLE_PAGE_SIZE, (dPage + 1) * TABLE_PAGE_SIZE);
              const onDSort = (k: string) => { setBonusPnlDealsSort((p) => ({ key: k, dir: p.key === k ? (p.dir === "asc" ? "desc" : "asc") : "asc" })); setBonusPnlDealsPage(0); };
              const ds = bonusPnlDealsSort;

              // Positions table
              const positions = Array.isArray(bonusPnlLp.openPositions) ? bonusPnlLp.openPositions : [];
              const pq = bonusPnlPosSearch.toLowerCase();
              const pFiltered = positions.filter((p) => !pq || String(p.symbol || "").toLowerCase().includes(pq) || String(p.ticket || "").includes(pq));
              const pSorted = bonusSortFn(pFiltered as any[], bonusPnlPosSort.key, bonusPnlPosSort.dir);
              const pPage = Math.min(bonusPnlPosPage, Math.max(0, Math.ceil(pSorted.length / TABLE_PAGE_SIZE) - 1));
              const pRows = pSorted.slice(pPage * TABLE_PAGE_SIZE, (pPage + 1) * TABLE_PAGE_SIZE);
              const onPSort = (k: string) => { setBonusPnlPosSort((p) => ({ key: k, dir: p.key === k ? (p.dir === "asc" ? "desc" : "asc") : "asc" })); setBonusPnlPosPage(0); };
              const ps = bonusPnlPosSort;

              const gPnl = Number(bonusPnlDaily?.grossPnl) || 0;

              // HWM-adjusted values from monthly report (last month entry)
              const hwmMonths = Array.isArray(bonusPnlMonthlyReport?.months) ? bonusPnlMonthlyReport.months : [];
              const hwm = hwmMonths.length > 0 ? hwmMonths[hwmMonths.length - 1] : null;
              const adjustedGrossPnl = hwm ? (Number(hwm.grossPnl) ?? gPnl) : gPnl;
              const effectiveLpTotal = hwm ? (Number(hwm.effectiveLpTotal) ?? (Number(bonusPnlLp.total) || 0)) : (Number(bonusPnlLp.total) || 0);
              const hwmActiveBlocked = hwm != null && adjustedGrossPnl === 0 && gPnl !== 0;
              const hasHwmImpact = hwm != null && Math.abs(adjustedGrossPnl - gPnl) > 0.01;
              const displayGrossPnl = hwm ? adjustedGrossPnl : gPnl;

              return (
                <div className="space-y-4">
                  {/* Hero PnL banner */}
                  {hwmActiveBlocked ? (
                    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-violet-950 to-indigo-950 p-5">
                      <div className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-white/5 blur-2xl" />
                      <div className="relative">
                        <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/60">Bonus PnL This Month</div>
                        <div className="mt-1 text-4xl font-bold tabular-nums text-violet-300">$0.00</div>
                        <div className="mt-2 text-xs text-white/60">{bonusPnlDaily?.fromUtc && `${bonusPnlDaily.fromUtc.slice(0, 10)} → ${bonusPnlDaily.toUtc?.slice(0, 10)}`}</div>
                        <div className="mt-3 rounded-xl border border-violet-500/30 bg-violet-900/50 px-4 py-3">
                          <div className="text-sm font-semibold text-violet-200">High Water Mark Active</div>
                          <div className="mt-1.5 text-xs text-violet-300/80 leading-relaxed">
                            LP made a profit of{" "}
                            <span className="font-semibold text-emerald-300">{signedValueText(Number(hwm?.watermarkOut) || 0)}</span>{" "}
                            this month, building the watermark buffer. No bonus PnL is due until LP losses exceed this buffer.
                          </div>
                          <div className="mt-2 text-xs text-violet-400">
                            Gross PnL (before HWM):{" "}
                            <span className={`font-semibold ${signedValueClass(gPnl)}`}>{signedValueText(gPnl)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className={`relative overflow-hidden rounded-2xl p-5 ${displayGrossPnl >= 0 ? "bg-gradient-to-br from-emerald-900 to-teal-900" : "bg-gradient-to-br from-rose-900 to-red-900"}`}>
                      <div className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-white/5 blur-2xl" />
                      <div className="relative">
                        <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/60">Gross PnL{hwm ? " (with HWM)" : " (Period)"}</div>
                        <div className={`mt-1 text-4xl font-bold tabular-nums ${displayGrossPnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{signedValueText(displayGrossPnl)}</div>
                        <div className="mt-2 text-xs text-white/60">{bonusPnlDaily?.fromUtc && `${bonusPnlDaily.fromUtc.slice(0, 10)} → ${bonusPnlDaily.toUtc?.slice(0, 10)}`}</div>
                        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-white/80">
                          <span>LP×50% <strong className={signedValueClass(Number(bonusPnlLp.total) || 0)}>{signedValueText(Number(bonusPnlLp.total) || 0)}</strong></span>
                          <span className="text-white/40">–</span>
                          <span>Client <strong className={signedValueClass(Number(bonusPnlClient.total) || 0)}>{signedValueText(Number(bonusPnlClient.total) || 0)}</strong></span>
                          <span className="text-white/40">–</span>
                          <span>Commission <strong className="text-white/90">{signedValueText(Math.abs(Number(bonusPnlLp.realizedCommission) || 0))}</strong></span>
                          <span className="text-white/40">–</span>
                          <span>Credit Cost <strong className="text-white/90">{signedValueText(Number(bonusPnlCost.creditCost) || 0)}</strong></span>
                          <span className="text-white/40">+</span>
                          <span>Withdrawal Charges <strong className="text-white/90">{signedValueText(Number(bonusPnlCost.withdrawalCharges) || 0)}</strong></span>
                        </div>
                        {hasHwmImpact && (
                          <div className="mt-2 text-xs text-white/50">
                            Before HWM: <span className={signedValueClass(gPnl)}>{signedValueText(gPnl)}</span>
                            {" · "}HWM impact: <span className={signedValueClass(adjustedGrossPnl - gPnl)}>{signedValueText(adjustedGrossPnl - gPnl)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Client / LP side-by-side breakdowns */}
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {/* Client PnL */}
                    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                      <div className="border-b border-slate-100 bg-gradient-to-r from-violet-50 to-transparent px-4 py-3 dark:border-slate-800 dark:from-violet-900/20">
                        <div className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Client Gross PnL (MT5)</div>
                        <div className={`mt-0.5 text-2xl font-bold tabular-nums ${signedValueClass(Number(bonusPnlClient.total) || 0)}`}>{signedValueText(Number(bonusPnlClient.total) || 0)}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-px bg-slate-100 dark:bg-slate-800">
                        {[
                          { label: "Realized PnL", val: Number(bonusPnlClient.realizedPnl) || 0 },
                          { label: "Realized Swap", val: Number(bonusPnlClient.realizedSwap) || 0 },
                          { label: "Unrealized PnL", val: Number(bonusPnlClient.unrealizedPnl) || 0 },
                          { label: "Unrealized Swap", val: Number(bonusPnlClient.unrealizedSwap) || 0 },
                        ].map((item) => (
                          <div key={item.label} className="bg-white px-4 py-3 dark:bg-slate-900/60">
                            <div className="text-[10px] uppercase tracking-wide text-slate-400">{item.label}</div>
                            <div className={`mt-0.5 font-semibold tabular-nums ${signedValueClass(item.val)}`}>{signedValueText(item.val)}</div>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-4 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800">
                        <span>Closed Deals: <strong className="text-slate-700 dark:text-slate-200">{Number(bonusPnlClient.closedDealCount) || 0}</strong></span>
                        <span>Open Positions: <strong className="text-slate-700 dark:text-slate-200">{Number(bonusPnlClient.openPositionCount) || 0}</strong></span>
                      </div>
                    </div>

                    {/* LP PnL */}
                    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                      <div className="border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-transparent px-4 py-3 dark:border-slate-800 dark:from-indigo-900/20">
                        <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">LP PnL ×50% (XTB / XOpenHub)</div>
                        <div className={`mt-0.5 text-2xl font-bold tabular-nums ${signedValueClass(Number(bonusPnlLp.total) || 0)}`}>{signedValueText(Number(bonusPnlLp.total) || 0)}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-px bg-slate-100 dark:bg-slate-800">
                        {[
                          { label: "Realized PnL", val: Number(bonusPnlLp.realizedPnl) || 0 },
                          { label: "Realized Swap", val: Number(bonusPnlLp.realizedSwap) || 0 },
                          { label: "Unrealized PnL", val: Number(bonusPnlLp.unrealizedPnl) || 0 },
                          { label: "Unrealized Swap", val: Number(bonusPnlLp.unrealizedSwap) || 0 },
                        ].map((item) => (
                          <div key={item.label} className="bg-white px-4 py-3 dark:bg-slate-900/60">
                            <div className="text-[10px] uppercase tracking-wide text-slate-400">{item.label}</div>
                            <div className={`mt-0.5 font-semibold tabular-nums ${signedValueClass(item.val)}`}>{signedValueText(item.val)}</div>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-4 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500 dark:border-slate-800">
                        <span>Raw Total: <strong className={`${signedValueClass(Number(bonusPnlLp.rawTotal) || 0)}`}>{signedValueText(Number(bonusPnlLp.rawTotal) || 0)}</strong></span>
                        <span>Commission: <strong className="text-slate-700 dark:text-slate-200">{signedValueText(Number(bonusPnlLp.realizedCommission) || 0)}</strong></span>
                      </div>
                    </div>
                  </div>

                  {/* Cost cards row */}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {[
                      { label: "Credit Settled", val: Number(bonusPnlCost.creditSettled) || 0, sub: `${Number(bonusPnlCost.settledTransactionCount) || 0} transactions`, color: "from-teal-50 dark:from-teal-900/20 border-teal-200 dark:border-teal-800" },
                      { label: "Credit Unsettled", val: Number(bonusPnlCost.creditUnsettled) || 0, sub: `${Number(bonusPnlCost.unsettledAccountCount) || 0} accounts (bal < 0)`, color: "from-orange-50 dark:from-orange-900/20 border-orange-200 dark:border-orange-800" },
                      { label: "Withdrawal Charges (1.26%)", val: Number(bonusPnlCost.withdrawalCharges) || 0, sub: `${signedValueText(Number(bonusPnlCost.withdrawalTotal) || 0)} total · ${Number(bonusPnlCost.withdrawalCount) || 0} withdrawals`, color: "from-blue-50 dark:from-blue-900/20 border-blue-200 dark:border-blue-800" },
                    ].map((c) => (
                      <div key={c.label} className={`rounded-xl border bg-gradient-to-br ${c.color} to-transparent p-4`}>
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">{c.label}</div>
                        <div className={`mt-1.5 text-2xl font-bold tabular-nums ${signedValueClass(c.val)}`}>{signedValueText(c.val)}</div>
                        <div className="mt-1 text-xs text-slate-500">{c.sub}</div>
                      </div>
                    ))}
                  </div>

                  {/* LP Closed Deals table */}
                  <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/40">
                      <button type="button" onClick={() => setBonusPnlExpanded((p) => ({ ...p, lpClosedDeals: !p.lpClosedDeals }))} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300 hover:text-violet-500 transition">
                        {bonusPnlExpanded.lpClosedDeals ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        LP Closed Deals
                        <span className="ml-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">{deals.length}</span>
                      </button>
                      {bonusPnlExpanded.lpClosedDeals && (
                        <input value={bonusPnlDealsSearch} onChange={(e) => { setBonusPnlDealsSearch(e.target.value); setBonusPnlDealsPage(0); }} placeholder="Search symbol or deal…" className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
                      )}
                    </div>
                    {bonusPnlExpanded.lpClosedDeals && (
                      <>
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-xs">
                            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
                              <tr>
                                <SortTh col="deal" label="Deal" sortState={ds} onSort={onDSort} className="text-left" />
                                <SortTh col="symbol" label="Symbol" sortState={ds} onSort={onDSort} className="text-left" />
                                <SortTh col="direction" label="Dir" sortState={ds} onSort={onDSort} className="text-left" />
                                <SortTh col="volume" label="Volume" sortState={ds} onSort={onDSort} className="text-right" />
                                <SortTh col="profit" label="Profit" sortState={ds} onSort={onDSort} className="text-right" />
                                <SortTh col="swap" label="Swap" sortState={ds} onSort={onDSort} className="text-right" />
                                <SortTh col="commission" label="Comm." sortState={ds} onSort={onDSort} className="text-right" />
                                <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase">Comment</th>
                                <SortTh col="time" label="Time" sortState={ds} onSort={onDSort} className="text-left" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                              {dRows.map((d, idx) => (
                                <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/40 transition-colors">
                                  <td className="px-3 py-2 text-slate-500">{d.deal ?? "—"}</td>
                                  <td className="px-3 py-2 font-mono font-semibold text-amber-700 dark:text-amber-300">{d.symbol || "—"}</td>
                                  <td className="px-3 py-2">{(d.direction || "").toLowerCase() === "buy" ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">BUY</span> : <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">SELL</span>}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{formatMaybeNumber(d.volume, 4)}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${signedValueClass(Number(d.profit) || 0)}`}>{signedValueText(Number(d.profit) || 0)}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums ${signedValueClass(Number(d.swap) || 0)}`}>{signedValueText(Number(d.swap) || 0)}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums ${signedValueClass(Number(d.commission) || 0)}`}>{signedValueText(Number(d.commission) || 0)}</td>
                                  <td className="px-3 py-2 text-slate-400 max-w-[140px] truncate">{d.comment || "—"}</td>
                                  <td className="px-3 py-2 whitespace-nowrap text-slate-400">{d.time || "—"}</td>
                                </tr>
                              ))}
                              {!dRows.length && <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">No deals match filter</td></tr>}
                            </tbody>
                          </table>
                        </div>
                        <Pagination page={dPage} total={dSorted.length} pageSize={TABLE_PAGE_SIZE} onPage={setBonusPnlDealsPage} />
                      </>
                    )}
                  </div>

                  {/* LP Open Positions table */}
                  <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/40">
                      <button type="button" onClick={() => setBonusPnlExpanded((p) => ({ ...p, lpOpenPositions: !p.lpOpenPositions }))} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300 hover:text-violet-500 transition">
                        {bonusPnlExpanded.lpOpenPositions ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        LP Open Positions
                        <span className="ml-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">{positions.length}</span>
                      </button>
                      {bonusPnlExpanded.lpOpenPositions && (
                        <input value={bonusPnlPosSearch} onChange={(e) => { setBonusPnlPosSearch(e.target.value); setBonusPnlPosPage(0); }} placeholder="Search symbol or ticket…" className="w-52 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
                      )}
                    </div>
                    {bonusPnlExpanded.lpOpenPositions && (
                      <>
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-xs">
                            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
                              <tr>
                                <SortTh col="ticket" label="Ticket" sortState={ps} onSort={onPSort} className="text-left" />
                                <SortTh col="time" label="Open Time" sortState={ps} onSort={onPSort} className="text-left" />
                                <SortTh col="symbol" label="Symbol" sortState={ps} onSort={onPSort} className="text-left" />
                                <SortTh col="direction" label="Dir" sortState={ps} onSort={onPSort} className="text-left" />
                                <SortTh col="volume" label="Volume" sortState={ps} onSort={onPSort} className="text-right" />
                                <SortTh col="openPrice" label="Open" sortState={ps} onSort={onPSort} className="text-right" />
                                <SortTh col="currentPrice" label="Current" sortState={ps} onSort={onPSort} className="text-right" />
                                <SortTh col="profit" label="Profit" sortState={ps} onSort={onPSort} className="text-right" />
                                <SortTh col="swap" label="Swap" sortState={ps} onSort={onPSort} className="text-right" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                              {pRows.map((pos, idx) => (
                                <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/40 transition-colors">
                                  <td className="px-3 py-2 text-slate-500">{pos.ticket ?? "—"}</td>
                                  <td className="px-3 py-2 whitespace-nowrap text-slate-400">{pos.time || "—"}</td>
                                  <td className="px-3 py-2 font-mono font-semibold text-amber-700 dark:text-amber-300">{pos.symbol || "—"}</td>
                                  <td className="px-3 py-2">{(pos.direction || "").toLowerCase() === "buy" ? <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">BUY</span> : <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">SELL</span>}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{formatMaybeNumber(pos.volume, 4)}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{formatMaybeNumber(pos.openPrice, 5)}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{formatMaybeNumber(pos.currentPrice, 5)}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${signedValueClass(Number(pos.profit) || 0)}`}>{signedValueText(Number(pos.profit) || 0)}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums ${signedValueClass(Number(pos.swap) || 0)}`}>{signedValueText(Number(pos.swap) || 0)}</td>
                                </tr>
                              ))}
                              {!pRows.length && <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">No open positions</td></tr>}
                            </tbody>
                          </table>
                        </div>
                        <Pagination page={pPage} total={pSorted.length} pageSize={TABLE_PAGE_SIZE} onPage={setBonusPnlPosPage} />
                      </>
                    )}
                  </div>

                  {/* Credit settled/unsettled detail collapsibles */}
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                      <button type="button" onClick={() => setBonusPnlExpanded((p) => ({ ...p, creditSettled: !p.creditSettled }))} className="flex w-full items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-teal-700 dark:border-slate-800 dark:bg-slate-900/40 dark:text-teal-300 hover:text-teal-500 transition">
                        {bonusPnlExpanded.creditSettled ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        Credit Settled Details
                        <span className="ml-1 rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-bold text-teal-700 dark:bg-teal-900/40 dark:text-teal-200">{Array.isArray(bonusPnlCost.settledDetails) ? bonusPnlCost.settledDetails.length : 0}</span>
                      </button>
                      {bonusPnlExpanded.creditSettled && (
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-xs">
                            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
                              <tr>
                                <th className="px-3 py-2.5 text-left font-semibold uppercase">Login</th>
                                <th className="px-3 py-2.5 text-left font-semibold uppercase">Deal</th>
                                <th className="px-3 py-2.5 text-left font-semibold uppercase">Type</th>
                                <th className="px-3 py-2.5 text-right font-semibold uppercase">Amount</th>
                                <th className="px-3 py-2.5 text-left font-semibold uppercase">Comment</th>
                                <th className="px-3 py-2.5 text-left font-semibold uppercase">Time</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                              {(bonusPnlCost.settledDetails || []).map((item, idx) => (
                                <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                                  <td className="px-3 py-2">{item.login ?? "—"}</td>
                                  <td className="px-3 py-2 text-slate-400">{item.dealTicket ?? "—"}</td>
                                  <td className="px-3 py-2">{item.actionType || "—"}</td>
                                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${signedValueClass(Number(item.amount) || 0)}`}>{signedValueText(Number(item.amount) || 0)}</td>
                                  <td className="px-3 py-2 text-slate-400 max-w-[120px] truncate">{item.comment || "—"}</td>
                                  <td className="px-3 py-2 whitespace-nowrap text-slate-400">{item.time || "—"}</td>
                                </tr>
                              ))}
                              {!(bonusPnlCost.settledDetails || []).length && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No settled credit transactions</td></tr>}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                      <button type="button" onClick={() => setBonusPnlExpanded((p) => ({ ...p, creditUnsettled: !p.creditUnsettled }))} className="flex w-full items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-orange-700 dark:border-slate-800 dark:bg-slate-900/40 dark:text-orange-300 hover:text-orange-500 transition">
                        {bonusPnlExpanded.creditUnsettled ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        Credit Unsettled Accounts
                        <span className="ml-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-700 dark:bg-orange-900/40 dark:text-orange-200">{Array.isArray(bonusPnlCost.unsettledDetails) ? bonusPnlCost.unsettledDetails.length : 0}</span>
                      </button>
                      {bonusPnlExpanded.creditUnsettled && (
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-xs">
                            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
                              <tr>
                                <th className="px-3 py-2.5 text-left font-semibold uppercase">Login</th>
                                <th className="px-3 py-2.5 text-right font-semibold uppercase">Balance</th>
                                <th className="px-3 py-2.5 text-right font-semibold uppercase">Equity</th>
                                <th className="px-3 py-2.5 text-right font-semibold uppercase">Margin</th>
                                <th className="px-3 py-2.5 text-right font-semibold uppercase">Unsettled</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                              {(bonusPnlCost.unsettledDetails || []).map((item, idx) => (
                                <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                                  <td className="px-3 py-2">{item.login ?? "—"}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">{signedValueText(Number(item.balance) || 0)}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{signedValueText(Number(item.equity) || 0)}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{signedValueText(Number(item.margin) || 0)}</td>
                                  <td className="px-3 py-2 text-right tabular-nums font-medium text-rose-600 dark:text-rose-400">{signedValueText(Math.abs(Number(item.balance) || 0))}</td>
                                </tr>
                              ))}
                              {!(bonusPnlCost.unsettledDetails || []).length && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No unsettled credit accounts</td></tr>}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Formula breakdown */}
                  <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-800/40 dark:bg-violet-900/10">
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Gross PnL Formula Breakdown</div>
                    <div className="space-y-1 text-xs">
                      {[
                        { label: "LP PnL ×50%", val: Number(bonusPnlLp.total) || 0 },
                        { label: "− Client Gross PnL", val: Number(bonusPnlClient.total) || 0 },
                        { label: "− LP Commission (100%)", val: -Math.abs(Number(bonusPnlLp.realizedCommission) || 0) },
                        { label: "− Credit Cost (Settled + Unsettled)", val: Number(bonusPnlCost.creditCost) || 0 },
                        { label: "+ Withdrawal Charges (1.26%)", val: Number(bonusPnlCost.withdrawalCharges) || 0 },
                      ].map((item) => (
                        <div key={item.label} className="flex items-center justify-between rounded px-3 py-1.5 hover:bg-violet-100/60 dark:hover:bg-violet-900/20">
                          <span className="text-slate-500 dark:text-slate-400">{item.label}</span>
                          <span className={`font-semibold ${signedValueClass(item.val)}`}>{signedValueText(item.val)}</span>
                        </div>
                      ))}
                      <div className="mt-2 flex items-center justify-between rounded-lg bg-violet-100 px-3 py-2 dark:bg-violet-900/30">
                        <span className="font-semibold text-violet-700 dark:text-violet-200">= Gross PnL</span>
                        <span className={`text-lg font-bold tabular-nums ${signedValueClass(gPnl)}`}>{signedValueText(gPnl)}</span>
                      </div>
                      {hwm && (
                        <>
                          <div className="mt-3 border-t border-violet-200/60 pt-3 dark:border-violet-800/40">
                            <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">High Water Mark Adjustment</div>
                            {[
                              { label: "Watermark buffer in", val: Number(hwm.watermarkIn) || 0, color: "text-violet-600 dark:text-violet-300" },
                              { label: "LP Raw PnL this month", val: Number(hwm.lpRawTotal) || (Number(bonusPnlLp.rawTotal) || 0), color: signedValueClass(Number(hwm.lpRawTotal) || 0) },
                              { label: "Effective LP (50%) after HWM", val: effectiveLpTotal, color: signedValueClass(effectiveLpTotal) },
                              { label: "Watermark buffer out", val: Number(hwm.watermarkOut) || 0, color: "text-violet-600 dark:text-violet-300" },
                            ].map((item) => (
                              <div key={item.label} className="flex items-center justify-between rounded px-3 py-1.5 hover:bg-violet-100/60 dark:hover:bg-violet-900/20">
                                <span className="text-violet-500 dark:text-violet-400">{item.label}</span>
                                <span className={`font-semibold ${item.color}`}>{signedValueText(Number(item.val))}</span>
                              </div>
                            ))}
                          </div>
                          <div className="mt-1 flex items-center justify-between rounded-lg bg-violet-200/60 px-3 py-2 dark:bg-violet-800/30">
                            <span className="font-semibold text-violet-800 dark:text-violet-200">= Bonus PnL (with HWM)</span>
                            <span className={`text-lg font-bold tabular-nums ${signedValueClass(adjustedGrossPnl)}`}>{signedValueText(adjustedGrossPnl)}</span>
                          </div>
                          {hwmActiveBlocked && (
                            <div className="mt-2 rounded-lg border border-violet-400/30 bg-violet-100/60 px-3 py-2.5 text-xs text-violet-600 dark:border-violet-700/40 dark:bg-violet-900/20 dark:text-violet-300 leading-relaxed">
                              LP profited this month — profits are banked into the watermark buffer ({signedValueText(Number(hwm.watermarkOut) || 0)}).
                              No bonus PnL is payable until future LP losses exceed this buffer.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            };

            // ── EQUITY subtab ─────────────────────────────────────────────────
            const EquityTab = () => {
              const accounts = bonusEquityVisibleAccounts;
              const eq = bonusEquitySearch.toLowerCase();
              const eFiltered = accounts.filter((a) => !eq || String(a.login ?? "").includes(eq));
              const eSorted = bonusSortFn(eFiltered as any[], bonusEquitySort.key, bonusEquitySort.dir);
              const ePage = Math.min(bonusEquityPage, Math.max(0, Math.ceil(eSorted.length / TABLE_PAGE_SIZE) - 1));
              const eRows = eSorted.slice(ePage * TABLE_PAGE_SIZE, (ePage + 1) * TABLE_PAGE_SIZE);
              const onESort = (k: string) => { setBonusEquitySort((p) => ({ key: k, dir: p.key === k ? (p.dir === "asc" ? "desc" : "asc") : "asc" })); setBonusEquityPage(0); };
              const es = bonusEquitySort;

              return (
                <div className="space-y-4">
                  {/* Connection status bar */}
                  <div className="flex flex-wrap gap-3">
                    {[
                      { label: "XTB API", ok: connXtb, okText: "Connected & Live", failText: "Disconnected" },
                      { label: "Bonus Manager", ok: connMgr, okText: "Active", failText: "Not Configured" },
                    ].map((s) => (
                      <div key={s.label} className={`flex items-center gap-2.5 rounded-xl border px-4 py-2.5 ${s.ok ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800/40 dark:bg-emerald-900/20" : "border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-900/20"}`}>
                        <span className={`h-2 w-2 rounded-full ${s.ok ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`} />
                        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{s.label}</span>
                        <span className={`text-xs font-semibold ${s.ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>{s.ok ? s.okText : s.failText}</span>
                      </div>
                    ))}
                  </div>

                  {/* Equity comparison cards */}
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className="relative overflow-hidden rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-4 dark:border-violet-800/40 dark:from-violet-900/20 dark:to-slate-900/60">
                      <div className="text-[10px] uppercase tracking-widest text-violet-500">Client Equity (MT5)</div>
                      <div className="mt-2 text-2xl font-bold text-violet-700 dark:text-violet-300">{formatDollar(clientEquity)}</div>
                      <div className="mt-3 space-y-1 text-xs">
                        {[["Balance", Number(bonusEquityClient.totalBalance) || 0], ["Credit", Number(bonusEquityClient.totalCredit) || 0], ["Margin", Number(bonusEquityClient.totalMargin) || 0]].map(([l, v]) => (
                          <div key={String(l)} className="flex justify-between">
                            <span className="text-slate-500">{String(l)}</span>
                            <span className="font-medium tabular-nums">{formatDollar(Number(v))}</span>
                          </div>
                        ))}
                        <div className="flex justify-between border-t border-violet-100/60 pt-1 dark:border-violet-800/20">
                          <span className="text-slate-500">Margin Level</span>
                          <span className="font-medium">{bonusClientMarginLevel == null ? "—" : `${bonusClientMarginLevel.toFixed(2)}%`}</span>
                        </div>
                      </div>
                    </div>
                    <div className="relative overflow-hidden rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-4 dark:border-indigo-800/40 dark:from-indigo-900/20 dark:to-slate-900/60">
                      <div className="text-[10px] uppercase tracking-widest text-indigo-500">LP Equity (XTB)</div>
                      <div className="mt-2 text-2xl font-bold text-indigo-700 dark:text-indigo-300">{formatDollar(lpEquity)}</div>
                      <div className="mt-3 space-y-1 text-xs">
                        {[["Balance", Number(bonusEquityLp.balance) || 0], ["Margin", Number(bonusEquityLp.margin) || 0], ["Free Margin", Number(bonusEquityLp.freeMargin) || 0]].map(([l, v]) => (
                          <div key={String(l)} className="flex justify-between">
                            <span className="text-slate-500">{String(l)}</span>
                            <span className="font-medium tabular-nums">{formatDollar(Number(v))}</span>
                          </div>
                        ))}
                        <div className="flex justify-between border-t border-indigo-100/60 pt-1 dark:border-indigo-800/20">
                          <span className="text-slate-500">Margin Level</span>
                          <span className="font-medium">{formatMaybeNumber(bonusEquityLp.marginLevel, 2)}%</span>
                        </div>
                      </div>
                    </div>
                    <div className={`relative overflow-hidden rounded-xl border p-4 ${equityDiff >= 0 ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white dark:border-emerald-800/40 dark:from-emerald-900/20" : "border-rose-200 bg-gradient-to-br from-rose-50 to-white dark:border-rose-800/40 dark:from-rose-900/20"} dark:to-slate-900/60`}>
                      <div className={`text-[10px] uppercase tracking-widest ${equityDiff >= 0 ? "text-emerald-500" : "text-rose-500"}`}>Equity Difference (LP − Client)</div>
                      <div className={`mt-2 text-2xl font-bold ${equityDiff >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{formatDollar(equityDiff)}</div>
                      <div className="mt-3 space-y-1 text-xs">
                        {[["Client Withdrawable", bonusEquityClientWithdrawable], ["LP Withdrawable", bonusEquityLpWithdrawable], ["WD Difference", bonusEquityWithdrawableDifference]].map(([l, v]) => (
                          <div key={String(l)} className="flex justify-between">
                            <span className="text-slate-500">{String(l)}</span>
                            <span className={`font-medium tabular-nums ${l === "WD Difference" ? (Number(v) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400") : ""}`}>{formatDollar(Number(v))}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Monthly PnL summary */}
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
                      <div className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Monthly Gross PnL</div>
                      <div className={`mt-2 text-2xl font-bold tabular-nums ${signedValueClass(Number(bonusPnlSummary?.grossPnl) || 0)}`}>{signedValueText(Number(bonusPnlSummary?.grossPnl) || 0)}</div>
                      <div className="mt-1.5 text-xs text-slate-500">{bonusPnlSummary?.fromUtc?.slice(0, 10) || "—"} → {bonusPnlSummary?.toUtc?.slice(0, 10) || "—"}</div>
                    </div>
                    {(() => {
                      const _wiAmt = Number(bonusPnlSummary?.watermarkIn) || 0;
                      const _hwmRcv = bonusPnlSummary?.lpReceivableHwm !== undefined ? Number(bonusPnlSummary.lpReceivableHwm) : (Number(bonusPnlSummary?.lpReceivable) || 0);
                      const _hwmCardActive = _wiAmt > 0 && _hwmRcv === 0;
                      const _lpRcv = Number(bonusPnlSummary?.lpReceivable) || 0;
                      const _lpPnl = Number(bonusPnlSummary?.lpRealizedPnl) || 0;
                      const _lpSwap = Number(bonusPnlSummary?.lpRealizedSwap) || 0;
                      const _lpUnreal = Number(bonusPnlSummary?.lpUnrealizedPnl) || 0;
                      return (
                        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
                          <div className={`text-xs font-semibold uppercase tracking-wide ${_hwmCardActive ? "text-violet-600 dark:text-violet-400" : "text-indigo-700 dark:text-indigo-300"}`}>LP Receivable (PnL + Swap) ×50%</div>
                          <div className={`mt-2 text-2xl font-bold tabular-nums ${_hwmCardActive ? "text-violet-500 dark:text-violet-400" : signedValueClass(_hwmRcv)}`}>{signedValueText(_hwmRcv)}</div>
                          {_hwmCardActive ? (
                            <div className="mt-1.5 space-y-0.5 text-xs">
                              <div className="text-violet-500 dark:text-violet-400">HWM Active — buffer: <strong>{signedValueText(_wiAmt)}</strong></div>
                              <div className="flex flex-wrap gap-2 text-slate-400 dark:text-slate-500">
                                <span>Before HWM: <strong className={signedValueClass(_lpRcv)}>{signedValueText(_lpRcv)}</strong></span>
                                <span>PnL: <strong className={signedValueClass(_lpPnl)}>{signedValueText(_lpPnl)}</strong></span>
                                <span>Swap: <strong className={signedValueClass(_lpSwap)}>{signedValueText(_lpSwap)}</strong></span>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-1.5 space-y-0.5 text-xs text-slate-500">
                              <div className="flex flex-wrap gap-3">
                                <span>PnL: <strong className={signedValueClass(_lpPnl)}>{signedValueText(_lpPnl)}</strong></span>
                                <span>Swap: <strong className={signedValueClass(_lpSwap)}>{signedValueText(_lpSwap)}</strong></span>
                                <span>Unrealized: <strong className={signedValueClass(_lpUnreal)}>{signedValueText(_lpUnreal)}</strong></span>
                              </div>
                              {_wiAmt > 0 && (
                                <div className="text-violet-500 dark:text-violet-400">HWM buffer: <strong>{signedValueText(_wiAmt)}</strong></div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Client accounts table */}
                  <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60 overflow-hidden">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/40">
                      <button type="button" onClick={() => setBonusEquityClientTableExpanded((v) => !v)} className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300 hover:text-violet-500 transition">
                        {bonusEquityClientTableExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        Bonus Client Accounts
                        <span className="ml-1 rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">{accounts.length}</span>
                      </button>
                      {bonusEquityClientTableExpanded && (
                        <input value={bonusEquitySearch} onChange={(e) => { setBonusEquitySearch(e.target.value); setBonusEquityPage(0); }} placeholder="Search login…" className="w-40 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
                      )}
                    </div>
                    {bonusEquityClientTableExpanded && (
                      <>
                        <div className="overflow-x-auto">
                          <table className="min-w-full text-xs">
                            <thead className="bg-slate-50 text-slate-500 dark:bg-slate-900/50 dark:text-slate-400">
                              <tr>
                                <SortTh col="login" label="Login" sortState={es} onSort={onESort} className="text-left" />
                                <SortTh col="equity" label="Equity" sortState={es} onSort={onESort} className="text-right" />
                                <SortTh col="balance" label="Balance" sortState={es} onSort={onESort} className="text-right" />
                                <SortTh col="credit" label="Credit" sortState={es} onSort={onESort} className="text-right" />
                                <SortTh col="margin" label="Margin" sortState={es} onSort={onESort} className="text-right" />
                                <SortTh col="marginFree" label="Free Margin" sortState={es} onSort={onESort} className="text-right" />
                                <SortTh col="marginLevel" label="Margin %" sortState={es} onSort={onESort} className="text-right" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                              {eRows.map((acc, idx) => (
                                <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-900/40 transition-colors">
                                  <td className="px-3 py-2.5 font-mono font-semibold text-violet-700 dark:text-violet-200">{acc.login ?? "—"}</td>
                                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">{formatMaybeNumber(acc.equity, 2)}</td>
                                  <td className="px-3 py-2.5 text-right tabular-nums">{formatMaybeNumber(acc.balance, 2)}</td>
                                  <td className="px-3 py-2.5 text-right tabular-nums">{formatMaybeNumber(acc.credit, 2)}</td>
                                  <td className="px-3 py-2.5 text-right tabular-nums">{formatMaybeNumber(acc.margin, 2)}</td>
                                  <td className="px-3 py-2.5 text-right tabular-nums">{formatMaybeNumber(acc.marginFree, 2)}</td>
                                  <td className="px-3 py-2.5 text-right tabular-nums">{Number(acc.marginLevel) ? `${formatMaybeNumber(acc.marginLevel, 2)}%` : "—"}</td>
                                </tr>
                              ))}
                              {!eRows.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No accounts match search</td></tr>}
                            </tbody>
                          </table>
                        </div>
                        <Pagination page={ePage} total={eSorted.length} pageSize={TABLE_PAGE_SIZE} onPage={setBonusEquityPage} />
                      </>
                    )}
                  </div>
                </div>
              );
            };

            // ── Wrapper ───────────────────────────────────────────────────────
            return (
              <div className="space-y-4">
                {/* Page header with refresh */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-200/60 bg-gradient-to-r from-violet-50 to-indigo-50 px-4 py-3 dark:border-violet-800/30 dark:from-violet-900/20 dark:to-indigo-900/20">
                  <div>
                    <h2 className="text-sm font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                      Bonus Manager · {bonusShowOverview ? "Overview" : bonusSubTab === "Bonus Coverage" ? "Coverage" : bonusSubTab === "Bonus Risk" ? "Risk Exposure" : bonusSubTab === "Bonus PNL" ? "P&L Analysis" : "Equity Monitor"}
                    </h2>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {toReadable(fromDate)} — {toReadable(toDate)}
                      {bonusLastUpdated && <> · Updated {bonusLastUpdated.toLocaleTimeString()}</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {bonusError && <span className="rounded-md bg-rose-100 px-2.5 py-1 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">{bonusError}</span>}
                    <button type="button" onClick={handlePageRefresh} className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300/60 bg-white px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-800/40 dark:bg-slate-900 dark:text-violet-300 dark:hover:bg-violet-900/20 transition">
                      <RefreshCw className={`h-3.5 w-3.5 ${bonusLoading ? "animate-spin" : ""}`} /> Refresh
                    </button>
                  </div>
                </div>

                {!allowedBonusSubTabs.length ? (
                  <div className="rounded-lg border border-amber-400/30 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">No Bonus subtab access granted.</div>
                ) : bonusShowOverview ? (
                  <OverviewPage />
                ) : bonusSubTab === "Bonus Coverage" ? (
                  <CoverageTab />
                ) : bonusSubTab === "Bonus Risk" ? (
                  <RiskTab />
                ) : bonusSubTab === "Bonus PNL" ? (
                  <PnlTab />
                ) : bonusSubTab === "Bonus Equity" ? (
                  <EquityTab />
                ) : (
                  <OverviewPage />
                )}
              </div>
            );
          })()
          : activeMenu === "Contract Sizes" ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Contract Size Multipliers</h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Normalize client lots to LP-equivalent lots when contract sizes differ between servers.</p>
                </div>
                <div className="flex items-center gap-2">
                  {contractSizesLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {contractSizesLastUpdated.toLocaleTimeString()}</span>}
                  <button
                    type="button"
                    onClick={() => setContractSizesRefreshKey((k) => k + 1)}
                    className="inline-flex items-center gap-2 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 dark:text-cyan-200 hover:bg-cyan-500/20"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${contractSizesLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                </div>
              </div>

              <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-6">
                  <input
                    value={contractSymbolInput}
                    onChange={(e) => setContractSymbolInput(e.target.value.toUpperCase())}
                    placeholder="Symbol (e.g. US30)"
                    className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={detectContractSizes}
                    className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                  >
                    Detect
                  </button>
                  <input
                    value={contractClientCsInput}
                    onChange={(e) => setContractClientCsInput(e.target.value)}
                    placeholder="Client CS"
                    type="number"
                    min={0}
                    step="0.01"
                    className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  />
                  <input
                    value={contractLpCsInput}
                    onChange={(e) => setContractLpCsInput(e.target.value)}
                    placeholder="LP CS"
                    type="number"
                    min={0}
                    step="0.01"
                    className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  />
                  <input
                    readOnly
                    value={contractMultiplierValue === null ? "-" : contractMultiplierValue.toFixed(4)}
                    className="rounded border border-slate-300 bg-slate-100 px-2 py-1.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200"
                  />
                  <button
                    type="button"
                    onClick={addContractSizeEntry}
                    className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                  >
                    Add
                  </button>
                </div>
                {contractFormMessage && (
                  <div className={`mt-2 text-xs ${contractFormMessage.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
                    {contractFormMessage.text}
                  </div>
                )}
              </div>

              {contractSizesError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{contractSizesError}</div>
              )}

              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table data-table-kind="contract-sizes" className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">ID</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Client CS</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">LP CS</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Multiplier</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contractSizes.map((entry) => {
                      const editing = contractEditingId === entry.id;
                      return (
                        <tr key={entry.id} className="bg-slate-50 dark:bg-slate-950/30">
                          <td className="border-t border-slate-800 px-3 py-2">{entry.id}</td>
                          <td className="border-t border-slate-800 px-3 py-2 font-mono text-amber-700 dark:text-amber-300">{entry.symbol}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">
                            {editing ? (
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={contractEditClientCs}
                                onChange={(e) => setContractEditClientCs(e.target.value)}
                                className="w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                              />
                            ) : (
                              entry.clientContractSize
                            )}
                          </td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">
                            {editing ? (
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={contractEditLpCs}
                                onChange={(e) => setContractEditLpCs(e.target.value)}
                                className="w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                              />
                            ) : (
                              entry.lpContractSize
                            )}
                          </td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right font-semibold text-cyan-700 dark:text-cyan-300">{entry.multiplier.toFixed(4)}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">
                            {editing ? (
                              <div className="flex justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => void saveContractSizeEdit(entry.id)}
                                  className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setContractEditingId(null)}
                                  className="rounded border border-slate-400/40 bg-slate-500/10 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-500/20 dark:text-slate-200"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <div className="flex justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setContractEditingId(entry.id);
                                    setContractEditClientCs(String(entry.clientContractSize));
                                    setContractEditLpCs(String(entry.lpContractSize));
                                  }}
                                  className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-700 hover:bg-cyan-500/20 dark:text-cyan-300"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteContractSizeEntry(entry.id)}
                                  className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!contractSizesLoading && !contractSizes.length && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
                  No contract size multipliers configured.
                </div>
              )}
            </section>
          ) : activeMenu === "Deal Matching" ? (
            <DealMatchingTab baseUrl={BACKEND_BASE_URL} />
          ) : activeMenu === "Swap Tracker" ? (
            <section
              className={`rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 ${
                fullscreenTable === "swap" ? "fixed inset-3 z-50 flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-950" : ""
              }`}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Swap-Free Tracker</h2>
                <div className="flex items-center gap-2">
                  {swapLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {swapLastUpdated.toLocaleTimeString()}</span>}
                  <button
                    type="button"
                    onClick={handleSwapSnapshot}
                    disabled={snapshottingTable === "swap" || swapLoading || !swapRows.length}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Camera className={`h-3.5 w-3.5 ${snapshottingTable === "swap" ? "animate-pulse" : ""}`} />
                    {snapshottingTable === "swap" ? "Capturing..." : "Snapshot"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFullscreenTable((v) => (v === "swap" ? null : "swap"))}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20"
                  >
                    {fullscreenTable === "swap" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    {fullscreenTable === "swap" ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                </div>
              </div>
              {swapError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{swapError}</div>
              )}
              <div className={`min-h-0 rounded-lg border border-slate-800 ${fullscreenTable === "swap" ? "flex-1 overflow-auto" : "overflow-x-auto"}`}>
                <table data-table-kind="swap" className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">LP</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Ticket</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Side</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Volume</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Swap ($)</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Swap Free Days</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Days Used</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Days Left</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Charge Tonight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {swapRows.map((row, idx) => (
                      <tr key={`${row.lpName}-${row.ticket}-${idx}`} className="bg-slate-50 dark:bg-slate-950/30">
                        <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{row.lpName}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-left text-slate-500 dark:text-slate-400">{row.ticket}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-left">{row.symbol}</td>
                        <td className={`border-t border-slate-800 px-3 py-2 text-right ${row.side === "Buy" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{row.side}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{row.volume.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className={`border-t border-slate-800 px-3 py-2 text-right ${row.swap > 0.005 ? "text-emerald-700 dark:text-emerald-300" : row.swap < -0.005 ? "text-rose-700 dark:text-rose-300" : "text-amber-700 dark:text-amber-300"}`}>
                          {row.swap.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{row.swapFreeDays === null ? <span className="text-slate-500">-</span> : row.swapFreeDays}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{row.daysUsed}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">
                          {row.daysLeft === 0 && row.willChargeTonight ? (
                            <span className="rounded bg-rose-400 px-2 py-0.5 text-[11px] font-semibold text-slate-950">{row.daysLeft}</span>
                          ) : row.daysLeft <= 2 && row.daysLeft > 0 ? (
                            <span className="rounded bg-amber-300 px-2 py-0.5 text-[11px] font-semibold text-slate-950">{row.daysLeft}</span>
                          ) : row.daysLeft > 2 ? (
                            <span className="rounded bg-emerald-300 px-2 py-0.5 text-[11px] font-semibold text-slate-950">{row.daysLeft}</span>
                          ) : (
                            <span className="text-slate-500">-</span>
                          )}
                        </td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">
                          {row.willChargeTonight ? (
                            <span className="rounded bg-rose-400 px-2 py-0.5 text-[11px] font-semibold text-slate-950">YES</span>
                          ) : (
                            <span className="text-slate-500">No</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!swapLoading && !swapRows.length && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">No positions found.</div>
              )}
            </section>
          ) : activeMenu === "History" ? (
            <section
              className={`rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 ${
                fullscreenTable === "history" ? "fixed inset-3 z-50 flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-950" : ""
              }`}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">History & Revenue Share</h2>
                <div className="flex items-center gap-2">
                  {historyLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {historyLastUpdated.toLocaleTimeString()}</span>}
                  <button
                    type="button"
                    onClick={handleHistorySnapshot}
                    disabled={
                      snapshottingTable === "history" ||
                      historyLoading ||
                      (historyTab === "aggregate" && !historyAggregateVisibleItems.length) ||
                      (historyTab === "deals" && !(historyDealsData?.deals || []).length) ||
                      (historyTab === "volume" && !(historyVolumeData?.items || []).length)
                    }
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Camera className={`h-3.5 w-3.5 ${snapshottingTable === "history" ? "animate-pulse" : ""}`} />
                    {snapshottingTable === "history" ? "Capturing..." : "Snapshot"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFullscreenTable((v) => (v === "history" ? null : "history"))}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-500/20"
                  >
                    {fullscreenTable === "history" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    {fullscreenTable === "history" ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                </div>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                {[
                  { id: "aggregate", label: "Revenue Share" },
                  { id: "deals", label: "Trade Deals" },
                  { id: "volume", label: "Volume (Yards)" },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setHistoryTab(tab.id as "aggregate" | "deals" | "volume")}
                    className={`rounded-md border px-3 py-1.5 text-xs ${
                      historyTab === tab.id
                        ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-100"
                        : "border-slate-300 bg-white text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:border-slate-600"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => void handleHistoryLoad()}
                  className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-500/20"
                >
                  Load
                </button>

                {historyTab === "aggregate" && historyAggregateHiddenRowsCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setHistoryShowLowNtpRows((value) => !value)}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-400/40 bg-slate-500/10 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-500/20 dark:text-slate-200"
                  >
                    {historyShowLowNtpRows ? "Hide 0% NTP Rows" : `Show 0% NTP Rows (${historyAggregateHiddenRowsCount})`}
                  </button>
                )}

                {historyTab === "deals" && (
                  <>
                    <select
                      value={historySelectedLogin}
                      onChange={(e) => setHistorySelectedLogin(e.target.value)}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    >
                      <option value="">Select LP</option>
                      {historyLpAccounts.map((lp) => (
                        <option key={`${lp.lpName}-${lp.mt5Login}`} value={String(lp.mt5Login)}>
                          {lp.lpName} ({lp.mt5Login})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleHistoryLoad()}
                      className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-500/20"
                    >
                      Load Deals
                    </button>
                    <button
                      type="button"
                      onClick={exportHistoryDealsCsv}
                      disabled={!historyDealsData?.deals?.length}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Export CSV
                    </button>
                  </>
                )}
              </div>

              {historyError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{historyError}</div>
              )}

              {historyTab === "aggregate" && !historyShowLowNtpRows && historyAggregateHiddenRowsCount > 0 && (
                <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                  {historyAggregateHiddenRowsCount} row{historyAggregateHiddenRowsCount === 1 ? " is" : "s are"} hidden (NTP % = 0).
                </div>
              )}

              {historyTab === "aggregate" && (
                <div className={`${fullscreenTable === "history" ? "min-h-0 flex-1 overflow-auto" : ""}`}>
                  <SortableTable
                    tableId="dealing-history-aggregate-table"
                    enableColumnVisibility
                    rows={historyAggregateVisibleItems}
                    columns={historyAggregateColumns}
                    exportFilePrefix="history-revenue-share"
                    emptyText="No revenue-share rows available for this range."
                    rowClassName={(row) => (row.isError ? "bg-slate-50 opacity-50 dark:bg-slate-950/30" : "bg-slate-50 dark:bg-slate-950/30")}
                  />
                  {historyAggregateVisibleTotals && (
                    <div className="mt-2 rounded-lg border border-slate-800 bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40">
                      <span className="font-semibold text-slate-600 dark:text-slate-300">Totals:</span>{" "}
                      <span className="text-slate-500 dark:text-slate-400">
                        StartEq {historyAggregateVisibleTotals.startEquity.toLocaleString()} | EndEq {historyAggregateVisibleTotals.endEquity.toLocaleString()} | Credit {historyAggregateVisibleTotals.credit.toLocaleString()} | Deposit {historyAggregateVisibleTotals.deposit.toLocaleString()} | Withdrawal {historyAggregateVisibleTotals.withdrawal.toLocaleString()} | NetDep {historyAggregateVisibleTotals.netDeposits.toLocaleString()} | Gross {historyAggregateVisibleTotals.grossProfit.toLocaleString()} | Commission {historyAggregateVisibleTotals.totalCommission.toLocaleString()} | Swap {historyAggregateVisibleTotals.totalSwap.toLocaleString()} | NetPL {historyAggregateVisibleTotals.netPL.toLocaleString()} | RealLP {historyAggregateVisibleTotals.realLpPL.toLocaleString()} | LPPL {historyAggregateVisibleTotals.lpPL.toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {historyTab === "deals" && (
                <div className={`${fullscreenTable === "history" ? "min-h-0 flex-1 overflow-auto" : ""}`}>
                  <SortableTable
                    tableId="dealing-history-deals-table"
                    enableColumnVisibility
                    rows={historyDealsData?.deals || []}
                    columns={historyDealsColumns}
                    exportFilePrefix="history-deals"
                    emptyText="No history deals available for this range."
                  />
                </div>
              )}

              {historyTab === "volume" && (
                <div className={`${fullscreenTable === "history" ? "min-h-0 flex-1 overflow-auto" : ""}`}>
                  <SortableTable
                    tableId="dealing-history-volume-table"
                    enableColumnVisibility
                    rows={(historyVolumeData?.items || []).filter((item) => !item.isError)}
                    columns={historyVolumeColumns}
                    exportFilePrefix="history-volume"
                    emptyText="No history volume available for this range."
                  />
                  {historyVolumeData?.totals && (
                    <div className="mt-2 rounded-lg border border-slate-800 bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40">
                      <span className="font-semibold text-slate-600 dark:text-slate-300">Totals:</span>{" "}
                      <span className="text-slate-500 dark:text-slate-400">
                        Trades {historyVolumeData.totals.tradeCount.toLocaleString()} | Lots {historyVolumeData.totals.totalLots.toLocaleString(undefined, { maximumFractionDigits: 2 })} | Notional {historyVolumeData.totals.notionalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} | Yards {historyVolumeData.totals.volumeYards.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {!historyLoading &&
                ((historyTab === "aggregate" && !historyAggregateVisibleItems.length) ||
                  (historyTab === "deals" && !(historyDealsData?.deals || []).length) ||
                  (historyTab === "volume" && !(historyVolumeData?.items || []).length)) && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
                    No history data available for this range.
                  </div>
                )}
            </section>
          ) : activeMenu === "Clients NOP" ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Clients NOP Report</h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Grouped buy/sell client exposure per symbol with net lots and margin profile.</p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-600 dark:text-slate-300">Symbol</label>
                  <select
                    value={nopSymbol}
                    onChange={(e) => setNopSymbol(e.target.value)}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  >
                    <option value="">All Symbols</option>
                    {nopSymbolsAll.map((symbol) => (
                      <option key={`nop-symbol-${symbol}`} value={symbol}>
                        {symbol}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handlePageRefresh}
                    className="inline-flex items-center gap-2 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 dark:text-cyan-200 hover:bg-cyan-500/20"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${nopLoading ? "animate-spin" : ""}`} />
                    Load
                  </button>
                </div>
              </div>

              <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
                <span>Timestamp: <span className="font-mono text-slate-700 dark:text-slate-200">{nopData?.timestamp || "-"}</span></span>
                <span>Accounts: <span className="font-mono text-slate-700 dark:text-slate-200">{(nopData?.accountsReporting || 0).toLocaleString()}</span></span>
                <span>Logins with positions: <span className="font-mono text-slate-700 dark:text-slate-200">{(nopData?.collectedLogins || 0).toLocaleString()}</span></span>
                {nopLastUpdated && <span>Updated {nopLastUpdated.toLocaleTimeString()}</span>}
              </div>

              {nopError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{nopError}</div>
              )}

              <div className="space-y-4">
                {(nopData?.symbols || []).map((sym) => {
                  const netCls = sym.netTotal > 0 ? "text-emerald-700 dark:text-emerald-300" : sym.netTotal < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500";
                  return (
                    <section key={`nop-${sym.symbol}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40">
                      <div className="mb-3 flex items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900/70">
                        <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">{sym.symbol}</span>
                        <span className="text-xs">NET: <span className={`font-mono font-semibold ${netCls}`}>{formatMaybeNumber(sym.netTotal, 2)} lots</span></span>
                      </div>

                      {sym.buyClients?.length > 0 && (
                        <div className="mb-3">
                          <div className="mb-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                            BUY ({sym.buyClients.length} clients)
                          </div>
                          <div className="overflow-x-auto rounded-lg border border-slate-800">
                            <table data-table-kind="nop-buy" className="min-w-full text-xs">
                              <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                                <tr>
                                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Login</th>
                                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Name</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Volume</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Real Limit</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">MT5 Limit</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Equity</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Credit</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Balance</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Free</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Margin</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">M.LVL</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sym.buyClients.map((c, idx) => (
                                  <tr
                                    key={`nop-buy-${sym.symbol}-${c.login}-${idx}`}
                                    className={`${Number(c.realLimit) > 0 && Math.abs(Number(c.volume) || 0) > Number(c.realLimit) ? "bg-rose-500/10" : "bg-slate-50 dark:bg-slate-950/30"}`}
                                  >
                                    <td className="border-t border-slate-800 px-3 py-2 text-left font-mono">{c.login}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-left">{c.name || "-"}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right font-semibold text-emerald-700 dark:text-emerald-300">{formatMaybeNumber(c.volume, 2)}</td>
                                    <td
                                      className={`border-t border-slate-800 px-3 py-2 text-right ${Number(c.realLimit) > 0 && Math.abs(Number(c.volume) || 0) > Number(c.realLimit) ? "font-semibold text-rose-700 dark:text-rose-300" : "text-slate-500 dark:text-slate-400"}`}
                                    >
                                      {Number(c.realLimit) > 0 ? formatMaybeNumber(c.realLimit, 2) : "-"}
                                    </td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right text-slate-500 dark:text-slate-400">{c.mt5Limit ? formatMaybeNumber(c.mt5Limit, 2) : "Unlimited"}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.equity, 2)}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.credit, 2)}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.balance, 2)}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.marginFree, 2)}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.margin, 2)}</td>
                                    <td
                                      className={`border-t border-slate-800 px-3 py-2 text-right ${
                                        !Number.isFinite(Number(c.marginLevel)) || Number(c.marginLevel) <= 0
                                          ? "text-slate-500 dark:text-slate-400"
                                          : Number(c.marginLevel) >= 200
                                            ? "text-emerald-700 dark:text-emerald-300"
                                            : Number(c.marginLevel) >= 100
                                              ? "text-slate-700 dark:text-slate-200"
                                              : "text-rose-700 dark:text-rose-300"
                                      }`}
                                    >
                                      {c.marginLevel ? `${formatMaybeNumber(c.marginLevel, 2)}%` : "-"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="bg-slate-200/80 dark:bg-slate-900/95 font-semibold text-slate-700 dark:text-slate-200">
                                  <td className="px-3 py-2 text-right" colSpan={2}>TOTAL</td>
                                  <td className="px-3 py-2 text-right text-emerald-700 dark:text-emerald-300">{formatMaybeNumber(sym.buyTotal, 2)}</td>
                                  <td className="px-3 py-2" colSpan={8} />
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      )}

                      {sym.sellClients?.length > 0 && (
                        <div className="mb-3">
                          <div className="mb-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
                            SELL ({sym.sellClients.length} clients)
                          </div>
                          <div className="overflow-x-auto rounded-lg border border-slate-800">
                            <table data-table-kind="nop-sell" className="min-w-full text-xs">
                              <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                                <tr>
                                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Login</th>
                                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Name</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Volume</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Real Limit</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">MT5 Limit</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Equity</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Credit</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Balance</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Free</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Margin</th>
                                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">M.LVL</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sym.sellClients.map((c, idx) => (
                                  <tr
                                    key={`nop-sell-${sym.symbol}-${c.login}-${idx}`}
                                    className={`${Number(c.realLimit) > 0 && Math.abs(Number(c.volume) || 0) > Number(c.realLimit) ? "bg-rose-500/10" : "bg-slate-50 dark:bg-slate-950/30"}`}
                                  >
                                    <td className="border-t border-slate-800 px-3 py-2 text-left font-mono">{c.login}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-left">{c.name || "-"}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right font-semibold text-rose-700 dark:text-rose-300">{formatMaybeNumber(c.volume, 2)}</td>
                                    <td
                                      className={`border-t border-slate-800 px-3 py-2 text-right ${Number(c.realLimit) > 0 && Math.abs(Number(c.volume) || 0) > Number(c.realLimit) ? "font-semibold text-rose-700 dark:text-rose-300" : "text-slate-500 dark:text-slate-400"}`}
                                    >
                                      {Number(c.realLimit) > 0 ? formatMaybeNumber(c.realLimit, 2) : "-"}
                                    </td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right text-slate-500 dark:text-slate-400">{c.mt5Limit ? formatMaybeNumber(c.mt5Limit, 2) : "Unlimited"}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.equity, 2)}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.credit, 2)}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.balance, 2)}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.marginFree, 2)}</td>
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{formatMaybeNumber(c.margin, 2)}</td>
                                    <td
                                      className={`border-t border-slate-800 px-3 py-2 text-right ${
                                        !Number.isFinite(Number(c.marginLevel)) || Number(c.marginLevel) <= 0
                                          ? "text-slate-500 dark:text-slate-400"
                                          : Number(c.marginLevel) >= 200
                                            ? "text-emerald-700 dark:text-emerald-300"
                                            : Number(c.marginLevel) >= 100
                                              ? "text-slate-700 dark:text-slate-200"
                                              : "text-rose-700 dark:text-rose-300"
                                      }`}
                                    >
                                      {c.marginLevel ? `${formatMaybeNumber(c.marginLevel, 2)}%` : "-"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="bg-slate-200/80 dark:bg-slate-900/95 font-semibold text-slate-700 dark:text-slate-200">
                                  <td className="px-3 py-2 text-right" colSpan={2}>TOTAL</td>
                                  <td className="px-3 py-2 text-right text-rose-700 dark:text-rose-300">{formatMaybeNumber(sym.sellTotal, 2)}</td>
                                  <td className="px-3 py-2" colSpan={8} />
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      )}

                      <div className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900/70">
                        <span className="font-semibold">NET TOTAL: </span>
                        <span className={`font-mono font-semibold ${netCls}`}>{formatMaybeNumber(sym.netTotal, 2)} lots</span>
                      </div>
                    </section>
                  );
                })}
              </div>

              {!nopLoading && !(nopData?.symbols || []).length && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
                  No positions found for the selected symbol.
                </div>
              )}
            </section>
          ) : activeMenu === "Client Profiling" ? (
            <ClientProfilingTab
              fromDate={toYmd(selectedFromDate)}
              toDate={toYmd(selectedToDate)}
              refreshKey={refreshKey}
              onFromDateChange={(value) => setSelectedFromDate(parseDateInput(value, selectedFromDate))}
              onToDateChange={(value) => setSelectedToDate(parseDateInput(value, selectedToDate))}
              onRefresh={handlePageRefresh}
            />
          ) : activeMenu === "Rebate Calculator" ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">IB Rebate Calculator (MT5 Side)</h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Upload rules CSV for current IB, select date range, then calculate from IB tree to accounts to trades.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {rebateLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {rebateLastUpdated.toLocaleTimeString()}</span>}
                  <button
                    type="button"
                    onClick={downloadRebateSampleCsv}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-slate-600"
                  >
                    Download Sample CSV
                  </button>
                </div>
              </div>

              <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-6">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">IB CRM ID</label>
                  <input
                    type="number"
                    value={rebateIbId}
                    onChange={(e) => setRebateIbId(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    placeholder="10342"
                  />
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Default Rebate/Lot</label>
                  <input
                    type="number"
                    step="0.01"
                    value={rebateDefaultRate}
                    onChange={(e) => setRebateDefaultRate(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    placeholder="2.00"
                  />
                  <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                    Used for all symbols if no CSV; also fallback for symbols not in CSV.
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">From Date</label>
                  <input
                    type="date"
                    value={rebateFromDate}
                    onChange={(e) => setRebateFromDate(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  />
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">To Date</label>
                  <input
                    type="date"
                    value={rebateToDate}
                    onChange={(e) => setRebateToDate(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  />
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Rebate Rules CSV</label>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => handleRebateCsvUpload(e.target.files?.[0])}
                    className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-cyan-500/15 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-cyan-800 hover:file:bg-cyan-500/20 dark:text-slate-300 dark:file:text-cyan-100"
                  />
                  <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                    Loaded rules: <span className="font-mono">{rebateRules.length}</span>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50 flex items-end">
                  <button
                    type="button"
                    onClick={runRebateCalculation}
                    disabled={rebateCalcLoading}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-2 text-xs font-medium text-cyan-900 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:text-cyan-100"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${rebateCalcLoading ? "animate-spin" : ""}`} />
                    {rebateCalcLoading ? "Running..." : "Run MT5 Calculation"}
                  </button>
                </div>
              </div>

              {rebateRulesError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{rebateRulesError}</div>
              )}
              {rebateCalcError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{rebateCalcError}</div>
              )}

              <div className="rounded-lg border border-slate-800 overflow-x-auto">
                <table data-table-kind="rebate-rules" className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Login</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Trades</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Traded Lots</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Eligible Lots</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Non-Eligible Lots</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Rebate/Lot</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">MT5 Commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rebateCalcRows.map((row) => (
                        <tr key={`${row.login}-${row.symbol}-${row.rebatePerLot}`} className="bg-slate-50 dark:bg-slate-950/30">
                          <td className="border-t border-slate-800 px-3 py-2 font-mono">{row.login}</td>
                          <td className="border-t border-slate-800 px-3 py-2 font-mono">{row.symbol}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{row.trades.toLocaleString()}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{row.tradedLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right text-emerald-700 dark:text-emerald-300">{row.eligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right text-amber-700 dark:text-amber-300">{row.ineligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">${row.rebatePerLot.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">${row.mt5CommissionUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        </tr>
                    ))}
                  </tbody>
                  {rebateCalcRows.length > 0 && (
                    <tfoot>
                      <tr className="bg-slate-200/80 dark:bg-slate-900/95 font-semibold text-slate-700 dark:text-slate-200">
                        <td className="px-3 py-2">TOTAL</td>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-right">{rebateCalcTotals.trades.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{rebateCalcTotals.tradedLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2 text-right">{rebateCalcTotals.eligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2 text-right">{rebateCalcTotals.ineligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2 text-right" />
                        <td className="px-3 py-2 text-right">${rebateCalcTotals.commission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>

              {rebateSymbolTotals.length > 0 && (
                <div className="mt-4 rounded-lg border border-slate-800 overflow-x-auto">
                  <table data-table-kind="rebate-result" className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Trades</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Traded Lots</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Eligible Lots</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Non-Eligible Lots</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rebateSymbolTotals.map((row) => (
                        <tr key={`symbol-total-${row.symbol}`} className="bg-slate-50 dark:bg-slate-950/30">
                          <td className="border-t border-slate-800 px-3 py-2 font-mono">{row.symbol}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{row.trades.toLocaleString()}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{row.tradedLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right text-emerald-700 dark:text-emerald-300">{row.eligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right text-amber-700 dark:text-amber-300">{row.ineligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">${row.commission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {!rebateCalcLoading && rebateCalcRows.length === 0 && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
                  Upload rules CSV and run calculation to see MT5-side commission totals.
                </div>
              )}

              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300">
                Priority: exact/wildcard CSV rule first, then default rebate rate fallback. If both are missing, symbol rebate is treated as 0.
              </div>
            </section>
          ) : (
            <>
              {overviewError && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{overviewError}</div>}

              <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 xl:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Risk & Coverage</h2>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                        <span className="rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">{riskCoverageSummary.symbols} symbols</span>
                        <span className="rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">Coverage {riskCoverageSummary.coveragePct.toFixed(1)}%</span>
                        <span className="rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">Worst {riskCoverageSummary.worstSymbol} {signedValueText(riskCoverageSummary.worstUncovered)}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveMenu("Coverage")}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        Coverage
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveMenu("Risk Exposure")}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        Risk
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="grid grid-cols-[auto_minmax(120px,1.2fr)_70px_90px_110px_110px_110px] items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-400">
                      <span></span>
                      <span>Symbol</span>
                      <span className="text-right">Pos</span>
                      <span className="text-right">Lots</span>
                      <span className="text-right">Client Net</span>
                      <span className="text-right">LP Coverage</span>
                      <span className="text-right">Uncovered</span>
                    </div>

                    {!riskCoverageRows.length && (
                      <div className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">No uncovered symbols in this range.</div>
                    )}

                    {riskCoverageRows.map((row) => {
                      const lpCoverage = row.clientNet - row.uncovered;
                      const isExpanded = overviewRiskExpandedSymbol === row.symbol;
                      return (
                        <div key={row.symbol} className="border-t border-slate-200 first:border-t-0 dark:border-slate-800">
                          <button
                            type="button"
                            onClick={() => setOverviewRiskExpandedSymbol((current) => (current === row.symbol ? null : row.symbol))}
                            className="grid w-full grid-cols-[auto_minmax(120px,1.2fr)_70px_90px_110px_110px_110px] items-center gap-3 px-3 py-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-slate-900/50"
                          >
                            <span className="text-slate-400 dark:text-slate-500">{isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">{row.symbol}</span>
                                {isGoldSymbol(row.symbol) && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">Gold</span>}
                              </div>
                              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{row.subSymbols.length} sub-symbols</div>
                            </div>
                            <span className="text-right text-sm text-slate-700 dark:text-slate-300">{row.positions}</span>
                            <span className={`text-right text-sm ${signedValueClass(row.lots)}`}>{signedValueText(row.lots)}</span>
                            <span className={`text-right text-sm ${signedValueClass(row.clientNet)}`}>{signedValueText(row.clientNet)}</span>
                            <span className={`text-right text-sm ${signedValueClass(lpCoverage)}`}>{signedValueText(lpCoverage)}</span>
                            <span className={`text-right text-sm font-semibold ${signedValueClass(row.uncovered)}`}>{signedValueText(row.uncovered)}</span>
                          </button>

                          {isExpanded && (
                            <div className="border-t border-slate-200 bg-slate-50/70 px-3 py-3 dark:border-slate-800 dark:bg-slate-950/40">
                              <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                                <span className="rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">Client {signedValueText(row.clientNet)}</span>
                                <span className="rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">LP {signedValueText(lpCoverage)}</span>
                                <span className="rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">Uncovered {signedValueText(row.uncovered)}</span>
                              </div>
                              {row.subSymbols.length > 0 ? (
                                <div className="overflow-x-auto">
                                  <table className="min-w-full text-xs">
                                    <thead>
                                      <tr className="text-slate-500 dark:text-slate-400">
                                        <th className="px-2 py-1 text-left font-semibold uppercase tracking-wide">Sub Symbol</th>
                                        <th className="px-2 py-1 text-right font-semibold uppercase tracking-wide">Net Lots</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {row.subSymbols.map((sub) => (
                                        <tr key={`${row.symbol}-${sub.symbol}`} className="border-t border-slate-200 dark:border-slate-800">
                                          <td className="px-2 py-1.5 font-mono text-slate-700 dark:text-slate-300">{sub.symbol}</td>
                                          <td className={`px-2 py-1.5 text-right ${signedValueClass(sub.netExposureLots)}`}>{signedValueText(sub.netExposureLots)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                <div className="text-xs text-slate-500 dark:text-slate-400">No split routing detail available for this symbol.</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 xl:col-span-1">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Live Notifications</h2>
                  <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                    {!liveNotifications.length && (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
                        {liveEnabledEvents.length === 0 ? "Enable at least one alert in Settings > Alerts." : "Waiting for live notifications..."}
                      </div>
                    )}
                    {liveNotifications.map((n) => (
                      <div
                        key={n.id}
                        className={`rounded-lg border p-2.5 text-xs ${
                          n.type === "warning"
                            ? "border-amber-300/40 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10"
                            : n.type === "success"
                              ? "border-emerald-300/40 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/10"
                              : "border-cyan-300/40 bg-cyan-50/70 dark:border-cyan-500/30 dark:bg-cyan-500/10"
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {n.type === "warning" ? (
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300" />
                            ) : n.type === "success" ? (
                              <Bell className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" />
                            ) : (
                              <Info className="h-3.5 w-3.5 text-cyan-700 dark:text-cyan-300" />
                            )}
                            <span className="font-medium text-slate-900 dark:text-slate-100 truncate">{n.title}</span>
                            <span className="rounded-full border border-slate-300/70 bg-white/70 px-2 py-0.5 text-[10px] font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                              {n.eventName}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">{n.at}</span>
                        </div>
                        <div className="text-xs text-slate-600 dark:text-slate-300">{n.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
    )
  );
}







