import { useMemo, useState } from "react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";

type Row = Record<string, any>;

type DealMatchResponse = {
  fromDate?: string;
  toDate?: string;
  totalClientDeals?: number;
  totalCentroidOrders?: number;
  matchedCount?: number;
  totalBonusClientDeals?: number;
  totalSpreadRevenueUsd?: number;
  totalMt5MarkupUsd?: number;
  totalClientCommission?: number;
  totalGrossRevenueUsd?: number;
  totalLpCommissionAllocated?: number;
  fixApiOrderCount?: number;
  matches?: Row[];
  unmatchedClientDeals?: Row[];
  unmatchedCentroidOrders?: Row[];
  fixApiOrders?: Row[];
  coverageLps?: Row[];
  clientRevenueSummaries?: Row[];
  clientSystems?: Row[];
};

type RunParams = { group: string; from: number; to: number; symbol: string; login: string };

type UnmatchedAggregateRow = {
  login: string | number;
  clientName: string;
  group: string;
  system: string;
  dealCount: number;
  lots: number;
  buyLots: number;
  sellLots: number;
  symbols: string;
  latestTime: string;
  sampleExternalIds: string;
};

type RevenueRow = {
  login: string;
  name: string;
  group: string;
  system: string;
  lots: number;
  markupRevenueUsd: number;
  mt5MarkupUsd: number;
  centroidMarkupUsd: number;
  clientCommissionUsd: number;
  grossRevenueUsd: number;
  lpCommissionUsd: number;
  totalRevenueUsd: number;
};

type CoverageLpRow = {
  lpName: string;
  lpLogin: string;
  source: string;
  dealCount: number;
  lots: number;
  millionsUsd: number;
  effectiveCommission: number;
  actualCommission: number;
  calculatedCommission: number;
  configuredRatePerMillion?: number;
  effectiveRatePerMillion?: number;
  commissionSource: string;
};

type SystemRow = {
  system: string;
  lots: number | null;
  markupRevenueUsd: number | null;
  mt5MarkupUsd: number | null;
  grossRevenueUsd: number | null;
  commission: number;
};

// ── formatting helpers ──────────────────────────────────────────────────────

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function safe(value: any): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmtNum(value: any, digits = 2): string {
  return num(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const fmtNum5 = (value: any) => fmtNum(value, 5);

function fmtInt(value: any): string {
  return Math.round(num(value)).toLocaleString();
}

function fmtPct(value: any): string {
  return `${fmtNum(value)}%`;
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

function sideClass(value: any): string {
  const v = String(value || "").toLowerCase();
  if (v === "buy") return "font-semibold text-emerald-700 dark:text-emerald-300";
  if (v === "sell") return "font-semibold text-rose-700 dark:text-rose-300";
  return "text-slate-600 dark:text-slate-300";
}

function systemClass(value: any): string {
  const v = String(value || "");
  if (v === "Bonus") return "font-semibold text-amber-600 dark:text-amber-300";
  if (v === "LP Charged") return "font-semibold text-rose-600 dark:text-rose-300";
  if (v === "Net (Client - LP)") return "font-semibold text-cyan-600 dark:text-cyan-300";
  return "font-semibold text-sky-700 dark:text-sky-300";
}

function systemCommissionClass(system: any, value: any): string {
  const s = String(system || "");
  if (s === "LP Charged") return "font-semibold text-rose-600 dark:text-rose-300";
  if (s === "Net (Client - LP)") return `font-semibold ${signedClass(value)}`;
  return "font-semibold text-amber-600 dark:text-amber-300";
}

function ymdToUnixRange(fromDate: string, toDate: string) {
  const from = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000);
  const to = Math.floor(new Date(`${toDate}T23:59:59Z`).getTime() / 1000);
  return { from, to };
}

function collapseTitleClass(open: boolean) {
  return open
    ? "border-cyan-300/60 bg-cyan-50 text-cyan-900 shadow-sm transition-colors duration-200 hover:bg-cyan-100 dark:border-cyan-500/40 dark:bg-cyan-500/10 dark:text-cyan-200 dark:hover:bg-cyan-500/20"
    : "border-slate-300 bg-white text-slate-700 shadow-sm transition-colors duration-200 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-200 dark:hover:bg-slate-900/70";
}

// Client-aggregate the unmatched MT5 deals: sum lots, split buy/sell, unique symbols,
// latest deal time, and up to 3 sample external IDs per login (mirrors the reference page).
function aggregateUnmatchedMt5(unmatchedDeals: Row[]): UnmatchedAggregateRow[] {
  const rows = new Map<
    string,
    Omit<UnmatchedAggregateRow, "symbols" | "sampleExternalIds"> & { symbols: Set<string>; externalIds: string[] }
  >();
  for (const u of unmatchedDeals) {
    const key = String(u.login || "");
    if (!rows.has(key)) {
      rows.set(key, {
        login: u.login || "",
        clientName: u.clientName || "",
        group: u.group || "",
        system: u.isBonus ? "Bonus" : "Client",
        dealCount: 0,
        lots: 0,
        buyLots: 0,
        sellLots: 0,
        symbols: new Set<string>(),
        latestTime: "",
        externalIds: [],
      });
    }

    const row = rows.get(key)!;
    const lots = num(u.volume);
    row.dealCount += 1;
    row.lots += lots;
    if (String(u.side || "").toLowerCase() === "buy") row.buyLots += lots;
    if (String(u.side || "").toLowerCase() === "sell") row.sellLots += lots;
    if (u.symbol) row.symbols.add(String(u.symbol));
    if (u.time && (!row.latestTime || String(u.time) > row.latestTime)) row.latestTime = String(u.time);
    const extId = u.externalId != null && u.externalId !== "" ? String(u.externalId) : "";
    if (extId && row.externalIds.length < 3 && !row.externalIds.includes(extId)) row.externalIds.push(extId);
  }

  return Array.from(rows.values())
    .map((r) => ({ ...r, symbols: Array.from(r.symbols).sort().join(", "), sampleExternalIds: r.externalIds.join(", ") }))
    .sort((a, b) => num(b.lots) - num(a.lots));
}

// ── totals footer (pinned-TOTAL substitute; SortableTable has no native pinned-row support) ──

function TotalsBar({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-b-md border border-t-0 border-slate-300 bg-slate-100 px-3 py-1.5 text-[11px] dark:border-slate-700 dark:bg-slate-900/70">
      <span className="rounded bg-cyan-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Total</span>
      {items.map((it, idx) => (
        <span key={idx} className="whitespace-nowrap text-slate-700 dark:text-slate-200">
          <span className="mr-1 font-normal text-slate-500 dark:text-slate-400">{it.label}:</span>
          <span className="font-semibold">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

// ── column definitions (module scope — static, do not depend on component state) ──

const summaryColumns: SortableTableColumn<Row>[] = [
  { key: "source", label: "Source", sortValue: (r) => String(r.source || ""), render: (r) => <span className="font-semibold">{safe(r.source)}</span> },
  { key: "deals", label: "Deals", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.deals), render: (r) => fmtInt(r.deals) },
  { key: "lots", label: "Lots", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.lots), render: (r) => fmtNum(r.lots) },
  {
    key: "unmatchedDeals",
    label: "Unmatched",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.unmatchedDeals),
    render: (r) => <span className={num(r.unmatchedDeals) > 0 ? "text-rose-700 dark:text-rose-300" : ""}>{fmtInt(r.unmatchedDeals)}</span>,
  },
  { key: "matchPct", label: "Match %", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.matchPct), render: (r) => fmtPct(r.matchPct) },
];

const systemColumns: SortableTableColumn<SystemRow>[] = [
  { key: "system", label: "System", sortValue: (r) => String(r.system || ""), render: (r) => <span className={systemClass(r.system)}>{safe(r.system)}</span> },
  {
    key: "lots",
    label: "Lots",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => (r.lots == null ? -1 : num(r.lots)),
    render: (r) => (r.lots == null ? "-" : fmtNum(r.lots)),
  },
  {
    key: "markupRevenueUsd",
    label: "Markup Revenue",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => (r.markupRevenueUsd == null ? 0 : num(r.markupRevenueUsd)),
    render: (r) => (r.markupRevenueUsd == null ? "-" : <span className={`font-semibold ${signedClass(r.markupRevenueUsd)}`}>{money(r.markupRevenueUsd)}</span>),
  },
  {
    key: "mt5MarkupUsd",
    label: "MT5 Markup",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => (r.mt5MarkupUsd == null ? 0 : num(r.mt5MarkupUsd)),
    render: (r) => (r.mt5MarkupUsd == null ? "-" : <span className={signedClass(r.mt5MarkupUsd)}>{money(r.mt5MarkupUsd)}</span>),
  },
  {
    key: "grossRevenueUsd",
    label: "Gross Revenue",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => (r.grossRevenueUsd == null ? 0 : num(r.grossRevenueUsd)),
    render: (r) => (r.grossRevenueUsd == null ? "-" : <span className={`font-semibold ${signedClass(r.grossRevenueUsd)}`}>{money(r.grossRevenueUsd)}</span>),
  },
  {
    key: "commission",
    label: "Commission Charged",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.commission),
    render: (r) => <span className={systemCommissionClass(r.system, r.commission)}>{money(r.commission)}</span>,
  },
];

const clientRevenueColumns: SortableTableColumn<RevenueRow>[] = [
  { key: "login", label: "Login", sortValue: (r) => String(r.login || ""), render: (r) => <span className="font-mono">{safe(r.login)}</span> },
  { key: "name", label: "Name", sortValue: (r) => String(r.name || ""), render: (r) => safe(r.name) },
  { key: "group", label: "Group", sortValue: (r) => String(r.group || ""), render: (r) => safe(r.group) },
  { key: "system", label: "System", sortValue: (r) => String(r.system || ""), render: (r) => <span className={systemClass(r.system)}>{safe(r.system)}</span> },
  { key: "lots", label: "Lots", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.lots), render: (r) => fmtNum(r.lots) },
  {
    key: "markupRevenueUsd",
    label: "Markup Rev",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.markupRevenueUsd),
    render: (r) => <span className={signedClass(r.markupRevenueUsd)}>{money(r.markupRevenueUsd)}</span>,
  },
  {
    key: "mt5MarkupUsd",
    label: "MT5 Markup",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.mt5MarkupUsd),
    render: (r) => <span className={signedClass(r.mt5MarkupUsd)}>{money(r.mt5MarkupUsd)}</span>,
  },
  {
    key: "centroidMarkupUsd",
    label: "Centroid Markup",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.centroidMarkupUsd),
    render: (r) => <span className={signedClass(r.centroidMarkupUsd)}>{money(r.centroidMarkupUsd)}</span>,
  },
  {
    key: "clientCommissionUsd",
    label: "MT5 Commission",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.clientCommissionUsd),
    render: (r) => <span className="text-amber-700 dark:text-amber-300">{money(r.clientCommissionUsd)}</span>,
  },
  {
    key: "grossRevenueUsd",
    label: "Gross Revenue",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.grossRevenueUsd),
    render: (r) => <span className={`font-semibold ${signedClass(r.grossRevenueUsd)}`}>{money(r.grossRevenueUsd)}</span>,
  },
  {
    key: "lpCommissionUsd",
    label: "LP Commission",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.lpCommissionUsd),
    render: (r) => <span className="text-rose-700 dark:text-rose-300">{money(r.lpCommissionUsd)}</span>,
  },
  {
    key: "totalRevenueUsd",
    label: "Net Revenue",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.totalRevenueUsd),
    render: (r) => <span className={`font-semibold ${signedClass(r.totalRevenueUsd)}`}>{money(r.totalRevenueUsd)}</span>,
  },
];

