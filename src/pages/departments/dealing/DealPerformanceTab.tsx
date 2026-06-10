import { useEffect, useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import {
  CRM_API_TOKEN,
  CRM_API_VERSION,
  deriveBaseRows,
  fetchCrmUserIdByLogin,
  fetchDealMatch,
  fetchIbPeriodTransactions,
  isIb,
  mapWithConcurrency,
  money,
  num,
  toYmd,
  type DealMatchRevenueRow,
} from "@/lib/dealMatchApi";

const colors = {
  blue: "#1d4ed8",
  teal: "#0f766e",
  green: "#15803d",
  gold: "#b45309",
  red: "#be123c",
  slate: "#475569",
  cyan: "#0891b2",
};

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
    return Math.max(88, Math.min(220, maxCell * 7 + 20));
  });
  const tableWidth = colWidths.reduce((sum, w) => sum + w, 0);
  const headerHeight = 28;
  const rowHeight = 21;
  const titleHeight = 44;
  const canvasWidth = Math.max(980, tableWidth + 24);
  const canvasHeight = Math.max(320, titleHeight + headerHeight + normalizedRows.length * rowHeight + 16);

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "600 15px Inter, Arial, sans-serif";
  ctx.fillText(title, 12, 22);
  ctx.font = "11px Inter, Arial, sans-serif";
  ctx.fillStyle = "#94a3b8";
  ctx.fillText(`Rows: ${normalizedRows.length} | ${new Date().toLocaleString()}`, 12, 38);

  const tableX = 12;
  const tableY = titleHeight;
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(tableX, tableY, tableWidth, headerHeight);
  ctx.strokeStyle = "#1e293b";
  ctx.strokeRect(tableX, tableY, tableWidth, headerHeight);

  ctx.font = "600 11px Inter, Arial, sans-serif";
  ctx.fillStyle = "#e2e8f0";
  let x = tableX;
  headers.forEach((h, idx) => {
    ctx.fillText(h, x + 7, tableY + 18);
    x += colWidths[idx];
  });

  ctx.font = "11px Inter, Arial, sans-serif";
  normalizedRows.forEach((row, rIdx) => {
    const y = tableY + headerHeight + rIdx * rowHeight;
    ctx.fillStyle = rIdx % 2 === 0 ? "#0b1220" : "#0f172a";
    ctx.fillRect(tableX, y, tableWidth, rowHeight);
    ctx.strokeStyle = "#1e293b";
    ctx.strokeRect(tableX, y, tableWidth, rowHeight);
    let colX = tableX;
    row.forEach((cell, cIdx) => {
      ctx.fillStyle = "#cbd5e1";
      const text = cell.length > 34 ? `${cell.slice(0, 31)}...` : cell;
      ctx.fillText(text, colX + 7, y + 15);
      colX += colWidths[cIdx];
    });
  });

  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  a.href = canvas.toDataURL("image/png");
  a.download = `${filePrefix}-${stamp}.png`;
  a.click();
};

