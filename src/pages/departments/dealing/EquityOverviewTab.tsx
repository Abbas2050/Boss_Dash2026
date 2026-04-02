import { useEffect, useMemo, useState } from "react";
import { Camera, Maximize2, Minimize2 } from "lucide-react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import { type EquityAccount, type EquityDashboard, fetchEquityOverviewDashboard, fetchEquityOverviewNames } from "@/lib/equityOverviewApi";

type FullscreenTable = "client" | "lp" | null;
type SnapshotTable = "client" | "lp" | null;

type SnapshotInput = {
  filePrefix: string;
  title: string;
  headers: string[];
  rows: Array<Array<string | number>>;
};

const takeTableSnapshot = ({ filePrefix, title, headers, rows }: SnapshotInput) => {
  if (!rows.length) return;

  const normalizedRows = rows.map((row) => row.map((cell) => String(cell ?? "")));
  const colWidths = headers.map((header, idx) => {
    const maxCell = normalizedRows.reduce((max, row) => Math.max(max, (row[idx] || "").length), header.length);
    return Math.max(96, Math.min(260, maxCell * 8 + 24));
  });

  const tableWidth = colWidths.reduce((sum, width) => sum + width, 0);
  const headerHeight = 30;
  const rowHeight = 22;
  const titleHeight = 46;
  const imageWidth = Math.max(920, tableWidth + 24);
  const imageHeight = Math.max(320, titleHeight + headerHeight + normalizedRows.length * rowHeight + 14);

  const canvas = document.createElement("canvas");
  canvas.width = imageWidth;
  canvas.height = imageHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, imageWidth, imageHeight);

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "600 16px Inter, Arial, sans-serif";
  ctx.fillText(title, 12, 22);
  ctx.font = "12px Inter, Arial, sans-serif";
  ctx.fillStyle = "#94a3b8";
  ctx.fillText(`Rows: ${normalizedRows.length}  Captured: ${new Date().toLocaleString()}`, 12, 40);

  const tableX = 12;
  const tableY = titleHeight;
  let x = tableX;

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(tableX, tableY, tableWidth, headerHeight);
  ctx.strokeStyle = "#1e293b";
  ctx.strokeRect(tableX, tableY, tableWidth, headerHeight);

  ctx.font = "600 12px Inter, Arial, sans-serif";
  ctx.fillStyle = "#e2e8f0";
  headers.forEach((header, idx) => {
    ctx.fillText(header, x + 8, tableY + 19);
    x += colWidths[idx];
  });

  ctx.font = "11px Inter, Arial, sans-serif";
  normalizedRows.forEach((row, rowIdx) => {
    const y = tableY + headerHeight + rowIdx * rowHeight;
    ctx.fillStyle = rowIdx % 2 === 0 ? "#0b1220" : "#0f172a";
    ctx.fillRect(tableX, y, tableWidth, rowHeight);
    ctx.strokeStyle = "#1e293b";
    ctx.strokeRect(tableX, y, tableWidth, rowHeight);

    let colX = tableX;
    row.forEach((cell, colIdx) => {
      ctx.fillStyle = "#cbd5e1";
      const text = cell.length > 38 ? `${cell.slice(0, 35)}...` : cell;
      ctx.fillText(text, colX + 8, y + 15);
      colX += colWidths[colIdx] || 120;
    });
  });

  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  a.href = canvas.toDataURL("image/png");
  a.download = `${filePrefix}-${stamp}.png`;
  a.click();
};

