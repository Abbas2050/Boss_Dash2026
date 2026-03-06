import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bell, Camera, Info, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { getDealsByGroup, getPositionsByGroup, getSummaryByGroup } from "@/lib/dealingApi";
import { SignalRConnectionManager } from "@/lib/signalRConnectionManager";
import { fetchAccountsByUserId, fetchDealsByLogin, fetchIbTree } from "@/lib/rebateApi";
import { hasAccess } from "@/lib/auth";
import { DEALING_TABS } from "@/lib/permissions";
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
type ColumnFilterOperator = "contains" | "eq" | "neq";

const TABLE_ENHANCER_SELECTOR = "table.min-w-full";

const normalizeFilterValue = (value: unknown) => String(value ?? "").trim().toLowerCase();

const parseMaybeNumber = (raw: string) => {
  const cleaned = raw.replace(/[$,%\s,]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

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

const mountTableEnhancer = (table: HTMLTableElement) => {
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  if (!thead || !tbody) return () => undefined;

  const headerRows = Array.from(thead.querySelectorAll("tr"));
  const headerRow = headerRows[headerRows.length - 1] as HTMLTableRowElement | undefined;
  if (!headerRow) return () => undefined;

  const ths = Array.from(headerRow.querySelectorAll("th"));
  if (!ths.length) return () => undefined;

  const headers = ths.map((th, idx) => {
    const txt = (th.textContent || "").trim();
    return txt || `Column ${idx + 1}`;
  });
  const tableKind = String(table.dataset.tableKind || "").toLowerCase();

  const filterState = headers.map(() => ({ op: "contains" as ColumnFilterOperator, value: "" }));
  let globalQuery = "";
  let sortIndex = -1;
  let sortDir: "asc" | "desc" = "asc";

  const wrapper = table.parentElement;
  if (!wrapper) return () => undefined;

  const toolbar = document.createElement("div");
  toolbar.className = "mb-2 flex flex-wrap items-center gap-2";

  const globalInput = document.createElement("input");
  globalInput.type = "text";
  globalInput.placeholder = "Search all columns...";
  globalInput.className = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear Filters";
  clearBtn.className = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200";

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.textContent = "Export Excel";
  exportBtn.className = "rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300";
  const showHiddenBtn = document.createElement("button");
  showHiddenBtn.type = "button";
  showHiddenBtn.textContent = "Show hidden data";
  showHiddenBtn.className = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200";
  let showHiddenData = false;

  toolbar.appendChild(globalInput);
  toolbar.appendChild(clearBtn);
  toolbar.appendChild(exportBtn);
  toolbar.appendChild(showHiddenBtn);
  wrapper.parentElement?.insertBefore(toolbar, wrapper);

  const filterRow = document.createElement("tr");
  filterRow.className = "bg-slate-100/80 dark:bg-slate-900/70";

  headers.forEach((_, idx) => {
    const th = document.createElement("th");
    th.className = "px-2 py-1";

    const row = document.createElement("div");
    row.className = "flex items-center gap-1";

    const op = document.createElement("select");
    op.className = "rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] dark:border-slate-700 dark:bg-slate-900";
    [
      { v: "contains", t: "~" },
      { v: "eq", t: "=" },
      { v: "neq", t: "!=" },
    ].forEach((item) => {
      const option = document.createElement("option");
      option.value = item.v;
      option.textContent = item.t;
      op.appendChild(option);
    });

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "filter";
    input.className = "w-full min-w-[64px] rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px] dark:border-slate-700 dark:bg-slate-900";

    row.appendChild(op);
    row.appendChild(input);
    th.appendChild(row);
    filterRow.appendChild(th);

    op.addEventListener("change", () => {
      filterState[idx].op = op.value as ColumnFilterOperator;
      applyState();
    });
    input.addEventListener("input", () => {
      filterState[idx].value = input.value;
      applyState();
    });
  });

  thead.appendChild(filterRow);

  const indicators: HTMLSpanElement[] = [];
  ths.forEach((th, idx) => {
    th.style.cursor = "pointer";
    const indicator = document.createElement("span");
    indicator.className = "ml-1 text-[10px] text-slate-400";
    indicator.textContent = "-";
    th.appendChild(indicator);
    indicators.push(indicator);
    th.addEventListener("click", () => {
      if (sortIndex === idx) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortIndex = idx;
        sortDir = "asc";
      }
      applyState();
    });
  });

  const getRows = () =>
    Array.from(tbody.querySelectorAll("tr")).map((tr, index) => {
      const cells = Array.from(tr.querySelectorAll("td,th")).map((cell) => (cell.textContent || "").trim());
      return { tr: tr as HTMLTableRowElement, cells, index };
    });
  const isTotalLabel = (txt: string) => {
    const t = String(txt || "").toUpperCase();
    return t === "TOTAL" || t === "GOLD TOTAL";
  };
  const getNumberAt = (row: { cells: string[] }, colName: string) => {
    const idx = headers.findIndex((h) => h.toLowerCase() === colName.toLowerCase());
    if (idx < 0) return null;
    return parseMaybeNumber(row.cells[idx] || "");
  };

  const applyState = () => {
    const rows = getRows();
    const normalizedGlobal = normalizeFilterValue(globalQuery);
    const rowHiddenByDefault = new Set<HTMLTableRowElement>();
    const hiddenCols = new Set<number>();

    if (!showHiddenData) {
      if (tableKind === "coverage" || tableKind === "risk") {
        rows.forEach((row) => {
          const label = row.cells[0] || "";
          if (isTotalLabel(label)) return;
          const clientNet = getNumberAt(row, "Client Net");
          if (clientNet === 0) rowHiddenByDefault.add(row.tr);
        });
      }
      if (tableKind === "metrics") {
        rows.forEach((row) => {
          const label = row.cells[0] || "";
          if (isTotalLabel(label)) return;
          const equity = getNumberAt(row, "Equity");
          if (equity === 0) rowHiddenByDefault.add(row.tr);
        });
      }
      if (tableKind === "coverage") {
        for (let col = 4; col < headers.length; col += 1) {
          let nonZeroFound = false;
          for (const row of rows) {
            const label = row.cells[0] || "";
            if (isTotalLabel(label)) continue;
            const n = parseMaybeNumber(row.cells[col] || "");
            if (n !== null && n !== 0) {
              nonZeroFound = true;
              break;
            }
          }
          if (!nonZeroFound) hiddenCols.add(col);
        }
      }
    }

    let visible = rows.filter((row) => {
      if (rowHiddenByDefault.has(row.tr)) return false;
      const globalPass = !normalizedGlobal || row.cells.some((c) => normalizeFilterValue(c).includes(normalizedGlobal));
      if (!globalPass) return false;

      for (let i = 0; i < filterState.length; i += 1) {
        const value = normalizeFilterValue(filterState[i].value);
        if (!value) continue;
        const cellRaw = row.cells[i] || "";
        const cell = normalizeFilterValue(cellRaw);
        const op = filterState[i].op;

        if (op === "contains" && !cell.includes(value)) return false;
        if (op === "eq") {
          const nCell = parseMaybeNumber(cellRaw);
          const nValue = parseMaybeNumber(filterState[i].value);
          if (nCell !== null && nValue !== null) {
            if (nCell !== nValue) return false;
          } else if (cell !== value) return false;
        }
        if (op === "neq") {
          const nCell = parseMaybeNumber(cellRaw);
          const nValue = parseMaybeNumber(filterState[i].value);
          if (nCell !== null && nValue !== null) {
            if (nCell === nValue) return false;
          } else if (cell === value) return false;
        }
      }
      return true;
    });

    if (sortIndex >= 0) {
      visible = [...visible].sort((a, b) => {
        const aRaw = a.cells[sortIndex] || "";
        const bRaw = b.cells[sortIndex] || "";
        const aNum = parseMaybeNumber(aRaw);
        const bNum = parseMaybeNumber(bRaw);
        let cmp = 0;
        if (aNum !== null && bNum !== null) {
          cmp = aNum - bNum;
        } else {
          cmp = aRaw.localeCompare(bRaw, undefined, { numeric: true, sensitivity: "base" });
        }
        if (cmp === 0) cmp = a.index - b.index;
        return sortDir === "asc" ? cmp : -cmp;
      });
    }

    const visibleSet = new Set(visible.map((r) => r.tr));
    const hidden = rows.filter((r) => !visibleSet.has(r.tr));

    [...visible, ...hidden].forEach((row) => {
      row.tr.style.display = visibleSet.has(row.tr) ? "" : "none";
      tbody.appendChild(row.tr);
      Array.from(row.tr.querySelectorAll("td,th")).forEach((cell, idx) => {
        (cell as HTMLElement).style.display = hiddenCols.has(idx) ? "none" : "";
      });
    });
    ths.forEach((th, idx) => {
      (th as HTMLElement).style.display = hiddenCols.has(idx) ? "none" : "";
    });
    Array.from(filterRow.querySelectorAll("th")).forEach((th, idx) => {
      (th as HTMLElement).style.display = hiddenCols.has(idx) ? "none" : "";
    });

    indicators.forEach((indicator, idx) => {
      if (idx !== sortIndex) indicator.textContent = "-";
      else indicator.textContent = sortDir === "asc" ? "^" : "v";
    });
  };

  globalInput.addEventListener("input", () => {
    globalQuery = globalInput.value;
    applyState();
  });

  clearBtn.addEventListener("click", () => {
    globalQuery = "";
    globalInput.value = "";
    sortIndex = -1;
    sortDir = "asc";
    filterState.forEach((f) => {
      f.op = "contains";
      f.value = "";
    });
    Array.from(filterRow.querySelectorAll("select")).forEach((s) => ((s as HTMLSelectElement).value = "contains"));
    Array.from(filterRow.querySelectorAll("input")).forEach((s) => ((s as HTMLInputElement).value = ""));
    applyState();
  });

  exportBtn.addEventListener("click", () => {
    const visibleRows = getRows().filter((r) => r.tr.style.display !== "none");
    const hiddenCols = new Set<number>();
    ths.forEach((th, idx) => {
      if ((th as HTMLElement).style.display === "none") hiddenCols.add(idx);
    });
    const visibleColIndexes = headers.map((_, idx) => idx).filter((idx) => !hiddenCols.has(idx));
    const exportHeaders = visibleColIndexes.map((idx) => headers[idx]);
    const csvRows = visibleRows.map((r) => visibleColIndexes.map((idx) => r.cells[idx] || ""));
    if (!csvRows.length) return;
    exportRowsToCsv("dealing-table", exportHeaders, csvRows);
  });
  showHiddenBtn.addEventListener("click", () => {
    showHiddenData = !showHiddenData;
    showHiddenBtn.textContent = showHiddenData ? "Hide hidden data" : "Show hidden data";
    applyState();
  });

  applyState();

  return () => {
    toolbar.remove();
    filterRow.remove();
    ths.forEach((th) => {
      th.style.cursor = "";
    });
    indicators.forEach((indicator) => indicator.remove());
    Array.from(tbody.querySelectorAll("tr")).forEach((row) => {
      (row as HTMLTableRowElement).style.display = "";
      Array.from((row as HTMLTableRowElement).querySelectorAll("td,th")).forEach((cell) => {
        (cell as HTMLElement).style.display = "";
      });
    });
    ths.forEach((th) => {
      (th as HTMLElement).style.display = "";
    });
    Array.from(filterRow.querySelectorAll("th")).forEach((th) => {
      (th as HTMLElement).style.display = "";
    });
  };
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

const REBATE_RULES_SAMPLE_CSV = `symbol,rate_per_lot
XAUUSD,2.00
EURUSD,1.00
GBPUSD,1.00
US30,0.50
*,0.00
`;

const normalizeRebateSymbol = (symbol: string) => {
  const upper = String(symbol || "").trim().toUpperCase();
  if (!upper) return "";
  const dot = upper.indexOf(".");
  return dot === -1 ? upper : upper.slice(0, dot);
};

const wildcardToRegex = (pattern: string) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
};

const getRateForSymbol = (symbol: string, rules: RebateRule[], defaultRatePerLot: number) => {
  const normalized = normalizeRebateSymbol(symbol);
  for (const rule of rules) {
    const target = normalizeRebateSymbol(rule.symbolPattern);
    if (!target) continue;
    if (target.includes("*")) {
      if (wildcardToRegex(target).test(normalized)) return rule.ratePerLot;
      continue;
    }
    if (target === normalized) return rule.ratePerLot;
  }
  return Number.isFinite(defaultRatePerLot) && defaultRatePerLot > 0 ? defaultRatePerLot : 0;
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

const getAlertsHubConfig = () => {
  const backendBaseUrl = (import.meta as any).env?.VITE_BACKEND_BASE_URL || "";
  const explicitTokenUrl = (import.meta as any).env?.VITE_SIGNALR_TOKEN_URL || "";
  const base = String(backendBaseUrl).replace(/\/+$/, "");
  const tokenBase = String(explicitTokenUrl).trim();
  return {
    hubUrl: base ? `${base}/ws/dashboard` : "/ws/dashboard",
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
  const [historySavingLp, setHistorySavingLp] = useState<string | null>(null);
  const [historyStartPeriodEdits, setHistoryStartPeriodEdits] = useState<Record<string, string>>({});
  const [nopData, setNopData] = useState<NopReportData | null>(null);
  const [nopLoading, setNopLoading] = useState(false);
  const [nopError, setNopError] = useState<string | null>(null);
  const [nopLastUpdated, setNopLastUpdated] = useState<Date | null>(null);
  const [nopRefreshKey, setNopRefreshKey] = useState(0);
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

  const modeLabel = isUtcTodaySelection(fromDate, toDate) ? "Live" : "Reports";
  const menuLoading =
    activeMenu === "Coverage" || activeMenu === "Risk Exposure"
      ? coverageLoading
      : activeMenu === "Metrics"
        ? metricsLoading
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

  const menuItems = DEALING_TABS as readonly string[];
  const allowedMenuItems = useMemo(
    () => menuItems.filter((item) => hasAccess(`Dealing:${item}`)),
    [menuItems]
  );

  useEffect(() => {
    if (!allowedMenuItems.length) return;
    if (!allowedMenuItems.includes(activeMenu)) {
      setActiveMenu(allowedMenuItems[0]);
    }
  }, [allowedMenuItems, activeMenu]);

  const handlePageRefresh = () => {
    if (activeMenu === "Coverage" || activeMenu === "Risk Exposure") {
      setCoverageRefreshKey((k) => k + 1);
      return;
    }
    if (activeMenu === "Metrics") {
      setMetricsRefreshKey((k) => k + 1);
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
      if (!coverageData?.rows?.length) return;
      const lpNames = coverageData.lpNames || [];
      const headers = ["Symbol", "Buy/Sell", "Client Net", "Uncovered", ...lpNames];
      const rows: Array<Array<string | number>> = [];
      [...coverageRows.gold, ...coverageRows.rest].forEach((row, idx) => {
        rows.push([row.symbol, row.direction || "-", row.clientNet, row.uncovered, ...lpNames.map((lp) => row.lpNets?.[lp] || 0)]);
        const isGoldEnd = isGoldSymbol(row.symbol) && idx === coverageRows.gold.length - 1 && coverageRows.gold.length > 0;
        if (isGoldEnd) {
          rows.push(["GOLD TOTAL", "", coverageGoldTotals.clientNet, coverageGoldTotals.uncovered, ...lpNames.map((lp) => coverageGoldTotals.lpTotals[lp] || 0)]);
        }
      });
      rows.push(["TOTAL", "", coverageData.totals?.clientNet || 0, coverageData.totals?.uncovered || 0, ...lpNames.map((lp) => coverageData.totals?.lpNets?.[lp] || 0)]);
      downloadTableSnapshot({ filePrefix: "coverage-snapshot", title: "Coverage Snapshot - Position Match Table", updatedAt: coverageLastUpdated, headers, rows });
    });

  const handleRiskSnapshot = () =>
    runSnapshot("risk", () => {
      if (!riskRows.length) return;
      const headers = ["Symbol", "Direction", "Client Net", "LP Coverage", "Uncovered", "Coverage %"];
      const rows: Array<Array<string | number>> = riskRows.map((row) => {
        const lpCoverage = row.clientNet - row.uncovered;
        const pct = row.clientNet === 0 ? "-" : `${(((row.clientNet - row.uncovered) / row.clientNet) * 100).toFixed(1)}%`;
        return [row.symbol, row.direction || "-", row.clientNet, lpCoverage, row.uncovered, pct];
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
        const items = historyAggregateData?.items || [];
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
        if (historyAggregateData?.totals) {
          const t = historyAggregateData.totals;
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
    const root = dealingRootRef.current;
    if (!root) return;

    const tables = Array.from(root.querySelectorAll(TABLE_ENHANCER_SELECTOR)) as HTMLTableElement[];
    if (!tables.length) return;

    const cleanups = tables.map((table) => mountTableEnhancer(table));
    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [
    activeMenu,
    historyTab,
    coverageData?.rows?.length,
    metricsData?.items?.length,
    swapRows.length,
    historyAggregateData?.items?.length,
    historyDealsData?.deals?.length,
    historyVolumeData?.items?.length,
    rebateCalcRows.length,
  ]);

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
    const metricsEndpoint = backendBaseUrl ? `${backendBaseUrl}/Metrics/lp` : "/Metrics/lp";
    const equitySummaryEndpoint = backendBaseUrl ? `${backendBaseUrl}/Metrics/equity-summary` : "/Metrics/equity-summary";
    let cancelled = false;

    const fetchMetrics = async () => {
      if (cancelled) return;
      setMetricsLoading(true);
      try {
        const [metricsResp, equityResp] = await Promise.allSettled([fetch(metricsEndpoint), fetch(equitySummaryEndpoint)]);

        if (metricsResp.status !== "fulfilled") {
          throw metricsResp.reason || new Error("Metrics API request failed");
        }
        if (!metricsResp.value.ok) throw new Error(`Metrics API ${metricsResp.value.status}`);

        const data = (await metricsResp.value.json()) as MetricsData;
        if (cancelled) return;
        setMetricsData(data);
        if (equityResp.status === "fulfilled" && equityResp.value.ok) {
          const summary = (await equityResp.value.json()) as Partial<EquitySummaryData>;
          setMetricsEquitySummary({
            lpWithdrawableEquity: Number(summary.lpWithdrawableEquity) || 0,
            clientWithdrawableEquity: Number(summary.clientWithdrawableEquity) || 0,
            difference: Number(summary.difference) || 0,
          });
        }
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
    if (activeMenu !== "Contract Sizes") {
      setContractSizesError(null);
      return;
    }
    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl ? `${backendBaseUrl}/api/ContractSize` : "/api/ContractSize";
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
    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl ? `${backendBaseUrl}/api/ContractSize/detect/${encodeURIComponent(symbol)}` : `/api/ContractSize/detect/${encodeURIComponent(symbol)}`;
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
    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl ? `${backendBaseUrl}/api/ContractSize` : "/api/ContractSize";
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
    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl ? `${backendBaseUrl}/api/ContractSize/${id}` : `/api/ContractSize/${id}`;
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
    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl ? `${backendBaseUrl}/api/ContractSize/${id}` : `/api/ContractSize/${id}`;
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

  const applyHistoryLpStartPeriod = async (lpName: string, dateValue: string, options?: { refresh?: boolean }) => {
    const customStartDate = String(dateValue || "").trim();
    const parsedTs = inputDateToUtcEpochSeconds(customStartDate);
    if (!parsedTs) {
      setHistoryError("Invalid Start Period date.");
      return;
    }
    const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const endpoint = backendBaseUrl
      ? `${backendBaseUrl}/History/lp-config/${encodeURIComponent(lpName)}`
      : `/History/lp-config/${encodeURIComponent(lpName)}`;

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

  useEffect(() => {
    if (activeMenu !== "Clients NOP") return;
    let cancelled = false;

    const loadNop = async () => {
      setNopLoading(true);
      setNopError(null);
      try {
        const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "").replace(/\/+$/, "");
        const positionsEndpoint = backendBaseUrl
          ? `${backendBaseUrl}/Position/GetPositionsByGroup?group=${encodeURIComponent("*")}`
          : `/Position/GetPositionsByGroup?group=${encodeURIComponent("*")}`;
        const positionsResp = await fetch(positionsEndpoint, { headers: { accept: "application/json, text/plain, */*" } });
        if (!positionsResp.ok) throw new Error(`GetPositionsByGroup ${positionsResp.status}`);
        const allPositions = (await positionsResp.json()) as Array<{
          login?: number | string;
          symbol?: string;
          action?: number;
          lots?: number;
          volume?: number;
          volumeExt?: number;
        }>;

        const allSymbols = Array.from(
          new Set(
            (allPositions || [])
              .map((p) => String(p?.symbol || "").trim())
              .filter(Boolean),
          ),
        ).sort((a, b) => a.localeCompare(b));

        const filteredPositions = (allPositions || []).filter((p) => {
          const symbol = String(p?.symbol || "").trim();
          if (!symbol) return false;
          if (nopSymbol && symbol !== nopSymbol) return false;
          return getPositionLots(p) > 0;
        });

        const logins = Array.from(
          new Set(
            filteredPositions
              .map((p) => Number(p?.login))
              .filter((v) => Number.isFinite(v) && v > 0),
          ),
        );

        const accountsEndpoint = backendBaseUrl ? `${backendBaseUrl}/Account/GetAllAccounts` : "/Account/GetAllAccounts";
        const accountsResp = await fetch(accountsEndpoint, { headers: { accept: "application/json, text/plain, */*" } });
        if (!accountsResp.ok) throw new Error(`GetAllAccounts ${accountsResp.status}`);
        const allAccounts = (await accountsResp.json()) as Array<{
          login?: number | string;
          balance?: number;
          credit?: number;
          margin?: number;
          marginFree?: number;
          marginLevel?: number;
          equity?: number;
        }>;
        const accountByLogin = new Map<number, (typeof allAccounts)[number]>();
        for (const account of allAccounts || []) {
          const login = Number(account?.login);
          if (!Number.isFinite(login) || login <= 0) continue;
          accountByLogin.set(login, account);
        }

        const userInfoByLogin = new Map<number, { name?: string }>();
        const chunkSize = 80;
        for (let i = 0; i < logins.length; i += chunkSize) {
          const chunk = logins.slice(i, i + chunkSize);
          if (!chunk.length) continue;
          const query = chunk.map((login) => `logins=${encodeURIComponent(String(login))}`).join("&");
          const userInfoEndpoint = backendBaseUrl ? `${backendBaseUrl}/Account/GetUserInfoBatch?${query}` : `/Account/GetUserInfoBatch?${query}`;
          try {
            const infoResp = await fetch(userInfoEndpoint, { headers: { accept: "application/json, text/plain, */*" } });
            if (!infoResp.ok) continue;
            const payload = (await infoResp.json()) as Record<string, { login?: number | string; name?: string }>;
            Object.values(payload || {}).forEach((entry) => {
              const login = Number(entry?.login);
              if (!Number.isFinite(login) || login <= 0) return;
              userInfoByLogin.set(login, { name: String(entry?.name || "") });
            });
          } catch {
            // continue without names if batch info request fails
          }
        }

        const symbolBuckets = new Map<string, { buy: Map<number, number>; sell: Map<number, number> }>();
        for (const position of filteredPositions) {
          const symbol = String(position?.symbol || "").trim();
          const login = Number(position?.login);
          const lots = getPositionLots(position);
          if (!symbol || !Number.isFinite(login) || login <= 0 || !(lots > 0)) continue;
          const side = Number(position?.action) === 1 ? "sell" : "buy";
          const bucket = symbolBuckets.get(symbol) || { buy: new Map<number, number>(), sell: new Map<number, number>() };
          const current = bucket[side].get(login) || 0;
          bucket[side].set(login, current + lots);
          symbolBuckets.set(symbol, bucket);
        }

        const toClient = (login: number, volume: number): NopClient => {
          const account = accountByLogin.get(login);
          const info = userInfoByLogin.get(login);
          return {
            login,
            name: String(info?.name || ""),
            volume,
            realLimit: null,
            mt5Limit: null,
            equity: Number(account?.equity || 0),
            credit: Number(account?.credit || 0),
            balance: Number(account?.balance || 0),
            marginFree: Number(account?.marginFree || 0),
            margin: Number(account?.margin || 0),
            marginLevel: Number(account?.marginLevel || 0),
          };
        };

        const symbols: NopSymbolGroup[] = Array.from(symbolBuckets.entries())
          .map(([symbol, bucket]) => {
            const buyClients = Array.from(bucket.buy.entries())
              .map(([login, volume]) => toClient(login, volume))
              .sort((a, b) => b.volume - a.volume);
            const sellClients = Array.from(bucket.sell.entries())
              .map(([login, volume]) => toClient(login, volume))
              .sort((a, b) => b.volume - a.volume);
            const buyTotal = buyClients.reduce((sum, row) => sum + row.volume, 0);
            const sellTotal = sellClients.reduce((sum, row) => sum + row.volume, 0);
            return {
              symbol,
              buyClients,
              sellClients,
              buyTotal,
              sellTotal,
              netTotal: buyTotal - sellTotal,
            };
          })
          .sort((a, b) => a.symbol.localeCompare(b.symbol));

        const normalized: NopReportData = {
          timestamp: new Date().toISOString(),
          accountsReporting: logins.filter((login) => accountByLogin.has(login)).length,
          collectedLogins: logins.length,
          symbols,
        };
        if (cancelled) return;
        setNopData(normalized);
        setNopLastUpdated(new Date());
        setNopSymbolsAll(allSymbols);
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

    if (activeMenu === "Clients NOP") {
      const rows = nopData?.symbols || [];
      let buyLots = 0;
      let sellLots = 0;

      rows.forEach((s) => {
        buyLots += Number.isFinite(s.buyTotal) ? s.buyTotal : 0;
        sellLots += Number.isFinite(s.sellTotal) ? s.sellTotal : 0;
      });

      const netLots = buyLots - sellLots;
      return [
        { label: "Symbols", value: rows.length.toLocaleString() },
        { label: "Buy Lots", value: buyLots.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
        { label: "Sell Lots", value: sellLots.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
        { label: "Net Lots", value: netLots.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
      ];
    }

    return [
      { label: "Client Equity", value: `$${metrics.totalEquity.toLocaleString()}` },
      { label: "LP Equity", value: `$${(overviewData.lpMetrics?.totals?.equity || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}` },
      {
        label: "Difference (LP Equity-Client Equity)",
        value: `$${((overviewData.lpMetrics?.totals?.equity || 0) - metrics.totalEquity).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      },
      { label: "Total Credit", value: `$${metrics.totalCredit.toLocaleString()}` },
      { label: "Trading Profit", value: `$${metrics.tradingProfit.toLocaleString()}` },
      { label: "LP Accounts", value: (overviewData.lpMetrics?.items?.length || 0).toLocaleString() },
      { label: "Swap Due Tonight", value: overviewData.swaps.filter((row) => row.willChargeTonight).length.toLocaleString() },
      { label: "Total Uncovered", value: (overviewData.coverage?.totals?.uncovered || 0).toFixed(2) },
    ];
  }, [activeMenu, coverageData, riskKpis, metricsData, swapRows, metrics, historyTab, historyAggregateData, historyDealsData, historyVolumeData, overviewData, rebateCalcRows, rebateLoginsCount, nopData, contractSizes]);

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
    <div ref={dealingRootRef} className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 p-6 md:p-8">
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="h-fit rounded-2xl border border-slate-200 bg-gradient-to-b from-white via-slate-50 to-slate-100 p-4 dark:border-cyan-500/20 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 lg:sticky lg:top-6">
          <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300/80">Dealing Menu</div>
          <div className="mt-3 space-y-1.5">
            {allowedMenuItems.map((item) => {
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

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {summaryCards.map((card) => (
              <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
                <div className="text-xs text-slate-500 dark:text-slate-400">{card.label}</div>
                <div className="mt-2 font-mono text-xl font-semibold text-slate-900 dark:text-slate-100">{card.value}</div>
              </div>
            ))}
          </section>

          {activeMenu === "Coverage" ? (
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
                  {coverageLastUpdated && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">Updated {coverageLastUpdated.toLocaleTimeString()}</span>
                  )}
                  <button
                    type="button"
                    onClick={handleCoverageSnapshot}
                    disabled={snapshottingTable === "coverage" || coverageLoading || !coverageData?.rows?.length}
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
                    onClick={() => setCoverageRefreshKey((k) => k + 1)}
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

              <div className={`min-h-0 rounded-lg border border-slate-800 ${fullscreenTable === "coverage" ? "flex-1 overflow-auto" : "overflow-x-auto"}`}>
                <table data-table-kind="coverage" className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
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
                          <tr className={isGold ? "bg-amber-100/50 dark:bg-amber-500/5" : "bg-slate-50 dark:bg-slate-950/30"}>
                            <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{row.symbol}</td>
                            <td className="border-t border-slate-800 px-3 py-2 text-left">
                              {row.direction === "BUY" ? (
                                <span className="font-semibold text-emerald-700 dark:text-emerald-300">BUY</span>
                              ) : row.direction === "SELL" ? (
                                <span className="font-semibold text-rose-700 dark:text-rose-300">SELL</span>
                              ) : (
                                <span className="text-slate-500">-</span>
                              )}
                            </td>
                            <td className="border-t border-slate-800 px-3 py-2 text-right">
                              {formatCoverageVal(row.clientNet)}
                              {renderContractSizeBadge(row.contractSizeMultiplier)}
                            </td>
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
                    <tr className="bg-slate-200/80 dark:bg-slate-900/95 font-semibold text-slate-700 dark:text-slate-200">
                      <td className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2">TOTAL</td>
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
                    <button
                      type="button"
                      onClick={handleRiskSnapshot}
                      disabled={snapshottingTable === "risk" || coverageLoading || !riskRows.length}
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

                <div className={`min-h-0 rounded-lg border border-slate-800 ${fullscreenTable === "risk" ? "flex-1 overflow-auto" : "overflow-x-auto"}`}>
                  <table data-table-kind="risk" className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
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
                          <tr key={`${row.symbol}-${idx}`} className={isGold ? "bg-amber-100/50 dark:bg-amber-500/5" : "bg-slate-50 dark:bg-slate-950/30"}>
                            <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{row.symbol}</td>
                            <td className="border-t border-slate-800 px-3 py-2 text-left">
                              {row.direction === "BUY" ? (
                                <span className="font-semibold text-emerald-700 dark:text-emerald-300">BUY</span>
                              ) : row.direction === "SELL" ? (
                                <span className="font-semibold text-rose-700 dark:text-rose-300">SELL</span>
                              ) : (
                                <span className="text-slate-500">-</span>
                              )}
                            </td>
                            <td className="border-t border-slate-800 px-3 py-2 text-right">
                              {formatCoverageVal(row.clientNet)}
                              {renderContractSizeBadge(row.contractSizeMultiplier)}
                            </td>
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
                      <tr className="bg-slate-200/80 dark:bg-slate-900/95 font-semibold text-slate-700 dark:text-slate-200">
                        <td className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2">TOTAL</td>
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
              {metricsError && (
                <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{metricsError}</div>
              )}
              <div className={`min-h-0 rounded-lg border border-slate-800 ${fullscreenTable === "metrics" ? "flex-1 overflow-auto" : "overflow-x-auto"}`}>
                <table data-table-kind="metrics" className="min-w-full text-xs">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">LP</th>
                      <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Login</th>
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
                      <tr key={`${item.lp}-${item.login}`} className="bg-slate-50 dark:bg-slate-950/30">
                        <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{item.lp}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-slate-500 dark:text-slate-400">{item.login}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.equity)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.realEquity)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.credit)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.balance)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.margin)}</td>
                        <td className="border-t border-slate-800 px-3 py-2 text-right">{formatDollar(item.freeMargin)}</td>
                        <td
                          className={`border-t border-slate-800 px-3 py-2 text-right ${
                            item.marginLevel === 0 ? "text-slate-500" : item.marginLevel >= 100 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"
                          }`}
                        >
                          {item.marginLevel.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-200/80 dark:bg-slate-900/95 font-semibold text-slate-700 dark:text-slate-200">
                      <td className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2">TOTAL</td>
                      <td className="px-3 py-2" />
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
          ) : activeMenu === "Contract Sizes" ? (
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
                      (historyTab === "aggregate" && !(historyAggregateData?.items || []).length) ||
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

              {historyTab === "aggregate" && (
                <div className={`min-h-0 rounded-lg border border-slate-800 ${fullscreenTable === "history" ? "flex-1 overflow-auto" : "overflow-x-auto"}`}>
                  <table data-table-kind="history-aggregate" className="min-w-full text-xs">
                    <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2 text-left font-semibold uppercase tracking-wide">LP Name</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Login</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Source</th>
                        <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Start Period</th>
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
                        <tr key={`${item.lpName}-${item.login}-${idx}`} className={item.isError ? "opacity-50" : "bg-slate-50 dark:bg-slate-950/30"}>
                          <td className="sticky left-0 border-t border-slate-800 bg-inherit px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{item.lpName}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-left">{item.login}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-left text-slate-500 dark:text-slate-400">{item.source || "-"}</td>
                          {item.isError ? (
                            <td colSpan={14} className="border-t border-slate-800 px-3 py-2 text-left text-rose-700 dark:text-rose-300">
                              {item.errorMessage || "Error"}
                            </td>
                          ) : (
                            <>
                              <td className="border-t border-slate-800 px-3 py-2 text-left">
                                  <input
                                    type="date"
                                  value={(historyStartPeriodEdits[item.lpName] ?? epochSecondsToInputDate(item.effectiveFrom ?? historyTimestamps.from)) || toYmd(fromDate)}
                                    onChange={(e) =>
                                      setHistoryStartPeriodEdits((prev) => ({
                                        ...prev,
                                      [item.lpName]: e.target.value,
                                    }))
                                  }
                                  disabled={historySavingLp === item.lpName}
                                  className="w-[132px] rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                                />
                              </td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.startEquity.toLocaleString()}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.endEquity.toLocaleString()}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right">{item.credit.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.deposit > 0 ? "text-emerald-700 dark:text-emerald-300" : item.deposit < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.deposit.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.withdrawal > 0 ? "text-emerald-700 dark:text-emerald-300" : item.withdrawal < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.withdrawal.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.netDeposits > 0 ? "text-emerald-700 dark:text-emerald-300" : item.netDeposits < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.netDeposits.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.grossProfit > 0 ? "text-emerald-700 dark:text-emerald-300" : item.grossProfit < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.grossProfit.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.totalCommission > 0 ? "text-emerald-700 dark:text-emerald-300" : item.totalCommission < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.totalCommission.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.totalSwap > 0 ? "text-emerald-700 dark:text-emerald-300" : item.totalSwap < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.totalSwap.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.netPL > 0 ? "text-emerald-700 dark:text-emerald-300" : item.netPL < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.netPL.toLocaleString()}</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.realLpPL > 0 ? "text-emerald-700 dark:text-emerald-300" : item.realLpPL < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.realLpPL.toLocaleString()}</td>
                              <td className="border-t border-slate-800 px-3 py-2 text-right text-amber-700 dark:text-amber-300">{item.ntpPercent.toFixed(1)}%</td>
                              <td className={`border-t border-slate-800 px-3 py-2 text-right ${item.lpPL > 0 ? "text-emerald-700 dark:text-emerald-300" : item.lpPL < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{item.lpPL.toLocaleString()}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    {historyAggregateData?.totals && (
                      <tfoot>
                        <tr className="bg-slate-200/80 dark:bg-slate-900/95 font-semibold text-slate-700 dark:text-slate-200">
                          <td className="sticky left-0 bg-slate-100 dark:bg-slate-900/95 px-3 py-2">TOTAL</td>
                          <td className="px-3 py-2" />
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
                <div className={`min-h-0 rounded-lg border border-slate-800 ${fullscreenTable === "history" ? "flex-1 overflow-auto" : "overflow-x-auto"}`}>
                  <table data-table-kind="history-deals" className="min-w-full text-xs">
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
                        <tr key={`${d.dealTicket}-${idx}`} className="bg-slate-50 dark:bg-slate-950/30">
                          <td className="border-t border-slate-800 px-3 py-2">{d.dealTicket}</td>
                          <td className="border-t border-slate-800 px-3 py-2 font-mono">{d.symbol}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-slate-500 dark:text-slate-400">{d.timeString}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.direction === "Buy" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{d.direction}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.entry}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.price.toLocaleString(undefined, { maximumFractionDigits: 5 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.contractSize.toLocaleString()}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.marketValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.profit > 0 ? "text-emerald-700 dark:text-emerald-300" : d.profit < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{d.profit.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.commission > 0 ? "text-emerald-700 dark:text-emerald-300" : d.commission < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{d.commission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.fee > 0 ? "text-emerald-700 dark:text-emerald-300" : d.fee < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{d.fee.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className={`border-t border-slate-800 px-3 py-2 text-right ${d.swap > 0 ? "text-emerald-700 dark:text-emerald-300" : d.swap < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500"}`}>{d.swap.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.lpCommission.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-right">{d.lpCommPerLot.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {historyTab === "volume" && (
                <div className={`min-h-0 rounded-lg border border-slate-800 ${fullscreenTable === "history" ? "flex-1 overflow-auto" : "overflow-x-auto"}`}>
                  <table data-table-kind="history-volume" className="min-w-full text-xs">
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
                        <tr key={`${item.lpName}-${item.login}-${idx}`} className={item.isError ? "opacity-50" : "bg-slate-50 dark:bg-slate-950/30"}>
                          <td className="border-t border-slate-800 px-3 py-2 font-mono">{item.lpName}</td>
                          <td className="border-t border-slate-800 px-3 py-2">{item.login}</td>
                          <td className="border-t border-slate-800 px-3 py-2 text-slate-500 dark:text-slate-400">{item.source || "-"}</td>
                          {item.isError ? (
                            <td colSpan={4} className="border-t border-slate-800 px-3 py-2 text-left text-rose-700 dark:text-rose-300">
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
                        <tr className="bg-slate-200/80 dark:bg-slate-900/95 font-semibold text-slate-700 dark:text-slate-200">
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
                    onClick={() => setNopRefreshKey((k) => k + 1)}
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
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{c.marginLevel ? `${formatMaybeNumber(c.marginLevel, 2)}%` : "-"}</td>
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
                                    <td className="border-t border-slate-800 px-3 py-2 text-right">{c.marginLevel ? `${formatMaybeNumber(c.marginLevel, 2)}%` : "-"}</td>
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
                        <td className="px-3 py-2 text-right">{rebateCalcRows.reduce((s, r) => s + r.trades, 0).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right">{rebateCalcRows.reduce((s, r) => s + r.tradedLots, 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2 text-right">{rebateCalcRows.reduce((s, r) => s + r.eligibleLots, 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2 text-right">{rebateCalcRows.reduce((s, r) => s + r.ineligibleLots, 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        <td className="px-3 py-2 text-right" />
                        <td className="px-3 py-2 text-right">${rebateCalcRows.reduce((s, r) => s + r.mt5CommissionUsd, 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
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
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Risk & Coverage</h2>
                  <div className="space-y-2">
                    {!riskCoverageRows.length && <div className="rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3 text-xs text-slate-500 dark:text-slate-400">No uncovered symbols in this range.</div>}
                    {riskCoverageRows.map((row) => {
                      const lpCoverage = row.clientNet - row.uncovered;
                      return (
                      <div key={row.symbol} className="group relative rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50 p-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono text-slate-900 dark:text-slate-100">{row.symbol}</span>
                          <span className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                            Pos: {row.positions} | Lots: {row.lots.toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                          <div className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900/80">
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">Client Net</div>
                            <div className={`text-sm font-semibold ${row.clientNet >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
                              {row.clientNet.toFixed(2)}
                            </div>
                          </div>
                          <div className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900/80">
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">LP Coverage</div>
                            <div className={`text-sm font-semibold ${lpCoverage >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
                              {lpCoverage.toFixed(2)}
                            </div>
                          </div>
                          <div className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900/80">
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">Uncovered</div>
                            <div className={`text-sm font-semibold ${row.uncovered >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
                              {row.uncovered.toFixed(2)}
                            </div>
                          </div>
                        </div>
                        {row.subSymbols.length > 0 && (
                          <div className="pointer-events-none absolute left-2 right-2 top-full z-20 mt-1 rounded-lg border border-slate-700 bg-slate-950/95 p-2 text-[11px] opacity-0 transition-opacity group-hover:opacity-100">
                            <div className="mb-1 text-slate-400">Sub symbols</div>
                            <div className="space-y-0.5">
                              {row.subSymbols.map((sub) => (
                                <div key={`${row.symbol}-${sub.symbol}`} className="flex items-center justify-between">
                                  <span className="font-mono text-slate-300">{sub.symbol}</span>
                                  <span className={sub.netExposureLots >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>
                                    {sub.netExposureLots.toFixed(2)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )})}
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







