import { useEffect, useMemo, useState } from "react";
import { RefreshCw, TrendingUp } from "lucide-react";
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
import { enumerateMonths, type ReportData } from "./dealPerformanceReport";
import { generatePerformancePdf } from "./performancePdf";

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

/**
 * One row per CRM client rather than per MT5 account. A client commonly holds
 * several trading accounts, and grouping per login charged their whole rebate
 * once per account. Mirrors groupRowsByClient() in reports/dealMatchWeeklyReport.js
 * so this tab and the weekly email report the same Net Revenue for a period.
 */
type ClientRevenueRow = {
  clientKey: string;
  crmId: number | null;
  name: string;
  accounts: string[];
  lots: number;
  markup: number;
  clientComm: number;
  lpComm: number;
  /** Notional in millions USD, summed across the client's accounts. */
  millionsUsd: number;
  totalRev: number;
  /** Rebate Withdrawn — IB transactions settled inside the period, never the wallet balance. */
  ibCommission: number;
  netRevenue: number;
};

/** Chart-friendly view of a client row: recharts needs a single string field to label an axis. */
type ChartClientRow = ClientRevenueRow & { label: string };

const clientLabel = (row: ClientRevenueRow) => row.name || row.accounts[0] || "-";

/**
 * Folds per-login rows into one row per CRM client. Pure: the login → CRM user
 * map is resolved by the caller and passed in.
 */
