import { useEffect, useMemo, useState } from "react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

// ── formatting helpers ──────────────────────────────────────────────────────

const nf2 = (n: number | null | undefined) =>
  Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const nf5 = (n: number | null | undefined) => {
  if (n === null || n === undefined || n === ("" as unknown)) return "";
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(5) : "";
};

const nfInt = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString();

function toLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function fmtTime(v: string | null | undefined): string {
  if (!v) return "";
  return String(v).replace("T", " ").replace(/Z$/, "").slice(0, 19);
}

const posCls = "text-emerald-600 dark:text-emerald-300";
const negCls = "text-rose-600 dark:text-rose-300";
const mutedCls = "text-slate-400 dark:text-slate-500";

// Positive = favorable (won) => green. Negative = adverse (lost) => red. Else muted.
function adverseCls(v: number | null | undefined): string {
  if (v === null || v === undefined) return mutedCls;
  const n = Number(v);
  if (!Number.isFinite(n)) return mutedCls;
  if (n > 0) return posCls;
  if (n < 0) return negCls;
  return mutedCls;
}

function hasNoMaker(row: SlippageRow): boolean {
  return row.hasMakerMatch === false;
}

// ── types ─────────────────────────────────────────────────────────────────────

type SlippageRow = {
  time?: string;
  extLogin?: string | number;
  extOrder?: string | number;
  cenOrdId?: string | number;
  symbol?: string;
  side?: string;
  state?: string;
  fillVolume?: number;
  lpsid?: string;
  reqPrice?: number;
  clientPrice?: number;
  makerReqPrice?: number;
  lpPrice?: number;
  clientSlipPoints?: number;
  clientPlImpact?: number;
  lpSlipPoints?: number;
  lpPlImpact?: number;
  clientSlipPrice?: number;
  lpSlipPrice?: number;
  avgPrice?: number;
  rawAvgPrice?: number;
  bid?: number;
  ask?: number;
  extBid?: number;
  extAsk?: number;
  priceDev?: number;
  totalMarkup?: number;
  mt5Markup?: number;
  quoteConvRate?: number;
  contractSize?: number;
  makerAvgPrice?: number;
  makerRawAvgPrice?: number;
  makerSlippageNative?: number;
  group?: string;
  account?: string;
  extDealid?: string | number;
  hasMakerMatch?: boolean;
};

type SlippageRunResponse = {
  rows?: SlippageRow[];
  internalRows?: SlippageRow[];
  rowCount?: number;
  fromDate?: string;
  toDate?: string;
};

type Bucket = {
  key: string;
  count: number;
  lots: number;
  netSlipUsd: number;
  netPosUsd: number;
  netNegUsd: number;
  avgSlipPts: number;
};

type PerLegTotals = {
  fillVolume: number;
  clientSlipPoints: number;
  clientPlImpact: number;
  lpSlipPoints: number;
  lpPlImpact: number;
  bridgeMarkupAbsSum: number;
  mt5MarkupAbsSum: number;
  netMarkupSum: number;
  markupSavingsSum: number;
  markupSavingsUsdSum: number;
};

// ── markup helpers (computed columns) ───────────────────────────────────────

const bridgeMarkupAbs = (r: SlippageRow) => Math.abs(Number(r.totalMarkup) || 0);
const mt5MarkupAbs = (r: SlippageRow) => Math.abs(Number(r.mt5Markup) || 0);
const netMarkupAbs = (r: SlippageRow) => bridgeMarkupAbs(r) + mt5MarkupAbs(r);
const markupSavingsPts = (r: SlippageRow) => mt5MarkupAbs(r) - bridgeMarkupAbs(r);
function markupSavingsUsd(r: SlippageRow): number {
  const cs = Number(r.contractSize) || 0;
  const lots = Number(r.fillVolume) || 0;
  const units = cs > 0 ? lots * cs : lots;
  const conv = Number(r.quoteConvRate) || 1;
  return markupSavingsPts(r) * units * conv;
}