export function EquityOverviewTab({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<EquityDashboard | null>(null);
  const [clientItems, setClientItems] = useState<EquityAccount[]>([]);
  const [lpItems, setLpItems] = useState<EquityAccount[]>([]);
  const [namesByLogin, setNamesByLogin] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);

  const [clientExpanded, setClientExpanded] = useState(false);
  const [lpExpanded, setLpExpanded] = useState(false);
  const [clientSourceFilter, setClientSourceFilter] = useState("");
  const [lpSourceFilter, setLpSourceFilter] = useState("");
  const [fullscreenTable, setFullscreenTable] = useState<FullscreenTable>(null);
  const [snapshottingTable, setSnapshottingTable] = useState<SnapshotTable>(null);

  useEffect(() => {
    if (!fullscreenTable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreenTable(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fullscreenTable]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const json = await fetchEquityOverviewDashboard({ includeDetails: false });
        if (cancelled) return;
        setData(json);
        setLastUpdated(new Date());
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load equity overview.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const iv = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [refreshKey]);

  const loadDetails = async () => {
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const [dashResp, namesResp] = await Promise.all([
        fetchEquityOverviewDashboard({ includeDetails: true }),
        fetchEquityOverviewNames().catch(() => ({} as Record<string, string>)),
      ]);
      setClientItems(Array.isArray(dashResp?.clients?.items) ? dashResp.clients.items : []);
      setLpItems(Array.isArray(dashResp?.lps?.items) ? dashResp.lps.items : []);
      setNamesByLogin(namesResp || {});
      setDetailsLoaded(true);
    } catch (e: any) {
      setDetailsError(e?.message || "Failed to load client/LP details.");
    } finally {
      setDetailsLoading(false);
    }
  };

  const formatMoney = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const colorClass = (v: number) => (v > 0 ? "text-emerald-700 dark:text-emerald-300" : v < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500");

  const filterItems = (items: EquityAccount[], source: string) => items.filter((item) => !source || String(item.source || "") === source);

  const clientRows = useMemo(() => filterItems(clientItems || [], clientSourceFilter), [clientItems, clientSourceFilter]);
  const lpRows = useMemo(() => filterItems(lpItems || [], lpSourceFilter), [lpItems, lpSourceFilter]);

  const baseColumns = useMemo<SortableTableColumn<EquityAccount>[]>(
    () => [
      {
        key: "name",
        label: "Name",
        sortValue: (row) => String(row.name || namesByLogin[String(row.login || "")] || ""),
        searchValue: (row) => `${row.name || ""} ${namesByLogin[String(row.login || "")] || ""} ${row.login || ""}`,
        render: (row) => row.name || namesByLogin[String(row.login || "")] || "-",
      },
      { key: "login", label: "Login", sortValue: (row) => String(row.login || ""), render: (row) => <span className="font-mono">{String(row.login || "-")}</span> },
      { key: "source", label: "Source", sortValue: (row) => String(row.source || ""), render: (row) => row.source || "-" },
      { key: "equity", label: "Equity", sortValue: (row) => Number(row.equity) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatMoney(Number(row.equity || 0)) },
      { key: "withdrawableEquity", label: "WD Equity", sortValue: (row) => Number(row.withdrawableEquity) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatMoney(Number(row.withdrawableEquity || 0)) },
      { key: "credit", label: "Credit", sortValue: (row) => Number(row.credit) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatMoney(Number(row.credit || 0)) },
      { key: "balance", label: "Balance", sortValue: (row) => Number(row.balance) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatMoney(Number(row.balance || 0)) },
      { key: "margin", label: "Margin", sortValue: (row) => Number(row.margin) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatMoney(Number(row.margin || 0)) },
      { key: "freeMargin", label: "Free Margin", sortValue: (row) => Number(row.freeMargin) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatMoney(Number(row.freeMargin || 0)) },
      {
        key: "marginLevel",
        label: "Margin Level",
        sortValue: (row) => Number(row.marginLevel) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => {
          const marginLevel = Number(row.marginLevel) || 0;
          return <span className={marginLevel >= 100 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>{marginLevel.toFixed(2)}%</span>;
        },
      },
    ],
    [namesByLogin],
  );

  const runSnapshot = (table: SnapshotTable, rows: EquityAccount[], title: string, filePrefix: string) => {
    if (!rows.length) return;
    setSnapshottingTable(table);
    try {
      const headers = ["Name", "Login", "Source", "Equity", "WD Equity", "Credit", "Balance", "Margin", "Free Margin", "Margin Level"];
      const snapshotRows = rows.map((row) => {
        const login = String(row.login || "");
        const marginLevel = Number(row.marginLevel) || 0;
        return [
          row.name || namesByLogin[login] || "-",
          login,
          String(row.source || "-"),
          formatMoney(Number(row.equity || 0)),
          formatMoney(Number(row.withdrawableEquity || 0)),
          formatMoney(Number(row.credit || 0)),
          formatMoney(Number(row.balance || 0)),
          formatMoney(Number(row.margin || 0)),
          formatMoney(Number(row.freeMargin || 0)),
          `${marginLevel.toFixed(2)}%`,
        ];
      });
      takeTableSnapshot({ filePrefix, title, headers, rows: snapshotRows });
    } finally {
      setSnapshottingTable(null);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Equity Overview</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : "-"}</span>
          <button
            type="button"
            onClick={loadDetails}
            disabled={detailsLoading}
            className="rounded-md border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-500/20 disabled:opacity-60 dark:text-cyan-200"
          >
            {detailsLoaded ? (detailsLoading ? "Refreshing Details..." : "Refresh Details") : detailsLoading ? "Loading Details..." : "Load Client & LP Details"}
          </button>
        </div>
      </div>

      {error && <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}

      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Client Withdrawable Equity</div>
          <div className="flex items-center justify-between py-1 text-sm"><span>Live Clients</span><span className={colorClass(Number(data?.clients?.liveWithdrawableEquity || 0))}>{formatMoney(Number(data?.clients?.liveWithdrawableEquity || 0))}</span></div>
          <div className="flex items-center justify-between py-1 text-sm"><span>Bonus Clients</span><span className={colorClass(Number(data?.clients?.bonusWithdrawableEquity || 0))}>{formatMoney(Number(data?.clients?.bonusWithdrawableEquity || 0))}</span></div>
          <div className="mt-2 flex items-center justify-between border-t border-slate-300 pt-2 text-sm font-semibold dark:border-slate-700"><span>Net Client WD Equity</span><span className={colorClass(Number(data?.clients?.netWithdrawableEquity || 0))}>{formatMoney(Number(data?.clients?.netWithdrawableEquity || 0))}</span></div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">LP Withdrawable Equity</div>
          <div className="flex items-center justify-between py-1 text-sm"><span>Live LPs</span><span className={colorClass(Number(data?.lps?.liveWithdrawableEquity || 0))}>{formatMoney(Number(data?.lps?.liveWithdrawableEquity || 0))}</span></div>
          <div className="flex items-center justify-between py-1 text-sm"><span>Bonus LP (XTB)</span><span className={colorClass(Number(data?.lps?.bonusWithdrawableEquity || 0))}>{formatMoney(Number(data?.lps?.bonusWithdrawableEquity || 0))}</span></div>
          <div className="mt-2 flex items-center justify-between border-t border-slate-300 pt-2 text-sm font-semibold dark:border-slate-700"><span>Net LP WD Equity</span><span className={colorClass(Number(data?.lps?.netWithdrawableEquity || 0))}>{formatMoney(Number(data?.lps?.netWithdrawableEquity || 0))}</span></div>
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center dark:border-slate-800 dark:bg-slate-900/50">
        <div className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">Net LP - Net Client Withdrawable Equity</div>
        <div className={`mt-1 text-xl font-semibold ${colorClass(Number(data?.netDifference || 0))}`}>{formatMoney(Number(data?.netDifference || 0))}</div>
      </div>

      {detailsError && <div className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{detailsError}</div>}

      {!detailsLoaded ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-300">
          Client Details and LP Details are not loaded by default for faster page load. Click "Load Client & LP Details" when needed.
        </div>
      ) : (
        <div className="space-y-3">
          <div className={`rounded-lg border border-slate-200 dark:border-slate-800 ${fullscreenTable === "client" ? "fixed inset-3 z-50 flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-950" : ""}`}>
            <button type="button" onClick={() => setClientExpanded((v) => !v)} className="flex w-full items-center justify-between bg-slate-50 px-3 py-2 text-left text-sm font-semibold dark:bg-slate-900/50">
              <span>Client Details ({clientItems.length})</span>
              <span>{clientExpanded ? "-" : "+"}</span>
            </button>
            {clientExpanded && (
              <div className="p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <select value={clientSourceFilter} onChange={(e) => setClientSourceFilter(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/70">
                    <option value="">All Sources</option>
                    <option value="Live">Live</option>
                    <option value="Bonus">Bonus</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => runSnapshot("client", clientRows, "Equity Snapshot - Client Details", "equity-client-snapshot")}
                    disabled={snapshottingTable === "client" || !clientRows.length}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Camera className={`h-3.5 w-3.5 ${snapshottingTable === "client" ? "animate-pulse" : ""}`} />
                    {snapshottingTable === "client" ? "Capturing..." : "Snapshot"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFullscreenTable((v) => (v === "client" ? null : "client"))}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
                  >
                    {fullscreenTable === "client" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    {fullscreenTable === "client" ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                </div>
                <div className={`${fullscreenTable === "client" ? "min-h-0 flex-1 overflow-auto" : ""}`}>
                  <SortableTable
                    tableId="dealing-equity-client-table"
                    enableColumnVisibility
                    rows={clientRows}
                    columns={baseColumns}
                    exportFilePrefix="equity-client-details"
                    tableClassName="min-w-[1160px] text-xs"
                    emptyText="No client detail rows for selected source."
                  />
                </div>
              </div>
            )}
          </div>

          <div className={`rounded-lg border border-slate-200 dark:border-slate-800 ${fullscreenTable === "lp" ? "fixed inset-3 z-50 flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-950" : ""}`}>
            <button type="button" onClick={() => setLpExpanded((v) => !v)} className="flex w-full items-center justify-between bg-slate-50 px-3 py-2 text-left text-sm font-semibold dark:bg-slate-900/50">
              <span>LP Details ({lpItems.length})</span>
              <span>{lpExpanded ? "-" : "+"}</span>
            </button>
            {lpExpanded && (
              <div className="p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <select value={lpSourceFilter} onChange={(e) => setLpSourceFilter(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/70">
                    <option value="">All Sources</option>
                    <option value="Live">Live</option>
                    <option value="Bonus">Bonus</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => runSnapshot("lp", lpRows, "Equity Snapshot - LP Details", "equity-lp-snapshot")}
                    disabled={snapshottingTable === "lp" || !lpRows.length}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Camera className={`h-3.5 w-3.5 ${snapshottingTable === "lp" ? "animate-pulse" : ""}`} />
                    {snapshottingTable === "lp" ? "Capturing..." : "Snapshot"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFullscreenTable((v) => (v === "lp" ? null : "lp"))}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
                  >
                    {fullscreenTable === "lp" ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                    {fullscreenTable === "lp" ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                </div>
                <div className={`${fullscreenTable === "lp" ? "min-h-0 flex-1 overflow-auto" : ""}`}>
                  <SortableTable
                    tableId="dealing-equity-lp-table"
                    enableColumnVisibility
                    rows={lpRows}
                    columns={baseColumns}
                    exportFilePrefix="equity-lp-details"
                    tableClassName="min-w-[1160px] text-xs"
                    emptyText="No LP detail rows for selected source."
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {loading && <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">Loading equity overview...</div>}
    </section>
  );
}
