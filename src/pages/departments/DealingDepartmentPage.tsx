import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Activity, DollarSign, Gauge, RefreshCw, TrendingDown, TrendingUp, Users } from "lucide-react";
import { getDealsByGroup, getPositionsByGroup, getSummaryByGroup } from "@/lib/dealingApi";
import { SignalRConnectionManager } from "@/lib/signalRConnectionManager";

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
  lpNets?: Record<string, number>;
};

type CoverageData = {
  rows: CoverageRow[];
  lpNames: string[];
  totals: {
    clientNet: number;
    uncovered: number;
    lpNets?: Record<string, number>;
  };
};

type MetricsItem = {
  lp: string;
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

type DealingOverviewData = {
  coverage: CoverageData | null;
  lpMetrics: MetricsData | null;
  swaps: SwapPosition[];
  historyAggregate: HistoryAggregateData | null;
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

const isGoldSymbol = (symbol: string) => {
  const s = String(symbol || "").toUpperCase();
  return s === "XAUUSD" || s.startsWith("GOLD");
};

const formatCoverageVal = (value: number) => {
  if (value === 0) return <span className="text-slate-500">0.00</span>;
  if (value > 0) return <span className="text-emerald-300">{value.toFixed(2)}</span>;
  return <span className="text-rose-300">{value.toFixed(2)}</span>;
};

const formatPctClass = (value: number) => {
  if (!Number.isFinite(value)) return "text-slate-500";
  if (value >= 90) return "text-emerald-300";
  if (value >= 50) return "text-amber-300";
  return "text-rose-300";
};

const formatDollar = (value: number) => {
  const abs = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value === 0) return <span className="text-slate-500">$0.00</span>;
  if (value > 0) return <span className="text-emerald-300">${abs}</span>;
  return <span className="text-rose-300">-${abs}</span>;
};

const escapeCsv = (value: string | number | null | undefined) => {
  const raw = value === null || value === undefined ? "" : String(value);
  if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

export function DealingDepartmentPage() {
  const [fromDate, setFromDate] = useState<Date>(() => new Date());
  const [toDate, setToDate] = useState<Date>(() => new Date());
  const [isLoading, setIsLoading] = useState(false);
  const [metrics, setMetrics] = useState<DealingMetrics>(DEFAULT_METRICS);
  const [topSymbols, setTopSymbols] = useState<SymbolActivity[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeMenu, setActiveMenu] = useState("Dealing");
  const [coverageData, setCoverageData] = useState<CoverageData | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [coverageStatus, setCoverageStatus] = useState<"connected" | "connecting" | "disconnected">("disconnected");
  const [coverageLastUpdated, setCoverageLastUpdated] = useState<Date | null>(null);
  const [coverageRefreshKey, setCoverageRefreshKey] = useState(0);
  const coverageSignalRRef = useRef<SignalRConnectionManager | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsData | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLastUpdated, setMetricsLastUpdated] = useState<Date | null>(null);
  const [metricsRefreshKey, setMetricsRefreshKey] = useState(0);
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
  const [overviewData, setOverviewData] = useState<DealingOverviewData>({
    coverage: null,
    lpMetrics: null,
    swaps: [],
    historyAggregate: null,
  });
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewLastUpdated, setOverviewLastUpdated] = useState<Date | null>(null);

  const modeLabel = isUtcTodaySelection(fromDate, toDate) ? "Live" : "Reports";
  const menuLoading =
    activeMenu === "Coverage" || activeMenu === "Risk Exposure"
      ? coverageLoading
      : activeMenu === "Metrics"
        ? metricsLoading
      : activeMenu === "Swap Tracker"
        ? swapLoading
        : activeMenu === "History"
          ? historyLoading
          : isLoading;

  useEffect(() => {
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
  }, [fromDate, toDate, refreshKey]);

  const cards = useMemo(
    () => [
      { label: "Total Equity", value: `$${metrics.totalEquity.toLocaleString()}`, icon: DollarSign },
      { label: "Total Credit", value: `$${metrics.totalCredit.toLocaleString()}`, icon: DollarSign },
      { label: "Clients With Credit", value: metrics.clientsWithCredit.toLocaleString(), icon: Users },
      { label: "Trading Profit", value: `$${metrics.tradingProfit.toLocaleString()}`, icon: Activity },
      { label: "Net Lots", value: `${metrics.netLots.toFixed(2)} lots`, icon: Gauge },
      { label: "Buy Lots", value: `${metrics.buyLots.toFixed(2)} lots`, icon: TrendingUp },
      { label: "Sell Lots", value: `${metrics.sellLots.toFixed(2)} lots`, icon: TrendingDown },
      { label: "Deals", value: metrics.dealCount.toLocaleString(), icon: Activity },
    ],
    [metrics]
  );

  const menuItems = [
    "Dealing",
    "Risk Exposure",
    "Coverage",
    "Metrics",
    "Deal Matching",
    "History",
    "Swap Tracker",
  ];

  const handlePageRefresh = () => {
    if (activeMenu === "Coverage" || activeMenu === "Risk Exposure") {
      setCoverageRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Metrics") {
      setMetricsRefreshKey((k) => k + 1);
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
    setRefreshKey((k) => k + 1);
  };

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

    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const coverageEndpoint = backendBaseUrl ? `${backendBaseUrl}/Coverage/position-match-table` : "/Coverage/position-match-table";
    const hubUrl = backendBaseUrl ? `${backendBaseUrl}/ws/dashboard` : "/ws/dashboard";
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

    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl ? `${backendBaseUrl}/Metrics/lp` : "/Metrics/lp";
    let cancelled = false;

    const fetchMetrics = async () => {
      if (cancelled) return;
      setMetricsLoading(true);
      try {
        const resp = await fetch(endpoint);
        if (!resp.ok) throw new Error(`Metrics API ${resp.status}`);
        const data = (await resp.json()) as MetricsData;
        if (cancelled) return;
        setMetricsData(data);
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
    if (activeMenu !== "Swap Tracker") {
      setSwapError(null);
      return;
    }

    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl ? `${backendBaseUrl}/Swap/positions` : "/Swap/positions";
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

  const coverageRows = useMemo(() => {
    if (!coverageData?.rows) return { gold: [] as CoverageRow[], rest: [] as CoverageRow[] };
    const gold = coverageData.rows.filter((row) => isGoldSymbol(row.symbol)).sort((a, b) => a.symbol.localeCompare(b.symbol));
    const rest = coverageData.rows.filter((row) => !isGoldSymbol(row.symbol)).sort((a, b) => a.symbol.localeCompare(b.symbol));
    return { gold, rest };
  }, [coverageData]);

  const coverageGoldTotals = useMemo(() => {
    const gold = coverageRows.gold;
    const lpTotals: Record<string, number> = {};
    (coverageData?.lpNames || []).forEach((lp) => {
      lpTotals[lp] = gold.reduce((sum, row) => sum + (row.lpNets?.[lp] || 0), 0);
    });
    return {
      clientNet: gold.reduce((sum, row) => sum + row.clientNet, 0),
      uncovered: gold.reduce((sum, row) => sum + row.uncovered, 0),
      lpTotals,
    };
  }, [coverageRows.gold, coverageData?.lpNames]);

  const historyTimestamps = useMemo(() => {
    const from = Math.floor(getUtcDayStartFromLocalDate(fromDate).getTime() / 1000);
    const to = Math.floor(getUtcDayEndFromLocalDate(toDate).getTime() / 1000);
    return { from, to };
  }, [fromDate, toDate]);

  useEffect(() => {
    if (activeMenu !== "Dealing") {
      setOverviewError(null);
      return;
    }

    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    let cancelled = false;

    const loadOverview = async () => {
      setOverviewLoading(true);
      setOverviewError(null);
      try {
        const coverageEndpoint = backendBaseUrl ? `${backendBaseUrl}/Coverage/position-match-table` : "/Coverage/position-match-table";
        const metricsEndpoint = backendBaseUrl ? `${backendBaseUrl}/Metrics/lp` : "/Metrics/lp";
        const swapEndpoint = backendBaseUrl ? `${backendBaseUrl}/Swap/positions` : "/Swap/positions";
        const historyEndpoint = backendBaseUrl
          ? `${backendBaseUrl}/History/aggregate?from=${historyTimestamps.from}&to=${historyTimestamps.to}`
          : `/History/aggregate?from=${historyTimestamps.from}&to=${historyTimestamps.to}`;

        const [coverageResp, metricsResp, swapResp, historyResp] = await Promise.allSettled([
          fetch(coverageEndpoint),
          fetch(metricsEndpoint),
          fetch(swapEndpoint),
          fetch(historyEndpoint),
        ]);

        const nextData: DealingOverviewData = {
          coverage: null,
          lpMetrics: null,
          swaps: [],
          historyAggregate: null,
        };

        if (coverageResp.status === "fulfilled" && coverageResp.value.ok) {
          nextData.coverage = (await coverageResp.value.json()) as CoverageData;
        }
        if (metricsResp.status === "fulfilled" && metricsResp.value.ok) {
          nextData.lpMetrics = (await metricsResp.value.json()) as MetricsData;
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

        if (!nextData.coverage && !nextData.lpMetrics && nextData.swaps.length === 0 && !nextData.historyAggregate) {
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
    const gold = coverageData.rows.filter((row) => isGoldSymbol(row.symbol)).sort((a, b) => Math.abs(b.uncovered) - Math.abs(a.uncovered));
    const rest = coverageData.rows.filter((row) => !isGoldSymbol(row.symbol)).sort((a, b) => Math.abs(b.uncovered) - Math.abs(a.uncovered));
    return [...gold, ...rest];
  }, [coverageData]);

  const riskKpis = useMemo(() => {
    const rows = coverageData?.rows || [];
    const activeLps = coverageData?.lpNames?.length || 0;
    const symbolCount = rows.length;
    const totalUncovered = rows.reduce((sum, row) => sum + Math.abs(row.uncovered), 0);
    let largestSymbol = "-";
    let largestExposure = 0;
    rows.forEach((row) => {
      const abs = Math.abs(row.uncovered);
      if (abs > largestExposure) {
        largestExposure = abs;
        largestSymbol = row.symbol;
      }
    });
    return { activeLps, symbolCount, totalUncovered, largestExposure, largestSymbol };
  }, [coverageData]);

  useEffect(() => {
    if (activeMenu !== "History") {
      setHistoryError(null);
      return;
    }

    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl ? `${backendBaseUrl}/api/LpAccount` : "/api/LpAccount";
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

    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    let cancelled = false;

    const loadHistory = async () => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        if (historyTab === "aggregate") {
          const endpoint = backendBaseUrl
            ? `${backendBaseUrl}/History/aggregate?from=${historyTimestamps.from}&to=${historyTimestamps.to}`
            : `/History/aggregate?from=${historyTimestamps.from}&to=${historyTimestamps.to}`;
          const resp = await fetch(endpoint);
          if (!resp.ok) throw new Error(`History aggregate ${resp.status}`);
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
          const endpoint = backendBaseUrl
            ? `${backendBaseUrl}/History/deals?login=${historySelectedLogin}&from=${historyTimestamps.from}&to=${historyTimestamps.to}`
            : `/History/deals?login=${historySelectedLogin}&from=${historyTimestamps.from}&to=${historyTimestamps.to}`;
          const resp = await fetch(endpoint);
          if (!resp.ok) throw new Error(`History deals ${resp.status}`);
          const data = (await resp.json()) as HistoryDealsData;
          if (cancelled) return;
          setHistoryDealsData(data);
          setHistoryLastUpdated(new Date());
          return;
        }

        const endpoint = backendBaseUrl
          ? `${backendBaseUrl}/History/volume?from=${historyTimestamps.from}&to=${historyTimestamps.to}`
          : `/History/volume?from=${historyTimestamps.from}&to=${historyTimestamps.to}`;
        const resp = await fetch(endpoint);
        if (!resp.ok) throw new Error(`History volume ${resp.status}`);
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

  const summaryCards = useMemo(() => {
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
        { label: "Total Uncovered", value: riskKpis.totalUncovered.toFixed(2) },
        { label: "Largest Exposure", value: riskKpis.largestExposure > 0 ? `${riskKpis.largestExposure.toFixed(2)} (${riskKpis.largestSymbol})` : "-" },
      ];
    }

    if (activeMenu === "Metrics") {
      const items = metricsData?.items || [];
      const avgMarginLevel =
        items.length > 0 ? items.reduce((sum, item) => sum + (Number.isFinite(item.marginLevel) ? item.marginLevel : 0), 0) / items.length : 0;
      return [
        { label: "LP Accounts", value: items.length.toLocaleString() },
        { label: "Total Equity", value: `$${(metricsData?.totals?.equity || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}` },
        { label: "Total Margin", value: `$${(metricsData?.totals?.margin || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}` },
        { label: "Avg Margin Level", value: `${avgMarginLevel.toFixed(2)}%` },
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
        const totals = historyAggregateData?.totals;
        return [
          { label: "LP Rows", value: (historyAggregateData?.items?.length || 0).toLocaleString() },
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

    return [
      { label: "Total Equity", value: `$${metrics.totalEquity.toLocaleString()}` },
      { label: "Total Credit", value: `$${metrics.totalCredit.toLocaleString()}` },
      { label: "Clients With Credit", value: metrics.clientsWithCredit.toLocaleString() },
      { label: "Trading Profit", value: `$${metrics.tradingProfit.toLocaleString()}` },
      { label: "Net Lots", value: `${metrics.netLots.toFixed(2)} lots` },
      { label: "Buy Lots", value: `${metrics.buyLots.toFixed(2)} lots` },
      { label: "Sell Lots", value: `${metrics.sellLots.toFixed(2)} lots` },
      { label: "Deals", value: metrics.dealCount.toLocaleString() },
    ];
  }, [activeMenu, coverageData, riskKpis, metricsData, swapRows, metrics, historyTab, historyAggregateData, historyDealsData, historyVolumeData]);

  const dealingOverview = useMemo(() => {
    const coverageTotals = overviewData.coverage?.totals;
    const coverageClientAbs = Math.abs(coverageTotals?.clientNet || 0);
    const coverageUncoveredAbs = Math.abs(coverageTotals?.uncovered || 0);
    const coveragePct = coverageClientAbs > 0 ? ((coverageClientAbs - coverageUncoveredAbs) / coverageClientAbs) * 100 : 0;
    const uncoveredTop = [...(overviewData.coverage?.rows || [])]
      .sort((a, b) => Math.abs(b.uncovered) - Math.abs(a.uncovered))
      .slice(0, 5);
    const lowMarginLps = [...(overviewData.lpMetrics?.items || [])]
      .filter((item) => Number.isFinite(item.marginLevel))
      .sort((a, b) => a.marginLevel - b.marginLevel)
      .slice(0, 5);
    const swapsDueTonight = overviewData.swaps.filter((row) => row.willChargeTonight).length;
    const negativeSwapPositions = overviewData.swaps.filter((row) => row.swap < 0).length;
    const historyTotals = overviewData.historyAggregate?.totals;
    const historyRows = overviewData.historyAggregate?.items || [];
    const lpErrorCount = historyRows.filter((row) => row.isError).length;

    return {
      coveragePct,
      uncoveredTop,
      lowMarginLps,
      swapsDueTonight,
      negativeSwapPositions,
      historyTotals,
      historyRows,
      lpErrorCount,
    };
  }, [overviewData]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 p-6 md:p-8">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="h-fit rounded-2xl border border-slate-200 bg-gradient-to-b from-white via-slate-50 to-slate-100 p-4 dark:border-cyan-500/20 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 lg:sticky lg:top-6">
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300/80">Dealing Menu</div>
          <div className="mt-3 space-y-1.5">
            {menuItems.map((item) => {
              const active = activeMenu === item;
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
            <section className="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/40 p-5 dark:border-cyan-500/20 dark:from-slate-950 dark:via-slate-900 dark:to-cyan-950/40">
              <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />
              <div className="pointer-events-none absolute -left-10 -bottom-10 h-52 w-52 rounded-full bg-emerald-400/10 blur-3xl" />
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
                      value={toYmd(fromDate)}
                      onChange={(e) => setFromDate(new Date(`${e.target.value}T00:00:00`))}
                      className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    />
                  </label>
                  <label className="text-xs text-slate-700 dark:text-slate-300">
                    To
                    <input
                      type="date"
                      value={toYmd(toDate)}
                      onChange={(e) => setToDate(new Date(`${e.target.value}T00:00:00`))}
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
          ) : (
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
                      value={toYmd(fromDate)}
                      onChange={(e) => setFromDate(new Date(`${e.target.value}T00:00:00`))}
                      className="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                    />
                  </label>
                  <label className="text-xs text-slate-700 dark:text-slate-300">
                    To
                    <input
                      type="date"
                      value={toYmd(toDate)}
                      onChange={(e) => setToDate(new Date(`${e.target.value}T00:00:00`))}
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
          )}

          {error && (
            <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
          )}

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map((card) => (
              <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                <div className="text-xs text-slate-500 dark:text-slate-400">{card.label}</div>
                <div className="mt-2 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">{card.value}</div>
              </div>
            ))}
          </section>

          {activeMenu === "Coverage" ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">Position Match Table</h2>
                  <span className={`h-2 w-2 rounded-full ${coverageStatus === "connected" ? "bg-emerald-400" : coverageStatus === "connecting" ? "bg-amber-400" : "bg-rose-400"}`} />
                  <span className="text-xs text-slate-500 dark:text-slate-400">{coverageStatus}</span>
                </div>
                <div className="flex items-center gap-2">
                  {coverageLastUpdated && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">Updated {coverageLastUpdated.toLocaleTimeString()}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setCoverageRefreshKey((k) => k + 1)}
                    className="inline-flex items-center gap-2 rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20"
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

              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="sticky left-0 bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Buy/Sell</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Client Net</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Uncovered</th>
                      {(coverageData?.lpNames || []).map((lp) => (
                        <th key={lp} className="px-3 py-2 text-right font-semibold uppercase tracking-wide">{lp}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...coverageRows.gold, ...coverageRows.rest].map((row, idx) => {
                      const isGold = isGoldSymbol(row.symbol);
                      const isGoldEnd = isGold && idx === coverageRows.gold.length - 1 && coverageRows.gold.length > 0;
                      return (
                        <Fragment key={`${row.symbol}-${idx}`}>
                          <tr className={isGold ? "bg-amber-500/5" : "bg-slate-950/30"}>
                            <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{row.symbol}</td>
                            <td className="border-t border-slate-800 px-3 py-2 text-left">
                              {row.direction === "BUY" ? (
                                <span className="font-semibold text-emerald-300">BUY</span>
                              ) : row.direction === "SELL" ? (
                                <span className="font-semibold text-rose-300">SELL</span>
                              ) : (
                                <span className="text-slate-500">-</span>
                              )}
                            </td>
                            <td className="border-t border-slate-800 px-3 py-2 text-right">{formatCoverageVal(row.clientNet)}</td>
                            <td className="border-t border-slate-800 px-3 py-2 text-right">{formatCoverageVal(row.uncovered)}</td>
                            {(coverageData?.lpNames || []).map((lp) => (
                              <td key={`${row.symbol}-${lp}-${idx}`} className="border-t border-slate-800 px-3 py-2 text-right">
                                {formatCoverageVal(row.lpNets?.[lp] || 0)}
                              </td>
                            ))}
                          </tr>
                          {isGoldEnd && (
                            <tr className="bg-amber-500/15 font-semibold">
                              <td className="sticky left-0 border-t border-amber-500/40 bg-amber-500/15 px-3 py-2 text-amber-200">GOLD TOTAL</td>
                              <td className="border-t border-amber-500/40 px-3 py-2" />
                              <td className="border-t border-amber-500/40 px-3 py-2 text-right">{formatCoverageVal(coverageGoldTotals.clientNet)}</td>
                              <td className="border-t border-amber-500/40 px-3 py-2 text-right">{formatCoverageVal(coverageGoldTotals.uncovered)}</td>
                              {(coverageData?.lpNames || []).map((lp) => (
                                <td key={`gold-total-${lp}`} className="border-t border-amber-500/40 px-3 py-2 text-right">
                                  {formatCoverageVal(coverageGoldTotals.lpTotals[lp] || 0)}
                                </td>
                              ))}
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-900/95 font-semibold text-slate-200">
                      <td className="sticky left-0 bg-slate-900/95 px-3 py-2">TOTAL</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2 text-right">{formatCoverageVal(coverageData?.totals?.clientNet || 0)}</td>
                      <td className="px-3 py-2 text-right">{formatCoverageVal(coverageData?.totals?.uncovered || 0)}</td>
                      {(coverageData?.lpNames || []).map((lp) => (
                        <td key={`total-${lp}`} className="px-3 py-2 text-right">
                          {formatCoverageVal(coverageData?.totals?.lpNets?.[lp] || 0)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
              {!coverageLoading && !coverageData?.rows?.length && (
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-500 dark:text-slate-400">No coverage rows available.</div>
              )}
            </section>
          ) : activeMenu === "Risk Exposure" ? (
            <section className="space-y-4">
              <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">Risk Exposure Table</h2>
                    <span className={`h-2 w-2 rounded-full ${coverageStatus === "connected" ? "bg-emerald-400" : coverageStatus === "connecting" ? "bg-amber-400" : "bg-rose-400"}`} />
                    <span className="text-xs text-slate-500 dark:text-slate-400">{coverageStatus}</span>
                  </div>
                  {coverageLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {coverageLastUpdated.toLocaleTimeString()}</span>}
                </div>

                {coverageError && (
                  <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{coverageError}</div>
                )}

                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="sticky left-0 bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Direction</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Client Net</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">LP Coverage</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Uncovered</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Coverage %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {riskRows.map((row, idx) => {
                        const isGold = isGoldSymbol(row.symbol);
                        const lpCoverage = row.clientNet - row.uncovered;
                        const pct = row.clientNet === 0 ? NaN : ((row.clientNet - row.uncovered) / row.clientNet) * 100;
                        return (
                          <tr key={`${row.symbol}-${idx}`} className={isGold ? "bg-amber-500/5" : "bg-slate-950/30"}>
                            <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{row.symbol}</td>
                            <td className="border-t border-slate-800 px-3 py-2 text-left">
                              {row.direction === "BUY" ? (
                                <span className="font-semibold text-emerald-300">BUY</span>
                              ) : row.direction === "SELL" ? (
                                <span className="font-semibold text-rose-300">SELL</span>
                              ) : (
                                <span className="text-slate-500">-</span>
                              )}
                            </td>
                            <td className="border-t border-slate-800 px-3 py-2 text-right">{formatCoverageVal(row.clientNet)}</td>
                            <td className="border-t border-slate-800 px-3 py-2 text-right">{formatCoverageVal(lpCoverage)}</td>
                            <td className="border-t border-slate-800 px-3 py-2 text-right">{formatCoverageVal(row.uncovered)}</td>
                            <td className={`border-t border-slate-800 px-3 py-2 text-right ${formatPctClass(pct)}`}>
                              {Number.isFinite(pct) ? `${pct.toFixed(1)}%` : "-"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-900/95 font-semibold text-slate-200">
                        <td className="sticky left-0 bg-slate-900/95 px-3 py-2">TOTAL</td>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-right">{formatCoverageVal(coverageData?.totals?.clientNet || 0)}</td>
                        <td className="px-3 py-2 text-right">{formatCoverageVal((coverageData?.totals?.clientNet || 0) - (coverageData?.totals?.uncovered || 0))}</td>
                        <td className="px-3 py-2 text-right">{formatCoverageVal(coverageData?.totals?.uncovered || 0)}</td>
                        <td className={`px-3 py-2 text-right ${formatPctClass((coverageData?.totals?.clientNet || 0) === 0 ? NaN : (((coverageData?.totals?.clientNet || 0) - (coverageData?.totals?.uncovered || 0)) / (coverageData?.totals?.clientNet || 0)) * 100)}`}>
                          {(coverageData?.totals?.clientNet || 0) === 0
                            ? "-"
                            : `${((((coverageData?.totals?.clientNet || 0) - (coverageData?.totals?.uncovered || 0)) / (coverageData?.totals?.clientNet || 0)) * 100).toFixed(1)}%`}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {!coverageLoading && !riskRows.length && (
                  <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-500 dark:text-slate-400">No risk rows available.</div>
                )}
              </section>
            </section>
          ) : activeMenu === "Metrics" ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">LP Metrics</h2>
                {metricsLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {metricsLastUpdated.toLocaleTimeString()}</span>}
              </div>
              {metricsError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{metricsError}</div>
              )}
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="sticky left-0 bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">LP</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Equity</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Real Equity</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Credit</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Balance</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Margin</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Free Margin</th>
                      <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Margin Level %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(metricsData?.items || []).map((item) => (
                      <tr key={item.lp} className="bg-slate-950/30">
                        <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{item.lp}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.equity)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.realEquity)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.credit)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.balance)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.margin)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.freeMargin)}</td>
                        <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.marginLevel >= 100 ? "text-emerald-300" : "text-rose-300"}`}>
                          {item.marginLevel.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-900/95 font-semibold text-slate-200">
                      <td className="sticky left-0 bg-slate-900/95 px-3 py-2">TOTAL</td>
                      <td className="px-3 py-2 text-right">{formatDollar(metricsData?.totals?.equity || 0)}</td>
                      <td className="px-3 py-2 text-right">{formatDollar(metricsData?.totals?.realEquity || 0)}</td>
                      <td className="px-3 py-2 text-right">{formatDollar(metricsData?.totals?.credit || 0)}</td>
                      <td className="px-3 py-2 text-right">{formatDollar(metricsData?.totals?.balance || 0)}</td>
                      <td className="px-3 py-2 text-right">{formatDollar(metricsData?.totals?.margin || 0)}</td>
                      <td className="px-3 py-2 text-right">{formatDollar(metricsData?.totals?.freeMargin || 0)}</td>
                      <td className="px-3 py-2 text-right text-slate-500">-</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {!metricsLoading && !(metricsData?.items || []).length && (
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-500 dark:text-slate-400">No LP accounts found.</div>
              )}
            </section>
          ) : activeMenu === "Swap Tracker" ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">Swap-Free Tracker</h2>
                {swapLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {swapLastUpdated.toLocaleTimeString()}</span>}
              </div>
              {swapError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{swapError}</div>
              )}
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="sticky left-0 bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">LP</th>
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
                      <tr key={`${row.lpName}-${row.ticket}-${idx}`} className="bg-slate-950/30">
                        <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{row.lpName}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-left text-slate-500 dark:text-slate-400">{row.ticket}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-left">{row.symbol}</td>
                        <td className={`border-t border-slate-800 px-3 py-2 text-right ${row.side === "Buy" ? "text-emerald-300" : "text-rose-300"}`}>{row.side}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{row.volume.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className={`border-t border-slate-800 px-3 py-2 text-right ${row.swap > 0.005 ? "text-emerald-300" : row.swap < -0.005 ? "text-rose-300" : "text-amber-300"}`}>
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
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-500 dark:text-slate-400">No positions found.</div>
              )}
            </section>
          ) : activeMenu === "History" ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">History & Revenue Share</h2>
                {historyLastUpdated && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {historyLastUpdated.toLocaleTimeString()}</span>}
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
                        : "border-slate-700 bg-slate-900/70 text-slate-600 dark:text-slate-300 hover:border-slate-600"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}

                {historyTab === "deals" && (
                  <>
                    <select
                      value={historySelectedLogin}
                      onChange={(e) => setHistorySelectedLogin(e.target.value)}
                      className="rounded-md border border-slate-700 bg-slate-900/70 px-2 py-1.5 text-xs text-slate-900 dark:text-slate-100"
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
                      onClick={() => setHistoryRefreshKey((k) => k + 1)}
                      className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-500/20"
                    >
                      Load Deals
                    </button>
                    <button
                      type="button"
                      onClick={exportHistoryDealsCsv}
                      disabled={!historyDealsData?.deals?.length}
                      className="rounded-md border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Export CSV
                    </button>
                  </>
                )}
              </div>

              {historyError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{historyError}</div>
              )}

              {historyTab === "aggregate" && (
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="sticky left-0 bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">LP Name</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Login</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Source</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Start Equity</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">End Equity</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Credit</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Deposit</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Withdrawal</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Net Deposits</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Gross P/L</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Commission</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Swap</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Net P/L</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Real LP P/L</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">NTP %</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">LP P/L (Rev Share)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(historyAggregateData?.items || []).map((item, idx) => (
                        <tr key={`${item.lpName}-${item.login}-${idx}`} className={item.isError ? "opacity-50" : "bg-slate-950/30"}>
                          <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{item.lpName}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-left">{item.login}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-left text-slate-500 dark:text-slate-400">{item.source || "-"}</td>
                          {item.isError ? (
                            <td colSpan={13} className="border-t border-slate-800 px-3 py-2 text-left text-rose-300">
                              {item.errorMessage || "Error"}
                            </td>
                          ) : (
                            <>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.startEquity.toLocaleString()}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.endEquity.toLocaleString()}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.credit.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.deposit > 0 ? "text-emerald-300" : item.deposit < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.deposit.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.withdrawal > 0 ? "text-emerald-300" : item.withdrawal < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.withdrawal.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.netDeposits > 0 ? "text-emerald-300" : item.netDeposits < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.netDeposits.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.grossProfit > 0 ? "text-emerald-300" : item.grossProfit < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.grossProfit.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.totalCommission > 0 ? "text-emerald-300" : item.totalCommission < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.totalCommission.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.totalSwap > 0 ? "text-emerald-300" : item.totalSwap < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.totalSwap.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.netPL > 0 ? "text-emerald-300" : item.netPL < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.netPL.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.realLpPL > 0 ? "text-emerald-300" : item.realLpPL < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.realLpPL.toLocaleString()}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right text-amber-300">{item.ntpPercent.toFixed(1)}%</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.lpPL > 0 ? "text-emerald-300" : item.lpPL < 0 ? "text-rose-300" : "text-slate-500"}`}>{item.lpPL.toLocaleString()}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    {historyAggregateData?.totals && (
                      <tfoot>
                        <tr className="bg-slate-900/95 font-semibold text-slate-200">
                          <td className="sticky left-0 bg-slate-900/95 px-3 py-2">TOTAL</td>
                          <td className="px-3 py-2" />
                          <td className="px-3 py-2" />
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.startEquity.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.endEquity.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.credit.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.deposit.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.withdrawal.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.netDeposits.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.grossProfit.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.totalCommission.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.totalSwap.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.netPL.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.realLpPL.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right" />
                          <td className="px-3 py-2 text-right">{historyAggregateData.totals.lpPL.toLocaleString()}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}

              {historyTab === "deals" && (
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Ticket</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Time</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Direction</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Entry</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Volume</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Price</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Contract Size</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Market Value</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Profit</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Commission</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Fee</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Swap</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">LP Comm</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">LP Comm/Lot</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(historyDealsData?.deals || []).map((d, idx) => (
                        <tr key={`${d.dealTicket}-${idx}`} className="bg-slate-950/30">
                          <td className="border-t border-slate-800 px-3 py-2">{d.dealTicket}</td>
                          <td className="border-t border-slate-800 px-3 py-2 font-mono">{d.symbol}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-slate-500 dark:text-slate-400">{d.timeString}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.direction === "Buy" ? "text-emerald-300" : "text-rose-300"}`}>{d.direction}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.entry}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.price.toLocaleString(undefined, { maximumFractionDigits: 5 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.contractSize.toLocaleString()}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.marketValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.profit > 0 ? "text-emerald-300" : d.profit < 0 ? "text-rose-300" : "text-slate-500"}`}>{d.profit.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.commission > 0 ? "text-emerald-300" : d.commission < 0 ? "text-rose-300" : "text-slate-500"}`}>{d.commission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.fee > 0 ? "text-emerald-300" : d.fee < 0 ? "text-rose-300" : "text-slate-500"}`}>{d.fee.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.swap > 0 ? "text-emerald-300" : d.swap < 0 ? "text-rose-300" : "text-slate-500"}`}>{d.swap.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.lpCommission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.lpCommPerLot.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {historyTab === "volume" && (
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">LP Name</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Login</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Source</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Trade Count</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Total Lots</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Notional (USD)</th>
                        <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Volume (Yards)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(historyVolumeData?.items || []).map((item, idx) => (
                        <tr key={`${item.lpName}-${item.login}-${idx}`} className={item.isError ? "opacity-50" : "bg-slate-950/30"}>
                          <td className="border-t border-slate-800 px-3 py-2 font-mono">{item.lpName}</td>
                          <td className="border-t border-slate-800 px-3 py-2">{item.login}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-slate-500 dark:text-slate-400">{item.source || "-"}</td>
                          {item.isError ? (
                            <td colSpan={4} className="border-t border-slate-800 px-3 py-2 text-left text-rose-300">
                              {item.errorMessage || "Error"}
                            </td>
                          ) : (
                            <>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.tradeCount.toLocaleString()}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.totalLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.notionalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.volumeYards.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    {historyVolumeData?.totals && (
                      <tfoot>
                        <tr className="bg-slate-900/95 font-semibold text-slate-200">
                          <td className="px-3 py-2">TOTAL</td>
                          <td className="px-3 py-2" />
                          <td className="px-3 py-2" />
                          <td className="px-3 py-2 text-right">{historyVolumeData.totals.tradeCount.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{historyVolumeData.totals.totalLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="px-3 py-2 text-right">{historyVolumeData.totals.notionalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td className="px-3 py-2 text-right">{historyVolumeData.totals.volumeYards.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}

              {!historyLoading &&
                ((historyTab === "aggregate" && !(historyAggregateData?.items || []).length) ||
                  (historyTab === "deals" && !(historyDealsData?.deals || []).length) ||
                  (historyTab === "volume" && !(historyVolumeData?.items || []).length)) && (
                  <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-500 dark:text-slate-400">
                    No history data available for this range.
                  </div>
                )}
            </section>
          ) : (
            <>
              <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Coverage</div>
                  <div className={`mt-1 text-2xl font-semibold ${formatPctClass(dealingOverview.coveragePct)}`}>{dealingOverview.coveragePct.toFixed(1)}%</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">Net coverage ratio</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Swap Due Tonight</div>
                  <div className="mt-1 text-2xl font-semibold text-cyan-100">{dealingOverview.swapsDueTonight.toLocaleString()}</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Negative swap positions: {dealingOverview.negativeSwapPositions.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">History Net P/L</div>
                  <div className="mt-1 text-2xl font-semibold">{formatDollar(dealingOverview.historyTotals?.netPL || 0)}</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">Revenue share LP P/L: {(dealingOverview.historyTotals?.lpPL || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Deal Matching</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">{metrics.dealCount.toLocaleString()}</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">Deal count processed in current window</div>
                </div>
              </section>

              {overviewError && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{overviewError}</div>}

              <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 xl:col-span-1">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-cyan-200">Risk & Coverage</h2>
                  <div className="space-y-2">
                    {!dealingOverview.uncoveredTop.length && <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3 text-xs text-slate-500 dark:text-slate-400">No uncovered symbols in this range.</div>}
                    {dealingOverview.uncoveredTop.map((row) => (
                      <div key={row.symbol} className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono text-slate-900 dark:text-slate-100">{row.symbol}</span>
                          <span className={row.uncovered >= 0 ? "text-emerald-300" : "text-rose-300"}>{row.uncovered.toFixed(2)}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Client Net: {row.clientNet.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 xl:col-span-1">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-cyan-200">LP Health (Metrics)</h2>
                  <div className="space-y-2">
                    {!dealingOverview.lowMarginLps.length && <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3 text-xs text-slate-500 dark:text-slate-400">No LP metrics available.</div>}
                    {dealingOverview.lowMarginLps.map((lp) => (
                      <div key={`${lp.lp}-${lp.equity}`} className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono text-slate-900 dark:text-slate-100">{lp.lp}</span>
                          <span className={formatPctClass(lp.marginLevel)}>{lp.marginLevel.toFixed(2)}%</span>
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                          Equity: {lp.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })} | Free Margin: {lp.freeMargin.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 xl:col-span-1">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-cyan-200">Execution & History</h2>
                  <div className="space-y-3 text-sm">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3">
                      <div className="text-xs text-slate-500 dark:text-slate-400">History LP Rows</div>
                      <div className="mt-1 font-mono text-slate-900 dark:text-slate-100">{dealingOverview.historyRows.length.toLocaleString()}</div>
                      <div className="mt-1 text-[11px] text-slate-500">Error rows: {dealingOverview.lpErrorCount.toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3">
                      <div className="text-xs text-slate-500 dark:text-slate-400">Real LP P/L</div>
                      <div className="mt-1 font-mono">{formatDollar(dealingOverview.historyTotals?.realLpPL || 0)}</div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3">
                      <div className="text-xs text-slate-500 dark:text-slate-400">Date Window</div>
                      <div className="mt-1 font-mono text-slate-900 dark:text-slate-100">
                        {toYmd(fromDate)} {"->"} {toYmd(toDate)}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500">
                        {overviewLoading ? "Refreshing..." : overviewLastUpdated ? `Summary updated ${overviewLastUpdated.toLocaleTimeString()}` : "Summary pending"}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 lg:col-span-2">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-200">Top Symbols (Net Exposure)</h2>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{topSymbols.length} symbols</span>
                  </div>
                  <div className="space-y-2">
                    {topSymbols.length === 0 && (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-4 text-sm text-slate-500 dark:text-slate-400">
                        No live symbol exposure for this date range.
                      </div>
                    )}
                    {topSymbols.map((row) => (
                      <div key={row.symbol} className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3">
                        <div className="flex items-center justify-between">
                          <div className="font-mono text-sm text-slate-900 dark:text-slate-100">{row.symbol}</div>
                          <div className={`font-mono text-sm ${row.netExposureLots >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                            {row.netExposureLots >= 0 ? "+" : ""}
                            {row.netExposureLots.toFixed(2)} lots
                          </div>
                        </div>
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">Open positions: {row.positions}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-cyan-200">Quick Drill-down</h2>
                  <div className="space-y-2">
                    {["Risk Exposure", "Coverage", "Metrics", "Deal Matching", "History", "Swap Tracker"].map((menu) => (
                      <button
                        key={menu}
                        type="button"
                        onClick={() => setActiveMenu(menu)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-left text-xs text-slate-200 hover:border-cyan-500/40 hover:bg-cyan-500/10"
                      >
                        Open {menu}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


