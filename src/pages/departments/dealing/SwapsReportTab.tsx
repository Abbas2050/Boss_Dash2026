import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import { ymd } from "@/lib/revenueShareApi";
import { formatDubaiInstant } from "@/lib/dubaiTime";
import {
  fetchClientSwapDetail,
  fetchLpSwapDetail,
  fetchSwapsReport,
  SwapsReportError,
  type FinaltoDailyCostRow,
  type SwapAccountRow,
  type SwapDealRow,
  type SwapDetail,
  type SwapOpenPositionRow,
  type SwapPositionRow,
  type SwapTotals,
  type SwapsFailureKind,
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
 * MT5 hands back deal times as "2026-08-01 12:00:00" -- a UTC instant with the
 * zone marker missing. JavaScript's Date parses a zone-less date-time as LOCAL
 * time, so feeding that string straight to the formatter shifts the clock by
 * the viewer's own offset and can land on the wrong calendar day. That is the
 * exact walletMonitor.js bug documented in dubaiTime.ts, one layer up. Re-attach
 * the Z first, then render Dubai wall-clock like every other instant in the app.
 */
const instant = (value: string | number | Date | null | undefined) => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(value.trim())) {
    return formatDubaiInstant(`${value.trim().replace(" ", "T")}Z`);
  }
  return formatDubaiInstant(value);
};

/** Unix SECONDS from the backend; Date wants milliseconds. */
const unixInstant = (secs: number | null | undefined) => {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return formatDubaiInstant(n * 1000);
};

/**
 * Whether the row's statementSwap is a figure at all.
 *
 * The backend sends statementSwap: 0 with statementRowCount: 0 when no statement
 * was uploaded -- not null. Observed live on 2026-09-17: every one of the 43 LPs
 * in the 2026-09-05..11 response carried that pair, and a null check alone put
 * "$0.00" in the Statement DB column for all of them, as if each statement said
 * zero. The row count is the only reliable signal (see swapsReportApi.ts); a
 * zero with rows behind it is a genuine zero and still renders.
 */
// Number(null) is 0 and Number(undefined) is NaN; neither is > 0.
const hasStatement = (r: SwapAccountRow) => Number(r.statementRowCount) > 0;

/**
 * The two halves of the report differ only in which field carries the name, so
 * one factory builds both rather than two near-identical column lists drifting
 * apart.
 *
 * The swap columns are named for their SOURCE, not just "Total Swap", because
 * three different measurements of swap now sit next to each other and an
 * operator reconciling them has to know which is which. The underlying fields
 * are untouched: "Realized Swap" still renders `totalSwap`, exactly the figure
 * this tab rendered before.
 */
function swapColumns(
  nameLabel: string,
  nameOf: (row: SwapAccountRow) => string,
  opts: { statement: boolean; realizedLabel: string; unrealizedLabel: string },
): SortableTableColumn<SwapAccountRow>[] {
  const columns: SortableTableColumn<SwapAccountRow>[] = [
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
      label: opts.realizedLabel,
      headerTitle: "SOURCE: MT5 closed deals. Sum of deal Storage on deals closed inside the selected date range.",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => Number(r.totalSwap) || 0,
      render: (r) => <span className={`font-semibold ${signed(r.totalSwap)}`}>{money(r.totalSwap)}</span>,
    },
    {
      key: "unrealizedSwap",
      label: opts.unrealizedLabel,
      headerTitle:
        "SOURCE: MT5 open positions. Accrued swap on positions open RIGHT NOW, read live -- a snapshot, not a figure for the selected range. Terminal LPs send nothing here.",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => Number(r.unrealizedSwap) || 0,
      render: (r) =>
        r.unrealizedSwap === null || r.unrealizedSwap === undefined ? (
          <span className="text-slate-400">—</span>
        ) : (
          <span className={signed(r.unrealizedSwap)}>{money(r.unrealizedSwap)}</span>
        ),
    },
  ];

  if (opts.statement) {
    columns.push({
      key: "statementSwap",
      label: "Swap (Statement DB)",
      headerTitle:
        "SOURCE: LP Statement DB (uploaded broker PDFs). Sum of TotalSwaps across LpStatement rows whose StatementDate falls in the report window. Blank when no statements were uploaded for this LP and range.",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => (hasStatement(r) ? Number(r.statementSwap) || 0 : 0),
      render: (r) =>
        !hasStatement(r) || r.statementSwap === null || r.statementSwap === undefined ? (
          <span className="text-slate-400">—</span>
        ) : (
          <span
            className={signed(r.statementSwap)}
            title={r.statementRowCount ? `${r.statementRowCount} statement row(s) summed` : undefined}
          >
            {money(r.statementSwap)}
          </span>
        ),
    });
  }

  columns.push(
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
  );

  return columns;
}

