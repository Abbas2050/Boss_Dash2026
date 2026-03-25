import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, X, ChevronRight, TrendingUp, BarChart2, Activity, DollarSign } from "lucide-react";

// ─── API Types ───────────────────────────────────────────────────────────────

interface TopClient {
  rank: number;
  login: number;
  name: string;
  equity: number;
  balance: number;
  credit: number;
  marginLevel: number;
  floatingPnl: number;
  openPositionCount: number;
  totalOpenLots: number;
  dailyRealizedLots: number;
  totalDailyVolume?: number;
  openLots?: number;
}

interface TopClientsResponse {
  generatedAt: string;
  fromDate: string;
  toDate: string;
  topByEquity: TopClient[];
  topByVolume: TopClient[];
  topByDailyVolume: TopClient[];
  topByDailyRealized: TopClient[];
}

interface OpenPosition {
  symbol: string;
  buyLots: number;
  sellLots: number;
  netLots: number;
  netDirection: string;
  positionCount: number;
  profit: number;
  swap: number;
}

interface TopSymbol {
  symbol: string;
  totalLots: number;
  dealCount: number;
  realizedPnl: number;
  swap: number;
  commission: number;
  dailyAvg?: number;
}

interface DetailSummary {
  periodClosedDeals: number;
  periodTradedLots: number;
  dailyAvgLots: number;
  periodDays: number;
  totalOpenPositions: number;
  totalOpenLots: number;
  totalFloatingPnl: number;
  totalSwap: number;
}

interface AccountInfo {
  equity: number;
  balance: number;
  credit: number;
  margin: number;
  marginFree: number;
  marginLevel: number;
  marginLeverage: number;
  floatingPnl: number;
  swap: number;
}