// ── aggregation (By-LP / By-Symbol rollups) ─────────────────────────────────
// Groups rows by keyField (lpsid for by-LP, symbol for the drilldown). Empty
// key => emptyLabel. Each bucket reports lots + LP-slippage USD totals.
function aggregateBy(rows: SlippageRow[], keyField: "lpsid" | "symbol", emptyLabel: string): Bucket[] {
  const map = new Map<string, Bucket & { sumSlipPts: number; slipPtsCount: number }>();
  for (const r of rows) {
    const raw = keyField === "lpsid" ? r.lpsid : r.symbol;
    const key = String(raw || "").trim() || emptyLabel;
    let agg = map.get(key);
    if (!agg) {
      agg = { key, count: 0, lots: 0, netSlipUsd: 0, netPosUsd: 0, netNegUsd: 0, avgSlipPts: 0, sumSlipPts: 0, slipPtsCount: 0 };
      map.set(key, agg);
    }
    const lots = Number(r.fillVolume) || 0;
    const usd = Number(r.lpPlImpact) || 0;
    const pts = Number(r.lpSlipPoints) || 0;
    const hasLpFill = Number(r.lpPrice) > 0;

    agg.count += 1;
    agg.lots += lots;
    agg.netSlipUsd += usd;
    if (usd > 0) agg.netPosUsd += usd;
    else if (usd < 0) agg.netNegUsd += usd;
    if (hasLpFill) {
      agg.sumSlipPts += pts;
      agg.slipPtsCount += 1;
    }
  }
  const out: Bucket[] = [];
  for (const a of map.values()) {
    out.push({
      key: a.key,
      count: a.count,
      lots: a.lots,
      netSlipUsd: a.netSlipUsd,
      netPosUsd: a.netPosUsd,
      netNegUsd: a.netNegUsd,
      avgSlipPts: a.slipPtsCount > 0 ? a.sumSlipPts / a.slipPtsCount : 0,
    });
  }
  // Worst net slippage first (most negative).
  out.sort((a, b) => a.netSlipUsd - b.netSlipUsd);
  return out;
}

// Weighted-average TOTAL row for a rollup grid. Weighted by per-bucket
// contribution counts so the grand average stays honest.
function rollupTotals(buckets: Bucket[]): Bucket {
  return {
    key: "TOTAL",
    count: buckets.reduce((s, b) => s + b.count, 0),
    lots: buckets.reduce((s, b) => s + b.lots, 0),
    netSlipUsd: buckets.reduce((s, b) => s + b.netSlipUsd, 0),
    avgSlipPts:
      buckets.reduce((s, b) => s + b.avgSlipPts * b.count, 0) / Math.max(1, buckets.reduce((s, b) => s + b.count, 0)),
    netPosUsd: buckets.reduce((s, b) => s + b.netPosUsd, 0),
    netNegUsd: buckets.reduce((s, b) => s + b.netNegUsd, 0),
  };
}

// TOTAL row for the per-order detail / internal-accounts grids.
function perLegTotals(rows: SlippageRow[]): PerLegTotals {
  const t: PerLegTotals = {
    fillVolume: 0,
    clientSlipPoints: 0,
    clientPlImpact: 0,
    lpSlipPoints: 0,
    lpPlImpact: 0,
    bridgeMarkupAbsSum: 0,
    mt5MarkupAbsSum: 0,
    netMarkupSum: 0,
    markupSavingsSum: 0,
    markupSavingsUsdSum: 0,
  };
  for (const r of rows) {
    t.fillVolume += Number(r.fillVolume) || 0;
    t.clientSlipPoints += Number(r.clientSlipPoints) || 0;
    t.clientPlImpact += Number(r.clientPlImpact) || 0;
    t.lpSlipPoints += Number(r.lpSlipPoints) || 0;
    t.lpPlImpact += Number(r.lpPlImpact) || 0;
    t.bridgeMarkupAbsSum += bridgeMarkupAbs(r);
    t.mt5MarkupAbsSum += mt5MarkupAbs(r);
    t.markupSavingsUsdSum += markupSavingsUsd(r);
  }
  t.netMarkupSum = t.bridgeMarkupAbsSum + t.mt5MarkupAbsSum;
  t.markupSavingsSum = t.mt5MarkupAbsSum - t.bridgeMarkupAbsSum;
  return t;
}