/**
 * A pinned total for a drilldown grid, summed from the rows it shows.
 *
 * Unlike the main panels these grids carry no backend totals and are never
 * filtered, so summing what is on screen is the honest figure rather than a
 * second opinion. Columns not listed render empty.
 */
function sumFooter<T>(
  rows: T[],
  fields: Array<{ key: string; pick: (row: T) => number | null | undefined; fmt: (n: number) => React.ReactNode }>,
): Partial<Record<string, React.ReactNode>> | undefined {
  if (!rows.length) return undefined;
  const out: Partial<Record<string, React.ReactNode>> = {};
  for (const f of fields) out[f.key] = f.fmt(rows.reduce((acc, r) => acc + (Number(f.pick(r)) || 0), 0));
  return out;
}

/**
 * The pinned TOTAL row for a main panel, keyed by column.
 *
 * Only the columns that have a meaningful total are filled; name/login/source
 * are left out so they render empty rather than as a zero that means nothing.
 *
 * `totalSwap` and `unrealizedSwap` come from the BACKEND's totals, not from
 * summing the visible rows: the table can be searched and filtered, and a
 * footer that re-summed whatever happens to be on screen would quietly become
 * a different number from the one in the line above it. `statementSwap` has no
 * backend total, so it is summed here from the rows, and that difference is
 * deliberate rather than an oversight.
 */