const clientRevenueDetailColumns: SortableTableColumn<Row>[] = [
  { key: "lpsid", label: "LP", sortValue: (r) => String(r.lpsid || ""), render: (r) => safe(r.lpsid) },
  { key: "lpName", label: "TEM", sortValue: (r) => String(r.lpName || ""), render: (r) => safe(r.lpName) },
  { key: "tradeCount", label: "Trades", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.tradeCount), render: (r) => fmtInt(r.tradeCount) },
  { key: "symbols", label: "Symbols", sortValue: (r) => String(r.symbols || ""), render: (r) => safe(r.symbols) },
  {
    key: "clientLotsPlaced",
    label: "Client Lots",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.clientLotsPlaced),
    render: (r) => <span className="text-cyan-700 dark:text-cyan-300">{fmtNum(r.clientLotsPlaced)}</span>,
  },
  {
    key: "lpLotsSent",
    label: "LP Lots",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.lpLotsSent),
    render: (r) => <span className="text-purple-700 dark:text-purple-300">{fmtNum(r.lpLotsSent)}</span>,
  },
  { key: "allocationPct", label: "Alloc %", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.allocationPct), render: (r) => fmtPct(r.allocationPct) },
  {
    key: "markupRevenueUsd",
    label: "Markup Rev",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.markupRevenueUsd),
    render: (r) => <span className={signedClass(r.markupRevenueUsd)}>{money(r.markupRevenueUsd)}</span>,
  },
  {
    key: "mt5MarkupUsd",
    label: "MT5 Markup",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.mt5MarkupUsd),
    render: (r) => <span className={signedClass(r.mt5MarkupUsd)}>{money(r.mt5MarkupUsd)}</span>,
  },
  {
    key: "centroidMarkupUsd",
    label: "Centroid Markup",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.centroidMarkupUsd),
    render: (r) => <span className={signedClass(r.centroidMarkupUsd)}>{money(r.centroidMarkupUsd)}</span>,
  },
  {
    key: "clientCommissionUsd",
    label: "MT5 Commission",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.clientCommissionUsd),
    render: (r) => <span className="text-amber-700 dark:text-amber-300">{money(r.clientCommissionUsd)}</span>,
  },
  {
    key: "grossRevenueUsd",
    label: "Gross Revenue",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.grossRevenueUsd),
    render: (r) => <span className={`font-semibold ${signedClass(r.grossRevenueUsd)}`}>{money(r.grossRevenueUsd)}</span>,
  },
  {
    key: "lpCommissionUsd",
    label: "LP Commission",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.lpCommissionUsd),
    render: (r) => <span className="text-rose-700 dark:text-rose-300">{money(r.lpCommissionUsd)}</span>,
  },
  {
    // Net Revenue = Gross - LP Commission — always computed client-side (ignores any server field).
    key: "netRevenueUsd",
    label: "Net Revenue",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.grossRevenueUsd) - num(r.lpCommissionUsd),
    render: (r) => {
      const net = num(r.grossRevenueUsd) - num(r.lpCommissionUsd);
      return <span className={`font-semibold ${signedClass(net)}`}>{money(net)}</span>;
    },
  },
];

const coverageLpColumns: SortableTableColumn<CoverageLpRow>[] = [
  { key: "lpName", label: "LP", sortValue: (r) => String(r.lpName || ""), render: (r) => <span className="font-semibold">{safe(r.lpName)}</span> },
  { key: "lpLogin", label: "Login", sortValue: (r) => String(r.lpLogin || ""), render: (r) => safe(r.lpLogin) },
  { key: "lots", label: "Lots", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.lots), render: (r) => fmtNum(r.lots) },
  {
    key: "millionsUsd",
    label: "$M",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.millionsUsd),
    render: (r) => <span className="text-emerald-700 dark:text-emerald-300">{fmtNum(r.millionsUsd)}</span>,
  },
  {
    key: "effectiveCommission",
    label: "LP Commission",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.effectiveCommission),
    render: (r) => <span className="font-semibold text-cyan-700 dark:text-cyan-300">{money(r.effectiveCommission)}</span>,
  },
];