// ── presentational bits ──────────────────────────────────────────────────────

function TotalsBar({ items }: { items: Array<{ label: string; value: string; cls?: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-xs font-semibold dark:border-slate-800 dark:bg-slate-900/70">
      <span className="text-slate-500 dark:text-slate-400">TOTAL</span>
      {items.map((it) => (
        <span key={it.label} className="tabular-nums">
          <span className="mr-1 font-normal text-slate-500 dark:text-slate-400">{it.label}:</span>
          <span className={it.cls || "text-slate-800 dark:text-slate-100"}>{it.value}</span>
        </span>
      ))}
    </div>
  );
}

// ── component ─────────────────────────────────────────────────────────────────

export function SlippageReportTab({ refreshKey }: { refreshKey: number }) {
  // filters
  const [group, setGroup] = useState("*");
  const [fromYmd, setFromYmd] = useState("");
  const [toYmd, setToYmd] = useState("");
  const [symbol, setSymbol] = useState("");
  const [login, setLogin] = useState("");

  // fetch state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statsText, setStatsText] = useState("");
  const [data, setData] = useState<SlippageRunResponse | null>(null);

  // drill-down state
  const [selectedLp, setSelectedLp] = useState<string | null>(null);

  // default dates: today → today (matches reference behaviour)
  useEffect(() => {
    const iso = toLocalYmd(new Date());
    setFromYmd(iso);
    setToYmd(iso);
  }, []);

  const runReport = async () => {
    if (!fromYmd || !toYmd) {
      setError("Pick a date range first.");
      return;
    }
    setError(null);
    setLoading(true);
    setStatsText("Loading…");
    setSelectedLp(null);
    try {
      const params = new URLSearchParams({ from: fromYmd, to: toYmd, group: group || "*" });
      if (symbol.trim()) params.set("symbol", symbol.trim());
      if (login.trim()) params.set("login", login.trim());
      const resp = await fetch(`${BACKEND_BASE_URL}/SlippageReport/Run?${params.toString()}`);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`Error ${resp.status}${txt ? `: ${txt}` : ""}`);
      }
      const payload = (await resp.json()) as SlippageRunResponse;
      setData(payload);
      const orderCount = payload.rowCount ?? payload.rows?.length ?? 0;
      setStatsText(`${payload.fromDate ?? fromYmd} → ${payload.toDate ?? toYmd} · ${nfInt(orderCount)} orders`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e?.message ?? "Failed to load slippage data.");
      setStatsText("Error");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  // Re-run whenever the page-level refresh button is clicked (mirrors RiskScenarioTab / DealPerformanceTab).
  useEffect(() => {
    if (refreshKey > 0) void runReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const allRows = data?.rows ?? [];
  const internalRows = data?.internalRows ?? [];

  const lpBuckets = useMemo(() => aggregateBy(allRows, "lpsid", "Unattributed"), [allRows]);
  const lpTotals = useMemo(() => rollupTotals(lpBuckets), [lpBuckets]);

  const bySymbolRows = useMemo(() => {
    if (!selectedLp) return [];
    return allRows.filter((r) => (String(r.lpsid || "").trim() || "Unattributed") === selectedLp);
  }, [allRows, selectedLp]);
  const symbolBuckets = useMemo(() => aggregateBy(bySymbolRows, "symbol", "—"), [bySymbolRows]);
  const symbolTotals = useMemo(() => rollupTotals(symbolBuckets), [symbolBuckets]);

  const detailTotals = useMemo(() => perLegTotals(allRows), [allRows]);
  const internalTotals = useMemo(() => perLegTotals(internalRows), [internalRows]);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const totalLots = lpBuckets.reduce((s, b) => s + b.lots, 0);
    const totalSlip = lpBuckets.reduce((s, b) => s + b.netSlipUsd, 0);

    // Displayed as slippage COST per lot: positive = we/client paid this much per lot,
    // negative = we gained. Best LP = lowest cost, Worst LP = highest cost.
    const ranked = lpBuckets
      .filter((b) => b.key !== "Unattributed" && b.lots > 0)
      .map((b) => ({ ...b, costPerLot: b.lots > 0 ? -b.netSlipUsd / b.lots : 0 }))
      .sort((a, b) => a.costPerLot - b.costPerLot);
    const best = ranked[0] ?? null;
    const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;

    const byClient = new Map<string, number>();
    for (const r of allRows) {
      const key = String(r.extLogin || "").trim();
      if (!key) continue;
      byClient.set(key, (byClient.get(key) || 0) + (Number(r.clientPlImpact) || 0));
    }
    let worstClient: string | null = null;
    let worstClientCost = 0;
    for (const [key, gain] of byClient) {
      const cost = -gain;
      if (cost > worstClientCost) {
        worstClientCost = cost;
        worstClient = key;
      }
    }

    return { totalLots, totalSlip, best, worst, worstClient, worstClientCost };
  }, [lpBuckets, allRows]);

  // ── column defs ───────────────────────────────────────────────────────────

  const rollupColumns = (keyHeader: string): SortableTableColumn<Bucket>[] => [
    {
      key: "key",
      label: keyHeader,
      sortValue: (r) => r.key,
      render: (r) => (
        <span className={`font-semibold ${r.key === "Unattributed" || r.key === "—" ? "italic text-slate-400 dark:text-slate-500" : "text-slate-800 dark:text-slate-100"}`}>
          {r.key}
        </span>
      ),
    },
    {
      key: "lots",
      label: "Lots",
      sortValue: (r) => r.lots,
      headerClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (r) => nf2(r.lots),
    },
    {
      key: "netSlipUsd",
      label: "Net Slippage USD",
      sortValue: (r) => r.netSlipUsd,
      headerClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (r) => <span className={adverseCls(r.netSlipUsd)}>{nf2(r.netSlipUsd)}</span>,
    },
    {
      key: "avgSlipPts",
      label: "Avg Slippage (pts)",
      sortValue: (r) => r.avgSlipPts,
      headerClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (r) => <span className={adverseCls(r.avgSlipPts)}>{nf2(r.avgSlipPts)}</span>,
    },
    {
      key: "netPosUsd",
      label: "Net Positive USD",
      sortValue: (r) => r.netPosUsd,
      headerClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (r) => <span className={posCls}>{nf2(r.netPosUsd)}</span>,
    },
    {
      key: "netNegUsd",
      label: "Net Negative USD",
      sortValue: (r) => r.netNegUsd,
      headerClassName: "text-right",
      cellClassName: "text-right tabular-nums",
      render: (r) => <span className={negCls}>{nf2(r.netNegUsd)}</span>,
    },
  ];

  const byLpColumns = useMemo(() => rollupColumns("LP (lpsid)"), []);
  const bySymbolColumns = useMemo(() => rollupColumns("Symbol"), []);

  const detailColumns = useMemo<SortableTableColumn<SlippageRow>[]>(
    () => [
      { key: "time", label: "Time", sortValue: (r) => r.time || "", render: (r) => <span className="font-mono text-slate-700 dark:text-slate-200">{fmtTime(r.time)}</span>, hideable: false },
      { key: "extLogin", label: "ExtLogin", sortValue: (r) => String(r.extLogin ?? ""), render: (r) => <span className="font-mono text-slate-800 dark:text-slate-100">{r.extLogin ?? ""}</span> },
      { key: "extOrder", label: "Ext Order ID", sortValue: (r) => String(r.extOrder ?? ""), render: (r) => r.extOrder ?? "" },
      { key: "cenOrdId", label: "Centroid Order ID", sortValue: (r) => String(r.cenOrdId ?? ""), render: (r) => r.cenOrdId ?? "" },
      { key: "symbol", label: "Symbol", sortValue: (r) => String(r.symbol ?? ""), render: (r) => <span className="font-semibold text-slate-800 dark:text-slate-100">{r.symbol}</span> },
      {
        key: "side",
        label: "Side",
        sortValue: (r) => String(r.side ?? ""),
        render: (r) => {
          const v = String(r.side || "").toLowerCase();
          const cls = v === "buy" ? "text-emerald-500 dark:text-emerald-400" : v === "sell" ? "text-rose-500 dark:text-rose-400" : "";
          return <span className={cls}>{r.side}</span>;
        },
      },
      { key: "state", label: "State", sortValue: (r) => String(r.state ?? ""), render: (r) => r.state ?? "" },
      {
        key: "fillVolume",
        label: "FillVolume",
        sortValue: (r) => Number(r.fillVolume) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => nf2(r.fillVolume),
      },
      {
        key: "lpsid",
        label: "LPSID",
        sortValue: (r) => String(r.lpsid ?? ""),
        render: (r) => (hasNoMaker(r) ? <span className="italic text-slate-400 dark:text-slate-500">—</span> : r.lpsid || ""),
      },
      { key: "reqPrice", label: "Client Req Price", sortValue: (r) => Number(r.reqPrice) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.reqPrice) },
      { key: "clientPrice", label: "Client Price", sortValue: (r) => Number(r.clientPrice) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.clientPrice) },
      { key: "makerReqPrice", label: "LP Req Price", sortValue: (r) => Number(r.makerReqPrice) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.makerReqPrice) },
      { key: "lpPrice", label: "LP Price", sortValue: (r) => Number(r.lpPrice) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.lpPrice) },
      {
        key: "clientSlipPoints",
        label: "ClientSlipPoints",
        sortValue: (r) => Number(r.clientSlipPoints) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className={adverseCls(r.clientSlipPoints)}>{nf2(r.clientSlipPoints)}</span>,
      },
      {
        key: "clientPlImpact",
        label: "Client Slippage USD",
        sortValue: (r) => Number(r.clientPlImpact) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className={adverseCls(r.clientPlImpact)}>{nf2(r.clientPlImpact)}</span>,
      },
      {
        key: "lpSlipPoints",
        label: "LpSlipPoints",
        sortValue: (r) => Number(r.lpSlipPoints) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => (hasNoMaker(r) ? <span className="italic text-slate-400 dark:text-slate-500">—</span> : <span className={adverseCls(r.lpSlipPoints)}>{nf2(r.lpSlipPoints)}</span>),
      },
      {
        key: "lpPlImpact",
        label: "LP Slippage USD",
        sortValue: (r) => Number(r.lpPlImpact) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => (hasNoMaker(r) ? <span className="italic text-slate-400 dark:text-slate-500">—</span> : <span className={adverseCls(r.lpPlImpact)}>{nf2(r.lpPlImpact)}</span>),
      },

      // ── hidden by default — toggle via Columns menu ──
      {
        key: "clientSlipPrice",
        label: "ClientSlipPrice",
        defaultVisible: false,
        sortValue: (r) => Number(r.clientSlipPrice) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className={adverseCls(r.clientSlipPrice)}>{nf5(r.clientSlipPrice)}</span>,
      },
      {
        key: "lpSlipPrice",
        label: "LpSlipPrice",
        defaultVisible: false,
        sortValue: (r) => Number(r.lpSlipPrice) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => (hasNoMaker(r) ? <span className="italic text-slate-400 dark:text-slate-500">—</span> : <span className={adverseCls(r.lpSlipPrice)}>{nf5(r.lpSlipPrice)}</span>),
      },
      { key: "avgPrice", label: "AvgPrice", defaultVisible: false, sortValue: (r) => Number(r.avgPrice) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.avgPrice) },
      { key: "rawAvgPrice", label: "RawAvgPrice", defaultVisible: false, sortValue: (r) => Number(r.rawAvgPrice) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.rawAvgPrice) },
      { key: "bid", label: "LP Bid (bid)", defaultVisible: false, sortValue: (r) => Number(r.bid) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.bid) },
      { key: "ask", label: "LP Ask (ask)", defaultVisible: false, sortValue: (r) => Number(r.ask) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.ask) },
      { key: "extBid", label: "Client Bid (ext_bid)", defaultVisible: false, sortValue: (r) => Number(r.extBid) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.extBid) },
      { key: "extAsk", label: "Client Ask (ext_ask)", defaultVisible: false, sortValue: (r) => Number(r.extAsk) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.extAsk) },
      { key: "priceDev", label: "PriceDev", defaultVisible: false, sortValue: (r) => Number(r.priceDev) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.priceDev) },
      {
        key: "bridgeMarkupAbs",
        label: "Bridge Markup",
        defaultVisible: false,
        sortValue: (r) => bridgeMarkupAbs(r),
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => nf5(bridgeMarkupAbs(r)),
      },
      {
        key: "mt5MarkupAbs",
        label: "MT5 Markup",
        defaultVisible: false,
        sortValue: (r) => mt5MarkupAbs(r),
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => nf5(mt5MarkupAbs(r)),
      },
      {
        key: "netMarkup",
        label: "Net Markup",
        defaultVisible: false,
        sortValue: (r) => netMarkupAbs(r),
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => nf5(netMarkupAbs(r)),
      },
      {
        key: "markupSavings",
        label: "Markup Savings",
        defaultVisible: false,
        sortValue: (r) => markupSavingsPts(r),
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className={adverseCls(markupSavingsPts(r))}>{nf5(markupSavingsPts(r))}</span>,
      },
      {
        key: "markupSavingsUsd",
        label: "Markup Savings USD",
        defaultVisible: false,
        sortValue: (r) => markupSavingsUsd(r),
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => <span className={adverseCls(markupSavingsUsd(r))}>{nf2(markupSavingsUsd(r))}</span>,
      },
      { key: "quoteConvRate", label: "QuoteConvRate", defaultVisible: false, sortValue: (r) => Number(r.quoteConvRate) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf5(r.quoteConvRate) },
      { key: "contractSize", label: "ContractSize", defaultVisible: false, sortValue: (r) => Number(r.contractSize) || 0, headerClassName: "text-right", cellClassName: "text-right tabular-nums", render: (r) => nf2(r.contractSize) },
      {
        key: "makerAvgPrice",
        label: "MakerAvgPrice",
        defaultVisible: false,
        sortValue: (r) => Number(r.makerAvgPrice) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => (hasNoMaker(r) ? <span className="italic text-slate-400 dark:text-slate-500">—</span> : nf5(r.makerAvgPrice)),
      },
      {
        key: "makerRawAvgPrice",
        label: "MakerRawAvgPrice",
        defaultVisible: false,
        sortValue: (r) => Number(r.makerRawAvgPrice) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => (hasNoMaker(r) ? <span className="italic text-slate-400 dark:text-slate-500">—</span> : nf5(r.makerRawAvgPrice)),
      },
      {
        key: "makerSlippageNative",
        label: "MakerSlippageNative",
        defaultVisible: false,
        sortValue: (r) => Number(r.makerSlippageNative) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right tabular-nums",
        render: (r) => (hasNoMaker(r) ? <span className="italic text-slate-400 dark:text-slate-500">—</span> : <span className={adverseCls(r.makerSlippageNative)}>{nf5(r.makerSlippageNative)}</span>),
      },
      { key: "group", label: "Group", defaultVisible: false, sortValue: (r) => String(r.group ?? ""), render: (r) => r.group ?? "" },
      { key: "account", label: "Account", defaultVisible: false, sortValue: (r) => String(r.account ?? ""), render: (r) => r.account ?? "" },
      { key: "extDealid", label: "ExtDealid", defaultVisible: false, sortValue: (r) => String(r.extDealid ?? ""), render: (r) => r.extDealid ?? "" },
    ],
    [],
  );

  // ── render ────────────────────────────────────────────────────────────────

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
            Slippage Report
          </h2>
          {statsText && <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{statsText}</span>}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className={labelCls}>
            Group
            <input value={group} onChange={(e) => setGroup(e.target.value)} className={`mt-1 block w-16 ${inputCls}`} />
          </label>
          <label className={labelCls}>
            From
            <input type="date" value={fromYmd} onChange={(e) => setFromYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
          </label>
          <label className={labelCls}>
            To
            <input type="date" value={toYmd} onChange={(e) => setToYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
          </label>
          <label className={labelCls}>
            Symbol
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="all" className={`mt-1 block w-24 ${inputCls}`} />
          </label>
          <label className={labelCls}>
            Login
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="all" className={`mt-1 block w-24 ${inputCls}`} />
          </label>
          <button
            type="button"
            onClick={runReport}
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

      {/* ── KPI cards ── */}
      {data && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">Total Lots</div>
            <div className="mt-1 font-mono text-lg font-semibold text-emerald-600 dark:text-emerald-300">{nf2(kpis.totalLots)}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">Total Net LP Slippage USD</div>
            <div className={`mt-1 font-mono text-lg font-semibold ${adverseCls(kpis.totalSlip)}`}>{nf2(kpis.totalSlip)}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">Best LP — lowest USD/lot</div>
            <div className="mt-1 truncate text-sm font-semibold text-emerald-600 dark:text-emerald-300">{kpis.best ? kpis.best.key : "—"}</div>
            <div className="font-mono text-xs text-slate-600 dark:text-slate-300">{kpis.best ? `${nf2(kpis.best.costPerLot)} USD/lot` : "0.00 USD/lot"}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">Worst LP — highest USD/lot</div>
            <div className="mt-1 truncate text-sm font-semibold text-rose-600 dark:text-rose-300">{kpis.worst ? kpis.worst.key : "—"}</div>
            <div className="font-mono text-xs text-slate-600 dark:text-slate-300">{kpis.worst ? `${nf2(kpis.worst.costPerLot)} USD/lot` : "0.00 USD/lot"}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800/80 dark:bg-slate-900/50">
            <div className="text-xs text-slate-500 dark:text-slate-400">Worst Client — highest total USD slippage</div>
            <div className="mt-1 truncate text-sm font-semibold text-rose-600 dark:text-rose-300">{kpis.worstClient || "—"}</div>
            <div className="font-mono text-xs text-slate-600 dark:text-slate-300">{kpis.worstClient ? `${nf2(kpis.worstClientCost)} USD` : "0.00 USD"}</div>
          </div>
        </div>
      )}

      {/* ── By-LP rollup ── */}
      {data && (
        <div className="mb-4 space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
              By LP
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">— click a row to drill down by symbol</span>
            <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{lpBuckets.length} LP(s)</span>
          </div>
          <SortableTable
            tableId="dealing-slippage-bylp"
            rows={lpBuckets}
            columns={byLpColumns}
            tableClassName="min-w-full text-xs"
            emptyText="No rows for the selected filters."
            onRowClick={(row) => setSelectedLp(row.key)}
          />
          {lpBuckets.length > 0 && (
            <TotalsBar
              items={[
                { label: "Lots", value: nf2(lpTotals.lots) },
                { label: "Net Slippage USD", value: nf2(lpTotals.netSlipUsd), cls: adverseCls(lpTotals.netSlipUsd) },
                { label: "Avg Slippage (pts)", value: nf2(lpTotals.avgSlipPts), cls: adverseCls(lpTotals.avgSlipPts) },
                { label: "Net Positive USD", value: nf2(lpTotals.netPosUsd), cls: posCls },
                { label: "Net Negative USD", value: nf2(lpTotals.netNegUsd), cls: negCls },
              ]}
            />
          )}
        </div>
      )}

      {/* ── By-Symbol drilldown ── */}
      {data && selectedLp && (
        <div className="mb-4 space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-cyan-600 dark:text-cyan-300">
              By Symbol — <span className="text-slate-700 dark:text-slate-200">{selectedLp}</span>
            </h3>
            <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
              {symbolBuckets.length} symbol(s) · {bySymbolRows.length} order(s)
            </span>
          </div>
          <SortableTable
            tableId="dealing-slippage-bysymbol"
            rows={symbolBuckets}
            columns={bySymbolColumns}
            tableClassName="min-w-full text-xs"
            emptyText="No symbol data for this LP."
          />
          {symbolBuckets.length > 0 && (
            <TotalsBar
              items={[
                { label: "Lots", value: nf2(symbolTotals.lots) },
                { label: "Net Slippage USD", value: nf2(symbolTotals.netSlipUsd), cls: adverseCls(symbolTotals.netSlipUsd) },
                { label: "Avg Slippage (pts)", value: nf2(symbolTotals.avgSlipPts), cls: adverseCls(symbolTotals.avgSlipPts) },
                { label: "Net Positive USD", value: nf2(symbolTotals.netPosUsd), cls: posCls },
                { label: "Net Negative USD", value: nf2(symbolTotals.netNegUsd), cls: negCls },
              ]}
            />
          )}
        </div>
      )}

      {/* ── Detailed per-order report ── */}
      {data && (
        <details className="mb-4 rounded-xl border border-slate-200 bg-white dark:border-slate-800/80 dark:bg-slate-950/70" open>
          <summary className="cursor-pointer list-none px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
              Detailed report — per-order slippage
            </span>
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{nfInt(data.rowCount ?? allRows.length)} orders</span>
          </summary>
          <div className="space-y-1 px-4 pb-4">
            <SortableTable
              tableId="dealing-slippage-detail"
              rows={allRows}
              columns={detailColumns}
              enableColumnVisibility
              tableClassName="min-w-full text-xs"
              emptyText="No orders for the selected filters."
            />
            {allRows.length > 0 && (
              <TotalsBar
                items={[
                  { label: "FillVolume", value: nf2(detailTotals.fillVolume) },
                  { label: "ClientSlipPoints", value: nf2(detailTotals.clientSlipPoints), cls: adverseCls(detailTotals.clientSlipPoints) },
                  { label: "Client Slippage USD", value: nf2(detailTotals.clientPlImpact), cls: adverseCls(detailTotals.clientPlImpact) },
                  { label: "LpSlipPoints", value: nf2(detailTotals.lpSlipPoints), cls: adverseCls(detailTotals.lpSlipPoints) },
                  { label: "LP Slippage USD", value: nf2(detailTotals.lpPlImpact), cls: adverseCls(detailTotals.lpPlImpact) },
                ]}
              />
            )}
          </div>
        </details>
      )}

      {/* ── Internal Accounts — excluded from KPIs/By-LP/detail totals ── */}
      {data && internalRows.length > 0 && (
        <details className="rounded-xl border border-amber-400/40 bg-amber-500/5 dark:border-amber-400/30">
          <summary className="cursor-pointer list-none px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Internal Accounts
            </span>
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
              {nfInt(internalRows.length)} orders · {nf2(internalTotals.fillVolume)} lots · Client {nf2(internalTotals.clientPlImpact)} USD · LP {nf2(internalTotals.lpPlImpact)} USD
            </span>
          </summary>
          <div className="px-4 pb-4">
            <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">
              Not included in headline KPIs, By-LP rollup, or the detailed report above.
            </p>
            <SortableTable
              tableId="dealing-slippage-internal"
              rows={internalRows}
              columns={detailColumns}
              enableColumnVisibility
              tableClassName="min-w-full text-xs"
              emptyText="No internal-account orders."
            />
            <div className="mt-1">
              <TotalsBar
                items={[
                  { label: "FillVolume", value: nf2(internalTotals.fillVolume) },
                  { label: "ClientSlipPoints", value: nf2(internalTotals.clientSlipPoints), cls: adverseCls(internalTotals.clientSlipPoints) },
                  { label: "Client Slippage USD", value: nf2(internalTotals.clientPlImpact), cls: adverseCls(internalTotals.clientPlImpact) },
                  { label: "LpSlipPoints", value: nf2(internalTotals.lpSlipPoints), cls: adverseCls(internalTotals.lpSlipPoints) },
                  { label: "LP Slippage USD", value: nf2(internalTotals.lpPlImpact), cls: adverseCls(internalTotals.lpPlImpact) },
                ]}
              />
            </div>
          </div>
        </details>
      )}
    </section>
  );
}