async function fetchIbWalletBalance(crmId: number): Promise<number> {
  const resp = await fetch(`/rest/accounts?version=${encodeURIComponent(CRM_API_VERSION)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({ userId: crmId, segment: { limit: 500, offset: 0 } }),
  });
  if (!resp.ok) return 0;
  const rows = (await resp.json()) as Array<{ groupName?: string; balance?: number }>;
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => String(r.groupName || "").toUpperCase() === "IB-WALLET-USD")
    .reduce((sum, r) => sum + num(r.balance), 0);
}

export function DealPerformanceTab({
  baseUrl,
  fromDate,
  toDate,
  refreshKey,
  onLoadingChange,
  onStatusChange,
}: {
  baseUrl: string;
  fromDate: Date;
  toDate: Date;
  refreshKey: number;
  onLoadingChange?: (loading: boolean) => void;
  onStatusChange?: (text: string) => void;
}) {
  const fromDateYmd = useMemo(() => toYmd(fromDate), [fromDate]);
  const toDateYmd = useMemo(() => toYmd(toDate), [toDate]);
  const [rows, setRows] = useState<DealMatchRevenueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ from?: string; to?: string; loadedAt?: string }>({});
  const [snapshotting, setSnapshotting] = useState(false);

  const run = async () => {
    if (!fromDateYmd || !toDateYmd) return;
    setLoading(true);
    setError(null);
    try {
      const report = await fetchDealMatch(baseUrl, fromDateYmd, toDateYmd);
      const baseRows = deriveBaseRows(report).filter((r) => r.lots > 0);
      const ibCache = new Map<string, number>();
      const enriched = await mapWithConcurrency(
        baseRows,
        async (row) => {
          if (!row.login) return row;
          if (ibCache.has(row.login)) {
            const ibCommission = ibCache.get(row.login) || 0;
            return { ...row, ibCommission, netRevenue: (row.markup + row.clientComm) - (row.lpComm + ibCommission) };
          }
          const crmId = await fetchCrmUserIdByLogin(row.login);
          if (!crmId) return row;
          const ib = await isIb(crmId);
          if (!ib) return row;
          const [wallet, tx] = await Promise.all([fetchIbWalletBalance(crmId), fetchIbPeriodTransactions(crmId, fromDateYmd, toDateYmd)]);
          const ibCommission = wallet + tx;
          ibCache.set(row.login, ibCommission);
          return { ...row, ibCommission, netRevenue: (row.markup + row.clientComm) - (row.lpComm + ibCommission) };
        },
        6,
      );
      const sorted = enriched.sort((a, b) => b.netRevenue - a.netRevenue);
      setRows(sorted);
      setMeta({ from: fromDateYmd, to: toDateYmd, loadedAt: new Date().toLocaleString() });
    } catch (e: any) {
      setError(e?.message || "Failed to load performance data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, fromDateYmd, toDateYmd]);

  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  useEffect(() => {
    const text =
      meta.from && meta.to && meta.loadedAt
        ? `Range ${meta.from} to ${meta.to} | Updated ${meta.loadedAt}`
        : "";
    onStatusChange?.(text);
  }, [meta.from, meta.to, meta.loadedAt, onStatusChange]);

  const topNet = useMemo(() => rows.slice(0, 10), [rows]);
  const topTotal = useMemo(() => [...rows].sort((a, b) => b.totalRev - a.totalRev).slice(0, 10), [rows]);
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.lots += r.lots;
          acc.totalRev += r.totalRev;
          acc.net += r.netRevenue;
          acc.ib += r.ibCommission;
          acc.lp += r.lpComm;
          return acc;
        },
        { lots: 0, totalRev: 0, net: 0, ib: 0, lp: 0 },
      ),
    [rows],
  );

  const breakdownData = useMemo(
    () => [
      { name: "Markup", value: rows.reduce((s, r) => s + r.markup, 0), color: colors.cyan },
      { name: "Client Comm", value: rows.reduce((s, r) => s + r.clientComm, 0), color: colors.teal },
      { name: "LP Comm", value: rows.reduce((s, r) => s + r.lpComm, 0), color: colors.gold },
      { name: "IB Commission", value: rows.reduce((s, r) => s + r.ibCommission, 0), color: colors.red },
      { name: "Net Revenue", value: rows.reduce((s, r) => s + r.netRevenue, 0), color: colors.green },
    ],
    [rows],
  );

  const lotsVsNetByClient = useMemo(() => {
    return [...rows]
      .sort((a, b) => b.lots - a.lots)
      .slice(0, 12)
      .map((r) => ({
        login: r.login,
        name: r.name,
        lots: r.lots,
        netRevenue: r.netRevenue,
        revPerLot: r.lots > 0 ? r.netRevenue / r.lots : 0,
      }));
  }, [rows]);

  const columns = useMemo<SortableTableColumn<DealMatchRevenueRow>[]>(
    () => [
      { key: "login", label: "Login", sortValue: (r) => r.login, render: (r) => <span className="font-mono">{r.login}</span> },
      { key: "name", label: "Name", sortValue: (r) => r.name, searchValue: (r) => `${r.name} ${r.login}`, render: (r) => r.name || "-" },
      { key: "lots", label: "Lots", sortValue: (r) => r.lots, headerClassName: "text-right", cellClassName: "text-right", render: (r) => r.lots.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
      { key: "markup", label: "Markup", sortValue: (r) => r.markup, headerClassName: "text-right", cellClassName: "text-right", render: (r) => money(r.markup) },
      { key: "clientComm", label: "Client Comm", sortValue: (r) => r.clientComm, headerClassName: "text-right", cellClassName: "text-right", render: (r) => money(r.clientComm) },
      { key: "lpComm", label: "LP Comm", sortValue: (r) => r.lpComm, headerClassName: "text-right", cellClassName: "text-right", render: (r) => <span className="text-amber-700 dark:text-amber-300">{money(r.lpComm)}</span> },
      { key: "totalRev", label: "Total Rev", sortValue: (r) => r.totalRev, headerClassName: "text-right", cellClassName: "text-right", render: (r) => money(r.totalRev) },
      { key: "ibCommission", label: "IB Commission", sortValue: (r) => r.ibCommission, headerClassName: "text-right", cellClassName: "text-right", render: (r) => <span className="text-rose-700 dark:text-rose-300">{money(r.ibCommission)}</span> },
      {
        key: "netRevenue",
        label: "Net Revenue",
        sortValue: (r) => r.netRevenue,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (r) => <span className={r.netRevenue >= 0 ? "font-semibold text-emerald-700 dark:text-emerald-300" : "font-semibold text-rose-700 dark:text-rose-300"}>{money(r.netRevenue)}</span>,
      },
    ],
    [],
  );

  const handleSnapshot = () => {
    if (!rows.length) return;
    setSnapshotting(true);
    try {
      const headers = ["Login", "Name", "Lots", "Markup", "Client Comm", "LP Comm", "Total Rev", "IB Commission", "Net Revenue"];
      const snapshotRows = rows.map((r) => [
        r.login,
        r.name || "-",
        r.lots.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        money(r.markup),
        money(r.clientComm),
        money(r.lpComm),
        money(r.totalRev),
        money(r.ibCommission),
        money(r.netRevenue),
      ]);
      takeTableSnapshot({
        filePrefix: "deal-performance-table",
        title: "Deal Performance Snapshot",
        headers,
        rows: snapshotRows,
      });
    } finally {
      setSnapshotting(false);
    }
  };

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-slate-950/70">
      {error && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {[
          { label: "Clients", value: rows.length.toLocaleString(), tone: "text-slate-900 dark:text-slate-100" },
          { label: "Total Lots", value: totals.lots.toLocaleString(undefined, { maximumFractionDigits: 2 }), tone: "text-cyan-700 dark:text-cyan-300" },
          { label: "Total Revenue", value: money(totals.totalRev), tone: "text-blue-700 dark:text-blue-300" },
          { label: "Net Revenue", value: money(totals.net), tone: totals.net >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300" },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/40">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{kpi.label}</div>
            <div className={`mt-1 text-xl font-semibold ${kpi.tone}`}>{kpi.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">Top 10 Net Revenue</div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topNet} layout="vertical" margin={{ left: 8, right: 20, top: 10, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                <YAxis type="category" dataKey="login" width={70} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value: number) => money(num(value))} />
                <Bar dataKey="netRevenue" radius={[0, 6, 6, 0]} isAnimationActive animationDuration={900}>
                  {topNet.map((row, idx) => (
                    <Cell key={row.login} fill={idx < 3 ? colors.gold : row.netRevenue >= 0 ? colors.teal : colors.red} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">Gross vs Net (Top Total Rev)</div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topTotal} margin={{ left: 8, right: 20, top: 10, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="login" angle={-30} textAnchor="end" interval={0} height={50} tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(value: number) => money(num(value))} />
                <Legend />
                <Bar dataKey="totalRev" name="Total Rev" fill={colors.blue} radius={[6, 6, 0, 0]} isAnimationActive animationDuration={900} />
                <Bar dataKey="netRevenue" name="Net Rev" fill={colors.green} radius={[6, 6, 0, 0]} isAnimationActive animationDuration={1200} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
            Lots vs Net Revenue by Client (Top Volume)
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={lotsVsNetByClient} margin={{ left: 8, right: 20, top: 10, bottom: 28 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="login" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" interval={0} height={48} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                <Tooltip
                  formatter={(value: number, name: string) => {
                    if (name === "Net Revenue") return money(num(value));
                    if (name === "Rev/Lot") return money(num(value));
                    return num(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
                  }}
                />
                <Legend />
                <Bar
                  yAxisId="left"
                  dataKey="lots"
                  name="Lots"
                  fill={colors.cyan}
                  fillOpacity={0.65}
                  radius={[4, 4, 0, 0]}
                  isAnimationActive
                  animationDuration={900}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="netRevenue"
                  name="Net Revenue"
                  stroke={colors.green}
                  strokeWidth={2.4}
                  dot={{ r: 3 }}
                  isAnimationActive
                  animationDuration={1100}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="revPerLot"
                  name="Rev/Lot"
                  stroke={colors.gold}
                  strokeWidth={1.8}
                  strokeDasharray="4 4"
                  dot={false}
                  isAnimationActive
                  animationDuration={1200}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">Revenue Composition</div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={breakdownData} dataKey="value" nameKey="name" innerRadius={65} outerRadius={112} paddingAngle={2} isAnimationActive animationDuration={1100}>
                  {breakdownData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Legend />
                <Tooltip formatter={(value: number) => money(num(value))} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
          <TrendingUp className="h-3.5 w-3.5" />
          Email Revenue Table (Interactive)
        </div>
        <div className="mb-2 flex items-center justify-end">
          <button
            type="button"
            onClick={handleSnapshot}
            disabled={snapshotting || !rows.length}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {snapshotting ? "Capturing..." : "Snapshot"}
          </button>
        </div>
        <SortableTable
          tableId="dealing-performance-email-table"
          enableColumnVisibility
          rows={rows}
          columns={columns}
          tableClassName="min-w-full table-fixed text-[11px]"
          exportFilePrefix="deal-performance-email-table"
          emptyText={loading ? "Loading rows..." : "No rows found for selected range."}
          rowClassName={(row) => (row.netRevenue >= 0 ? "bg-slate-50 dark:bg-slate-950/30" : "bg-rose-50/40 dark:bg-rose-950/10")}
        />
      </div>
    </section>
  );
}
