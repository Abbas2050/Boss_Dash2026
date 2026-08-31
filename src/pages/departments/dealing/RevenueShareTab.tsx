import { useCallback, useEffect, useMemo, useState } from "react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import {
  fetchDeals,
  fetchRevenueShare,
  fetchVolume,
  hidesFromRevenueShare,
  isErrorRow,
  type DealRow,
  type RevenueShareRow,
  type VolumeRow,
} from "@/lib/revenueShareApi";

type View = "share" | "deals" | "volume";

const money = (v: number | null | undefined) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const num = (v: number | null | undefined, digits = 2) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "-";
};

const signed = (v: number | null | undefined) => {
  const n = Number(v) || 0;
  return n > 0 ? "text-emerald-700 dark:text-emerald-300" : n < 0 ? "text-rose-700 dark:text-rose-300" : "";
};

// Local YYYY-MM-DD, not d.toISOString().slice(0, 10). toISOString() reports
// the UTC calendar day, which for a UAE user (UTC+4) is the wrong day
// between local midnight and 04:00 -- the "To" date would default to
// yesterday, and at a month boundary monthStart could land a month early.
// Deriving from getFullYear/getMonth/getDate keeps the default in the
// user's own calendar day.
export const ymd = (d: Date) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * A cell that refuses to print a figure for a row the backend could not
 * compute. A zero in a revenue-share table is a number somebody may act on.
 */
function cell(row: { isError?: boolean }, render: () => React.ReactNode) {
  return isErrorRow(row) ? <span className="text-slate-400 dark:text-slate-500">-</span> : render();
}