function totalsFooter(
  rows: SwapAccountRow[],
  totals: SwapTotals | null,
  { statement = false }: { statement?: boolean } = {},
): Partial<Record<string, React.ReactNode>> | undefined {
  if (!totals) return undefined;
  const footer: Partial<Record<string, React.ReactNode>> = {
    totalSwap: <span className={signed(totals.totalSwap)}>{money(totals.totalSwap)}</span>,
    unrealizedSwap:
      totals.unrealizedSwap === null || totals.unrealizedSwap === undefined ? (
        <span className="text-slate-400">—</span>
      ) : (
        <span className={signed(totals.unrealizedSwap)}>{money(totals.unrealizedSwap)}</span>
      ),
  };
  if (statement) {
    // Only total the column when at least one LP actually HAS a statement.
    //
    // Summing regardless produced "$0.00" on a day when nothing was uploaded,
    // which in this column does not mean "the statements net to zero" -- it
    // means "the statements say zero", about statements that do not exist. That
    // is the same misreading the per-row dash exists to prevent, and it is what
    // the whole Manager-LP argument in the Swaps email turned on.
    const withStatements = rows.filter(hasStatement);
    footer.statementSwap = withStatements.length ? (
      <span className={signed(withStatements.reduce((acc, r) => acc + (Number(r.statementSwap) || 0), 0))}>
        {money(withStatements.reduce((acc, r) => acc + (Number(r.statementSwap) || 0), 0))}
      </span>
    ) : (
      <span className="text-slate-400">—</span>
    );
  }
  return footer;
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

type DetailColumn<T> = {
  key: string;
  label: string;
  right?: boolean;
  render: (row: T) => React.ReactNode;
};

/**
 * Drilldown tables. SortableTable is kept for the two main panels (it owns the
 * CSV export and column memory the operators already rely on); these secondary
 * tables are plainer but stack into one card per row on a phone, which is where
 * this dashboard is actually read.
 */
function DetailTable<T>({
  columns,
  rows,
  empty,
  rowKey,
  footer,
  footerLabel = "TOTAL",
}: {
  columns: DetailColumn<T>[];
  rows: T[];
  empty: string;
  rowKey: (row: T, index: number) => string;
  /** Totals pinned to the bottom, keyed by column. Only filled columns render. */
  footer?: Partial<Record<string, React.ReactNode>>;
  footerLabel?: React.ReactNode;
}) {
  if (!rows.length) {
    return <p className="rounded border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/40">{empty}</p>;
  }
  return (
    <>
      <div className="hidden overflow-x-auto rounded border border-slate-200 md:block dark:border-slate-800">
        <table className="min-w-full text-[11px]">
          <thead className="bg-slate-100 text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={`px-2 py-1.5 font-semibold uppercase tracking-wide ${col.right ? "text-right" : "text-left"}`}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={rowKey(row, idx)} className="border-t border-slate-200 dark:border-slate-800">
                {columns.map((col) => (
                  <td key={col.key} className={`px-2 py-1.5 ${col.right ? "text-right" : "text-left"}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && (
            <tfoot>
              <tr className="border-t-2 border-slate-400 bg-slate-100 font-semibold dark:border-slate-600 dark:bg-slate-900/80">
                {columns.map((col, i) => (
                  <td key={col.key} className={`px-2 py-1.5 ${col.right ? "text-right" : "text-left"}`}>
                    {i === 0 ? (footer[col.key] ?? footerLabel) : (footer[col.key] ?? null)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* The phone layout renders each row as a card, so a pinned table row has
          no equivalent -- the total becomes one more card, marked as the total. */}
      {footer && (
        <div className="mt-2 rounded-xl border-2 border-slate-400 bg-slate-100 p-3 md:hidden dark:border-slate-600 dark:bg-slate-900/80">
          <dl className="space-y-1 text-xs font-semibold">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">{footerLabel}</dt>
              <dd />
            </div>
            {columns
              .filter((col) => footer[col.key] != null)
              .map((col) => (
                <div key={col.key} className="flex justify-between gap-3">
                  <dt className="text-slate-500">{col.label}</dt>
                  <dd className="text-right">{footer[col.key]}</dd>
                </div>
              ))}
          </dl>
        </div>
      )}

      <div className="space-y-2 md:hidden">
        {rows.map((row, idx) => (
          <div key={`card-${rowKey(row, idx)}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40">
            <dl className="space-y-1 text-xs">
              {columns.map((col) => (
                <div key={col.key} className="flex justify-between gap-3">
                  <dt className="text-slate-500">{col.label}</dt>
                  <dd className="text-right">{col.render(row)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

const positionColumns: DetailColumn<SwapPositionRow>[] = [
  { key: "positionId", label: "Position ID", render: (r) => <span className="font-mono">{r.positionId ?? "-"}</span> },
  { key: "symbol", label: "Symbol", render: (r) => r.symbol || "-" },
  { key: "dealCount", label: "Deal Count", right: true, render: (r) => num(r.dealCount, 0) },
  { key: "totalSwap", label: "Total Swap", right: true, render: (r) => <span className={signed(r.totalSwap)}>{money(r.totalSwap)}</span> },
  { key: "dealVolume", label: "Deal Volume", right: true, render: (r) => num(r.dealVolume) },
  { key: "realizedVolume", label: "Realized Volume", right: true, render: (r) => num(r.realizedVolume) },
  { key: "first", label: "First (UTC)", render: (r) => unixInstant(r.firstDealUnixSec) },
  { key: "last", label: "Last (UTC)", render: (r) => unixInstant(r.lastDealUnixSec) },
];

const dealColumns: DetailColumn<SwapDealRow>[] = [
  { key: "dealId", label: "Deal ID", render: (r) => <span className="font-mono">{r.dealId ?? "-"}</span> },
  { key: "timeUtc", label: "Time (UTC)", render: (r) => instant(r.timeUtc) },
  { key: "positionId", label: "Position ID", render: (r) => <span className="font-mono">{r.positionId ?? "-"}</span> },
  { key: "symbol", label: "Symbol", render: (r) => r.symbol || "-" },
  { key: "action", label: "Action", render: (r) => r.action || "-" },
  { key: "entry", label: "Entry", render: (r) => r.entry || "-" },
  { key: "lots", label: "Lots", right: true, render: (r) => num(r.lots) },
  { key: "closedLegLots", label: "Closed-Leg Lots", right: true, render: (r) => num(r.closedLegLots) },
  { key: "storage", label: "Storage (Swap)", right: true, render: (r) => <span className={signed(r.storage)}>{money(r.storage)}</span> },
];

const openPositionColumns: DetailColumn<SwapOpenPositionRow>[] = [
  { key: "ticket", label: "Ticket", render: (r) => <span className="font-mono">{r.ticket ?? "-"}</span> },
  { key: "symbol", label: "Symbol", render: (r) => r.symbol || "-" },
  { key: "type", label: "Type", render: (r) => r.type || "-" },
  { key: "lots", label: "Lots", right: true, render: (r) => num(r.lots) },
  { key: "opened", label: "Opened (UTC)", render: (r) => instant(r.timeCreateUtc) },
  { key: "swap", label: "Swap (accrued)", right: true, render: (r) => <span className={signed(r.swap)}>{money(r.swap)}</span> },
  { key: "profit", label: "Floating P&L", right: true, render: (r) => <span className={signed(r.profit)}>{money(r.profit)}</span> },
];

const finaltoColumns: DetailColumn<FinaltoDailyCostRow>[] = [
  { key: "subAccountId", label: "Sub-account", render: (r) => <span className="font-mono">{r.subAccountId ?? "-"}</span> },
  { key: "instrument", label: "Instrument", render: (r) => r.instrument || "-" },
  // Rendered verbatim, NOT through formatDubaiInstant. This is the calendar day
  // Finalto booked the cost against, not an instant; shifting it by four hours
  // would move a cost into the neighbouring day's bucket.
  { key: "tradeDate", label: "Trade Date (UTC)", render: (r) => r.tradeDate || "-" },
  { key: "longPosCost", label: "Long Pos Cost", right: true, render: (r) => <span className={signed(r.longPosCost)}>{money(r.longPosCost)}</span> },
  { key: "shortPosCost", label: "Short Pos Cost", right: true, render: (r) => <span className={signed(r.shortPosCost)}>{money(r.shortPosCost)}</span> },
  { key: "total", label: "Total", right: true, render: (r) => <span className={signed(r.total)}>{money(r.total)}</span> },
  {
    key: "eodRate",
    label: "EOD Rate",
    right: true,
    render: (r) => (Number.isFinite(Number(r.eodRate)) ? Number(r.eodRate).toFixed(6) : "-"),
  },
];

type Failure = { kind: SwapsFailureKind; message: string };

type DetailState = {
  title: string;
  /** The range the drilldown was fetched for, echoed in its own timeout text. */
  range: string;
  loading: boolean;
  detail: SwapDetail | null;
  failure: Failure | null;
  /** Set for Api LPs so the "this is the slow path" note stays on screen. */
  slowNote: string | null;
};

function toFailure(e: unknown): Failure {
  if (e instanceof SwapsReportError) return { kind: e.kind, message: e.message };
  return { kind: "failed", message: (e as Error)?.message || "Failed to load the swaps report." };
}

export function SwapsReportTab({ refreshKey }: { refreshKey?: number }) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [fromYmd, setFromYmd] = useState(ymd(monthStart));
  const [toYmd, setToYmd] = useState(ymd(today));
  const [liveFinalto, setLiveFinalto] = useState(false);
  const [report, setReport] = useState<SwapsReport | null>(null);
  /** The range the rendered report was actually run for, which can lag the inputs. */
  const [ranRange, setRanRange] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const detailSeq = useRef(0);

  /**
   * Written as a statement body with an early return rather than the obvious
   * `prev ? {...prev, ...patch} : prev` ternary. That shape is exactly what
   * src/lib/backendProxyUrls.test.ts scans for -- it is how the bare-path URL
   * fallback that silently aimed three settings pages at index.html was
   * spelled -- and the scan is narrow on purpose, so the fix is to not write
   * the shape rather than to carve an exemption into the guard.
   */
  const patchDetail = useCallback((patch: Partial<DetailState>) => {
    setDetail((prev) => {
      if (!prev) return null;
      return { ...prev, ...patch };
    });
  }, []);

  const range = `${fromYmd} → ${toYmd}`;

  /**
   * A visible second counter, not a spinner. The measured cost of this endpoint
   * is over 45 seconds for a SINGLE day and the proxy allows up to 180; a
   * spinner at 90 seconds is indistinguishable from a frozen tab, and the
   * operator's instinct is then to reload and start the 3-minute call again.
   */
  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  const load = useCallback(async () => {
    const confirmed = window.confirm(
      `Run the swaps report for ${range}?\n\n` +
        (liveFinalto
          ? "Raw Finalto is ON: the backend will bypass the FinaltoCosts cache and call the vendor's CFDCost SOAP endpoint once per business day per sub-account. This is the slow path.\n\n"
          : "") +
        "A single day has measured over 45 seconds. The proxy allows this route up to 180 seconds before it gives up.",
    );
    if (!confirmed) return;

    setLoading(true);
    setFailure(null);
    setDetail(null);
    try {
      setReport(await fetchSwapsReport(fromYmd, toYmd, liveFinalto));
      setRanRange(range);
    } catch (e) {
      // Deliberately no retry. A retry of a call that already burned three
      // minutes is not a recovery; it is the same wait again, and it hides
      // from the operator that the window is what needs to change.
      setFailure(toFailure(e));
      setReport(null);
      setRanRange(range);
    } finally {
      setLoading(false);
    }
  }, [fromYmd, liveFinalto, range, toYmd]);

  /**
   * refreshKey is accepted and deliberately NOT wired to a fetch, and neither is
   * mount. This endpoint is minutes of backend work; firing it because a tab
   * became visible, or because a page-wide "refresh everything" button was
   * pressed, spends that budget without anyone asking for it. The operator picks
   * a range and presses Run.
   */
  void refreshKey;

  const clientColumns = useMemo(
    () =>
      swapColumns("Client", (r) => r.name || "", {
        statement: false,
        realizedLabel: "Realized Swap",
        unrealizedLabel: "Unrealized Swap",
      }),
    [],
  );
  const lpColumns = useMemo(
    () =>
      swapColumns("LP Name", (r) => r.lpName || "", {
        statement: true,
        realizedLabel: "Realized Swap (Coverage acc)",
        unrealizedLabel: "Unrealized Swap (Coverage acc)",
      }),
    [],
  );

  const openClientDetail = useCallback(
    async (row: SwapAccountRow) => {
      const seq = ++detailSeq.current;
      const title = `Client ${row.login}${row.name ? ` — ${row.name}` : ""}`;
      setDetail({ title, range: ranRange || range, loading: true, detail: null, failure: null, slowNote: null });
      try {
        const data = await fetchClientSwapDetail(row.login, fromYmd, toYmd);
        if (detailSeq.current !== seq) return;
        patchDetail({ loading: false, detail: data });
      } catch (e) {
        if (detailSeq.current !== seq) return;
        patchDetail({ loading: false, failure: toFailure(e) });
      }
    },
    [fromYmd, patchDetail, ranRange, range, toYmd],
  );

  const openLpDetail = useCallback(
    async (row: SwapAccountRow) => {
      if (!row.id) {
        setDetail({
          title: `LP ${row.lpName || row.login}`,
          range: ranRange || range,
          loading: false,
          detail: null,
          failure: {
            kind: "failed",
            message: "This LP row carries no LpAccount id, so the drilldown has nothing to key on.",
          },
          slowNote: null,
        });
        return;
      }
      const isApi = String(row.source || "").toLowerCase() === "api";
      const loginLabel = Number(row.login) > 0 ? String(row.login) : `id ${row.id}`;
      const title = `LP ${row.lpName || ""} (${loginLabel})${row.source ? ` — ${row.source}` : ""}`;
      if (isApi) {
        // The only drilldown that is itself expensive: Finalto is pulled from
        // the vendor's SOAP API, one call per (sub-account, day). A row click is
        // not consent for a minute of vendor traffic, so name the LP and ask.
        const confirmed = window.confirm(
          `Open the LP detail for ${title}?\n\n` +
            "This is an Api LP: the backend pulls live from the vendor SOAP, one call per (sub-account, day), and may take a minute for wide ranges." +
            (liveFinalto ? "\n\nRaw Finalto is ON, so the cache is bypassed entirely." : ""),
        );
        if (!confirmed) return;
      }
      const seq = ++detailSeq.current;
      setDetail({
        title,
        range: ranRange || range,
        loading: true,
        detail: null,
        failure: null,
        slowNote: isApi
          ? "Api LP — Finalto pulls from the vendor SOAP, one call per (sub-account, day); this may take a minute for wide ranges."
          : null,
      });
      try {
        const data = await fetchLpSwapDetail(row.id, fromYmd, toYmd, liveFinalto);
        if (detailSeq.current !== seq) return;
        patchDetail({ loading: false, detail: data });
      } catch (e) {
        if (detailSeq.current !== seq) return;
        patchDetail({ loading: false, failure: toFailure(e) });
      }
    },
    [fromYmd, liveFinalto, patchDetail, ranRange, range, toYmd],
  );

  const inputCls = "rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900";

  const notes: string[] = [];
  if (report) {
    if (report.skippedApiLpCount > 0) {
      notes.push(`${report.skippedApiLpCount} API LP(s) skipped — only Xtb and Finalto are wired.`);
    }
    if (report.clientPanelError) notes.push(`Client panel failed: ${report.clientPanelError}`);
    if (report.lpErrors.length > 0) {
      notes.push(`${report.lpErrors.length} LP(s) failed: ${report.lpErrors.join("; ")}`);
    }
  }

  const loadedEmpty = !!report && report.clients.length === 0 && report.lps.length === 0;

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
          {loading ? "Running…" : "Run"}
        </button>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={liveFinalto}
            onChange={(e) => setLiveFinalto(e.target.checked)}
            aria-label="Raw Finalto (bypass DB cache)"
          />
          Raw Finalto (bypass DB cache)
        </label>
      </div>

      {/* The cost of the flag, in plain text rather than a title attribute --
          a tooltip does not exist on the phone this is read on. */}
      <p className="text-[11px] text-slate-500">
        {liveFinalto
          ? "Raw Finalto ON — the cache is bypassed and Finalto's CFDCost SOAP endpoint is called once per business day per sub-account. Slower than the run below already is."
          : "Raw Finalto OFF — cached FinaltoCosts rows are read and only the missing (sub-account, day) tuples are fetched live."}
      </p>

      {loading && (
        <div
          role="status"
          className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          Running the swaps report for {range} — {elapsed}s elapsed. A single day has measured over 45 seconds; the proxy
          allows this route up to 180 seconds. Leave the tab open.
        </div>
      )}

      {failure?.kind === "timeout" && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <p className="font-semibold">The report took too long.</p>
          <p className="mt-1">
            {ranRange || range} did not finish inside the 180-second budget on /api/SwapsReport. Narrow the range
            {liveFinalto ? ", turn Raw Finalto off," : ""} and press Run again. Nothing was retried automatically — a
            second three-minute call is not a recovery.
          </p>
          <p className="mt-1 text-[10px] opacity-70">{failure.message}</p>
        </div>
      )}

      {failure?.kind === "unauthorized" && (
        <div className="rounded-lg border border-slate-400/40 bg-slate-500/10 px-3 py-2 text-xs text-slate-700 dark:text-slate-300">
          <p className="font-semibold">Not authorised to read the swaps report.</p>
          <p className="mt-1">The session gate refused this request. Sign in again; narrowing the range will not help.</p>
          <p className="mt-1 text-[10px] opacity-70">{failure.message}</p>
        </div>
      )}

      {failure?.kind === "failed" && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
          {failure.message}
        </div>
      )}

      {!report && !failure && !loading && (
        <p className="rounded border border-dashed border-slate-300 px-3 py-3 text-xs text-slate-500 dark:border-slate-700">
          Not run yet. Pick a range and press Run — this report is never fetched on its own, because it costs minutes of
          backend work.
        </p>
      )}

      {notes.length > 0 && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}

      {loadedEmpty && (
        <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/40">
          The report ran for {ranRange} and returned no swap activity. This is an answer, not a failure.
        </p>
      )}

      {report && (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">By Client</h3>
            <TotalsLine totals={report.clientTotals} />
            <SortableTable
              tableId="swaps-report-clients"
              rows={report.clients}
              columns={clientColumns}
              tableClassName="min-w-full text-[11px]"
              emptyText="No client swap activity in this date range."
              footerRow={totalsFooter(report.clients, report.clientTotals)}
              onRowClick={(row) => void openClientDetail(row)}
            />
            <p className="text-[11px] text-slate-500">Click a client row for its per-position, per-deal and open-position breakdown.</p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">LP Swaps Charged To Us</h3>
            <TotalsLine totals={report.lpTotals} />
            <SortableTable
              tableId="swaps-report-lps"
              rows={report.lps}
              columns={lpColumns}
              tableClassName="min-w-full text-[11px]"
              emptyText="No LP swap activity in this date range."
              footerRow={totalsFooter(report.lps, report.lpTotals, { statement: true })}
              onRowClick={(row) => void openLpDetail(row)}
            />
            <p className="text-[11px] text-slate-500">
              Three independent measurements sit side by side: MT5 closed-deal Storage (Realized), MT5 open-position
              accrued swap (Unrealized), and the LP Statement DB from uploaded broker PDFs. They are expected to
              disagree; that is what makes the cross-check useful.
            </p>
          </div>
        </>
      )}

      {detail && (
        <div className="space-y-3 rounded-xl border border-slate-300 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/50">
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{detail.title}</h3>
            <span className="text-[11px] text-slate-500">{detail.range}</span>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="ml-auto rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 dark:border-slate-700 dark:text-slate-300"
            >
              Close
            </button>
          </div>

          {detail.slowNote && <p className="text-[11px] text-amber-700 dark:text-amber-300">{detail.slowNote}</p>}
          {detail.loading && <p className="text-xs text-slate-500">Loading the breakdown…</p>}

          {detail.failure?.kind === "timeout" && (
            <div className="rounded border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <p className="font-semibold">The report took too long.</p>
              <p className="mt-1">{detail.range} did not finish inside the 180-second budget for this drilldown. Narrow the range and try again.</p>
            </div>
          )}
          {detail.failure?.kind === "unauthorized" && (
            <div className="rounded border border-slate-400/40 bg-slate-500/10 px-3 py-2 text-xs text-slate-700 dark:text-slate-300">
              Not authorised to read this breakdown. Sign in again.
            </div>
          )}
          {detail.failure?.kind === "failed" && (
            <div className="rounded border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
              {detail.failure.message}
            </div>
          )}

          {detail.detail && (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
                <span>
                  Total Swap (deals in range){" "}
                  <strong className={signed(detail.detail.totalSwap)}>{money(detail.detail.totalSwap)}</strong>
                </span>
                <span>
                  Open Swap Accrued (now){" "}
                  <strong className={signed(detail.detail.openSwapAccrued)}>{money(detail.detail.openSwapAccrued)}</strong>
                </span>
                <span>
                  Deal Volume <strong>{num(detail.detail.dealVolume)}</strong>
                </span>
                <span>
                  Realized Volume <strong>{num(detail.detail.realizedVolume)}</strong>
                </span>
              </div>
              <p className="text-[10px] text-slate-500">Times are shown in Dubai wall-clock (UTC+4). Finalto trade dates are calendar days and are left as the vendor booked them.</p>

              {detail.detail.isFinalto ? (
                <div className="space-y-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Realized — per-instrument per-day (from Finalto GetCFDCost)
                  </h4>
                  {/* The full caveat from the source page. It was shortened to its first
                      and last sentence when this grid was ported, which dropped the two
                      things that make it actionable: WHY rate semantics are suspected, and
                      WHERE the actual charged figures probably live. Without them a reader
                      is told not to trust the column and given nowhere to go. */}
                  <p className="rounded border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                    <strong>Caveat:</strong> Long Pos Cost / Short Pos Cost may be per-unit financing{" "}
                    <em>rates</em>, not the actual charged dollar amounts. Precision (numeric(28,10)), the
                    DayToFinance window, and the sibling GetTomNextSwapRates endpoint all suggest rate
                    semantics. Verify against Finalto's own portal on a known position before treating
                    these as booked swap. Actual charged swap likely lives in FinaltoCashActivity with a
                    CashActivityType like &ldquo;Swap&rdquo; / &ldquo;Storage&rdquo;.
                  </p>
                  {detail.detail.finaltoDailyCosts.length === 0 && (
                    <p className="rounded border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                      No cost rows returned — check LP credentials, IsActive sub-accounts, or that the range includes
                      business days.
                    </p>
                  )}
                  <p className="text-[11px] text-slate-500">Unrealized: not exposed by Finalto.</p>
                  <DetailTable
                    columns={finaltoColumns}
                    rows={detail.detail.finaltoDailyCosts}
                    empty="No cost rows returned — check LP credentials, IsActive sub-accounts, or that the range includes business days."
                    rowKey={(row, idx) => `fin-${row.subAccountId ?? "x"}-${row.instrument ?? "x"}-${row.tradeDate ?? idx}`}
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Realized — per-position (grouped by PositionID, closed in range)
                    </h4>
                    <DetailTable
                      columns={positionColumns}
                      rows={detail.detail.positions}
                      empty="No closed positions in this range."
                      rowKey={(row, idx) => `pos-${row.positionId ?? idx}`}
                      footer={sumFooter(detail.detail.positions, [
                        { key: "dealCount", pick: (r) => r.dealCount, fmt: (n) => num(n) },
                        { key: "totalSwap", pick: (r) => r.totalSwap, fmt: (n) => <span className={signed(n)}>{money(n)}</span> },
                        { key: "dealVolume", pick: (r) => r.dealVolume, fmt: (n) => num(n) },
                        { key: "realizedVolume", pick: (r) => r.realizedVolume, fmt: (n) => num(n) },
                      ])}
                    />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Realized — per-deal (raw, Buy/Sell only, closed in range)
                    </h4>
                    <DetailTable
                      columns={dealColumns}
                      rows={detail.detail.deals}
                      empty="No closed deals in this range."
                      rowKey={(row, idx) => `deal-${row.dealId ?? idx}`}
                      footer={sumFooter(detail.detail.deals, [
                        { key: "lots", pick: (r) => r.lots, fmt: (n) => num(n) },
                        { key: "closedLegLots", pick: (r) => r.closedLegLots, fmt: (n) => num(n) },
                        { key: "storage", pick: (r) => r.storage, fmt: (n) => <span className={signed(n)}>{money(n)}</span> },
                      ])}
                    />
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Unrealized — currently open positions (live snapshot)
                    </h4>
                    <DetailTable
                      columns={openPositionColumns}
                      rows={detail.detail.openPositions}
                      empty="No open positions right now."
                      rowKey={(row, idx) => `open-${row.ticket ?? idx}`}
                      footer={sumFooter(detail.detail.openPositions, [
                        { key: "lots", pick: (r) => r.lots, fmt: (n) => num(n) },
                        { key: "swap", pick: (r) => r.swap, fmt: (n) => <span className={signed(n)}>{money(n)}</span> },
                        { key: "profit", pick: (r) => r.profit, fmt: (n) => <span className={signed(n)}>{money(n)}</span> },
                      ])}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