interface ClientDetail {
  name: string;
  group: string;
  account: AccountInfo;
  openPositions: OpenPosition[];
  topSymbols: TopSymbol[];
  summary: DetailSummary;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmt = (v: number | null | undefined, d = 2) =>
  v != null ? Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : "-";

const fmtCompact = (v: number) => {
  const abs = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${s}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${s}$${(abs / 1_000).toFixed(1)}K`;
  return `${s}$${abs.toFixed(2)}`;
};

const fmtMl = (v: number | null | undefined) =>
  v == null ? "-" : v > 99999 ? "INF" : fmt(v, 2) + "%";

const signCls = (v: number | null | undefined) =>
  (v ?? 0) > 0.005
    ? "text-emerald-600 dark:text-emerald-400"
    : (v ?? 0) < -0.005
      ? "text-rose-600 dark:text-rose-400"
      : "text-slate-500 dark:text-slate-400";

const MEDAL: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

// ─── Category config ─────────────────────────────────────────────────────────

type Category = "equity" | "volume" | "activity" | "realized";

interface CatDef {
  key: Category;
  label: string;
  icon: React.ReactNode;
  color: string;
  barColor: string;
  borderActive: string;
  bgActive: string;
  metricLabel: string;
  metricFn: (c: TopClient) => number;
  metricFmt: (v: number) => string;
  secondaryFns: Array<{ label: string; fn: (c: TopClient) => string }>;
}

const CATEGORIES: CatDef[] = [
  {
    key: "equity",
    label: "Equity",
    icon: <DollarSign className="h-3.5 w-3.5" />,
    color: "text-emerald-600 dark:text-emerald-400",
    barColor: "bg-emerald-500",
    borderActive: "border-emerald-500/50",
    bgActive: "bg-emerald-500/10",
    metricLabel: "Equity",
    metricFn: (c) => c.equity,
    metricFmt: fmtCompact,
    secondaryFns: [
      { label: "Balance", fn: (c) => fmtCompact(c.balance) },
      { label: "M.Lvl", fn: (c) => fmtMl(c.marginLevel) },
      { label: "Float", fn: (c) => fmt(c.floatingPnl) },
    ],
  },
  {
    key: "volume",
    label: "Open Vol",
    icon: <TrendingUp className="h-3.5 w-3.5" />,
    color: "text-cyan-600 dark:text-cyan-400",
    barColor: "bg-cyan-500",
    borderActive: "border-cyan-500/50",
    bgActive: "bg-cyan-500/10",
    metricLabel: "Open Lots",
    metricFn: (c) => c.totalOpenLots,
    metricFmt: (v) => fmt(v) + " lots",
    secondaryFns: [
      { label: "Positions", fn: (c) => String(c.openPositionCount) },
      { label: "Realized", fn: (c) => fmt(c.dailyRealizedLots) + "L" },
      { label: "Equity", fn: (c) => fmtCompact(c.equity) },
    ],
  },
  {
    key: "activity",
    label: "Activity",
    icon: <Activity className="h-3.5 w-3.5" />,
    color: "text-amber-600 dark:text-amber-400",
    barColor: "bg-amber-500",
    borderActive: "border-amber-500/50",
    bgActive: "bg-amber-500/10",
    metricLabel: "Total Vol",
    metricFn: (c) => c.totalDailyVolume ?? 0,
    metricFmt: (v) => fmt(v) + " lots",
    secondaryFns: [
      { label: "Realized", fn: (c) => fmt(c.dailyRealizedLots) + "L" },
      { label: "Open", fn: (c) => fmt(c.openLots ?? c.totalOpenLots) + "L" },
      { label: "Equity", fn: (c) => fmtCompact(c.equity) },
    ],
  },
  {
    key: "realized",
    label: "Realized",
    icon: <BarChart2 className="h-3.5 w-3.5" />,
    color: "text-violet-600 dark:text-violet-400",
    barColor: "bg-violet-500",
    borderActive: "border-violet-500/50",
    bgActive: "bg-violet-500/10",
    metricLabel: "Realized Vol",
    metricFn: (c) => c.dailyRealizedLots,
    metricFmt: (v) => fmt(v) + " lots",
    secondaryFns: [
      { label: "Open", fn: (c) => fmt(c.totalOpenLots) + "L" },
      { label: "Positions", fn: (c) => String(c.openPositionCount) },
      { label: "Equity", fn: (c) => fmtCompact(c.equity) },
    ],
  },
];

// ─── Leaderboard row ─────────────────────────────────────────────────────────

function LeaderRow({
  client,
  cat,
  maxVal,
  isSelected,
  onSelect,
}: {
  client: TopClient;
  cat: CatDef;
  maxVal: number;
  isSelected: boolean;
  onSelect: (c: TopClient) => void;
}) {
  const val = cat.metricFn(client);
  const pct = maxVal > 0 ? Math.min(100, (val / maxVal) * 100) : 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(client)}
      className={`group w-full rounded-xl border px-4 py-3 text-left transition-all ${
        isSelected
          ? `${cat.borderActive} ${cat.bgActive}`
          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 dark:hover:border-slate-700 dark:hover:bg-slate-800/50"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 flex-shrink-0 text-center">
          {client.rank <= 3 ? (
            <span className="text-xl leading-none">{MEDAL[client.rank]}</span>
          ) : (
            <span className="font-mono text-sm font-bold text-slate-400 dark:text-slate-500">#{client.rank}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-slate-800 dark:text-slate-100">{client.name}</div>
          <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">#{client.login}</div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className={`text-base font-bold tabular-nums ${cat.color}`}>{cat.metricFmt(val)}</div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400">{cat.metricLabel}</div>
        </div>
        <ChevronRight className={`h-4 w-4 flex-shrink-0 transition ${isSelected ? "text-slate-600 dark:text-slate-300" : "text-slate-300 dark:text-slate-600 group-hover:text-slate-400"}`} />
      </div>

      <div className="mt-2.5">
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={`h-full rounded-full transition-all ${cat.barColor}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex gap-4">
          {cat.secondaryFns.map((s) => (
            <div key={s.label} className="text-[11px]">
              <span className="text-slate-400 dark:text-slate-500">{s.label}: </span>
              <span className="text-slate-600 dark:text-slate-300">{s.fn(client)}</span>
            </div>
          ))}
        </div>
      </div>
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type ClientProfilingTabProps = {
  fromDate: string;
  toDate: string;
  refreshKey?: number;
  onFromDateChange: (value: string) => void;
  onToDateChange: (value: string) => void;
  onRefresh: () => void;
};

export function ClientProfilingTab({
  fromDate,
  toDate,
  refreshKey = 0,
  onFromDateChange,
  onToDateChange,
  onRefresh,
}: ClientProfilingTabProps) {
  const [count, setCount] = useState("10");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TopClientsResponse | null>(null);

  const [category, setCategory] = useState<Category>("equity");
  const [selectedClient, setSelectedClient] = useState<TopClient | null>(null);

  const [detailPeriod, setDetailPeriod] = useState(30);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const loadRankings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ count });
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      const res = await fetch(`/api/ClientProfile/top-clients?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("Client profiling endpoint returned non-JSON content");
      }
      const json: TopClientsResponse = await res.json();
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [count, fromDate, toDate]);

  const loadDetail = useCallback(
    async (client: TopClient, period = detailPeriod) => {
      setSelectedClient(client);
      setDetailLoading(true);
      setDetailError(null);
      setDetail(null);
      try {
        const res = await fetch(`/api/ClientProfile/${client.login}/detail?days=${period}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          throw new Error("Client detail endpoint returned non-JSON content");
        }
        const json: ClientDetail = await res.json();
        setDetail(json);
      } catch (e: unknown) {
        setDetailError(e instanceof Error ? e.message : String(e));
      } finally {
        setDetailLoading(false);
        setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
      }
    },
    [detailPeriod],
  );

  const changePeriod = (days: number) => {
    setDetailPeriod(days);
    if (selectedClient) loadDetail(selectedClient, days);
  };

  const closeDetail = () => {
    setSelectedClient(null);
    setDetail(null);
    setDetailError(null);
  };

  const cat = CATEGORIES.find((c) => c.key === category)!;

  const currentList = useMemo(() => {
    if (!data) return [];
    if (category === "equity") return data.topByEquity;
    if (category === "volume") return data.topByVolume;
    if (category === "activity") return data.topByDailyVolume;
    return data.topByDailyRealized;
  }, [data, category]);

  const maxVal = useMemo(() => Math.max(...currentList.map((c) => cat.metricFn(c)), 1), [currentList, cat]);

  const symbolRows = useMemo(
    () =>
      (detail?.topSymbols ?? []).map((s) => ({
        ...s,
        dailyAvg: (detail?.summary.periodDays ?? 0) > 0 ? s.totalLots / detail!.summary.periodDays : 0,
      })),
    [detail],
  );

  useEffect(() => {
    void loadRankings();
  }, [refreshKey]);

  return (
    <div className="space-y-4">
      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800/80 dark:bg-slate-950/70">
        <span className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">Client Profiling</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={fromDate}
            onChange={(e) => onFromDateChange(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <input
            type="date"
            value={toDate}
            onChange={(e) => onToDateChange(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
          <select value={count} onChange={(e) => setCount(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            <option value="5">Top 5</option>
            <option value="10">Top 10</option>
            <option value="15">Top 15</option>
            <option value="20">Top 20</option>
          </select>
          <button type="button" onClick={onRefresh} disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-700 hover:bg-cyan-500/20 disabled:opacity-60 dark:text-cyan-300">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {loading ? "Loading…" : "Refresh"}
          </button>
          {data && (
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              {data.fromDate === data.toDate ? data.fromDate : `${data.fromDate} – ${data.toDate}`} · {data.generatedAt} UTC
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {/* Category switcher */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CATEGORIES.map((c) => (
          <button key={c.key} type="button"
            onClick={() => { setCategory(c.key); setSelectedClient(null); setDetail(null); }}
            className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-all ${
              category === c.key
                ? `${c.borderActive} ${c.bgActive} ${c.color}`
                : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400 dark:hover:text-slate-200"
            }`}>
            {c.icon}{c.label}
          </button>
        ))}
      </div>

      {/* Leaderboard + Detail panel side by side */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">

        {/* Leaderboard */}
        <div className="space-y-2">
          {!data && !loading && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 py-12 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900/30 dark:text-slate-500">
              Set date range and click <span className="font-semibold">Load</span> to see rankings
            </div>
          )}
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
              <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!loading && currentList.map((client) => (
            <LeaderRow key={client.login} client={client} cat={cat} maxVal={maxVal}
              isSelected={selectedClient?.login === client.login} onSelect={(c) => void loadDetail(c)} />
          ))}
          {!loading && data && currentList.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 py-12 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900/30">
              No clients found for this period
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div ref={detailRef}>
          {!selectedClient ? (
            <div className="flex h-full min-h-[200px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900/30 dark:text-slate-500">
              Select a client on the left to view details
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800/80 dark:bg-slate-950/70">
              {/* Header */}
              <div className="flex items-center gap-3 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white px-4 py-3 dark:border-slate-800 dark:from-slate-900/80 dark:to-slate-950/50">
                <div className="text-2xl leading-none">{selectedClient.rank <= 3 ? MEDAL[selectedClient.rank] : `#${selectedClient.rank}`}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold text-slate-800 dark:text-slate-100">{detail?.name ?? selectedClient.name}</div>
                  <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="font-mono">#{selectedClient.login}</span>
                    {detail?.group && <span className="rounded bg-slate-200/70 px-1.5 py-0.5 dark:bg-slate-800">{detail.group}</span>}
                  </div>
                </div>
                <button type="button" onClick={closeDetail}
                  className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {detailLoading && (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
                  <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
                </div>
              )}
              {detailError && (
                <div className="m-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{detailError}</div>
              )}

              {detail && !detailLoading && (
                <div className="space-y-4 p-4">
                  {/* Account metrics — horizontal scrollable chips */}
                  <div className="overflow-x-auto pb-1">
                    <div className="flex gap-2" style={{ minWidth: "max-content" }}>
                      {[
                        { label: "Equity", value: fmtCompact(detail.account.equity), cls: "text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200/60 dark:border-emerald-800/50" },
                        { label: "Balance", value: fmtCompact(detail.account.balance), cls: "text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800" },
                        { label: "Credit", value: fmtCompact(detail.account.credit), cls: "text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800" },
                        { label: "Margin", value: fmtCompact(detail.account.margin), cls: "text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800" },
                        { label: "Free Margin", value: fmtCompact(detail.account.marginFree), cls: "text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800" },
                        {
                          label: "M. Level", value: fmtMl(detail.account.marginLevel),
                          cls: detail.account.marginLevel < 150
                            ? "text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-900/20 border-rose-200/60 dark:border-rose-800/50"
                            : "text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200/60 dark:border-emerald-800/50",
                        },
                        { label: "Leverage", value: `1:${detail.account.marginLeverage}`, cls: "text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800" },
                        { label: "Float PnL", value: fmt(detail.account.floatingPnl), cls: `${signCls(detail.account.floatingPnl)} bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800` },
                        { label: "Swap", value: fmt(detail.account.swap), cls: `${signCls(detail.account.swap)} bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800` },
                      ].map((m) => (
                        <div key={m.label} className={`flex-shrink-0 rounded-lg border px-3 py-2 ${m.cls}`}>
                          <div className="text-[10px] font-semibold uppercase tracking-wide opacity-60">{m.label}</div>
                          <div className="mt-0.5 font-bold tabular-nums">{m.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Open positions */}
                  <div>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Open Positions</div>
                    {detail.openPositions.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 py-4 text-center text-xs text-slate-400 dark:border-slate-700 dark:bg-slate-900/30">No open positions</div>
                    ) : (
                      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                        <table className="min-w-full text-xs">
                          <thead className="bg-slate-50 dark:bg-slate-900/70">
                            <tr>
                              {["Symbol", "Buy", "Sell", "Net", "#", "Profit", "Swap"].map((h) => (
                                <th key={h} className={`px-3 py-2 font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${h === "Symbol" ? "text-left" : "text-right"}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {detail.openPositions.map((p) => (
                              <tr key={p.symbol} className="border-t border-slate-100 bg-white dark:border-slate-800 dark:bg-slate-950/40">
                                <td className="px-3 py-2 font-mono font-semibold text-amber-600 dark:text-amber-400">{p.symbol}</td>
                                <td className="px-3 py-2 text-right text-emerald-600 dark:text-emerald-400">{fmt(p.buyLots)}</td>
                                <td className="px-3 py-2 text-right text-rose-600 dark:text-rose-400">{fmt(p.sellLots)}</td>
                                <td className={`px-3 py-2 text-right font-bold ${p.netLots > 0 ? "text-emerald-600 dark:text-emerald-400" : p.netLots < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-400"}`}>
                                  {fmt(Math.abs(p.netLots))} {p.netDirection}
                                </td>
                                <td className="px-3 py-2 text-right text-slate-500">{p.positionCount}</td>
                                <td className={`px-3 py-2 text-right ${signCls(p.profit)}`}>{fmt(p.profit)}</td>
                                <td className={`px-3 py-2 text-right ${signCls(p.swap)}`}>{fmt(p.swap)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="flex flex-wrap gap-4 border-t border-slate-100 bg-slate-50 px-3 py-2 text-[11px] dark:border-slate-800 dark:bg-slate-900/50">
                          <span className="text-slate-400">Positions: <span className="font-mono text-slate-600 dark:text-slate-300">{detail.summary.totalOpenPositions}</span></span>
                          <span className="text-slate-400">Open lots: <span className="font-mono text-slate-600 dark:text-slate-300">{fmt(detail.summary.totalOpenLots)}</span></span>
                          <span className="text-slate-400">Float: <span className={`font-mono font-semibold ${signCls(detail.summary.totalFloatingPnl)}`}>{fmt(detail.summary.totalFloatingPnl)}</span></span>
                          <span className="text-slate-400">Swap: <span className={`font-mono font-semibold ${signCls(detail.summary.totalSwap)}`}>{fmt(detail.summary.totalSwap)}</span></span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Top symbols */}
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Top Symbols — Closed Trades</div>
                      <div className="flex gap-1">
                        {([7, 30, 90, 180, 365] as const).map((d, i) => (
                          <button key={d} type="button" onClick={() => changePeriod(d)}
                            className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                              detailPeriod === d
                                ? "bg-primary text-primary-foreground"
                                : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700"
                            }`}>
                            {(["7d", "30d", "90d", "6m", "1y"] as const)[i]}
                          </button>
                        ))}
                      </div>
                    </div>
                    {symbolRows.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 py-4 text-center text-xs text-slate-400 dark:border-slate-700 dark:bg-slate-900/30">No closed trades in this period</div>
                    ) : (
                      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                        <table className="min-w-full text-xs">
                          <thead className="bg-slate-50 dark:bg-slate-900/70">
                            <tr>
                              {["Symbol", "Lots", "Daily Avg", "Deals", "Realized PnL", "Swap", "Commission"].map((h) => (
                                <th key={h} className={`px-3 py-2 font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${h === "Symbol" ? "text-left" : "text-right"}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {symbolRows.map((s) => (
                              <tr key={s.symbol} className="border-t border-slate-100 bg-white dark:border-slate-800 dark:bg-slate-950/40">
                                <td className="px-3 py-2 font-mono font-semibold text-amber-600 dark:text-amber-400">{s.symbol}</td>
                                <td className="px-3 py-2 text-right font-semibold">{fmt(s.totalLots)}</td>
                                <td className="px-3 py-2 text-right text-slate-500">{fmt(s.dailyAvg)}</td>
                                <td className="px-3 py-2 text-right text-slate-500">{s.dealCount}</td>
                                <td className={`px-3 py-2 text-right ${signCls(s.realizedPnl)}`}>{fmt(s.realizedPnl)}</td>
                                <td className={`px-3 py-2 text-right ${signCls(s.swap)}`}>{fmt(s.swap)}</td>
                                <td className="px-3 py-2 text-right text-slate-500">{fmt(s.commission)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="flex flex-wrap gap-4 border-t border-slate-100 bg-slate-50 px-3 py-2 text-[11px] dark:border-slate-800 dark:bg-slate-900/50">
                          <span className="text-slate-400">Deals: <span className="font-mono text-slate-600 dark:text-slate-300">{detail.summary.periodClosedDeals}</span></span>
                          <span className="text-slate-400">Lots: <span className="font-mono text-slate-600 dark:text-slate-300">{fmt(detail.summary.periodTradedLots)}</span></span>
                          <span className="text-slate-400">Daily avg: <span className="font-mono text-slate-600 dark:text-slate-300">{fmt(detail.summary.dailyAvgLots)} lots/day</span></span>
                          <span className="text-slate-400">Period: <span className="font-mono text-slate-600 dark:text-slate-300">{detail.summary.periodDays}d</span></span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
