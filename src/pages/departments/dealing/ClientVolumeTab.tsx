import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

// ── helpers ──────────────────────────────────────────────────────────────────

const fmtLots = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtMonthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[parseInt(m, 10) - 1] ?? m} ${y.slice(2)}`;
}

function toLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

// ── types ─────────────────────────────────────────────────────────────────────

type ByDateRow = {
  date: string;
  lots: number;
  stocksLots?: number;
  cfdLots?: number;
};

type ByClientRow = {
  login: string | number;
  name: string;
  group: string;
  system: string;
  lots: number;
  stocksLots?: number;
  cfdLots?: number;
  activeDays: number;
  dailyAverage: number;
  symbolCount: number;
};

type ByClientSymbolRow = {
  login: string | number;
  name: string;
  symbol: string;
  lots: number;
  stocksLots?: number;
  cfdLots?: number;
};

type RunResponse = {
  totalLots: number;
  totalStocksLots?: number;
  totalCfdLots?: number;
  avgLotsPerDay: number;
  fromDate: string;
  toDate: string;
  activeDays: number;
  byDate: ByDateRow[];
  byClient: ByClientRow[];
  byClientSymbol: ByClientSymbolRow[];
  byInternalAccount?: ByClientRow[];
};

type MonthlyRow = {
  month: string;
  lots: number;
  stocksLots?: number;
  cfdLots?: number;
};

type RoutingRow = {
  symbol: string;
  lpsid: string;
  lots: number;
  percentage: number;
};

type RoutingMeta = {
  symbolCount: number;
  totalLots: number;
};

type RoutingState = {
  rows: RoutingRow[];
  meta: RoutingMeta | null;
  loading: boolean;
  label: string;
};

// ── component ─────────────────────────────────────────────────────────────────

export function ClientVolumeTab({ refreshKey }: { refreshKey: number }) {
  // controls
  const [group, setGroup] = useState("*");
  const [fromYmd, setFromYmd] = useState("");
  const [toYmd, setToYmd] = useState("");
  const [symbol, setSymbol] = useState("");
  const [login, setLogin] = useState("");

  // fetch state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statsText, setStatsText] = useState("");
  const [data, setData] = useState<RunResponse | null>(null);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [monthlyMeta, setMonthlyMeta] = useState("Loading…");

  // drill-down state
  const [selectedLogin, setSelectedLogin] = useState<string | number | null>(null);
  const [routing, setRouting] = useState<RoutingState>({
    rows: [],
    meta: null,
    loading: false,
    label: "",
  });
  const routingAbortRef = useRef<AbortController | null>(null);

  // set default dates once on mount
  useEffect(() => {
    const today = new Date();
    const from = new Date(today.getTime() - 30 * 86400 * 1000);
    setToYmd(toLocalYmd(today));
    setFromYmd(toLocalYmd(from));
  }, []);

  // abort any in-flight routing fetch on unmount
  useEffect(() => {
    return () => {
      routingAbortRef.current?.abort();
    };
  }, []);

  // load monthly chart on mount and whenever refreshKey changes
  useEffect(() => {
    if (!fromYmd || !toYmd) return;
    void loadMonthly(fromYmd, toYmd, group);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // also reload monthly whenever dates/group stabilise after first render
  useEffect(() => {
    if (!fromYmd || !toYmd) return;
    void loadMonthly(fromYmd, toYmd, group);
  }, [fromYmd, toYmd, group]); // loadMonthly is intentionally stable (defined in component scope)

  const loadMonthly = async (from: string, to: string, grp: string) => {
    setMonthlyMeta("Loading…");
    try {
      const params = new URLSearchParams({ from, to, group: grp });
      const resp = await fetch(`${BACKEND_BASE_URL}/ClientVolume/Monthly?${params.toString()}`);
      if (!resp.ok) {
        setMonthlyMeta(`Error ${resp.status}`);
        return;
      }
      const rows = (await resp.json()) as MonthlyRow[];
      const list = Array.isArray(rows) ? rows : [];
      setMonthly(list);
      const total = list.reduce((s, r) => s + (r.lots || 0), 0);
      const totalStocks = list.reduce((s, r) => s + (r.stocksLots || 0), 0);
      const totalCfd = list.reduce((s, r) => s + (r.cfdLots || 0), 0);
      const fmtTotal = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
      setMonthlyMeta(
        total > 0
          ? `${from} → ${to} · ${fmtTotal(total)} total · ${fmtTotal(totalStocks)} stocks · ${fmtTotal(totalCfd)} CFD`
          : `${from} → ${to} · 0 lots`,
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setMonthlyMeta(`Failed: ${e?.message ?? "unknown error"}`);
    }
  };

  const runVolume = async () => {
    if (!fromYmd || !toYmd) {
      setError("Pick a date range first.");
      return;
    }
    setError(null);
    setLoading(true);
    setStatsText("Loading…");
    try {
      const params = new URLSearchParams({ from: fromYmd, to: toYmd, group: group || "*" });
      if (symbol.trim()) params.set("symbol", symbol.trim());
      if (login.trim()) params.set("login", login.trim());
      const resp = await fetch(`${BACKEND_BASE_URL}/ClientVolume/Run?${params.toString()}`);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`Error ${resp.status}${txt ? `: ${txt}` : ""}`);
      }
      const payload = (await resp.json()) as RunResponse;
      setData(payload);
      setSelectedLogin(null);
      routingAbortRef.current?.abort();
      setRouting({ rows: [], meta: null, loading: false, label: "" });
      setStatsText(`${payload.fromDate} → ${payload.toDate} · ${payload.activeDays} days`);
      void loadMonthly(fromYmd, toYmd, group || "*");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e?.message ?? "Failed to load volume data.");
      setStatsText("Error");
    } finally {
      setLoading(false);
    }
  };

  const loadRouting = async (clientLogin: string | number, clientName: string) => {
    if (!fromYmd || !toYmd) return;

    // Cancel any in-flight routing fetch — keeps the UI in sync with the most
    // recently clicked client when a user clicks rapidly.
    routingAbortRef.current?.abort();
    const ctrl = new AbortController();
    routingAbortRef.current = ctrl;

    setRouting({ rows: [], meta: null, loading: true, label: `login ${clientLogin}${clientName ? ` · ${clientName}` : ""}` });
    try {
      const params = new URLSearchParams({ from: fromYmd, to: toYmd, group: group || "*", login: String(clientLogin) });
      const resp = await fetch(`${BACKEND_BASE_URL}/ClientVolume/ClientRouting?${params.toString()}`, {
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        setRouting((prev) => ({ ...prev, loading: false, meta: null }));
        return;
      }
      const payload = (await resp.json()) as { perSymbolLp?: RoutingRow[]; totalLots?: number; symbolCount?: number };
      setRouting({
        rows: Array.isArray(payload.perSymbolLp) ? payload.perSymbolLp : [],
        meta: { symbolCount: payload.symbolCount ?? 0, totalLots: payload.totalLots ?? 0 },
        loading: false,
        label: `login ${clientLogin}${clientName ? ` · ${clientName}` : ""}`,
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setRouting((prev) => ({ ...prev, loading: false }));
    }
  };

  // ── chart data ───────────────────────────────────────────────────────────────

  const monthlyChartData = useMemo(
    () =>
      monthly.map((r) => {
        const stocksLots = Number(r.stocksLots || 0);
        const cfdLots = Number(r.cfdLots || 0);
        return {
          month: fmtMonthLabel(r.month),
          lots: Number(r.lots ?? stocksLots + cfdLots),
          stocksLots,
          cfdLots,
        };
      }),
    [monthly],
  );
  const monthlyTotalLots = useMemo(() => monthly.reduce((s, r) => s + (r.lots || 0), 0), [monthly]);

  // ── sorted client rows (desc by lots) ────────────────────────────────────────

  const byClientSorted = useMemo(() => {
    if (!data?.byClient) return [];
    return [...data.byClient].sort((a, b) => (b.lots ?? 0) - (a.lots ?? 0));
  }, [data]);

  const byInternalAccountSorted = useMemo(() => {
    if (!data?.byInternalAccount) return [];
    return [...data.byInternalAccount].sort((a, b) => (b.lots ?? 0) - (a.lots ?? 0));
  }, [data]);

  // ── filtered byClientSymbol rows ─────────────────────────────────────────────

  const bySymbolFiltered = useMemo(() => {
    if (!data?.byClientSymbol) return [];
    if (selectedLogin == null) return data.byClientSymbol;
    return data.byClientSymbol.filter((r) => String(r.login) === String(selectedLogin));
  }, [data, selectedLogin]);

  const bySymbolLabel = useMemo(() => {
    if (!data?.byClientSymbol) return "";
    if (selectedLogin == null) return `${data.byClientSymbol.length} rows (all clients)`;
    return `${bySymbolFiltered.length} rows · filtered to login ${selectedLogin}`;
  }, [data, selectedLogin, bySymbolFiltered.length]);

  // ── column defs ───────────────────────────────────────────────────────────────

  const byDateColumns = useMemo<SortableTableColumn<ByDateRow>[]>(
    () => [
      {
        key: "date",
        label: "Date",
        sortValue: (r) => r.date,
        render: (r) => <span className="font-mono text-slate-800 dark:text-slate-100">{r.date}</span>,
      },
      {
        key: "lots",
        label: "Lots",
        sortValue: (r) => Number(r.lots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => fmtLots(r.lots),
      },
      {
        key: "stocksLots",
        label: "Stocks Lots",
        sortValue: (r) => Number(r.stocksLots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className="text-[#60a5fa]">{fmtLots(r.stocksLots)}</span>,
      },
      {
        key: "cfdLots",
        label: "CFD Lots",
        sortValue: (r) => Number(r.cfdLots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className="text-[#c084fc]">{fmtLots(r.cfdLots)}</span>,
      },
    ],
    [],
  );

  const byClientColumns = useMemo<SortableTableColumn<ByClientRow>[]>(
    () => [
      {
        key: "login",
        label: "Login",
        sortValue: (r) => String(r.login),
        render: (r) => <span className="font-mono text-slate-800 dark:text-slate-100">{r.login}</span>,
      },
      {
        key: "name",
        label: "Name",
        sortValue: (r) => String(r.name || ""),
        render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.name || "—"}</span>,
      },
      {
        key: "group",
        label: "Group",
        sortValue: (r) => String(r.group || ""),
        render: (r) => <span className="text-slate-500 dark:text-slate-400">{r.group || "—"}</span>,
      },
      {
        key: "system",
        label: "System",
        sortValue: (r) => String(r.system || ""),
        render: (r) => <span className="text-slate-500 dark:text-slate-400">{r.system || "—"}</span>,
      },
      {
        key: "lots",
        label: "Lots",
        sortValue: (r) => Number(r.lots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className="text-emerald-700 dark:text-emerald-300">{fmtLots(r.lots)}</span>,
      },
      {
        key: "stocksLots",
        label: "Stocks Lots",
        sortValue: (r) => Number(r.stocksLots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className="text-[#60a5fa]">{fmtLots(r.stocksLots)}</span>,
      },
      {
        key: "cfdLots",
        label: "CFD Lots",
        sortValue: (r) => Number(r.cfdLots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className="text-[#c084fc]">{fmtLots(r.cfdLots)}</span>,
      },
      {
        key: "activeDays",
        label: "Active Days",
        sortValue: (r) => Number(r.activeDays) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => Math.round(Number(r.activeDays) || 0).toLocaleString(),
      },
      {
        key: "dailyAverage",
        label: "Daily Avg",
        sortValue: (r) => Number(r.dailyAverage) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => fmtLots(r.dailyAverage),
      },
      {
        key: "symbolCount",
        label: "Symbols",
        sortValue: (r) => Number(r.symbolCount) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => Math.round(Number(r.symbolCount) || 0).toLocaleString(),
      },
    ],
    [],
  );

  const bySymbolColumns = useMemo<SortableTableColumn<ByClientSymbolRow>[]>(
    () => [
      {
        key: "login",
        label: "Login",
        sortValue: (r) => String(r.login),
        render: (r) => <span className="font-mono text-slate-800 dark:text-slate-100">{r.login}</span>,
      },
      {
        key: "name",
        label: "Name",
        sortValue: (r) => String(r.name || ""),
        render: (r) => <span className="text-slate-700 dark:text-slate-200">{r.name || "—"}</span>,
      },
      {
        key: "symbol",
        label: "Symbol",
        sortValue: (r) => String(r.symbol || ""),
        render: (r) => <span className="font-mono text-cyan-700 dark:text-cyan-300">{r.symbol}</span>,
      },
      {
        key: "lots",
        label: "Lots",
        sortValue: (r) => Number(r.lots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => fmtLots(r.lots),
      },
      {
        key: "stocksLots",
        label: "Stocks Lots",
        sortValue: (r) => Number(r.stocksLots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className="text-[#60a5fa]">{fmtLots(r.stocksLots)}</span>,
      },
      {
        key: "cfdLots",
        label: "CFD Lots",
        sortValue: (r) => Number(r.cfdLots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className="text-[#c084fc]">{fmtLots(r.cfdLots)}</span>,
      },
    ],
    [],
  );

  const routingColumns = useMemo<SortableTableColumn<RoutingRow>[]>(
    () => [
      {
        key: "symbol",
        label: "Symbol",
        sortValue: (r) => String(r.symbol || ""),
        render: (r) => <span className="font-mono text-slate-800 dark:text-slate-100">{r.symbol}</span>,
      },
      {
        key: "lpsid",
        label: "LP SID",
        sortValue: (r) => String(r.lpsid || ""),
        render: (r) => (
          <span className={r.lpsid === "Unattributed" ? "italic text-slate-500 dark:text-slate-400" : "text-slate-700 dark:text-slate-200"}>
            {r.lpsid}
          </span>
        ),
      },
      {
        key: "lots",
        label: "Lots",
        sortValue: (r) => Number(r.lots) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => fmtLots(r.lots),
      },
      {
        key: "percentage",
        label: "% of Symbol",
        sortValue: (r) => Number(r.percentage) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => {
          const pct = Number(r.percentage) || 0;
          const cls =
            pct >= 50
              ? "text-emerald-700 dark:text-emerald-300"
              : pct >= 20
                ? "text-amber-700 dark:text-amber-300"
                : "text-slate-500 dark:text-slate-400";
          return <span className={cls}>{pct.toFixed(2)}%</span>;
        },
      },
    ],
    [],
  );

  // ── render ────────────────────────────────────────────────────────────────────

  const sectionCls = "rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70";
  const inputCls =
    "rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100";
  const labelCls = "text-xs text-slate-500 dark:text-slate-400";

  return (
    <section className={sectionCls}>
      {/* ── header / controls ── */}
      <div className="mb-4">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
            Client Volume
          </h2>
          {statsText && (
            <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{statsText}</span>
          )}
        </div>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-500">
          Volume counts the <strong>closed leg only</strong> (each round-trip once). Dates are MT5 server-local.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <label className={labelCls}>
            Group
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              className={`mt-1 block w-16 ${inputCls}`}
            />
          </label>
          <label className={labelCls}>
            From
            <input
              type="date"
              value={fromYmd}
              onChange={(e) => setFromYmd(e.target.value)}
              className={`mt-1 block ${inputCls}`}
            />
          </label>
          <label className={labelCls}>
            To
            <input
              type="date"
              value={toYmd}
              onChange={(e) => setToYmd(e.target.value)}
              className={`mt-1 block ${inputCls}`}
            />
          </label>
          <label className={labelCls}>
            Symbol
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="all"
              className={`mt-1 block w-24 ${inputCls}`}
            />
          </label>
          <label className={labelCls}>
            Login
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="all"
              className={`mt-1 block w-24 ${inputCls}`}
            />
          </label>
          <button
            type="button"
            onClick={runVolume}
            disabled={loading}
            className="inline-flex h-[30px] items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 disabled:opacity-60 dark:text-emerald-300"
          >
            {loading ? "Loading…" : "Run"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* ── monthly chart ── */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white dark:border-slate-800/80 dark:bg-slate-950/70 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/70">
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Monthly traded lots</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">{monthlyMeta}</span>
        </div>
        {monthlyTotalLots > 0 ? (
          <div className="px-2 py-2" style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyChartData} margin={{ top: 18, right: 12, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 10, fill: "#94a3b8" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#94a3b8" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
                  width={38}
                />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", fontSize: 11 }}
                  labelStyle={{ color: "#e2e8f0" }}
                  formatter={(value: number, name: string) => [fmtLots(value), name]}
                />
                <Legend
                  verticalAlign="bottom"
                  wrapperStyle={{ fontSize: 10, color: "#94a3b8" }}
                />
                <Bar dataKey="cfdLots" name="CFD" stackId="lots" fill="#c084fc" />
                <Bar dataKey="stocksLots" name="Stocks" stackId="lots" fill="#60a5fa" radius={[3, 3, 0, 0]}>
                  <LabelList
                    dataKey="lots"
                    position="top"
                    style={{ fontSize: 9, fill: "#94a3b8" }}
                    formatter={(v: number) =>
                      v > 0 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : ""
                    }
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex h-[180px] items-center justify-center text-xs italic text-slate-500 dark:text-slate-400">
            No closed deals in the selected window.
          </div>
        )}
      </div>

      {/* ── KPI cards (after Run) ── */}
      {data && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">Total Lots (closed)</div>
            <div className="mt-1 font-mono text-xl font-semibold text-emerald-600 dark:text-emerald-300">
              {fmtLots(data.totalLots)}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">Stocks Lots</div>
            <div className="mt-1 font-mono text-xl font-semibold text-[#60a5fa]">
              {fmtLots(data.totalStocksLots)}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">CFD Lots</div>
            <div className="mt-1 font-mono text-xl font-semibold text-[#c084fc]">
              {fmtLots(data.totalCfdLots)}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">Avg Lots / Day</div>
            <div className="mt-1 font-mono text-xl font-semibold text-cyan-600 dark:text-cyan-300">
              {fmtLots(data.avgLotsPerDay)}
            </div>
          </div>
        </div>
      )}

      {/* ── By Date ── */}
      {data && (
        <div className="mb-4 space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
            Daily totals (across all clients)
          </h3>
          <SortableTable
            tableId="dealing-client-volume-bydate"
            rows={data.byDate ?? []}
            columns={byDateColumns}
            tableClassName="min-w-full text-xs"
            emptyText="No daily data."
          />
        </div>
      )}

      {/* ── By Client ── */}
      {data && (
        <div className="mb-4 space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
              Per-client volume
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              — Click a row to filter symbols + see routing
            </span>
          </div>
          <SortableTable
            tableId="dealing-client-volume-byclient"
            rows={byClientSorted}
            columns={byClientColumns}
            tableClassName="min-w-full text-xs"
            emptyText="No client data."
            onRowClick={(row) => {
              setSelectedLogin(row.login);
              void loadRouting(row.login, row.name ?? "");
            }}
          />
        </div>
      )}

      {/* ── Internal Accounts (excluded from totals/KPIs/chart) ── */}
      {data && byInternalAccountSorted.length > 0 && (
        <div className="mb-4 space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300">
              Internal Accounts
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Not included in headline totals / KPIs / monthly chart.
            </span>
          </div>
          <SortableTable
            tableId="dealing-client-volume-internals"
            rows={byInternalAccountSorted}
            columns={byClientColumns}
            tableClassName="min-w-full text-xs"
            emptyText="No internal account data."
          />
        </div>
      )}

      {/* ── By Client × Symbol ── */}
      {data && (
        <div className="mb-4 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-cyan-600 dark:text-cyan-300">
              Volume per client × symbol
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">{bySymbolLabel}</span>
          </div>
          <SortableTable
            tableId="dealing-client-volume-bysymbol"
            rows={bySymbolFiltered}
            columns={bySymbolColumns}
            tableClassName="min-w-full text-xs"
            emptyText="No symbol data."
          />
        </div>
      )}

      {/* ── Routing (per symbol × LP) — shown when a client is selected ── */}
      {data && selectedLogin != null && (
        <div className="mb-2 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300">
                Order routing by symbol × LP
              </h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {routing.label}
              </span>
            </div>
            {routing.meta && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {routing.meta.symbolCount} symbols · {fmtLots(routing.meta.totalLots)} lots
              </span>
            )}
            {routing.loading && (
              <span className="text-xs text-slate-500 dark:text-slate-400">Loading…</span>
            )}
          </div>
          <SortableTable
            tableId="dealing-client-volume-routing"
            rows={routing.rows}
            columns={routingColumns}
            tableClassName="min-w-full text-xs"
            emptyText={routing.loading ? "Loading routing data…" : "No routing data for this client."}
          />
        </div>
      )}
    </section>
  );
}
