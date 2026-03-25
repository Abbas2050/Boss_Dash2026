import { useMemo, useState } from "react";

type TabKey = "revenue" | "matched" | "unmatchedClient" | "unmatchedLP" | "fixApi";
type Row = Record<string, any>;

type DealMatchResponse = {
  totalClientDeals?: number;
  totalCentroidOrders?: number;
  matchedCount?: number;
  unmatchedClientCount?: number;
  unmatchedLpCount?: number;
  totalSpreadRevenueUsd?: number;
  totalCentroidOnlyRevenueUsd?: number;
  totalFixApiRevenueUsd?: number;
  fixApiOrderCount?: number;
  totalClientCommission?: number;
  matches?: Row[];
  unmatchedClientDeals?: Row[];
  unmatchedCentroidOrders?: Row[];
  fixApiOrders?: Row[];
  centroidOnlyRevenues?: Row[];
  fixApiRevenues?: Row[];
};

type RawCentroidResponse = {
  count?: number;
  columns?: string[];
  orders?: Row[];
};

const DEFAULT_API_COLUMNS = [
  "ext_login",
  "ext_order",
  "ext_posid",
  "ext_dealid",
  "symbol",
  "party_symbol",
  "side",
  "volume",
  "avg_price",
  "fill_volume",
  "maker",
  "maker_cat",
  "cen_ord_id",
  "client_ord_id",
  "risk_account",
  "node_account",
  "bids",
  "asks",
  "state",
  "create_time",
  "recv_time_msc",
  "price",
  "execution",
  "group",
  "account",
  "bid",
  "ask",
  "ext_bid",
  "ext_ask",
  "comment",
  "commission",
  "contract_size",
  "quote_conv_rate",
  "ord_type",
  "total_markup",
  "fix_session",
  "node",
  "volume_abook",
  "volume_bbook",
];

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function safe(value: any): string {
  if (value === null || value === undefined) return "-";
  return String(value);
}

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value: any): string {
  const n = num(value);
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedClass(value: any): string {
  const n = num(value);
  if (n > 0.000001) return "text-emerald-700 dark:text-emerald-300";
  if (n < -0.000001) return "text-rose-700 dark:text-rose-300";
  return "text-slate-500 dark:text-slate-400";
}

export function DealMatchingTab({ baseUrl }: { baseUrl: string }) {
  const today = useMemo(() => toYmd(new Date()), []);

  const [group, setGroup] = useState("*");
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DealMatchResponse | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("revenue");
  const [selectedMatchIdx, setSelectedMatchIdx] = useState<number | null>(null);

  const [rawOpen, setRawOpen] = useState(false);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<Row[]>([]);
  const [rawColumns, setRawColumns] = useState<string[]>([]);
  const [rawView, setRawView] = useState<"table" | "json">("table");

  const [rawFrom, setRawFrom] = useState(today);
  const [rawTo, setRawTo] = useState(today);
  const [rawLogin, setRawLogin] = useState("");
  const [rawSymbol, setRawSymbol] = useState("");
  const [rawAccount, setRawAccount] = useState("");
  const [rawRiskAccount, setRawRiskAccount] = useState("");
  const [rawGroup, setRawGroup] = useState("");
  const [rawOrder, setRawOrder] = useState("");
  const [rawCenOrdId, setRawCenOrdId] = useState("");
  const [rawExecution, setRawExecution] = useState("");
  const [rawMarkupModels, setRawMarkupModels] = useState("");
  const [apiColumnsCsv, setApiColumnsCsv] = useState(DEFAULT_API_COLUMNS.join(","));

  const matches = result?.matches || [];
  const unmatchedClientDeals = result?.unmatchedClientDeals || [];
  const unmatchedCentroidOrders = result?.unmatchedCentroidOrders || [];
  const fixApiOrders = result?.fixApiOrders || [];

  const selectedMatch = selectedMatchIdx == null ? null : matches[selectedMatchIdx] || null;

  const revenue = useMemo(() => {
    const bySymbol: Record<string, { deals: number; markup: number; commission: number }> = {};
    const byLogin: Record<string, { login: string; name: string; group: string; deals: number; markup: number; commission: number }> = {};

    for (const m of matches) {
      const markup = num(m.spreadRevenueUsd);
      const commission = num(m.clientCommission);
      const symbolKey = safe(m.symbol);
      if (!bySymbol[symbolKey]) bySymbol[symbolKey] = { deals: 0, markup: 0, commission: 0 };
      bySymbol[symbolKey].deals += 1;
      bySymbol[symbolKey].markup += markup;
      bySymbol[symbolKey].commission += commission;

      const loginKey = safe(m.clientLogin);
      if (!byLogin[loginKey]) {
        byLogin[loginKey] = {
          login: loginKey,
          name: safe(m.clientName),
          group: safe(m.clientGroup),
          deals: 0,
          markup: 0,
          commission: 0,
        };
      }
      byLogin[loginKey].deals += 1;
      byLogin[loginKey].markup += markup;
      byLogin[loginKey].commission += commission;
    }

    const symbolRows = Object.entries(bySymbol)
      .map(([symbolName, v]) => ({
        symbol: symbolName,
        deals: v.deals,
        markup: v.markup,
        commission: v.commission,
        total: v.markup + v.commission,
        avgMarkup: v.deals > 0 ? v.markup / v.deals : 0,
      }))
      .sort((a, b) => b.total - a.total);

    const loginRows = Object.values(byLogin)
      .map((v) => ({
        ...v,
        total: v.markup + v.commission,
      }))
      .sort((a, b) => b.total - a.total);

    const centroidBySymbol = (result?.centroidOnlyRevenues || []).reduce<Record<string, { orders: number; markup: number }>>((acc, r) => {
      const key = safe(r.symbol);
      if (!acc[key]) acc[key] = { orders: 0, markup: 0 };
      acc[key].orders += 1;
      acc[key].markup += num(r.spreadRevenueUsd);
      return acc;
    }, {});

    const fixApiBySymbol = (result?.fixApiRevenues || []).reduce<Record<string, { orders: number; markup: number }>>((acc, r) => {
      const key = safe(r.symbol);
      if (!acc[key]) acc[key] = { orders: 0, markup: 0 };
      acc[key].orders += 1;
      acc[key].markup += num(r.spreadRevenueUsd);
      return acc;
    }, {});

    return {
      symbolRows,
      loginRows,
      centroidRows: Object.entries(centroidBySymbol)
        .map(([symbolName, v]) => ({ symbol: symbolName, ...v, avgMarkup: v.orders > 0 ? v.markup / v.orders : 0 }))
        .sort((a, b) => b.markup - a.markup),
      fixApiRows: Object.entries(fixApiBySymbol)
        .map(([symbolName, v]) => ({ symbol: symbolName, ...v, avgMarkup: v.orders > 0 ? v.markup / v.orders : 0 }))
        .sort((a, b) => b.markup - a.markup),
    };
  }, [matches, result]);

  const runMatch = async () => {
    if (!fromDate || !toDate) {
      setError("Please select From and To dates.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedMatchIdx(null);

    const params = new URLSearchParams({ group: group || "*", from: fromDate, to: toDate });
    if (symbol.trim()) params.set("symbol", symbol.trim());

    try {
      const resp = await fetch(`${baseUrl}/DealMatch/Run?${params.toString()}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `DealMatch API ${resp.status}`);
      }
      const data = (await resp.json()) as DealMatchResponse;
      setResult(data || {});
      setActiveTab("revenue");
    } catch (e: any) {
      setError(e?.message || "Failed to run deal matching.");
    } finally {
      setLoading(false);
    }
  };

  const fetchRawOrders = async () => {
    if (!rawFrom || !rawTo) {
      setRawError("Please select From and To dates.");
      return;
    }

    setRawLoading(true);
    setRawError(null);
    setRawRows([]);
    setRawColumns([]);

    const params = new URLSearchParams({ from: rawFrom, to: rawTo });
    const csv = apiColumnsCsv
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .join(",");
    if (csv) params.set("columns", csv);

    const optional: Array<[string, string]> = [
      ["login", rawLogin],
      ["symbol", rawSymbol],
      ["account", rawAccount],
      ["riskAccount", rawRiskAccount],
      ["group", rawGroup],
      ["order", rawOrder],
      ["cenOrdId", rawCenOrdId],
      ["execution", rawExecution],
      ["markupModels", rawMarkupModels],
    ];
    for (const [k, v] of optional) {
      if (v.trim()) params.set(k, v.trim());
    }

    try {
      const resp = await fetch(`${baseUrl}/DealMatch/CentroidOrders?${params.toString()}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `CentroidOrders API ${resp.status}`);
      }
      const data = (await resp.json()) as RawCentroidResponse;
      const orders = Array.isArray(data.orders) ? data.orders : [];
      const columns = Array.isArray(data.columns) && data.columns.length ? data.columns : (orders[0] ? Object.keys(orders[0]) : []);
      setRawRows(orders);
      setRawColumns(columns);
      if (rawView !== "table" && rawView !== "json") setRawView("table");
    } catch (e: any) {
      setRawError(e?.message || "Failed to fetch raw centroid orders.");
    } finally {
      setRawLoading(false);
    }
  };

  const tabButton = (key: TabKey, label: string, count?: number) => (
    <button
      type="button"
      onClick={() => setActiveTab(key)}
      className={`rounded-md border px-3 py-1.5 text-xs ${activeTab === key ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-100" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"}`}
    >
      {label}{typeof count === "number" ? ` (${count})` : ""}
    </button>
  );

  const fixRevMap = useMemo(() => {
    const map: Record<string, Row> = {};
    for (const row of result?.fixApiRevenues || []) {
      const key = safe(row.cenOrdId);
      if (key && key !== "-") map[key] = row;
    }
    return map;
  }, [result]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40">
        <label className="text-xs text-slate-600 dark:text-slate-300">
          <div className="mb-1">Group</div>
          <input value={group} onChange={(e) => setGroup(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
        </label>
        <label className="text-xs text-slate-600 dark:text-slate-300">
          <div className="mb-1">From</div>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
        </label>
        <label className="text-xs text-slate-600 dark:text-slate-300">
          <div className="mb-1">To</div>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
        </label>
        <label className="text-xs text-slate-600 dark:text-slate-300">
          <div className="mb-1">Symbol (optional)</div>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
        </label>
        <button
          type="button"
          onClick={runMatch}
          disabled={loading}
          className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Running..." : "Run Match"}
        </button>
      </div>

      <details className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40" open={rawOpen} onToggle={(e) => setRawOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer text-sm font-semibold text-cyan-700 dark:text-cyan-200">Raw Centroid Orders (API Test)</summary>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-4 lg:grid-cols-6">
            <input type="date" value={rawFrom} onChange={(e) => setRawFrom(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input type="date" value={rawTo} onChange={(e) => setRawTo(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawLogin} onChange={(e) => setRawLogin(e.target.value)} placeholder="Login" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawSymbol} onChange={(e) => setRawSymbol(e.target.value.toUpperCase())} placeholder="Symbol" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawAccount} onChange={(e) => setRawAccount(e.target.value)} placeholder="Account" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawRiskAccount} onChange={(e) => setRawRiskAccount(e.target.value)} placeholder="Risk Account" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawGroup} onChange={(e) => setRawGroup(e.target.value)} placeholder="Group" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawOrder} onChange={(e) => setRawOrder(e.target.value)} placeholder="Order" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawCenOrdId} onChange={(e) => setRawCenOrdId(e.target.value)} placeholder="Cen Ord ID" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawExecution} onChange={(e) => setRawExecution(e.target.value)} placeholder="Execution" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <input value={rawMarkupModels} onChange={(e) => setRawMarkupModels(e.target.value)} placeholder="Markup Models" className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900" />
            <button
              type="button"
              onClick={fetchRawOrders}
              disabled={rawLoading}
              className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-100 hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {rawLoading ? "Fetching..." : "Fetch Orders"}
            </button>
          </div>
          <div>
            <div className="mb-1 text-xs text-slate-500 dark:text-slate-400">API Columns (comma separated)</div>
            <textarea
              value={apiColumnsCsv}
              onChange={(e) => setApiColumnsCsv(e.target.value)}
              rows={2}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
            />
          </div>
          {rawError && <div className="rounded border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{rawError}</div>}
          {rawRows.length > 0 && (
            <>
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span>Count: {rawRows.length.toLocaleString()}</span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setRawView("table")} className={`rounded px-2 py-1 ${rawView === "table" ? "bg-cyan-500/20 text-cyan-100" : "bg-slate-700/30"}`}>Table</button>
                  <button type="button" onClick={() => setRawView("json")} className={`rounded px-2 py-1 ${rawView === "json" ? "bg-cyan-500/20 text-cyan-100" : "bg-slate-700/30"}`}>JSON</button>
                </div>
              </div>
              {rawView === "table" ? (
                <div className="max-h-[45vh] overflow-auto rounded border border-slate-800">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>{rawColumns.map((c) => <th key={c} className="px-2 py-1.5 text-left uppercase">{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {rawRows.map((row, idx) => (
                        <tr key={`raw-${idx}`} className="border-t border-slate-800/70 bg-slate-50 dark:bg-slate-950/30">
                          {rawColumns.map((col) => (
                            <td key={`${idx}-${col}`} className="px-2 py-1.5">{typeof row[col] === "object" ? JSON.stringify(row[col]) : safe(row[col])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="max-h-[45vh] overflow-auto rounded border border-slate-800 bg-slate-950 p-3 text-xs">
                  <pre>{JSON.stringify(rawRows, null, 2)}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </details>

      {error && <div className="mb-3 rounded border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}

      {result && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
            {[
              { label: "Client Deals", value: result.totalClientDeals || 0, cls: "text-cyan-700 dark:text-cyan-300" },
              { label: "Centroid Orders", value: result.totalCentroidOrders || 0, cls: "text-cyan-700 dark:text-cyan-300" },
              { label: "Matched", value: result.matchedCount || 0, cls: "text-emerald-700 dark:text-emerald-300" },
              { label: "Unmatched Client", value: result.unmatchedClientCount || 0, cls: "text-rose-700 dark:text-rose-300" },
              { label: "Unmatched LP", value: result.unmatchedLpCount || 0, cls: "text-rose-700 dark:text-rose-300" },
              { label: "Fix API Orders", value: result.fixApiOrderCount || 0, cls: "text-indigo-700 dark:text-indigo-300" },
              { label: "Matched Markup", value: money(result.totalSpreadRevenueUsd), cls: signedClass(result.totalSpreadRevenueUsd) },
              { label: "Centroid Markup", value: money(result.totalCentroidOnlyRevenueUsd), cls: signedClass(result.totalCentroidOnlyRevenueUsd) },
              { label: "FIX API Revenue", value: money(result.totalFixApiRevenueUsd), cls: signedClass(result.totalFixApiRevenueUsd) },
              { label: "Commission", value: money(result.totalClientCommission), cls: signedClass(result.totalClientCommission) },
              {
                label: "Total Income",
                value: money(num(result.totalSpreadRevenueUsd) + num(result.totalCentroidOnlyRevenueUsd) + num(result.totalFixApiRevenueUsd) + num(result.totalClientCommission)),
                cls: signedClass(num(result.totalSpreadRevenueUsd) + num(result.totalCentroidOnlyRevenueUsd) + num(result.totalFixApiRevenueUsd) + num(result.totalClientCommission)),
              },
            ].map((card) => (
              <div key={card.label} className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/50">
                <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">{card.label}</div>
                <div className={`mt-1 text-sm font-semibold ${card.cls}`}>{card.value}</div>
              </div>
            ))}
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            {tabButton("revenue", "Revenue")}
            {tabButton("matched", "Matched", matches.length)}
            {tabButton("unmatchedClient", "Unmatched Client", unmatchedClientDeals.length)}
            {tabButton("unmatchedLP", "Unmatched LP", unmatchedCentroidOrders.length)}
            {tabButton("fixApi", "FIX API", fixApiOrders.length)}
          </div>

          {activeTab === "revenue" && (
            <div className="space-y-4">
              <div className="rounded border border-slate-800 overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left">Symbol</th>
                      <th className="px-3 py-2 text-right">Deals</th>
                      <th className="px-3 py-2 text-right">Markup</th>
                      <th className="px-3 py-2 text-right">Commission</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2 text-right">Avg Markup/Deal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenue.symbolRows.map((r) => (
                      <tr key={`rev-symbol-${r.symbol}`} className="border-t border-slate-800/70 bg-slate-50 dark:bg-slate-950/30">
                        <td className="px-3 py-2 font-semibold">{r.symbol}</td>
                        <td className="px-3 py-2 text-right">{r.deals}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.markup)}`}>{money(r.markup)}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.commission)}`}>{money(r.commission)}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.total)}`}>{money(r.total)}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.avgMarkup)}`}>{money(r.avgMarkup)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {revenue.centroidRows.length > 0 && (
                <div className="rounded border border-slate-800 overflow-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left">Centroid Symbol</th>
                        <th className="px-3 py-2 text-right">Orders</th>
                        <th className="px-3 py-2 text-right">Markup</th>
                        <th className="px-3 py-2 text-right">Avg Markup/Order</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revenue.centroidRows.map((r) => (
                        <tr key={`cen-${r.symbol}`} className="border-t border-slate-800/70 bg-slate-50 dark:bg-slate-950/30">
                          <td className="px-3 py-2 font-semibold">{r.symbol}</td>
                          <td className="px-3 py-2 text-right">{r.orders}</td>
                          <td className={`px-3 py-2 text-right ${signedClass(r.markup)}`}>{money(r.markup)}</td>
                          <td className={`px-3 py-2 text-right ${signedClass(r.avgMarkup)}`}>{money(r.avgMarkup)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {revenue.fixApiRows.length > 0 && (
                <div className="rounded border border-slate-800 overflow-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left">FIX API Symbol</th>
                        <th className="px-3 py-2 text-right">Orders</th>
                        <th className="px-3 py-2 text-right">Markup</th>
                        <th className="px-3 py-2 text-right">Avg Markup/Order</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revenue.fixApiRows.map((r) => (
                        <tr key={`fixrev-${r.symbol}`} className="border-t border-slate-800/70 bg-slate-50 dark:bg-slate-950/30">
                          <td className="px-3 py-2 font-semibold">{r.symbol}</td>
                          <td className="px-3 py-2 text-right">{r.orders}</td>
                          <td className={`px-3 py-2 text-right ${signedClass(r.markup)}`}>{money(r.markup)}</td>
                          <td className={`px-3 py-2 text-right ${signedClass(r.avgMarkup)}`}>{money(r.avgMarkup)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="rounded border border-slate-800 overflow-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left">Login</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Group</th>
                      <th className="px-3 py-2 text-right">Deals</th>
                      <th className="px-3 py-2 text-right">Markup</th>
                      <th className="px-3 py-2 text-right">Commission</th>
                      <th className="px-3 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenue.loginRows.map((r) => (
                      <tr key={`rev-login-${r.login}`} className="border-t border-slate-800/70 bg-slate-50 dark:bg-slate-950/30">
                        <td className="px-3 py-2 font-mono">{r.login}</td>
                        <td className="px-3 py-2">{r.name}</td>
                        <td className="px-3 py-2">{r.group}</td>
                        <td className="px-3 py-2 text-right">{r.deals}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.markup)}`}>{money(r.markup)}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.commission)}`}>{money(r.commission)}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.total)}`}>{money(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === "matched" && (
            <div className="space-y-3">
              <div className="max-h-[52vh] overflow-auto rounded border border-slate-800">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Time</th>
                      <th className="px-2 py-1.5 text-left">Symbol</th>
                      <th className="px-2 py-1.5 text-left">Side</th>
                      <th className="px-2 py-1.5 text-left">Entry</th>
                      <th className="px-2 py-1.5 text-right">Login</th>
                      <th className="px-2 py-1.5 text-right">Volume</th>
                      <th className="px-2 py-1.5 text-right">Client Price</th>
                      <th className="px-2 py-1.5 text-right">LP Price</th>
                      <th className="px-2 py-1.5 text-right">Markup (pts)</th>
                      <th className="px-2 py-1.5 text-right">Markup ($)</th>
                      <th className="px-2 py-1.5 text-right">Commission</th>
                      <th className="px-2 py-1.5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m, idx) => {
                      const total = num(m.spreadRevenueUsd) + num(m.clientCommission);
                      return (
                        <tr key={`match-${idx}`} className={`border-t border-slate-800/70 ${selectedMatchIdx === idx ? "bg-slate-200/70 dark:bg-slate-800/70" : "bg-slate-50 dark:bg-slate-950/30"}`} onClick={() => setSelectedMatchIdx(idx)}>
                          <td className="px-2 py-1.5">{safe(m.dealTime)}</td>
                          <td className="px-2 py-1.5 font-semibold">{safe(m.symbol)}</td>
                          <td className="px-2 py-1.5">{safe(m.side)}</td>
                          <td className="px-2 py-1.5">{safe(m.entry)}</td>
                          <td className="px-2 py-1.5 text-right">{safe(m.clientLogin)}</td>
                          <td className="px-2 py-1.5 text-right">{safe(m.clientVolume)}</td>
                          <td className="px-2 py-1.5 text-right">{safe(m.clientPrice)}</td>
                          <td className="px-2 py-1.5 text-right">{safe(m.lpPrice)}</td>
                          <td className={`px-2 py-1.5 text-right ${signedClass(m.spread)}`}>{num(m.spread).toFixed(6)}</td>
                          <td className={`px-2 py-1.5 text-right ${signedClass(m.spreadRevenueUsd)}`}>{money(m.spreadRevenueUsd)}</td>
                          <td className="px-2 py-1.5 text-right">{money(m.clientCommission)}</td>
                          <td className={`px-2 py-1.5 text-right font-semibold ${signedClass(total)}`}>{money(total)}</td>
                        </tr>
                      );
                    })}
                    {!matches.length && (
                      <tr>
                        <td className="px-3 py-8 text-center text-slate-500" colSpan={12}>No matched deals</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {selectedMatch && (
                <div className="grid grid-cols-1 gap-3 rounded border border-slate-800 bg-slate-50 p-3 text-xs dark:bg-slate-900/40 md:grid-cols-2">
                  <div className="space-y-1">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Client Side</div>
                    {[
                      ["Time", selectedMatch.dealTime],
                      ["Login", selectedMatch.clientLogin],
                      ["Name", selectedMatch.clientName],
                      ["Group", selectedMatch.clientGroup],
                      ["Symbol", selectedMatch.symbol],
                      ["Side", selectedMatch.side],
                      ["Entry", selectedMatch.entry],
                      ["Volume", selectedMatch.clientVolume],
                      ["Client Price", selectedMatch.clientPrice],
                      ["Market Bid", selectedMatch.marketBid],
                      ["Market Ask", selectedMatch.marketAsk],
                      ["Commission", money(selectedMatch.clientCommission)],
                      ["Deal Ticket", selectedMatch.dealTicket],
                      ["Order Ticket", selectedMatch.orderTicket],
                      ["Position ID", selectedMatch.positionId],
                      ["External ID", selectedMatch.externalDealId],
                    ].map(([k, v]) => (
                      <div key={String(k)} className="flex justify-between border-b border-slate-800/50 py-0.5"><span className="text-slate-500">{String(k)}</span><span>{safe(v)}</span></div>
                    ))}
                  </div>
                  <div className="space-y-1">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">LP Side</div>
                    {[
                      ["LP Name", selectedMatch.lpName],
                      ["LP Symbol", selectedMatch.partySymbol],
                      ["LP Price", selectedMatch.lpPrice],
                      ["LP Volume", selectedMatch.lpVolume],
                      ["LP Bid", selectedMatch.lpBid],
                      ["LP Ask", selectedMatch.lpAsk],
                      ["Centroid Order", selectedMatch.centroidOrderId],
                      ["Fill Count", selectedMatch.centroidFillCount],
                      ["Markup (pts)", num(selectedMatch.spread).toFixed(6)],
                      ["Revenue ($)", money(selectedMatch.spreadRevenueUsd)],
                      ["Slippage (pts)", num(selectedMatch.slippage).toFixed(6)],
                      ["Slippage ($)", money(selectedMatch.slippageUsd)],
                      ["Contract Size", selectedMatch.contractSize],
                      ["Client Units", selectedMatch.clientUnits],
                      ["LP Units", selectedMatch.lpUnits],
                      ["Match Status", selectedMatch.matchStatus],
                      ["Match Method", selectedMatch.matchMethod],
                      ["Time Delta", selectedMatch.timeDeltaMs],
                    ].map(([k, v]) => (
                      <div key={String(k)} className="flex justify-between border-b border-slate-800/50 py-0.5"><span className="text-slate-500">{String(k)}</span><span>{safe(v)}</span></div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "unmatchedClient" && (
            <div className="max-h-[52vh] overflow-auto rounded border border-slate-800">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Time</th>
                    <th className="px-2 py-1.5 text-left">Symbol</th>
                    <th className="px-2 py-1.5 text-left">Side</th>
                    <th className="px-2 py-1.5 text-left">Entry</th>
                    <th className="px-2 py-1.5 text-right">Login</th>
                    <th className="px-2 py-1.5 text-left">Name</th>
                    <th className="px-2 py-1.5 text-left">Group</th>
                    <th className="px-2 py-1.5 text-right">Price</th>
                    <th className="px-2 py-1.5 text-right">Volume</th>
                    <th className="px-2 py-1.5 text-right">Deal</th>
                    <th className="px-2 py-1.5 text-left">Ext ID</th>
                    <th className="px-2 py-1.5 text-right">Order</th>
                    <th className="px-2 py-1.5 text-right">Position</th>
                    <th className="px-2 py-1.5 text-left">Comment</th>
                    <th className="px-2 py-1.5 text-left">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedClientDeals.map((d, idx) => (
                    <tr key={`uc-${idx}`} className="border-t border-slate-800/70 bg-slate-50 dark:bg-slate-950/30">
                      <td className="px-2 py-1.5">{safe(d.time)}</td>
                      <td className="px-2 py-1.5 font-semibold">{safe(d.symbol)}</td>
                      <td className="px-2 py-1.5">{safe(d.side)}</td>
                      <td className="px-2 py-1.5">{safe(d.entry)}</td>
                      <td className="px-2 py-1.5 text-right">{safe(d.login)}</td>
                      <td className="px-2 py-1.5">{safe(d.clientName)}</td>
                      <td className="px-2 py-1.5">{safe(d.group)}</td>
                      <td className="px-2 py-1.5 text-right">{safe(d.price)}</td>
                      <td className="px-2 py-1.5 text-right">{safe(d.volume)}</td>
                      <td className="px-2 py-1.5 text-right">{safe(d.deal)}</td>
                      <td className="px-2 py-1.5">{safe(d.externalId)}</td>
                      <td className="px-2 py-1.5 text-right">{safe(d.order)}</td>
                      <td className="px-2 py-1.5 text-right">{safe(d.positionId)}</td>
                      <td className="px-2 py-1.5">{safe(d.comment)}</td>
                      <td className="px-2 py-1.5">{safe(d.reason)}</td>
                    </tr>
                  ))}
                  {!unmatchedClientDeals.length && (
                    <tr>
                      <td className="px-3 py-8 text-center text-slate-500" colSpan={15}>All client deals matched</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "unmatchedLP" && (
            <div className="max-h-[52vh] overflow-auto rounded border border-slate-800">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Symbol</th>
                    <th className="px-2 py-1.5 text-left">Side</th>
                    <th className="px-2 py-1.5 text-right">LP Exec Price</th>
                    <th className="px-2 py-1.5 text-right">Volume</th>
                    <th className="px-2 py-1.5 text-right">Fill Vol</th>
                    <th className="px-2 py-1.5 text-left">Maker</th>
                    <th className="px-2 py-1.5 text-left">Node Account</th>
                    <th className="px-2 py-1.5 text-left">Login</th>
                    <th className="px-2 py-1.5 text-left">Account</th>
                    <th className="px-2 py-1.5 text-left">Ext Order</th>
                    <th className="px-2 py-1.5 text-left">Ext Deal</th>
                    <th className="px-2 py-1.5 text-left">Ext Pos</th>
                    <th className="px-2 py-1.5 text-left">Client Ord ID</th>
                    <th className="px-2 py-1.5 text-left">Cen Ord ID</th>
                    <th className="px-2 py-1.5 text-left">State</th>
                    <th className="px-2 py-1.5 text-left">Execution</th>
                    <th className="px-2 py-1.5 text-left">Group</th>
                    <th className="px-2 py-1.5 text-left">Risk Account</th>
                    <th className="px-2 py-1.5 text-left">Party Symbol</th>
                    <th className="px-2 py-1.5 text-left">Create Time</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedCentroidOrders.map((o, idx) => {
                    const execPrice = num(o.avg_price) > 0 ? o.avg_price : o.price;
                    return (
                      <tr key={`ulp-${idx}`} className="border-t border-slate-800/70 bg-slate-50 dark:bg-slate-950/30">
                        <td className="px-2 py-1.5 font-semibold">{safe(o.symbol)}</td>
                        <td className="px-2 py-1.5">{safe(o.side)}</td>
                        <td className="px-2 py-1.5 text-right">{safe(execPrice)}</td>
                        <td className="px-2 py-1.5 text-right">{safe(o.volume)}</td>
                        <td className="px-2 py-1.5 text-right">{safe(o.fill_volume)}</td>
                        <td className="px-2 py-1.5">{safe(o.maker)}</td>
                        <td className="px-2 py-1.5">{safe(o.node_account)}</td>
                        <td className="px-2 py-1.5">{safe(o.ext_login)}</td>
                        <td className="px-2 py-1.5">{safe(o.account)}</td>
                        <td className="px-2 py-1.5">{safe(o.ext_order) === "0" ? "FIX API" : safe(o.ext_order)}</td>
                        <td className="px-2 py-1.5">{safe(o.ext_dealid)}</td>
                        <td className="px-2 py-1.5">{safe(o.ext_posid)}</td>
                        <td className="px-2 py-1.5">{safe(o.client_ord_id)}</td>
                        <td className="px-2 py-1.5">{safe(o.cen_ord_id)}</td>
                        <td className="px-2 py-1.5">{safe(o.state)}</td>
                        <td className="px-2 py-1.5">{safe(o.execution)}</td>
                        <td className="px-2 py-1.5">{safe(o.group)}</td>
                        <td className="px-2 py-1.5">{safe(o.risk_account)}</td>
                        <td className="px-2 py-1.5">{safe(o.party_symbol)}</td>
                        <td className="px-2 py-1.5">{safe(o.create_time)}</td>
                      </tr>
                    );
                  })}
                  {!unmatchedCentroidOrders.length && (
                    <tr>
                      <td className="px-3 py-8 text-center text-slate-500" colSpan={20}>All LP orders matched</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "fixApi" && (
            <div className="max-h-[52vh] overflow-auto rounded border border-slate-800">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Symbol</th>
                    <th className="px-2 py-1.5 text-left">Side</th>
                    <th className="px-2 py-1.5 text-right">Client Price</th>
                    <th className="px-2 py-1.5 text-right">LP Price</th>
                    <th className="px-2 py-1.5 text-right">Volume</th>
                    <th className="px-2 py-1.5 text-right">Spread (pts)</th>
                    <th className="px-2 py-1.5 text-right">Revenue ($)</th>
                    <th className="px-2 py-1.5 text-left">Node</th>
                    <th className="px-2 py-1.5 text-left">Node Account</th>
                    <th className="px-2 py-1.5 text-left">Login</th>
                    <th className="px-2 py-1.5 text-left">Maker</th>
                    <th className="px-2 py-1.5 text-left">Party Symbol</th>
                    <th className="px-2 py-1.5 text-left">Client Ord ID</th>
                    <th className="px-2 py-1.5 text-left">Cen Ord ID</th>
                    <th className="px-2 py-1.5 text-left">State</th>
                    <th className="px-2 py-1.5 text-left">Fix Session</th>
                    <th className="px-2 py-1.5 text-left">Create Time</th>
                  </tr>
                </thead>
                <tbody>
                  {fixApiOrders.map((o, idx) => {
                    const rev = fixRevMap[safe(o.cen_ord_id)];
                    const clientPrice = rev ? rev.clientPrice : (String(o.side || "").toLowerCase() === "buy" ? o.ext_ask : o.ext_bid);
                    const lpPrice = rev ? rev.lpPrice : (num(o.avg_price) > 0 ? o.avg_price : null);
                    const spread = rev ? rev.spread : null;
                    const spreadRevenueUsd = rev ? rev.spreadRevenueUsd : null;
                    const volume = rev ? rev.volume : o.fill_volume || o.volume;

                    return (
                      <tr key={`fix-${idx}`} className="border-t border-slate-800/70 bg-slate-50 dark:bg-slate-950/30">
                        <td className="px-2 py-1.5 font-semibold">{safe(o.symbol)}</td>
                        <td className="px-2 py-1.5">{safe(o.side)}</td>
                        <td className="px-2 py-1.5 text-right">{safe(clientPrice)}</td>
                        <td className="px-2 py-1.5 text-right">{safe(lpPrice)}</td>
                        <td className="px-2 py-1.5 text-right">{safe(volume)}</td>
                        <td className={`px-2 py-1.5 text-right ${signedClass(spread)}`}>{spread == null ? "-" : num(spread).toFixed(6)}</td>
                        <td className={`px-2 py-1.5 text-right font-semibold ${signedClass(spreadRevenueUsd)}`}>{spreadRevenueUsd == null ? "-" : money(spreadRevenueUsd)}</td>
                        <td className="px-2 py-1.5">{safe(o.node)}</td>
                        <td className="px-2 py-1.5">{safe(o.node_account)}</td>
                        <td className="px-2 py-1.5">{safe(o.ext_login)}</td>
                        <td className="px-2 py-1.5">{safe(o.maker)}</td>
                        <td className="px-2 py-1.5">{safe(o.party_symbol)}</td>
                        <td className="px-2 py-1.5">{safe(o.client_ord_id)}</td>
                        <td className="px-2 py-1.5">{safe(o.cen_ord_id)}</td>
                        <td className="px-2 py-1.5">{safe(o.state)}</td>
                        <td className="px-2 py-1.5">{safe(o.fix_session)}</td>
                        <td className="px-2 py-1.5">{safe(o.create_time)}</td>
                      </tr>
                    );
                  })}
                  {!fixApiOrders.length && (
                    <tr>
                      <td className="px-3 py-8 text-center text-slate-500" colSpan={17}>No FIX API orders</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