const matchedColumns: SortableTableColumn<Row>[] = [
  { key: "clientLogin", label: "Login", sortValue: (r) => String(r.clientLogin || ""), render: (r) => <span className="font-mono">{safe(r.clientLogin)}</span> },
  { key: "clientName", label: "Name", sortValue: (r) => String(r.clientName || ""), render: (r) => safe(r.clientName) },
  { key: "symbol", label: "Symbol", hideable: false, sortValue: (r) => String(r.symbol || ""), render: (r) => <span className="font-semibold">{safe(r.symbol)}</span> },
  { key: "side", label: "Side", sortValue: (r) => String(r.side || ""), render: (r) => <span className={sideClass(r.side)}>{safe(r.side)}</span> },
  { key: "entry", label: "Entry", sortValue: (r) => String(r.entry || ""), render: (r) => safe(r.entry) },
  { key: "clientVolume", label: "Client Lots", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.clientVolume), render: (r) => fmtNum(r.clientVolume, 4) },
  { key: "clientPrice", label: "Client Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.clientPrice), render: (r) => fmtNum5(r.clientPrice) },
  { key: "lpVolume", label: "LP Lots", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.lpVolume), render: (r) => fmtNum(r.lpVolume, 4) },
  { key: "lpPrice", label: "LP Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.lpPrice), render: (r) => fmtNum5(r.lpPrice) },
  {
    key: "spreadRevenueUsd",
    label: "Markup Rev",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.spreadRevenueUsd),
    render: (r) => <span className={signedClass(r.spreadRevenueUsd)}>{money(r.spreadRevenueUsd)}</span>,
  },
  {
    key: "clientCommission",
    label: "Client Comm",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.clientCommission),
    render: (r) => money(r.clientCommission),
  },
  {
    key: "lpCommission",
    label: "LP Comm",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.lpCommission),
    render: (r) => <span className="text-rose-700 dark:text-rose-300">{money(r.lpCommission)}</span>,
  },
  {
    // Total Rev = Markup Rev + Client Comm - |LP Comm| — always computed client-side.
    key: "_totalRevenue",
    label: "Total Rev",
    hideable: false,
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.spreadRevenueUsd) + num(r.clientCommission) - Math.abs(num(r.lpCommission)),
    render: (r) => {
      const total = num(r.spreadRevenueUsd) + num(r.clientCommission) - Math.abs(num(r.lpCommission));
      return <span className={`font-semibold ${signedClass(total)}`}>{money(total)}</span>;
    },
  },
  { key: "dealTime", label: "Time", sortValue: (r) => String(r.dealTime || ""), render: (r) => safe(r.dealTime) },
  {
    key: "rawLpPrice",
    label: "Raw LP Price",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.rawLpPrice),
    render: (r) => <span className="text-slate-500 dark:text-slate-400">{fmtNum5(r.rawLpPrice)}</span>,
  },
  {
    key: "rawFillVolume",
    label: "Raw Fill Vol",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.rawFillVolume),
    render: (r) => <span className="text-slate-500 dark:text-slate-400">{fmtNum(r.rawFillVolume)}</span>,
  },
  {
    key: "spread",
    label: "Markup (pts)",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.spread),
    render: (r) => <span className={signedClass(r.spread)}>{fmtNum5(r.spread)}</span>,
  },
  { key: "lpsid", label: "LP SID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.lpsid || ""), render: (r) => safe(r.lpsid) },
  { key: "lpName", label: "LP", hideable: true, defaultVisible: false, sortValue: (r) => String(r.lpName || ""), render: (r) => safe(r.lpName) },
  { key: "dealCategory", label: "Category", hideable: true, defaultVisible: false, sortValue: (r) => String(r.dealCategory || ""), render: (r) => safe(r.dealCategory) },
  {
    key: "aggregatedDealCount",
    label: "Agg",
    hideable: true,
    defaultVisible: false,
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.aggregatedDealCount),
    render: (r) => (num(r.aggregatedDealCount) > 1 ? <span className="font-semibold text-amber-600 dark:text-amber-300">{fmtInt(r.aggregatedDealCount)}</span> : "-"),
  },
  { key: "matchMethod", label: "Method", hideable: true, defaultVisible: false, sortValue: (r) => String(r.matchMethod || ""), render: (r) => safe(r.matchMethod) },
  { key: "matchStatus", label: "Status", hideable: true, defaultVisible: false, sortValue: (r) => String(r.matchStatus || ""), render: (r) => safe(r.matchStatus) },
  { key: "dealTicket", label: "Deal", hideable: true, defaultVisible: false, sortValue: (r) => String(r.dealTicket || ""), render: (r) => safe(r.dealTicket) },
  { key: "orderTicket", label: "Order", hideable: true, defaultVisible: false, sortValue: (r) => String(r.orderTicket || ""), render: (r) => safe(r.orderTicket) },
  { key: "centroidOrderId", label: "Cen Ord ID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.centroidOrderId || ""), render: (r) => safe(r.centroidOrderId) },
  { key: "centroidExtOrder", label: "Cen Ext Order", hideable: true, defaultVisible: false, sortValue: (r) => String(r.centroidExtOrder || ""), render: (r) => safe(r.centroidExtOrder) },
  { key: "externalDealId", label: "Ext Deal ID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.externalDealId || ""), render: (r) => safe(r.externalDealId) },
  { key: "centroidTime", label: "LP Time", hideable: true, defaultVisible: false, sortValue: (r) => String(r.centroidTime || ""), render: (r) => safe(r.centroidTime) },
];

const unmatchedMt5Columns: SortableTableColumn<UnmatchedAggregateRow>[] = [
  { key: "login", label: "Login", sortValue: (r) => String(r.login || ""), render: (r) => <span className="font-mono">{safe(r.login)}</span> },
  { key: "clientName", label: "Name", sortValue: (r) => String(r.clientName || ""), render: (r) => safe(r.clientName) },
  { key: "group", label: "Group", sortValue: (r) => String(r.group || ""), render: (r) => safe(r.group) },
  { key: "system", label: "System", sortValue: (r) => String(r.system || ""), render: (r) => <span className={systemClass(r.system)}>{safe(r.system)}</span> },
  { key: "dealCount", label: "Deals", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.dealCount), render: (r) => fmtInt(r.dealCount) },
  { key: "lots", label: "Lots", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.lots), render: (r) => fmtNum(r.lots) },
  {
    key: "buyLots",
    label: "Buy Lots",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.buyLots),
    render: (r) => <span className="text-emerald-700 dark:text-emerald-300">{fmtNum(r.buyLots)}</span>,
  },
  {
    key: "sellLots",
    label: "Sell Lots",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.sellLots),
    render: (r) => <span className="text-rose-700 dark:text-rose-300">{fmtNum(r.sellLots)}</span>,
  },
  { key: "symbols", label: "Symbols", sortValue: (r) => String(r.symbols || ""), render: (r) => safe(r.symbols) },
  { key: "latestTime", label: "Latest Time", sortValue: (r) => String(r.latestTime || ""), render: (r) => safe(r.latestTime) },
  { key: "sampleExternalIds", label: "Sample Ext IDs", sortValue: (r) => String(r.sampleExternalIds || ""), render: (r) => safe(r.sampleExternalIds) },
];