export function RevenueShareTab({ refreshKey }: { refreshKey?: number }) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [fromYmd, setFromYmd] = useState(ymd(monthStart));
  const [toYmd, setToYmd] = useState(ymd(today));
  const [view, setView] = useState<View>("share");
  const [shareRows, setShareRows] = useState<RevenueShareRow[]>([]);
  const [volumeRows, setVolumeRows] = useState<VolumeRow[]>([]);
  const [dealRows, setDealRows] = useState<DealRow[]>([]);
  const [selectedLogin, setSelectedLogin] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [share, volume] = await Promise.all([fetchRevenueShare(fromYmd, toYmd), fetchVolume(fromYmd, toYmd)]);
      setShareRows(share);
      setVolumeRows(volume);
      setDealRows([]);
      setSelectedLogin("");
    } catch (e: any) {
      setError(e?.message || "Failed to load revenue share.");
      setShareRows([]);
      setVolumeRows([]);
    } finally {
      setLoading(false);
    }
  }, [fromYmd, toYmd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadDeals = useCallback(
    async (login: string) => {
      setSelectedLogin(login);
      setDealRows([]);
      if (!login) return;
      setLoading(true);
      setError(null);
      try {
        setDealRows(await fetchDeals(login, fromYmd, toYmd));
      } catch (e: any) {
        setError(e?.message || "Failed to load deals.");
      } finally {
        setLoading(false);
      }
    },
    [fromYmd, toYmd],
  );

  // An LP with no revenue-share agreement reports as ntpPercent 0 and has no
  // revenue share to show here -- a screen of 0.00 rows would bury the LPs
  // that actually have an agreement. Error rows are kept regardless of their
  // (meaningless) ntpPercent so a failed fetch still surfaces as an error,
  // not a silent disappearance. This does NOT apply to Volume, which is a
  // trading-activity view, not a settlement one, so volumeRows is left
  // unfiltered. hidesFromRevenueShare compares ntpPercent strictly against
  // the number 0 -- see its doc comment for why a null/string "0" must stay
  // visible instead of being coerced away.
  const visibleShareRows = useMemo(() => shareRows.filter((r) => !hidesFromRevenueShare(r)), [shareRows]);

  const shareColumns = useMemo<SortableTableColumn<RevenueShareRow>[]>(
    () => [
      { key: "lpName", label: "LP Name", sortValue: (r) => r.lpName || "", searchValue: (r) => `${r.lpName} ${r.login}`,
        render: (r) => (
          <span className="font-semibold">
            {r.lpName || "-"}
            {isErrorRow(r) && <span className="ml-2 text-xs font-normal text-rose-600 dark:text-rose-400">{r.errorMessage || "failed"}</span>}
          </span>
        ) },
      { key: "login", label: "Login", sortValue: (r) => r.login, render: (r) => <span className="font-mono">{r.login}</span> },
      { key: "source", label: "Source", sortValue: (r) => r.source || "", render: (r) => <span className="text-slate-500">{r.source || "-"}</span> },
      { key: "effectiveFrom", label: "Start Period", sortValue: (r) => r.effectiveFrom || "", render: (r) => r.effectiveFrom ? String(r.effectiveFrom).slice(0, 10) : "-" },
      ...([
        ["startEquity", "Start Equity"], ["endEquity", "End Equity"], ["credit", "Credit"],
        ["deposit", "Deposit"], ["withdrawal", "Withdrawal"], ["netDeposits", "Net Deposits"],
        ["grossProfit", "Gross P/L"], ["totalCommission", "Commission"], ["totalSwap", "Swap"],
        ["netPL", "Net P/L"], ["realLpPL", "Real LP P/L"],
      ] as [keyof RevenueShareRow, string][]).map(([key, label]) => ({
        key: String(key),
        label,
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (r: RevenueShareRow) => Number(r[key]) || 0,
        render: (r: RevenueShareRow) => cell(r, () => <span className={signed(Number(r[key]))}>{money(Number(r[key]))}</span>),
      })),
      { key: "ntpPercent", label: "NTP %", headerClassName: "text-right", cellClassName: "text-right",
        headerTitle: "The agreed revenue-share percentage, set by the backend.",
        sortValue: (r) => Number(r.ntpPercent) || 0,
        render: (r) => cell(r, () => <span className="text-amber-600 dark:text-amber-400">{num(r.ntpPercent, 1)}%</span>) },
      { key: "lpPL", label: "LP P/L (Rev Share)", headerClassName: "text-right", cellClassName: "text-right",
        headerTitle: "What this LP is owed. Supplied by the backend as Real LP P/L x NTP %; this page does not recompute it.",
        sortValue: (r) => Number(r.lpPL) || 0,
        render: (r) => cell(r, () => <span className={`font-bold ${signed(r.lpPL)}`}>{money(r.lpPL)}</span>) },
    ],
    [],
  );

  const volumeColumns = useMemo<SortableTableColumn<VolumeRow>[]>(
    () => [
      { key: "lpName", label: "LP Name", sortValue: (r) => r.lpName || "", searchValue: (r) => `${r.lpName} ${r.login}`,
        render: (r) => (
          <span className="font-semibold">
            {r.lpName || "-"}
            {isErrorRow(r) && <span className="ml-2 text-xs font-normal text-rose-600 dark:text-rose-400">{r.errorMessage || "failed"}</span>}
          </span>
        ) },
      { key: "login", label: "Login", sortValue: (r) => r.login, render: (r) => <span className="font-mono">{r.login}</span> },
      { key: "source", label: "Source", sortValue: (r) => r.source || "", render: (r) => <span className="text-slate-500">{r.source || "-"}</span> },
      { key: "tradeCount", label: "Trade Count", headerClassName: "text-right", cellClassName: "text-right",
        sortValue: (r) => Number(r.tradeCount) || 0, render: (r) => cell(r, () => num(r.tradeCount, 0)) },
      { key: "totalLots", label: "Total Lots", headerClassName: "text-right", cellClassName: "text-right",
        sortValue: (r) => Number(r.totalLots) || 0, render: (r) => cell(r, () => num(r.totalLots)) },
      { key: "notionalUsd", label: "Notional (USD)", headerClassName: "text-right", cellClassName: "text-right",
        sortValue: (r) => Number(r.notionalUsd) || 0, render: (r) => cell(r, () => money(r.notionalUsd)) },
      { key: "volumeYards", label: "Volume (Yards)", headerClassName: "text-right", cellClassName: "text-right",
        sortValue: (r) => Number(r.volumeYards) || 0, render: (r) => cell(r, () => num(r.volumeYards, 4)) },
    ],
    [],
  );

  const dealColumns = useMemo<SortableTableColumn<DealRow>[]>(
    () => [
      { key: "dealTicket", label: "Ticket", sortValue: (r) => Number(r.dealTicket) || 0, render: (r) => <span className="font-mono">{r.dealTicket}</span> },
      { key: "symbol", label: "Symbol", sortValue: (r) => r.symbol || "", render: (r) => <span className="font-semibold">{r.symbol}</span> },
      { key: "timeString", label: "Time", sortValue: (r) => r.timeString || "", render: (r) => <span className="text-slate-500">{r.timeString}</span> },
      { key: "direction", label: "Direction", sortValue: (r) => r.direction || "", render: (r) => r.direction },
      { key: "entry", label: "Entry", sortValue: (r) => r.entry || "", render: (r) => r.entry },
      { key: "volume", label: "Volume", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.volume) || 0, render: (r) => num(r.volume) },
      { key: "price", label: "Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.price) || 0, render: (r) => num(r.price, 5) },
      { key: "contractSize", label: "Contract Size", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.contractSize) || 0, render: (r) => num(r.contractSize, 0) },
      { key: "marketValue", label: "Market Value", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.marketValue) || 0, render: (r) => money(r.marketValue) },
      { key: "profit", label: "Profit", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.profit) || 0, render: (r) => <span className={signed(r.profit)}>{money(r.profit)}</span> },
      { key: "commission", label: "Commission", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.commission) || 0, render: (r) => <span className={signed(r.commission)}>{money(r.commission)}</span> },
      { key: "fee", label: "Fee", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.fee) || 0, render: (r) => <span className={signed(r.fee)}>{money(r.fee)}</span> },
      { key: "swap", label: "Swap", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.swap) || 0, render: (r) => <span className={signed(r.swap)}>{money(r.swap)}</span> },
      { key: "lpCommission", label: "LP Comm", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.lpCommission) || 0, render: (r) => money(r.lpCommission) },
      { key: "lpCommPerLot", label: "LP Comm/Lot", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.lpCommPerLot) || 0, render: (r) => money(r.lpCommPerLot) },
    ],
    [],
  );

  const inputCls = "rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900";
  const tabCls = (v: View) =>
    `rounded px-3 py-1 text-xs font-semibold ${view === v ? "bg-primary/20 text-primary" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`;

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          From
          <input type="date" value={fromYmd} onChange={(e) => setFromYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input type="date" value={toYmd} onChange={(e) => setToYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
        </label>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">
          {loading ? "Loading…" : "Run"}
        </button>
        <div className="ml-auto flex gap-1">
          <button type="button" className={tabCls("share")} onClick={() => setView("share")}>Revenue Share</button>
          <button type="button" className={tabCls("deals")} onClick={() => setView("deals")}>Deals</button>
          <button type="button" className={tabCls("volume")} onClick={() => setView("volume")}>Volume</button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{error}</div>}

      {view === "share" && (
        <SortableTable
          tableId="revenue-share"
          rows={visibleShareRows}
          columns={shareColumns}
          tableClassName="min-w-full text-[11px]"
          emptyText="No LP had a revenue-share period inside this date range. The aggregate is scoped by each agreement's start and end dates, not only by the dates you picked."
        />
      )}

      {view === "volume" && (
        <SortableTable
          tableId="revenue-share-volume"
          rows={volumeRows}
          columns={volumeColumns}
          tableClassName="min-w-full text-[11px]"
          emptyText="No LP had a revenue-share period inside this date range."
        />
      )}

      {view === "deals" && (
        <div className="space-y-2">
          <label className="text-xs text-slate-500">
            LP
            <select value={selectedLogin} onChange={(e) => void loadDeals(e.target.value)} className={`ml-2 ${inputCls}`}>
              <option value="">Select an LP…</option>
              {shareRows.map((r) => (
                <option key={r.login} value={r.login}>{r.lpName || r.login} ({r.login})</option>
              ))}
            </select>
          </label>
          {selectedLogin ? (
            <SortableTable
              tableId="revenue-share-deals"
              rows={dealRows}
              columns={dealColumns}
              tableClassName="min-w-full text-[11px]"
              emptyText="This LP has no deals in the selected range."
            />
          ) : (
            <p className="text-xs text-slate-500">Choose an LP to load its deals for the selected date range.</p>
          )}
        </div>
      )}
    </section>
  );
}
