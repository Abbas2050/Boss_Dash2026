import { useCallback, useEffect, useMemo, useState } from "react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import { ymd } from "@/lib/revenueShareApi";
import {
  fetchSwapsReport,
  type SwapAccountRow,
  type SwapTotals,
  type SwapsReport,
} from "@/lib/swapsReportApi";

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
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "-";
};

const signed = (v: number | null | undefined) => {
  const n = Number(v) || 0;
  return n > 0 ? "text-emerald-700 dark:text-emerald-300" : n < 0 ? "text-rose-700 dark:text-rose-300" : "";
};

/**
 * The two halves of the report differ only in which field carries the name, so
 * one factory builds both rather than two near-identical column lists drifting
 * apart.
 */
function swapColumns(nameLabel: string, nameOf: (row: SwapAccountRow) => string): SortableTableColumn<SwapAccountRow>[] {
  return [
    {
      key: "name",
      label: nameLabel,
      sortValue: (r) => nameOf(r) || "",
      searchValue: (r) => `${nameOf(r)} ${r.login}`,
      render: (r) => <span className="font-semibold">{nameOf(r) || "-"}</span>,
    },
    { key: "login", label: "Login", sortValue: (r) => r.login, render: (r) => <span className="font-mono">{r.login}</span> },
    {
      key: "source",
      label: "Source",
      sortValue: (r) => r.source || "",
      render: (r) => <span className="text-slate-500">{r.source || "-"}</span>,
    },
    {
      key: "totalSwap",
      label: "Total Swap",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => Number(r.totalSwap) || 0,
      render: (r) => <span className={`font-semibold ${signed(r.totalSwap)}`}>{money(r.totalSwap)}</span>,
    },
    {
      key: "dealVolume",
      label: "Deal Volume",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => Number(r.dealVolume) || 0,
      render: (r) => num(r.dealVolume),
    },
    {
      key: "realizedVolume",
      label: "Realized Volume",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => Number(r.realizedVolume) || 0,
      render: (r) => num(r.realizedVolume),
    },
  ];
}

/** Totals arrive from the backend. Absent, we say so rather than showing a figure. */
function TotalsLine({ totals }: { totals: SwapTotals | null }) {
  if (!totals) {
    return (
      <p className="text-xs text-slate-500">
        Totals unavailable &mdash; the report did not include them for this section.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/50">
      <span className="text-slate-500">
        Accounts <span className="font-semibold text-slate-700 dark:text-slate-200">{totals.accountCount}</span>
      </span>
      <span className="text-slate-500">
        Total Swap <span className={`font-semibold ${signed(totals.totalSwap)}`}>{money(totals.totalSwap)}</span>
      </span>
    </div>
  );
}

export function SwapsReportTab({ refreshKey }: { refreshKey?: number }) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [fromYmd, setFromYmd] = useState(ymd(monthStart));
  const [toYmd, setToYmd] = useState(ymd(today));
  const [report, setReport] = useState<SwapsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchSwapsReport(fromYmd, toYmd));
    } catch (e: any) {
      setError(e?.message || "Failed to load the swaps report.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [fromYmd, toYmd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const clientColumns = useMemo(() => swapColumns("Client", (r) => r.name || ""), []);
  const lpColumns = useMemo(() => swapColumns("LP Name", (r) => r.lpName || ""), []);

  const inputCls = "rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900";

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          From
          <input type="date" value={fromYmd} onChange={(e) => setFromYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input type="date" value={toYmd} onChange={(e) => setToYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
        </label>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {loading ? "Loading…" : "Run"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {!error && (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">By Client</h3>
            <TotalsLine totals={report?.clientTotals ?? null} />
            <SortableTable
              tableId="swaps-report-clients"
              rows={report?.clients || []}
              columns={clientColumns}
              tableClassName="min-w-full text-[11px]"
              emptyText="No client swap activity in this date range."
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">By LP</h3>
            <TotalsLine totals={report?.lpTotals ?? null} />
            <SortableTable
              tableId="swaps-report-lps"
              rows={report?.lps || []}
              columns={lpColumns}
              tableClassName="min-w-full text-[11px]"
              emptyText="No LP swap activity in this date range."
            />
          </div>
        </>
      )}
    </section>
  );
}