const unmatchedCenColumns: SortableTableColumn<Row>[] = [
  { key: "ext_login", label: "Ext Login", sortValue: (r) => String(r.ext_login || ""), render: (r) => safe(r.ext_login) },
  { key: "symbol", label: "Symbol", hideable: false, sortValue: (r) => String(r.symbol || ""), render: (r) => <span className="font-semibold">{safe(r.symbol)}</span> },
  { key: "side", label: "Side", sortValue: (r) => String(r.side || ""), render: (r) => <span className={sideClass(r.side)}>{safe(r.side)}</span> },
  { key: "volume", label: "Volume", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.volume), render: (r) => fmtNum(r.volume, 4) },
  { key: "fill_volume", label: "Fill Vol", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.fill_volume), render: (r) => fmtNum(r.fill_volume, 4) },
  { key: "avg_price", label: "Avg Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.avg_price), render: (r) => fmtNum5(r.avg_price) },
  { key: "raw_avg_price", label: "Raw Avg Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.raw_avg_price), render: (r) => fmtNum5(r.raw_avg_price) },
  { key: "total_markup", label: "Total Markup", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.total_markup), render: (r) => fmtNum5(r.total_markup) },
  { key: "lpsid", label: "LP SID", sortValue: (r) => String(r.lpsid || ""), render: (r) => safe(r.lpsid) },
  { key: "maker", label: "Maker", sortValue: (r) => String(r.maker || ""), render: (r) => safe(r.maker) },
  { key: "create_time", label: "Time", sortValue: (r) => String(r.create_time || ""), render: (r) => safe(r.create_time) },
  { key: "account_name", label: "Account Name", hideable: true, defaultVisible: false, sortValue: (r) => String(r.account_name || ""), render: (r) => safe(r.account_name) },
  { key: "manager_source", label: "Manager Source", hideable: true, defaultVisible: false, sortValue: (r) => String(r.manager_source || ""), render: (r) => safe(r.manager_source) },
  { key: "cen_ord_id", label: "Cen Ord ID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.cen_ord_id || ""), render: (r) => safe(r.cen_ord_id) },
  { key: "client_ord_id", label: "Client Ord ID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.client_ord_id || ""), render: (r) => safe(r.client_ord_id) },
  { key: "ext_order", label: "Ext Order", hideable: true, defaultVisible: false, sortValue: (r) => String(r.ext_order || ""), render: (r) => safe(r.ext_order) },
  { key: "ext_posid", label: "Ext Posid", hideable: true, defaultVisible: false, sortValue: (r) => String(r.ext_posid || ""), render: (r) => safe(r.ext_posid) },
  { key: "party_symbol", label: "Party Symbol", hideable: true, defaultVisible: false, sortValue: (r) => String(r.party_symbol || ""), render: (r) => safe(r.party_symbol) },
  { key: "node", label: "Node", hideable: true, defaultVisible: false, sortValue: (r) => String(r.node || ""), render: (r) => safe(r.node) },
  { key: "node_account", label: "Node Account", hideable: true, defaultVisible: false, sortValue: (r) => String(r.node_account || ""), render: (r) => safe(r.node_account) },
  { key: "state", label: "State", hideable: true, defaultVisible: false, sortValue: (r) => String(r.state || ""), render: (r) => safe(r.state) },
];

const partialColumns: SortableTableColumn<Row>[] = [
  { key: "clientLogin", label: "Login", sortValue: (r) => String(r.clientLogin || ""), render: (r) => <span className="font-mono">{safe(r.clientLogin)}</span> },
  { key: "clientName", label: "Name", sortValue: (r) => String(r.clientName || ""), render: (r) => safe(r.clientName) },
  { key: "symbol", label: "Symbol", hideable: false, sortValue: (r) => String(r.symbol || ""), render: (r) => <span className="font-semibold">{safe(r.symbol)}</span> },
  { key: "side", label: "Side", sortValue: (r) => String(r.side || ""), render: (r) => <span className={sideClass(r.side)}>{safe(r.side)}</span> },
  { key: "entry", label: "Entry", sortValue: (r) => String(r.entry || ""), render: (r) => safe(r.entry) },
  {
    key: "clientVolume",
    label: "MT5 Lots",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.clientVolume),
    render: (r) => <span className="text-cyan-700 dark:text-cyan-300">{fmtNum(r.clientVolume, 4)}</span>,
  },
  { key: "clientPrice", label: "MT5 Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.clientPrice), render: (r) => fmtNum5(r.clientPrice) },
  {
    key: "lpVolume",
    label: "Cen Lots",
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => num(r.lpVolume),
    render: (r) => <span className="text-purple-700 dark:text-purple-300">{fmtNum(r.lpVolume, 4)}</span>,
  },
  { key: "lpPrice", label: "Cen Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => num(r.lpPrice), render: (r) => fmtNum5(r.lpPrice) },
  {
    // Vol Diff = |clientVolume - lpVolume| — always computed client-side.
    key: "_volDiff",
    label: "Vol Diff",
    hideable: false,
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => Math.abs(num(r.clientVolume) - num(r.lpVolume)),
    render: (r) => <span className="font-semibold text-rose-700 dark:text-rose-300">{fmtNum(Math.abs(num(r.clientVolume) - num(r.lpVolume)), 4)}</span>,
  },
  {
    // Fill % = lpVolume / clientVolume * 100 — always computed client-side.
    key: "_volPct",
    label: "Fill %",
    hideable: false,
    headerClassName: "text-right",
    cellClassName: "text-right",
    sortValue: (r) => (num(r.clientVolume) > 0 ? (num(r.lpVolume) / num(r.clientVolume)) * 100 : 0),
    render: (r) => (num(r.clientVolume) > 0 ? fmtPct((num(r.lpVolume) / num(r.clientVolume)) * 100) : "-"),
  },
  { key: "matchStatus", label: "Status", sortValue: (r) => String(r.matchStatus || ""), render: (r) => <span className="text-amber-700 dark:text-amber-300">{safe(r.matchStatus)}</span> },
  { key: "lpsid", label: "LP SID", sortValue: (r) => String(r.lpsid || ""), render: (r) => safe(r.lpsid) },
  { key: "lpName", label: "LP", sortValue: (r) => String(r.lpName || ""), render: (r) => safe(r.lpName) },
  { key: "dealTime", label: "Time", sortValue: (r) => String(r.dealTime || ""), render: (r) => safe(r.dealTime) },
  {
    key: "rawLpPrice",
    label: "Raw LP Price",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.rawLpPrice),
    render: (r) => <span className="text-slate-500 dark:text-slate-400">{fmtNum5(r.rawLpPrice)}</span>,
  },
  {
    key: "rawFillVolume",
    label: "Raw Fill Vol",
    headerClassName: "text-right",
    cellClassName: "text-right",
    hideable: true,
    defaultVisible: false,
    sortValue: (r) => num(r.rawFillVolume),
    render: (r) => <span className="text-slate-500 dark:text-slate-400">{fmtNum(r.rawFillVolume)}</span>,
  },
  { key: "matchMethod", label: "Method", hideable: true, defaultVisible: false, sortValue: (r) => String(r.matchMethod || ""), render: (r) => safe(r.matchMethod) },
  { key: "contractSize", label: "CS", hideable: true, defaultVisible: false, sortValue: (r) => String(r.contractSize || ""), render: (r) => safe(r.contractSize) },
  { key: "centroidFillCount", label: "Legs", hideable: true, defaultVisible: false, sortValue: (r) => num(r.centroidFillCount), render: (r) => safe(r.centroidFillCount) },
  { key: "dealTicket", label: "MT5 Deal", hideable: true, defaultVisible: false, sortValue: (r) => String(r.dealTicket || ""), render: (r) => safe(r.dealTicket) },
  { key: "orderTicket", label: "MT5 Order", hideable: true, defaultVisible: false, sortValue: (r) => String(r.orderTicket || ""), render: (r) => safe(r.orderTicket) },
  { key: "externalDealId", label: "MT5 Ext ID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.externalDealId || ""), render: (r) => safe(r.externalDealId) },
  { key: "centroidOrderId", label: "Cen Ord ID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.centroidOrderId || ""), render: (r) => safe(r.centroidOrderId) },
  { key: "centroidExtOrder", label: "Cen Ext Order", hideable: true, defaultVisible: false, sortValue: (r) => String(r.centroidExtOrder || ""), render: (r) => safe(r.centroidExtOrder) },
];

const partialMt5DetailColumns: SortableTableColumn<Row>[] = [
  { key: "field", label: "Field", hideable: false, sortValue: (r) => String(r.field || ""), render: (r) => <span className="font-semibold text-cyan-700 dark:text-cyan-300">{safe(r.field)}</span> },
  { key: "value", label: "Value", sortValue: (r) => String(r.value ?? ""), render: (r) => (r.value != null && r.value !== "" ? String(r.value) : "-") },
];

const partialCenColumns: SortableTableColumn<Row>[] = [
  { key: "cenOrdId", label: "Cen Ord ID", sortValue: (r) => String(r.cenOrdId || ""), render: (r) => <span className="font-mono">{safe(r.cenOrdId)}</span> },
  { key: "extOrder", label: "Ext Order", sortValue: (r) => String(r.extOrder || ""), render: (r) => safe(r.extOrder) },
  { key: "symbol", label: "Symbol", sortValue: (r) => String(r.symbol || ""), render: (r) => <span className="font-semibold">{safe(r.symbol)}</span> },
  { key: "side", label: "Side", sortValue: (r) => String(r.side || ""), render: (r) => <span className={sideClass(r.side)}>{safe(r.side)}</span> },
  { key: "avgPrice", label: "Avg Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => String(r.avgPrice || ""), render: (r) => safe(r.avgPrice) },
  { key: "rawAvgPrice", label: "Raw Avg", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => String(r.rawAvgPrice || ""), render: (r) => safe(r.rawAvgPrice) },
  { key: "volume", label: "Volume", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => String(r.volume || ""), render: (r) => safe(r.volume) },
  { key: "fillVolume", label: "Fill Vol", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => String(r.fillVolume || ""), render: (r) => safe(r.fillVolume) },
  { key: "totalMarkup", label: "Markup", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => String(r.totalMarkup || ""), render: (r) => safe(r.totalMarkup) },
  { key: "state", label: "State", sortValue: (r) => String(r.state || ""), render: (r) => safe(r.state) },
  { key: "cenClientOrdId", label: "Cen Client Ord ID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.cenClientOrdId || ""), render: (r) => safe(r.cenClientOrdId) },
  { key: "clientOrdId", label: "Client Ord ID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.clientOrdId || ""), render: (r) => safe(r.clientOrdId) },
  { key: "extLogin", label: "Ext Login", hideable: true, defaultVisible: false, sortValue: (r) => String(r.extLogin || ""), render: (r) => safe(r.extLogin) },
  { key: "lpsid", label: "LP SID", hideable: true, defaultVisible: false, sortValue: (r) => String(r.lpsid || ""), render: (r) => safe(r.lpsid) },
  { key: "partySymbol", label: "Party Symbol", hideable: true, defaultVisible: false, sortValue: (r) => String(r.partySymbol || ""), render: (r) => safe(r.partySymbol) },
  { key: "volumeValue", label: "Vol Value", hideable: true, defaultVisible: false, sortValue: (r) => String(r.volumeValue || ""), render: (r) => safe(r.volumeValue) },
  { key: "fillVolumeValue", label: "Fill Vol Value", hideable: true, defaultVisible: false, sortValue: (r) => String(r.fillVolumeValue || ""), render: (r) => safe(r.fillVolumeValue) },
  { key: "contractSize", label: "Contract Size", hideable: true, defaultVisible: false, sortValue: (r) => String(r.contractSize || ""), render: (r) => safe(r.contractSize) },
  { key: "createTime", label: "Time", hideable: true, defaultVisible: false, sortValue: (r) => String(r.createTime || ""), render: (r) => safe(r.createTime) },
  { key: "node", label: "Node", hideable: true, defaultVisible: false, sortValue: (r) => String(r.node || ""), render: (r) => safe(r.node) },
  { key: "nodeAccount", label: "Node Account", hideable: true, defaultVisible: false, sortValue: (r) => String(r.nodeAccount || ""), render: (r) => safe(r.nodeAccount) },
];

// ── component ─────────────────────────────────────────────────────────────

export function DealMatchingTab({ baseUrl }: { baseUrl: string }) {
  const today = useMemo(() => toYmd(new Date()), []);

  const [group, setGroup] = useState("*");
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [symbol, setSymbol] = useState("");
  const [login, setLogin] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadDetailsLoading, setLoadDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("");
  const [report, setReport] = useState<DealMatchResponse | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const [lastRunParams, setLastRunParams] = useState<RunParams | null>(null);

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [systemsOpen, setSystemsOpen] = useState(false);
  const [clientRevenueOpen, setClientRevenueOpen] = useState(true);
  const [coverageLpOpen, setCoverageLpOpen] = useState(true);
  const [matchedOpen, setMatchedOpen] = useState(false);
  const [unmatchedMt5Open, setUnmatchedMt5Open] = useState(false);
  const [unmatchedCenOpen, setUnmatchedCenOpen] = useState(false);
  const [partialOpen, setPartialOpen] = useState(false);

  const [clientRevenueDetailRows, setClientRevenueDetailRows] = useState<Row[]>([]);
  const [clientRevenueDetailLabel, setClientRevenueDetailLabel] = useState("");
  const [clientRevenueDetailLoading, setClientRevenueDetailLoading] = useState(false);

  const [selectedLpDetail, setSelectedLpDetail] = useState<CoverageLpRow | null>(null);
  const [selectedPartial, setSelectedPartial] = useState<Row | null>(null);

  const matches = report?.matches || [];
  const unmatchedClientDeals = report?.unmatchedClientDeals || [];
  const unmatchedCentroidOrders = (report?.unmatchedCentroidOrders || []).concat(report?.fixApiOrders || []);

  const clientRevenueRows = (report?.clientRevenueSummaries || []) as RevenueRow[];
  const coverageLps = (report?.coverageLps || []) as CoverageLpRow[];

  const derivedSystems = useMemo<SystemRow[]>(() => {
    if (!report) return [];
    const systems = [...((report.clientSystems || []) as SystemRow[])];
    const lpLotsTotal = coverageLps.reduce((s, x) => s + num(x.lots), 0);
    const totalLpComm = Math.abs(num(report.totalLpCommissionAllocated));
    const clientMarkupTotal = systems.reduce((s, x) => s + num(x.markupRevenueUsd), 0);
    const clientMt5MarkupTotal = systems.reduce((s, x) => s + num(x.mt5MarkupUsd), 0);
    const clientGrossTotal = systems.reduce((s, x) => s + num(x.grossRevenueUsd), 0);
    systems.push({ system: "LP Charged", lots: lpLotsTotal, markupRevenueUsd: null, mt5MarkupUsd: null, grossRevenueUsd: null, commission: totalLpComm });
    systems.push({
      system: "Net (Client - LP)",
      lots: null,
      markupRevenueUsd: clientMarkupTotal,
      mt5MarkupUsd: clientMt5MarkupTotal,
      grossRevenueUsd: clientGrossTotal,
      commission: clientGrossTotal - totalLpComm,
    });
    return systems;
  }, [report, coverageLps]);

  const unmatchedByClientRows = useMemo(() => aggregateUnmatchedMt5(unmatchedClientDeals), [unmatchedClientDeals]);

  // Partial fills are always derived client-side from the matches array (never from a server field).
  const partialRows = useMemo(
    () => matches.filter((m) => String(m.matchStatus) === "Partial" || (num(m.lpVolume) > 0 && Math.abs(num(m.clientVolume) - num(m.lpVolume)) > 0.005)),
    [matches],
  );

  const partialCentroidLegs = useMemo(() => {
    const legs = Array.isArray(selectedPartial?.centroidLegs) ? selectedPartial!.centroidLegs : [];
    return legs.map((leg: Row) => ({
      cenOrdId: safe(leg.cenOrdId || leg.cen_ord_id),
      cenClientOrdId: safe(leg.cenClientOrdId || leg.cen_client_ord_id),
      clientOrdId: safe(leg.clientOrdId || leg.client_ord_id),
      extOrder: safe(leg.extOrder || leg.ext_order),
      extLogin: safe(leg.extLogin || leg.ext_login),
      lpsid: safe(leg.lpsid),
      symbol: safe(leg.symbol),
      partySymbol: safe(leg.partySymbol || leg.party_symbol),
      side: safe(leg.side),
      state: safe(leg.state),
      avgPrice: fmtNum5(leg.avgPrice ?? leg.avg_price),
      rawAvgPrice: fmtNum5(leg.rawAvgPrice ?? leg.raw_avg_price),
      volume: fmtNum(leg.volume, 4),
      fillVolume: fmtNum(leg.fillVolume ?? leg.fill_volume, 4),
      volumeValue: safe(leg.volumeValue ?? leg.volume_value),
      fillVolumeValue: safe(leg.fillVolumeValue ?? leg.fill_volume_value),
      contractSize: safe(leg.contractSize ?? leg.contract_size),
      totalMarkup: fmtNum5(leg.totalMarkup ?? leg.total_markup),
      createTime: safe(leg.createTime || leg.create_time),
      node: safe(leg.node),
      nodeAccount: safe(leg.nodeAccount || leg.node_account),
    }));
  }, [selectedPartial]);

  const partialMt5Rows = useMemo(() => {
    const m = selectedPartial;
    if (!m) return [];
    const f = (v: any, d: number) => (v != null && v !== "" ? fmtNum(v, d) : "");
    const rows: Array<{ field: string; value: string }> = [
      { field: "Deal Ticket", value: safe(m.dealTicket) },
      { field: "Order Ticket", value: safe(m.orderTicket) },
      { field: "Position ID", value: safe(m.positionId) },
      { field: "External ID", value: safe(m.externalDealId) },
      { field: "Login", value: safe(m.clientLogin) },
      { field: "Name", value: safe(m.clientName) },
      { field: "Group", value: safe(m.clientGroup) },
      { field: "Symbol", value: safe(m.symbol) },
      { field: "Side", value: safe(m.side) },
      { field: "Entry", value: safe(m.entry) },
      { field: "Category", value: safe(m.dealCategory) },
      { field: "Price", value: f(m.clientPrice, 5) },
      { field: "Volume (lots)", value: f(m.clientVolume, 4) },
      { field: "Contract Size", value: safe(m.contractSize) },
      { field: "Client Units", value: f(m.clientUnits, 4) },
      { field: "Commission", value: money(m.clientCommission) },
      { field: "Time", value: safe(m.dealTime) },
      { field: "Market Bid", value: f(m.marketBid, 5) },
      { field: "Market Ask", value: f(m.marketAsk, 5) },
      { field: "Match Method", value: safe(m.matchMethod) },
      { field: "Match Status", value: safe(m.matchStatus) },
      { field: "LP Price (agg)", value: f(m.lpPrice, 5) },
      { field: "LP Volume (agg)", value: f(m.lpVolume, 4) },
      { field: "LP SID", value: safe(m.lpsid) },
      { field: "LP Name", value: safe(m.lpName) },
      { field: "Cen Ord ID", value: safe(m.centroidOrderId) },
      { field: "Cen Ext Order", value: safe(m.centroidExtOrder) },
      { field: "Cen Ext Login", value: safe(m.centroidExtLogin) },
      { field: "Cen Fill Count", value: safe(m.centroidFillCount) },
      { field: "Spread", value: f(m.spread, 5) },
      { field: "Spread Revenue", value: money(m.spreadRevenueUsd) },
      { field: "LP Commission", value: money(m.lpCommission) },
    ];
    const subDeals: Row[] = Array.isArray(m.subDeals) ? m.subDeals : [];
    if (subDeals.length > 1) {
      rows.push({ field: "", value: "" });
      rows.push({ field: "-- Sub-Deals --", value: `${subDeals.length} deals aggregated` });
      subDeals.forEach((sd, i) => {
        rows.push({ field: `  Deal #${i + 1} Ticket`, value: safe(sd.deal) });
        rows.push({ field: `  Deal #${i + 1} Price`, value: f(sd.price, 5) });
        rows.push({ field: `  Deal #${i + 1} Volume`, value: f(sd.volume, 4) });
        rows.push({ field: `  Deal #${i + 1} Commission`, value: money(sd.commission) });
        rows.push({ field: `  Deal #${i + 1} Time`, value: safe(sd.time) });
        rows.push({ field: `  Deal #${i + 1} Entry`, value: safe(sd.entry) });
      });
    }
    return rows;
  }, [selectedPartial]);

  const summaryRows = useMemo(() => {
    if (!detailsLoaded || !report) return [];

    const bonusTotalDeals = num(report.totalBonusClientDeals);
    const liveTotalDeals = Math.max(num(report.totalClientDeals) - bonusTotalDeals, 0);

    const bonusMatches = matches.filter((m) => !!m.isBonus);
    const liveMatches = matches.filter((m) => !m.isBonus);
    const bonusUnmatched = unmatchedClientDeals.filter((u) => !!u.isBonus);
    const liveUnmatched = unmatchedClientDeals.filter((u) => !u.isBonus);

    const matchedLpLots = matches.reduce((s, m) => s + num(m.lpVolume), 0);
    const unmatchedCenLots = unmatchedCentroidOrders.reduce((s, o) => s + num(o.fill_volume ?? o.volume), 0);
    const unmatchedMt5Lots = unmatchedClientDeals.reduce((s, d) => s + num(d.volume), 0);

    const mt5Lots = unmatchedMt5Lots + matches.reduce((s, m) => s + num(m.clientVolume), 0);
    const liveLots = liveMatches.reduce((s, m) => s + num(m.clientVolume), 0) + liveUnmatched.reduce((s, u) => s + num(u.volume), 0);
    const bonusLots = bonusMatches.reduce((s, m) => s + num(m.clientVolume), 0) + bonusUnmatched.reduce((s, u) => s + num(u.volume), 0);

    const rows = [
      {
        source: "MT5 Deals",
        deals: num(report.totalClientDeals),
        lots: mt5Lots,
        unmatchedDeals: unmatchedClientDeals.length,
        matchPct: num(report.totalClientDeals) > 0 ? (matches.length / num(report.totalClientDeals)) * 100 : 0,
      },
      {
        source: "Client",
        deals: liveTotalDeals,
        lots: liveLots,
        unmatchedDeals: liveUnmatched.length,
        matchPct: liveTotalDeals > 0 ? (liveMatches.length / liveTotalDeals) * 100 : 0,
      },
      {
        source: "Bonus",
        deals: bonusTotalDeals,
        lots: bonusLots,
        unmatchedDeals: bonusUnmatched.length,
        matchPct: bonusTotalDeals > 0 ? (bonusMatches.length / bonusTotalDeals) * 100 : 0,
      },
      {
        source: "Centroid Orders",
        deals: num(report.totalCentroidOrders),
        lots: matchedLpLots + unmatchedCenLots,
        unmatchedDeals: unmatchedCentroidOrders.length,
        matchPct: num(report.totalCentroidOrders) > 0 ? (matches.length / num(report.totalCentroidOrders)) * 100 : 0,
      },
    ];

    return rows.filter((r) => r.deals || r.unmatchedDeals || r.source === "MT5 Deals" || r.source === "Centroid Orders");
  }, [detailsLoaded, matches, report, unmatchedCentroidOrders, unmatchedClientDeals]);

  const runMatch = async () => {
    if (!fromDate || !toDate) {
      setError("Please select From and To dates.");
      return;
    }

    const loginTrimmed = login.trim();
    if (loginTrimmed && !/^\d+$/.test(loginTrimmed)) {
      setError("Login must be a positive integer.");
      return;
    }

    setLoading(true);
    setError(null);
    setReport(null);
    setDetailsLoaded(false);
    setStatusLine("Loading...");
    setClientRevenueDetailRows([]);
    setClientRevenueDetailLabel("");
    setSelectedLpDetail(null);
    setSelectedPartial(null);

    const range = ymdToUnixRange(fromDate, toDate);
    const runParams: RunParams = { group: group || "*", from: range.from, to: range.to, symbol: symbol.trim(), login: loginTrimmed };
    setLastRunParams(runParams);

    const params = new URLSearchParams({
      group: runParams.group,
      from: String(runParams.from),
      to: String(runParams.to),
      symbol: runParams.symbol,
      lite: "true",
    });
    if (runParams.login) params.set("login", runParams.login);

    try {
      const resp = await fetch(`${baseUrl}/DealMatch/Run?${params.toString()}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `DealMatch API ${resp.status}`);
      }
      const data = (await resp.json()) as DealMatchResponse;
      setReport(data || {});
      setStatusLine(`${data.fromDate || fromDate} to ${data.toDate || toDate} | ${fmtInt(data.totalClientDeals)} MT5 deals, ${fmtInt(data.totalCentroidOrders)} Centroid orders, ${fmtInt(data.matchedCount)} matched`);
    } catch (e: any) {
      setError(e?.message || "Failed to run deal matching.");
      setStatusLine("");
    } finally {
      setLoading(false);
    }
  };

  const loadMatchDetails = async () => {
    if (!lastRunParams || detailsLoaded || loadDetailsLoading) return;

    setLoadDetailsLoading(true);
    setError(null);

    const params = new URLSearchParams({
      group: lastRunParams.group,
      from: String(lastRunParams.from),
      to: String(lastRunParams.to),
      symbol: lastRunParams.symbol,
      lite: "false",
    });
    if (lastRunParams.login) params.set("login", lastRunParams.login);

    try {
      const resp = await fetch(`${baseUrl}/DealMatch/Run?${params.toString()}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `DealMatch details API ${resp.status}`);
      }
      const data = (await resp.json()) as DealMatchResponse;
      setReport(data || {});
      setDetailsLoaded(true);
      setSummaryOpen(true);
      setMatchedOpen(true);
      setUnmatchedMt5Open(true);
      setUnmatchedCenOpen(true);
      setPartialOpen(true);
    } catch (e: any) {
      setError(e?.message || "Failed to load match details.");
    } finally {
      setLoadDetailsLoading(false);
    }
  };

  const onClientRevenueRowClick = async (row: RevenueRow) => {
    const selectedLogin = String(row.login || "").trim();
    if (!selectedLogin || selectedLogin === "-") return;

    setClientRevenueDetailLoading(true);
    setClientRevenueDetailRows([]);
    setClientRevenueDetailLabel(`${selectedLogin} | ${safe(row.name)} | loading...`);

    try {
      const resp = await fetch(`${baseUrl}/DealMatch/ClientRevenueDetail?login=${encodeURIComponent(selectedLogin)}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `ClientRevenueDetail API ${resp.status}`);
      }
      const rows = (await resp.json()) as Row[];
      const totalClientLots = (rows || []).reduce((s, r) => s + num(r.clientLotsPlaced), 0);
      const totalLpComm = (rows || []).reduce((s, r) => s + num(r.lpCommissionUsd), 0);
      setClientRevenueDetailRows(Array.isArray(rows) ? rows : []);
      setClientRevenueDetailLabel(`${selectedLogin} | ${safe(row.name)} | ${fmtNum(totalClientLots)} lots | LP comm ${money(totalLpComm)}`);
    } catch (e: any) {
      setClientRevenueDetailRows([]);
      setClientRevenueDetailLabel(`${selectedLogin} | ${safe(row.name)} | Error: ${e?.message || "failed"}`);
    } finally {
      setClientRevenueDetailLoading(false);
    }
  };

  // ── KPIs (exactly as reference: gross/lpComm/net come straight from the server) ──
  const totalMarkup = num(report?.totalSpreadRevenueUsd);
  const totalClientCommission = num(report?.totalClientCommission);
  const totalGross = num(report?.totalGrossRevenueUsd);
  const totalLpComm = Math.abs(num(report?.totalLpCommissionAllocated));
  const totalNet = totalGross - totalLpComm;

  // ── totals for pinned-TOTAL footers ──
  const clientRevenueTotals = useMemo(
    () => ({
      lots: clientRevenueRows.reduce((s, r) => s + num(r.lots), 0),
      markupRevenueUsd: clientRevenueRows.reduce((s, r) => s + num(r.markupRevenueUsd), 0),
      clientCommissionUsd: clientRevenueRows.reduce((s, r) => s + num(r.clientCommissionUsd), 0),
      grossRevenueUsd: clientRevenueRows.reduce((s, r) => s + num(r.grossRevenueUsd), 0),
      lpCommissionUsd: clientRevenueRows.reduce((s, r) => s + num(r.lpCommissionUsd), 0),
      totalRevenueUsd: clientRevenueRows.reduce((s, r) => s + num(r.totalRevenueUsd), 0),
    }),
    [clientRevenueRows],
  );

  const clientRevenueDetailTotals = useMemo(() => {
    const gross = clientRevenueDetailRows.reduce((s, r) => s + num(r.grossRevenueUsd), 0);
    const lpComm = clientRevenueDetailRows.reduce((s, r) => s + num(r.lpCommissionUsd), 0);
    return {
      tradeCount: clientRevenueDetailRows.reduce((s, r) => s + num(r.tradeCount), 0),
      clientLotsPlaced: clientRevenueDetailRows.reduce((s, r) => s + num(r.clientLotsPlaced), 0),
      lpLotsSent: clientRevenueDetailRows.reduce((s, r) => s + num(r.lpLotsSent), 0),
      markupRevenueUsd: clientRevenueDetailRows.reduce((s, r) => s + num(r.markupRevenueUsd), 0),
      clientCommissionUsd: clientRevenueDetailRows.reduce((s, r) => s + num(r.clientCommissionUsd), 0),
      grossRevenueUsd: gross,
      lpCommissionUsd: lpComm,
      netRevenueUsd: gross - lpComm,
    };
  }, [clientRevenueDetailRows]);

  const coverageLpTotals = useMemo(
    () => ({
      lots: coverageLps.reduce((s, r) => s + num(r.lots), 0),
      millionsUsd: coverageLps.reduce((s, r) => s + num(r.millionsUsd), 0),
      effectiveCommission: coverageLps.reduce((s, r) => s + num(r.effectiveCommission), 0),
    }),
    [coverageLps],
  );

  const matchedTotals = useMemo(
    () => ({
      clientVolume: matches.reduce((s, m) => s + num(m.clientVolume), 0),
      lpVolume: matches.reduce((s, m) => s + num(m.lpVolume), 0),
      clientCommission: matches.reduce((s, m) => s + num(m.clientCommission), 0),
      lpCommission: matches.reduce((s, m) => s + Math.abs(num(m.lpCommission)), 0),
    }),
    [matches],
  );

  return (
    <section className="space-y-3 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="rounded-xl border border-slate-200 bg-gradient-to-r from-cyan-50 via-white to-indigo-50 p-3 shadow-sm dark:border-slate-800 dark:from-cyan-500/10 dark:via-slate-900/50 dark:to-indigo-500/10">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-semibold text-cyan-700 dark:text-cyan-200">Deal Match Analysis</h2>
          <label className="text-xs text-slate-600 dark:text-slate-300">Group
            <input value={group} onChange={(e) => setGroup(e.target.value)} className="ml-1 w-16 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">From
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="ml-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">To
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="ml-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">Symbol
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="all" className="ml-1 w-20 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">Login
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="all" className="ml-1 w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <button
            type="button"
            onClick={runMatch}
            disabled={loading}
            className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-800 shadow-sm transition hover:bg-cyan-500/25 hover:shadow disabled:cursor-not-allowed disabled:opacity-60 dark:text-cyan-100"
          >
            {loading ? "Running..." : "Run Match"}
          </button>
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{statusLine}</span>
        </div>
      </div>

      {error && <div className="rounded border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{error}</div>}

      {report && (
        <>
          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <div className="rounded-lg border border-emerald-300/40 bg-emerald-50 p-2 dark:bg-emerald-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Markup Revenue</div>
              <div className={`mt-1 text-sm font-semibold ${signedClass(totalMarkup)}`}>{money(totalMarkup)}</div>
            </div>
            <div className="rounded-lg border border-amber-300/40 bg-amber-50 p-2 dark:bg-amber-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Commission Revenue</div>
              <div className={`mt-1 text-sm font-semibold ${signedClass(totalClientCommission)}`}>{money(totalClientCommission)}</div>
            </div>
            <div className="rounded-lg border border-cyan-300/40 bg-cyan-50 p-2 dark:bg-cyan-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Gross Revenue</div>
              <div className={`mt-1 text-sm font-semibold ${signedClass(totalGross)}`}>{money(totalGross)}</div>
            </div>
            <div className="rounded-lg border border-rose-300/40 bg-rose-50 p-2 dark:bg-rose-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">LP Commission</div>
              <div className="mt-1 text-sm font-semibold text-rose-700 dark:text-rose-300">-{money(totalLpComm).replace("-", "")}</div>
            </div>
            <div className="rounded-lg border border-cyan-300/50 bg-gradient-to-r from-cyan-50 to-emerald-50 p-2 dark:from-cyan-500/10 dark:to-emerald-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Total Net Revenue</div>
              <div className={`mt-1 text-sm font-semibold ${signedClass(totalNet)}`}>{money(totalNet)}</div>
            </div>
          </div>

          <div className="space-y-2">
            {/* Overall Summary — only rendered once match details are loaded */}
            {detailsLoaded && (
              <>
                <button type="button" onClick={() => setSummaryOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(summaryOpen)}`}>
                  {summaryOpen ? "-" : "+"} Overall Summary - MT5 / Client / Bonus / Centroid
                </button>
                {summaryOpen && (
                  <SortableTable
                    tableId="deal-matching-summary"
                    rows={summaryRows}
                    columns={summaryColumns}
                    tableClassName="min-w-full text-[11px]"
                    emptyText="No summary rows."
                  />
                )}
              </>
            )}

            {/* Client Systems */}
            <button type="button" onClick={() => setSystemsOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(systemsOpen)}`}>
              {systemsOpen ? "-" : "+"} Client Systems - Lots &amp; Commission Charged
            </button>
            {systemsOpen && (
              <SortableTable
                tableId="deal-matching-systems"
                rows={derivedSystems}
                columns={systemColumns}
                tableClassName="min-w-full text-[11px]"
                emptyText="No client system rows."
              />
            )}

            {/* Revenue by Client */}
            <button type="button" onClick={() => setClientRevenueOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(clientRevenueOpen)}`}>
              {clientRevenueOpen ? "-" : "+"} Revenue by Client
            </button>
            {clientRevenueOpen && (
              <div className="space-y-2">
                <div>
                  <SortableTable
                    tableId="deal-matching-client-revenue"
                    rows={clientRevenueRows}
                    columns={clientRevenueColumns}
                    tableClassName="min-w-full text-[11px]"
                    emptyText="No client revenue rows."
                    onRowClick={(row) => onClientRevenueRowClick(row)}
                  />
                  {clientRevenueRows.length > 0 && (
                    <TotalsBar
                      items={[
                        { label: "Lots", value: fmtNum(clientRevenueTotals.lots) },
                        { label: "Markup", value: money(clientRevenueTotals.markupRevenueUsd) },
                        { label: "Client Comm", value: money(clientRevenueTotals.clientCommissionUsd) },
                        { label: "Gross", value: money(clientRevenueTotals.grossRevenueUsd) },
                        { label: "LP Comm", value: money(clientRevenueTotals.lpCommissionUsd) },
                        { label: "Net Revenue", value: money(clientRevenueTotals.totalRevenueUsd) },
                      ]}
                    />
                  )}
                </div>

                {(clientRevenueDetailLoading || clientRevenueDetailRows.length > 0 || clientRevenueDetailLabel) && (
                  <div className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-cyan-700 dark:text-cyan-200">Client LP Allocation Detail</h3>
                      <span className="text-xs text-slate-500 dark:text-slate-400">{clientRevenueDetailLabel}</span>
                    </div>
                    {clientRevenueDetailLoading ? (
                      <div className="py-4 text-xs text-slate-500">Loading detail...</div>
                    ) : (
                      <div>
                        <SortableTable
                          tableId="deal-matching-client-revenue-detail"
                          rows={clientRevenueDetailRows}
                          columns={clientRevenueDetailColumns}
                          tableClassName="min-w-full text-[11px]"
                          emptyText="Select a client row to view LP allocation detail."
                        />
                        {clientRevenueDetailRows.length > 0 && (
                          <TotalsBar
                            items={[
                              { label: "Trades", value: fmtInt(clientRevenueDetailTotals.tradeCount) },
                              { label: "Client Lots", value: fmtNum(clientRevenueDetailTotals.clientLotsPlaced) },
                              { label: "LP Lots", value: fmtNum(clientRevenueDetailTotals.lpLotsSent) },
                              { label: "Markup", value: money(clientRevenueDetailTotals.markupRevenueUsd) },
                              { label: "Client Comm", value: money(clientRevenueDetailTotals.clientCommissionUsd) },
                              { label: "Gross", value: money(clientRevenueDetailTotals.grossRevenueUsd) },
                              { label: "LP Comm", value: money(clientRevenueDetailTotals.lpCommissionUsd) },
                              { label: "Net", value: money(clientRevenueDetailTotals.netRevenueUsd) },
                            ]}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Commission by LP */}
            <button type="button" onClick={() => setCoverageLpOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(coverageLpOpen)}`}>
              {coverageLpOpen ? "-" : "+"} Commission Charged by LP
            </button>
            {coverageLpOpen && (
              <div className="space-y-2">
                <div>
                  <SortableTable
                    tableId="deal-matching-coverage-lps"
                    rows={coverageLps}
                    columns={coverageLpColumns}
                    tableClassName="min-w-full text-[11px]"
                    emptyText="No LP coverage rows."
                    onRowClick={(row) => setSelectedLpDetail(row)}
                  />
                  {coverageLps.length > 0 && (
                    <TotalsBar
                      items={[
                        { label: "Lots", value: fmtNum(coverageLpTotals.lots) },
                        { label: "$M", value: fmtNum(coverageLpTotals.millionsUsd) },
                        { label: "LP Commission", value: money(coverageLpTotals.effectiveCommission) },
                      ]}
                    />
                  )}
                </div>

                {selectedLpDetail && (
                  <div className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-cyan-700 dark:text-cyan-200">LP Detail</h3>
                      <span className="text-xs text-slate-500 dark:text-slate-400">{safe(selectedLpDetail.lpName)} | {safe(selectedLpDetail.lpLogin)} | {safe(selectedLpDetail.source)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Source</div><div className="font-semibold">{safe(selectedLpDetail.source)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Deals</div><div className="font-semibold">{fmtInt(selectedLpDetail.dealCount)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Method</div><div className="font-semibold">{safe(selectedLpDetail.commissionSource)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Actual Commission</div><div className="font-semibold">{money(selectedLpDetail.actualCommission)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Calculated Commission</div><div className="font-semibold">{money(selectedLpDetail.calculatedCommission)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Configured $/M</div><div className="font-semibold">{fmtNum(selectedLpDetail.configuredRatePerMillion)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Live $/M</div><div className="font-semibold">{fmtNum(selectedLpDetail.effectiveRatePerMillion)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Lots</div><div className="font-semibold">{fmtNum(selectedLpDetail.lots)}</div></div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Load Match Details toolbar */}
            <div className="rounded-lg border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-amber-700 dark:text-amber-300">Match Details</h3>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Matched / Unmatched / Partial fills - on demand</div>
                </div>
                <button
                  type="button"
                  onClick={loadMatchDetails}
                  disabled={loadDetailsLoading || detailsLoaded}
                  className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-800 shadow-sm transition hover:bg-cyan-500/25 hover:shadow disabled:cursor-not-allowed disabled:opacity-60 dark:text-cyan-100"
                >
                  {detailsLoaded ? "Loaded" : loadDetailsLoading ? "Loading..." : "Load Match Details"}
                </button>
              </div>

              {detailsLoaded && (
                <div className="space-y-2">
                  {/* Matched Trades */}
                  <button type="button" onClick={() => setMatchedOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(matchedOpen)}`}>{matchedOpen ? "-" : "+"} Matched Trades</button>
                  {matchedOpen && (
                    <div>
                      <SortableTable
                        tableId="deal-matching-matched"
                        enableColumnVisibility
                        rows={matches}
                        columns={matchedColumns}
                        tableClassName="min-w-full text-[11px]"
                        emptyText="No matched trades."
                      />
                      {matches.length > 0 && (
                        <TotalsBar
                          items={[
                            { label: "Client Lots", value: fmtNum(matchedTotals.clientVolume, 4) },
                            { label: "LP Lots", value: fmtNum(matchedTotals.lpVolume, 4) },
                            { label: "Markup Rev", value: money(totalMarkup) },
                            { label: "Client Comm", value: money(matchedTotals.clientCommission) },
                            { label: "LP Comm", value: money(matchedTotals.lpCommission) },
                          ]}
                        />
                      )}
                    </div>
                  )}

                  {/* Unmatched MT5 Deals by Client */}
                  <button type="button" onClick={() => setUnmatchedMt5Open((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(unmatchedMt5Open)}`}>{unmatchedMt5Open ? "-" : "+"} Unmatched MT5 Deals by Client</button>
                  {unmatchedMt5Open && (
                    <SortableTable
                      tableId="deal-matching-unmatched-mt5"
                      rows={unmatchedByClientRows}
                      columns={unmatchedMt5Columns}
                      tableClassName="min-w-full text-[11px]"
                      emptyText="No unmatched MT5 deals."
                    />
                  )}

                  {/* Unmatched Centroid Orders */}
                  <button type="button" onClick={() => setUnmatchedCenOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(unmatchedCenOpen)}`}>{unmatchedCenOpen ? "-" : "+"} Unmatched Centroid Orders</button>
                  {unmatchedCenOpen && (
                    <SortableTable
                      tableId="deal-matching-unmatched-cen"
                      enableColumnVisibility
                      rows={unmatchedCentroidOrders}
                      columns={unmatchedCenColumns}
                      tableClassName="min-w-full text-[11px]"
                      emptyText="No unmatched centroid orders."
                    />
                  )}

                  {/* Partial Fills */}
                  <button type="button" onClick={() => setPartialOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(partialOpen)}`}>{partialOpen ? "-" : "+"} Partial Fills</button>
                  {partialOpen && (
                    <div className="space-y-2">
                      <SortableTable
                        tableId="deal-matching-partial"
                        enableColumnVisibility
                        rows={partialRows}
                        columns={partialColumns}
                        tableClassName="min-w-full text-[11px]"
                        emptyText="No partial fills."
                        onRowClick={(row) => setSelectedPartial(row)}
                      />

                      {selectedPartial && (
                        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                          <div className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                            <h4 className="mb-2 text-xs font-semibold text-cyan-700 dark:text-cyan-200">MT5 Deal Details</h4>
                            <SortableTable
                              tableId="deal-matching-partial-mt5"
                              rows={partialMt5Rows}
                              columns={partialMt5DetailColumns}
                              tableClassName="min-w-full text-[11px]"
                              emptyText="No deal details."
                            />
                          </div>
                          <div className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                            <div className="mb-2 flex items-center justify-between">
                              <h4 className="text-xs font-semibold text-cyan-700 dark:text-cyan-200">Centroid Legs</h4>
                              <span className="text-xs text-slate-500 dark:text-slate-400">{partialCentroidLegs.length} leg(s)</span>
                            </div>
                            <SortableTable
                              tableId="deal-matching-partial-cen"
                              enableColumnVisibility
                              rows={partialCentroidLegs}
                              columns={partialCenColumns}
                              tableClassName="min-w-full text-[11px]"
                              emptyText="No centroid legs on this match row."
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