function groupRowsByClient(rows: DealMatchRevenueRow[], crmIdByLogin: Map<string, number | null>): ClientRevenueRow[] {
  const byClient = new Map<string, ClientRevenueRow & { nameLots: number }>();

  rows.forEach((row, index) => {
    const login = String(row.login || "").trim();
    let clientKey: string;
    let crmId: number | null = null;
    if (login) {
      const resolved = crmIdByLogin.get(login);
      crmId = Number.isFinite(resolved) && (resolved as number) > 0 ? (resolved as number) : null;
      // An unresolved login cannot be merged into a client without inventing a
      // relationship the CRM does not assert, so it stands alone under its own key.
      clientKey = crmId === null ? `login:${login}` : `user:${crmId}`;
    } else {
      // Blank logins are unrelated accounts that merely share an absent login;
      // keying them all the same would fabricate one combined row.
      clientKey = `login:#${index}`;
    }

    let client = byClient.get(clientKey);
    if (!client) {
      client = {
        clientKey,
        crmId,
        name: "",
        accounts: [],
        lots: 0,
        markup: 0,
        clientComm: 0,
        lpComm: 0,
        millionsUsd: 0,
        totalRev: 0,
        ibCommission: 0,
        netRevenue: 0,
        nameLots: -1,
      };
      byClient.set(clientKey, client);
    }

    if (login) client.accounts.push(login);
    client.lots += num(row.lots);
    client.markup += num(row.markup);
    client.clientComm += num(row.clientComm);
    client.lpComm += num(row.lpComm);
    client.millionsUsd += num(row.millionsUsd);
    client.totalRev += num(row.totalRev);

    // Name comes from the largest account, so the choice is deterministic instead
    // of depending on the order the API happened to return.
    const name = String(row.name || "").trim();
    if (name && name !== "-" && num(row.lots) > client.nameLots) {
      client.name = name;
      client.nameLots = num(row.lots);
    }
  });

  return [...byClient.values()].map(({ nameLots: _nameLots, ...client }) => ({
    ...client,
    accounts: [...client.accounts].sort(),
    netRevenue: client.totalRev,
  }));
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
  const [rows, setRows] = useState<ClientRevenueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ from?: string; to?: string; loadedAt?: string }>({});
  const [monthlyRows, setMonthlyRows] = useState<
    { key: string; label: string; totalRev: number; netRevenue: number; lots: number; ibComm: number; lpComm: number }[]
  >([]);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [snapshotting, setSnapshotting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");

  const run = async () => {
    if (!fromDateYmd || !toDateYmd) return;
    setLoading(true);
    setError(null);
    setWarning(null);
    setProgress(0);
    setProgressLabel("Preparing…");
    try {
      // The upstream DealMatch/Run API returns 500 for very large date ranges, so we split
      // the range into calendar months, fetch each separately, and aggregate per client.
      const months = enumerateMonths(fromDate, toDate);
      if (!months.length) {
        setRows([]);
        setMonthlyRows([]);
        setMeta({ from: fromDateYmd, to: toDateYmd, loadedAt: new Date().toLocaleString() });
        return;
      }

      const warnings: string[] = [];
      const byLogin = new Map<string, DealMatchRevenueRow>();
      const monthTotalRev = new Map<string, number>();
      const monthLots = new Map<string, number>();
      const monthLpComm = new Map<string, number>();
      let fetched = 0;
      await mapWithConcurrency(
        months,
        async (mb) => {
          try {
            const report = await fetchDealMatch(baseUrl, mb.startYmd, mb.endYmd);
            const monthRows = deriveBaseRows(report).filter((r) => r.lots > 0);
            monthTotalRev.set(mb.key, monthRows.reduce((s, r) => s + r.totalRev, 0));
            monthLots.set(mb.key, monthRows.reduce((s, r) => s + r.lots, 0));
            monthLpComm.set(mb.key, monthRows.reduce((s, r) => s + r.lpComm, 0));
            monthRows.forEach((r) => {
                const cur =
                  byLogin.get(r.login) ||
                  { login: r.login, name: r.name, lots: 0, markup: 0, clientComm: 0, lpComm: 0, millionsUsd: 0, totalRev: 0, ibCommission: 0, netRevenue: 0 };
                if ((!cur.name || cur.name === "-") && r.name) cur.name = r.name;
                cur.lots += r.lots;
                cur.markup += r.markup;
                cur.clientComm += r.clientComm;
                cur.lpComm += r.lpComm;
                cur.millionsUsd += r.millionsUsd;
                cur.totalRev = cur.markup + cur.clientComm - cur.lpComm;
                cur.netRevenue = cur.totalRev; // default for non-IB clients; overridden below if IB
                byLogin.set(r.login, cur);
              });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (e: any) {
            warnings.push(`${mb.label}: ${e?.message || "failed"}`);
          } finally {
            fetched++;
            setProgress(Math.round((fetched / months.length) * 40));
            setProgressLabel(`Loading deals ${fetched}/${months.length} months`);
            onStatusChange?.(`Loading deals ${fetched}/${months.length} months…`);
          }
        },
        4,
      );

      const baseRows = Array.from(byLogin.values());

      // Resolve every MT5 login to its CRM client first, so the per-account rows can
      // be folded into one row per client before anything is charged to them.
      const logins = [...new Set(baseRows.map((r) => String(r.login || "").trim()).filter(Boolean))];
      setProgressLabel(`Resolving clients 0/${logins.length}`);
      const crmIdByLogin = new Map<string, number | null>();
      let identified = 0;
      await mapWithConcurrency(
        logins,
        async (login) => {
          try {
            crmIdByLogin.set(login, await fetchCrmUserIdByLogin(login));
          } catch {
            crmIdByLogin.set(login, null);
          } finally {
            identified++;
            setProgress(Math.min(70, 40 + Math.round((identified / Math.max(1, logins.length)) * 30)));
            setProgressLabel(`Resolving clients ${identified}/${logins.length}`);
          }
        },
        6,
      );

      const clientRows = groupRowsByClient(baseRows, crmIdByLogin);
      setProgressLabel(`Resolving rebates 0/${clientRows.length}`);

      // Rebate Withdrawn counts ONLY the IB transactions settled inside the period.
      // The IB wallet balance is deliberately excluded: it is accumulated, still
      // unpaid commission read at the instant the page loads, so it is not a cost of
      // the period, and including it made the same closed period produce a different
      // Net Revenue on every reload. Matches reports/dealMatchWeeklyReport.js.
      // Cached by crmId — never by login — so a client with several accounts is
      // charged once, not once per account.
      const ibCache = new Map<number, number>();
      const ibByMonth = new Map<string, number>();
      let resolved = 0;
      const enriched = await mapWithConcurrency(
        clientRows,
        async (row) => {
          try {
            const crmId = row.crmId;
            if (!crmId) return row;
            const cached = ibCache.get(crmId);
            if (cached !== undefined) {
              return { ...row, ibCommission: cached, netRevenue: (row.markup + row.clientComm) - (row.lpComm + cached) };
            }
            if (!(await isIb(crmId))) return row;
            // Transactions are fetched per month too, so large ranges don't 500.
            let tx = 0;
            for (const mb of months) {
              try {
                const m = await fetchIbPeriodTransactions(crmId, mb.startYmd, mb.endYmd);
                tx += m;
                ibByMonth.set(mb.key, (ibByMonth.get(mb.key) || 0) + m);
              } catch {
                /* ignore a single month's IB transaction failure */
              }
            }
            ibCache.set(crmId, tx);
            return { ...row, ibCommission: tx, netRevenue: (row.markup + row.clientComm) - (row.lpComm + tx) };
          } finally {
            resolved++;
            setProgress(Math.min(99, 70 + Math.round((resolved / Math.max(1, clientRows.length)) * 29)));
            setProgressLabel(`Resolving rebates ${resolved}/${clientRows.length}`);
          }
        },
        6,
      );

      const sorted = enriched.sort((a, b) => b.netRevenue - a.netRevenue);
      setMonthlyRows(
        months.map((mb) => {
          const totalRev = monthTotalRev.get(mb.key) || 0;
          const ibComm = ibByMonth.get(mb.key) || 0;
          return {
            key: mb.key,
            label: mb.label,
            totalRev,
            netRevenue: totalRev - ibComm,
            lots: monthLots.get(mb.key) || 0,
            ibComm,
            lpComm: monthLpComm.get(mb.key) || 0,
          };
        }),
      );
      setRows(sorted);
      setProgress(100);
      setMeta({ from: fromDateYmd, to: toDateYmd, loadedAt: new Date().toLocaleString() });

      if (warnings.length) {
        if (!sorted.length) {
          setError(`All ${months.length} month(s) failed to load. ${warnings[0]}`);
        } else {
          setWarning(`${warnings.length} of ${months.length} month(s) could not be loaded and were skipped: ${warnings.join("; ")}`);
        }
      }
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

  const topNet = useMemo<ChartClientRow[]>(
    () => rows.slice(0, 10).map((r) => ({ ...r, label: clientLabel(r) })),
    [rows],
  );
  const topTotal = useMemo<ChartClientRow[]>(
    () => [...rows].sort((a, b) => b.totalRev - a.totalRev).slice(0, 10).map((r) => ({ ...r, label: clientLabel(r) })),
    [rows],
  );
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
      { name: "Rebate Withdrawn", value: rows.reduce((s, r) => s + r.ibCommission, 0), color: colors.red },
      { name: "Net Revenue", value: rows.reduce((s, r) => s + r.netRevenue, 0), color: colors.green },
    ],
    [rows],
  );

  const lotsVsNetByClient = useMemo(() => {
    return [...rows]
      .sort((a, b) => b.lots - a.lots)
      .slice(0, 12)
      .map((r) => ({
        clientKey: r.clientKey,
        label: clientLabel(r),
        name: r.name,
        lots: r.lots,
        netRevenue: r.netRevenue,
        revPerLot: r.lots > 0 ? r.netRevenue / r.lots : 0,
      }));
  }, [rows]);

  const columns = useMemo<SortableTableColumn<ClientRevenueRow>[]>(
    () => [
      {
        key: "accounts",
        label: "Accounts",
        sortValue: (r) => r.accounts.join(", "),
        searchValue: (r) => r.accounts.join(" "),
        render: (r) => <span className="font-mono">{r.accounts.join(", ") || "-"}</span>,
      },
      { key: "name", label: "Name", sortValue: (r) => r.name, searchValue: (r) => `${r.name} ${r.accounts.join(" ")}`, render: (r) => r.name || "-" },
      { key: "lots", label: "Lots", sortValue: (r) => r.lots, headerClassName: "text-right", cellClassName: "text-right", render: (r) => r.lots.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
      { key: "markup", label: "Markup", sortValue: (r) => r.markup, headerClassName: "text-right", cellClassName: "text-right", render: (r) => money(r.markup) },
      { key: "clientComm", label: "Client Comm", sortValue: (r) => r.clientComm, headerClassName: "text-right", cellClassName: "text-right", render: (r) => money(r.clientComm) },
      { key: "lpComm", label: "LP Comm", sortValue: (r) => r.lpComm, headerClassName: "text-right", cellClassName: "text-right", render: (r) => <span className="text-amber-700 dark:text-amber-300">{money(r.lpComm)}</span> },
      { key: "totalRev", label: "Total Rev", sortValue: (r) => r.totalRev, headerClassName: "text-right", cellClassName: "text-right", render: (r) => money(r.totalRev) },
      { key: "ibCommission", label: "Rebate Withdrawn", sortValue: (r) => r.ibCommission, headerClassName: "text-right", cellClassName: "text-right", render: (r) => <span className="text-rose-700 dark:text-rose-300">{money(r.ibCommission)}</span> },
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

  const handleExportPdf = async () => {
    if (!rows.length) return;
    setExporting(true);
    setExportStatus("Building PDF…");
    setError(null);
    try {
      // Reuse the data already loaded on screen — no second round of API calls.
      const reportTotals = rows.reduce(
        (acc, r) => {
          acc.lots += r.lots;
          acc.totalRev += r.totalRev;
          acc.netRevenue += r.netRevenue;
          acc.ibComm += r.ibCommission;
          acc.lpComm += r.lpComm;
          return acc;
        },
        { lots: 0, totalRev: 0, netRevenue: 0, ibComm: 0, lpComm: 0, clients: rows.length },
      );
      const data: ReportData = {
        meta: { fromYmd: meta.from || fromDateYmd, toYmd: meta.to || toDateYmd, generatedAt: new Date().toLocaleString() },
        months: monthlyRows.map((m) => ({
          key: m.key,
          label: m.label,
          lots: m.lots,
          totalRev: m.totalRev,
          ibComm: m.ibComm,
          lpComm: m.lpComm,
          netRevenue: m.netRevenue,
        })),
        totals: reportTotals,
        topClients: [...rows]
          .sort((a, b) => b.netRevenue - a.netRevenue)
          .slice(0, 20)
          .map((r) => ({ login: r.accounts.join(", "), name: r.name, lots: r.lots, totalRev: r.totalRev, ibComm: r.ibCommission, netRevenue: r.netRevenue })),
        warnings: [],
      };
      await generatePerformancePdf(data);
      setExportStatus("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setError(e?.message || "Failed to generate PDF report.");
    } finally {
      setExporting(false);
      setExportStatus("");
    }
  };

  const handleSnapshot = () => {
    if (!rows.length) return;
    setSnapshotting(true);
    try {
      const headers = ["Accounts", "Name", "Lots", "Markup", "Client Comm", "LP Comm", "Total Rev", "Rebate Withdrawn", "Net Revenue"];
      const snapshotRows = rows.map((r) => [
        r.accounts.join(", "),
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
      {warning && <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{warning}</div>}

      {loading && (
        <div className="flex flex-col items-center justify-center gap-4 py-24">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300">
            <RefreshCw className="h-4 w-4 animate-spin text-cyan-600" />
            {progressLabel || "Loading…"}
          </div>
          <div className="h-2.5 w-full max-w-md overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 transition-all duration-300 ease-out"
              style={{ width: `${Math.max(3, progress)}%` }}
            />
          </div>
          <div className="font-mono text-xs text-slate-500">{progress}%</div>
        </div>
      )}

      {!loading && (
      <>
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

      {monthlyRows.length > 1 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
            <TrendingUp className="h-3.5 w-3.5" />
            Monthly Revenue — Total vs Net (with Lots)
          </div>
          <div className="h-[380px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={monthlyRows} margin={{ left: 8, right: 16, top: 8, bottom: 30 }} barGap={2} barCategoryGap="20%">
                <defs>
                  <linearGradient id="gradTotalRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#60a5fa" />
                    <stop offset="100%" stopColor="#1d4ed8" />
                  </linearGradient>
                  <linearGradient id="gradNetRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4ade80" />
                    <stop offset="100%" stopColor="#15803d" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" interval={0} height={52} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(Number(v)).toLocaleString()}`} />
                <Tooltip
                  formatter={(value: number, name: string) =>
                    name === "Lots"
                      ? [num(value).toLocaleString(undefined, { maximumFractionDigits: 2 }), name]
                      : [money(num(value)), name]
                  }
                  cursor={{ fill: "rgba(148,163,184,0.12)" }}
                />
                <Legend />
                <Bar yAxisId="left" dataKey="totalRev" name="Total Rev" fill="url(#gradTotalRev)" radius={[6, 6, 0, 0]} isAnimationActive animationDuration={900} maxBarSize={26} />
                <Bar yAxisId="left" dataKey="netRevenue" name="Net Rev" fill="url(#gradNetRev)" radius={[6, 6, 0, 0]} isAnimationActive animationDuration={1100} maxBarSize={26} />
                <Line yAxisId="right" type="monotone" dataKey="lots" name="Lots" stroke="#b45309" strokeWidth={2.2} dot={{ r: 3 }} isAnimationActive animationDuration={1200} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">Top 10 Net Revenue</div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topNet} layout="vertical" margin={{ left: 8, right: 20, top: 10, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                <YAxis type="category" dataKey="label" width={110} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value: number) => money(num(value))} />
                <Bar dataKey="netRevenue" radius={[0, 6, 6, 0]} isAnimationActive animationDuration={900}>
                  {topNet.map((row, idx) => (
                    <Cell key={row.clientKey} fill={idx < 3 ? colors.gold : row.netRevenue >= 0 ? colors.teal : colors.red} />
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
                <XAxis dataKey="label" angle={-30} textAnchor="end" interval={0} height={50} tick={{ fontSize: 10 }} />
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
                <XAxis dataKey="label" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" interval={0} height={48} />
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
        <div className="mb-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleExportPdf}
            disabled={exporting || loading || !rows.length}
            className="rounded-md border border-cyan-600 bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? (exportStatus || "Generating…") : "Download PDF Report"}
          </button>
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
      </>
      )}
    </section>
  );
}
