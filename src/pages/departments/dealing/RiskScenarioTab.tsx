import { useEffect, useMemo, useState } from "react";
import { Camera, Maximize2, Minimize2 } from "lucide-react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";

type RiskScenarioRow = {
  lp?: string;
  source?: string;
  netVolume?: number;
  vwapOpen?: number;
  priceCurrent?: number;
  adversePrice?: number;
  plNow?: number;
  deltaPl?: number;
  plAfter?: number;
  revSharePct?: number | string;
  plShareUsd?: number;
  equityNow?: number;
  equityAfter?: number;
  mlNow?: number;
  mlAfter?: number;
  margin?: number;
  freeMarginNow?: number;
  freeMarginAfter?: number;
  fundingToTarget?: number;
  comment?: string;
};

type RiskScenarioTotals = {
  netVolume?: number;
  plNow?: number;
  deltaPl?: number;
  plAfter?: number;
  plShareUsd?: number;
  equityNow?: number;
  equityAfter?: number;
  mlNow?: number;
  mlAfter?: number;
  margin?: number;
  freeMarginNow?: number;
  freeMarginAfter?: number;
  fundingToTarget?: number;
  comment?: string;
};

type RiskScenarioResponse = {
  rows?: RiskScenarioRow[];
  totals?: RiskScenarioTotals;
  direction?: "Up" | "Down" | string;
};

const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

const formatNumber = (value: number | undefined | null, digits = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const formatMoney = (value: number | undefined | null) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const mlClassName = (value: number | undefined | null) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "text-slate-500";
  if (n >= 200) return "text-emerald-700 dark:text-emerald-300";
  if (n >= 100) return "text-amber-700 dark:text-amber-300";
  return "text-rose-700 dark:text-rose-300";
};

const moneyClassName = (value: number | undefined | null) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "text-slate-500";
  return n > 0 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300";
};

const fundingAsNegative = (value: number | undefined | null) => Math.abs(Number(value || 0)) * -1;

const takeSnapshot = (headers: string[], rows: Array<Array<string | number>>, filePrefix: string, title: string) => {
  if (!rows.length) return;

  const normalizedRows = rows.map((row) => row.map((cell) => String(cell ?? "")));
  const colWidths = headers.map((header, idx) => {
    const maxCell = normalizedRows.reduce((max, row) => Math.max(max, (row[idx] || "").length), header.length);
    return Math.max(92, Math.min(220, maxCell * 8 + 20));
  });
  const tableWidth = colWidths.reduce((sum, width) => sum + width, 0);
  const headerHeight = 30;
  const rowHeight = 22;
  const titleHeight = 46;
  const width = Math.max(920, tableWidth + 24);
  const height = Math.max(320, titleHeight + headerHeight + normalizedRows.length * rowHeight + 14);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#020617";
  ctx.fillRect(0, 0, width, height);
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
      const text = cell.length > 34 ? `${cell.slice(0, 31)}...` : cell;
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

export function RiskScenarioTab({ refreshKey }: { refreshKey: number }) {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [direction, setDirection] = useState<"Up" | "Down">("Up");
  const [moveAmount, setMoveAmount] = useState("10");
  const [targetMl, setTargetMl] = useState("150");

  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RiskScenarioResponse | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);

  const loadSymbols = async () => {
    try {
      const resp = await fetch(`${BACKEND_BASE_URL}/RiskScenario/symbols`);
      if (!resp.ok) throw new Error(`RiskScenario symbols ${resp.status}`);
      const payload = (await resp.json()) as string[];
      const sorted = (Array.isArray(payload) ? payload : []).filter(Boolean).sort((a, b) => a.localeCompare(b));
      setSymbols(sorted);
      setSelectedSymbol((current) => (current && sorted.includes(current) ? current : sorted[0] || ""));
    } catch (e: any) {
      setError(e?.message || "Failed to load risk scenario symbols.");
    }
  };

  useEffect(() => {
    loadSymbols();
  }, []);

  useEffect(() => {
    if (refreshKey > 0) {
      void calculateScenario();
    }
  }, [refreshKey]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  const calculateScenario = async () => {
    const numericMove = Number(moveAmount);
    const numericTargetMl = Number(targetMl);

    if (!selectedSymbol || !Number.isFinite(numericMove) || numericMove === 0) {
      setError("Select a symbol and enter a non-zero move amount.");
      return;
    }

    setError(null);
    setLoading(true);
    setStatusText("Calculating...");
    try {
      const resp = await fetch(`${BACKEND_BASE_URL}/RiskScenario/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: selectedSymbol,
          direction,
          moveAmount: numericMove,
          targetMl: Number.isFinite(numericTargetMl) ? numericTargetMl : 150,
        }),
      });
      if (!resp.ok) throw new Error(`RiskScenario analyze ${resp.status}`);
      const payload = (await resp.json()) as RiskScenarioResponse;
      setResult(payload);
      setStatusText(`${Array.isArray(payload?.rows) ? payload.rows.length : 0} LP(s) with ${selectedSymbol} positions`);
    } catch (e: any) {
      setError(e?.message || "Failed to calculate risk scenario.");
      setStatusText("Error");
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const rows = useMemo(() => (Array.isArray(result?.rows) ? result.rows : []), [result]);

  const columns = useMemo<SortableTableColumn<RiskScenarioRow>[]>(
    () => [
      {
        key: "lp",
        label: "LP",
        sortValue: (row) => String(row.lp || ""),
        searchValue: (row) => `${row.lp || ""} ${row.source || ""} ${row.comment || ""}`,
        render: (row) => <span className="font-medium text-slate-800 dark:text-slate-100">{row.lp || "-"}</span>,
      },
      {
        key: "source",
        label: "Source",
        sortValue: (row) => String(row.source || ""),
        render: (row) => (
          <span className={String(row.source || "").toLowerCase() === "bonus" ? "text-amber-700 dark:text-amber-300" : "text-cyan-700 dark:text-cyan-300"}>
            {row.source || "-"}
          </span>
        ),
      },
      { key: "netVolume", label: "Net Vol", sortValue: (row) => Number(row.netVolume) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatNumber(row.netVolume, 3) },
      { key: "vwapOpen", label: "VWAP Open", sortValue: (row) => Number(row.vwapOpen) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatNumber(row.vwapOpen, 5) },
      { key: "priceCurrent", label: "Price Current", sortValue: (row) => Number(row.priceCurrent) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatNumber(row.priceCurrent, 5) },
      { key: "adversePrice", label: "Adverse Price", sortValue: (row) => Number(row.adversePrice) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => formatNumber(row.adversePrice, 5) },
      {
        key: "plNow",
        label: "P/L Now",
        sortValue: (row) => Number(row.plNow) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => <span className={moneyClassName(row.plNow)}>{formatMoney(row.plNow)}</span>,
      },
      {
        key: "deltaPl",
        label: "P&L Change",
        sortValue: (row) => Number(row.deltaPl) || 0,
        headerClassName: "text-right",
        cellClassName: "bg-cyan-500/5 text-right",
        render: (row) => <span className={moneyClassName(row.deltaPl)}>{formatMoney(row.deltaPl)}</span>,
      },
      {
        key: "plAfter",
        label: "P/L After",
        sortValue: (row) => Number(row.plAfter) || 0,
        headerClassName: "text-right",
        cellClassName: "bg-cyan-500/5 text-right",
        render: (row) => <span className={moneyClassName(row.plAfter)}>{formatMoney(row.plAfter)}</span>,
      },
      { key: "revSharePct", label: "Rev Share %", sortValue: (row) => Number(row.revSharePct) || 0, headerClassName: "text-right", cellClassName: "text-right", render: (row) => row.revSharePct ?? "-" },
      {
        key: "plShareUsd",
        label: "PL Share $",
        sortValue: (row) => Number(row.plShareUsd) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => <span className={moneyClassName(row.plShareUsd)}>{formatMoney(row.plShareUsd)}</span>,
      },
      {
        key: "equityNow",
        label: "Equity Now",
        sortValue: (row) => Number(row.equityNow) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => <span className={moneyClassName(row.equityNow)}>{formatMoney(row.equityNow)}</span>,
      },
      {
        key: "equityAfter",
        label: "Equity After",
        sortValue: (row) => Number(row.equityAfter) || 0,
        headerClassName: "text-right",
        cellClassName: "bg-cyan-500/5 text-right",
        render: (row) => <span className={moneyClassName(row.equityAfter)}>{formatMoney(row.equityAfter)}</span>,
      },
      {
        key: "mlNow",
        label: "ML Now %",
        sortValue: (row) => Number(row.mlNow) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => (
          <span className={mlClassName(row.mlNow)}>{Number.isFinite(Number(row.mlNow)) && Number(row.mlNow) !== 0 ? `${formatNumber(row.mlNow)}%` : "-"}</span>
        ),
      },
      {
        key: "mlAfter",
        label: "ML After %",
        sortValue: (row) => Number(row.mlAfter) || 0,
        headerClassName: "text-right",
        cellClassName: "bg-cyan-500/5 text-right",
        render: (row) => (
          <span className={mlClassName(row.mlAfter)}>{Number.isFinite(Number(row.mlAfter)) && Number(row.mlAfter) !== 0 ? `${formatNumber(row.mlAfter)}%` : "-"}</span>
        ),
      },
      {
        key: "margin",
        label: "Margin",
        sortValue: (row) => Number(row.margin) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => <span className={moneyClassName(row.margin)}>{formatMoney(row.margin)}</span>,
      },
      {
        key: "freeMarginNow",
        label: "FM Now",
        sortValue: (row) => Number(row.freeMarginNow) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => <span className={moneyClassName(row.freeMarginNow)}>{formatMoney(row.freeMarginNow)}</span>,
      },
      {
        key: "freeMarginAfter",
        label: "FM After",
        sortValue: (row) => Number(row.freeMarginAfter) || 0,
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => <span className={moneyClassName(row.freeMarginAfter)}>{formatMoney(row.freeMarginAfter)}</span>,
      },
      {
        key: "fundingToTarget",
        label: "Funding to Target",
        sortValue: (row) => fundingAsNegative(row.fundingToTarget),
        headerClassName: "text-right",
        cellClassName: "text-right",
        render: (row) => {
          const value = fundingAsNegative(row.fundingToTarget);
          return <span className={moneyClassName(value)}>{formatMoney(value)}</span>;
        },
      },
      {
        key: "comment",
        label: "Comment",
        sortValue: (row) => String(row.comment || ""),
        render: (row) => <span className="text-slate-500 dark:text-slate-400">{row.comment || ""}</span>,
      },
    ],
    [],
  );

  const handleSnapshot = () => {
    if (!rows.length) return;
    setSnapshotting(true);
    try {
      const headers = [
        "LP", "Source", "Net Vol", "VWAP Open", "Price Current", "Adverse Price", "P/L Now", "P&L Change", "P/L After",
        "Rev Share %", "PL Share $", "Equity Now", "Equity After", "ML Now %", "ML After %", "Margin", "FM Now", "FM After", "Funding to Target", "Comment",
      ];
      const snapshotRows = rows.map((row) => [
        row.lp || "-",
        row.source || "-",
        formatNumber(row.netVolume, 3),
        formatNumber(row.vwapOpen, 5),
        formatNumber(row.priceCurrent, 5),
        formatNumber(row.adversePrice, 5),
        formatMoney(row.plNow),
        formatMoney(row.deltaPl),
        formatMoney(row.plAfter),
        row.revSharePct ?? "-",
        formatMoney(row.plShareUsd),
        formatMoney(row.equityNow),
        formatMoney(row.equityAfter),
        Number.isFinite(Number(row.mlNow)) && Number(row.mlNow) !== 0 ? `${formatNumber(row.mlNow)}%` : "-",
        Number.isFinite(Number(row.mlAfter)) && Number(row.mlAfter) !== 0 ? `${formatNumber(row.mlAfter)}%` : "-",
        formatMoney(row.margin),
        formatMoney(row.freeMarginNow),
        formatMoney(row.freeMarginAfter),
        formatMoney(fundingAsNegative(row.fundingToTarget)),
        row.comment || "",
      ]);
      takeSnapshot(headers, snapshotRows, "risk-scenario-snapshot", "Risk Scenario Snapshot");
    } finally {
      setSnapshotting(false);
    }
  };

  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70 ${fullscreen ? "fixed inset-3 z-50 flex h-[calc(100vh-1.5rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden bg-white shadow-2xl dark:bg-slate-950" : ""}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">Risk Scenario Analysis</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">{statusText}</span>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5 xl:grid-cols-6">
        <label className="text-xs text-slate-600 dark:text-slate-300">
          Symbol
          <select
            value={selectedSymbol}
            onChange={(e) => setSelectedSymbol(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
          >
            {symbols.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
            {!symbols.length && <option value="">Loading...</option>}
          </select>
        </label>

        <label className="text-xs text-slate-600 dark:text-slate-300">
          Direction
          <select
            value={direction}
            onChange={(e) => setDirection((e.target.value as "Up" | "Down") || "Up")}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
          >
            <option value="Up">Up</option>
            <option value="Down">Down</option>
          </select>
        </label>

        <label className="text-xs text-slate-600 dark:text-slate-300">
          Move (price)
          <input
            value={moveAmount}
            onChange={(e) => setMoveAmount(e.target.value)}
            type="number"
            step="0.01"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
          />
        </label>

        <label className="text-xs text-slate-600 dark:text-slate-300">
          Target ML %
          <input
            value={targetMl}
            onChange={(e) => setTargetMl(e.target.value)}
            type="number"
            step="10"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
          />
        </label>

        <div className="flex items-end">
          <button
            type="button"
            onClick={calculateScenario}
            disabled={loading}
            className="inline-flex h-[30px] items-center gap-2 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-500/20 disabled:opacity-60 dark:text-cyan-200"
          >
            {loading ? "Calculating..." : "Calculate"}
          </button>
        </div>
      </div>

      {error && <div className="mb-3 rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{error}</div>}

      {!loading && rows.length === 0 ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
          No scenario rows yet. Select inputs and click Calculate.
        </div>
      ) : null}

      {rows.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSnapshot}
              disabled={snapshotting || !rows.length}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Camera className={`h-3.5 w-3.5 ${snapshotting ? "animate-pulse" : ""}`} />
              {snapshotting ? "Capturing..." : "Snapshot"}
            </button>
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
            >
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              {fullscreen ? "Exit Fullscreen" : "Fullscreen"}
            </button>
          </div>
          <SortableTable
            tableId="dealing-risk-scenario-table"
            enableColumnVisibility
            rows={rows}
            columns={columns}
            tableClassName="min-w-[1600px] text-xs"
            exportFilePrefix="dealing-risk-scenario"
            emptyText="No scenario rows yet. Select inputs and click Calculate."
          />
          {result?.totals && (
            <div className="rounded-lg border border-slate-800 bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Totals:</span>{" "}
              <span className="text-slate-500 dark:text-slate-400">
                NetVol {formatNumber(result.totals.netVolume, 3)} | PL Now {formatMoney(result.totals.plNow)} | PL Change {formatMoney(result.totals.deltaPl)} | PL After {formatMoney(result.totals.plAfter)} | PL Share {formatMoney(result.totals.plShareUsd)} | Equity Now {formatMoney(result.totals.equityNow)} | Equity After {formatMoney(result.totals.equityAfter)} | ML Now {Number.isFinite(Number(result.totals.mlNow)) && Number(result.totals.mlNow) !== 0 ? `${formatNumber(result.totals.mlNow)}%` : "-"} | ML After {Number.isFinite(Number(result.totals.mlAfter)) && Number(result.totals.mlAfter) !== 0 ? `${formatNumber(result.totals.mlAfter)}%` : "-"} | Margin {formatMoney(result.totals.margin)} | FM Now {formatMoney(result.totals.freeMarginNow)} | FM After {formatMoney(result.totals.freeMarginAfter)} | Funding {formatMoney(fundingAsNegative(result.totals.fundingToTarget))}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
