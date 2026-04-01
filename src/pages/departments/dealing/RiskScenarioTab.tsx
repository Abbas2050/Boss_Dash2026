import { useEffect, useMemo, useState } from "react";

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

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800/80 dark:bg-slate-950/70">
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
        <div className="overflow-auto rounded-md border border-slate-200 dark:border-slate-800">
          <table className="min-w-[1600px] text-xs">
            <thead className="bg-slate-100 dark:bg-slate-900/80">
              <tr>
                <th className="px-2 py-2 text-left">LP</th>
                <th className="px-2 py-2 text-left">Source</th>
                <th className="px-2 py-2 text-right">Net Vol</th>
                <th className="px-2 py-2 text-right">VWAP Open</th>
                <th className="px-2 py-2 text-right">Price Current</th>
                <th className="px-2 py-2 text-right">Adverse Price</th>
                <th className="px-2 py-2 text-right">P/L Now</th>
                <th className="px-2 py-2 text-right">P&L Change</th>
                <th className="px-2 py-2 text-right">P/L After</th>
                <th className="px-2 py-2 text-right">Rev Share %</th>
                <th className="px-2 py-2 text-right">PL Share $</th>
                <th className="px-2 py-2 text-right">Equity Now</th>
                <th className="px-2 py-2 text-right">Equity After</th>
                <th className="px-2 py-2 text-right">ML Now %</th>
                <th className="px-2 py-2 text-right">ML After %</th>
                <th className="px-2 py-2 text-right">Margin</th>
                <th className="px-2 py-2 text-right">FM Now</th>
                <th className="px-2 py-2 text-right">FM After</th>
                <th className="px-2 py-2 text-right">Funding to Target</th>
                <th className="px-2 py-2 text-left">Comment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={`risk-scenario-row-${idx}`} className="border-t border-slate-200 dark:border-slate-800">
                  <td className="px-2 py-1.5 text-left font-medium text-slate-800 dark:text-slate-100">{row.lp || "-"}</td>
                  <td className="px-2 py-1.5 text-left">
                    <span className={String(row.source || "").toLowerCase() === "bonus" ? "text-amber-700 dark:text-amber-300" : "text-cyan-700 dark:text-cyan-300"}>
                      {row.source || "-"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right">{formatNumber(row.netVolume, 3)}</td>
                  <td className="px-2 py-1.5 text-right">{formatNumber(row.vwapOpen, 5)}</td>
                  <td className="px-2 py-1.5 text-right">{formatNumber(row.priceCurrent, 5)}</td>
                  <td className="px-2 py-1.5 text-right">{formatNumber(row.adversePrice, 5)}</td>
                  <td className={`px-2 py-1.5 text-right ${moneyClassName(row.plNow)}`}>{formatMoney(row.plNow)}</td>
                  <td className={`bg-cyan-500/5 px-2 py-1.5 text-right ${moneyClassName(row.deltaPl)}`}>{formatMoney(row.deltaPl)}</td>
                  <td className={`bg-cyan-500/5 px-2 py-1.5 text-right ${moneyClassName(row.plAfter)}`}>{formatMoney(row.plAfter)}</td>
                  <td className="px-2 py-1.5 text-right">{row.revSharePct ?? "-"}</td>
                  <td className={`px-2 py-1.5 text-right ${moneyClassName(row.plShareUsd)}`}>{formatMoney(row.plShareUsd)}</td>
                  <td className={`px-2 py-1.5 text-right ${moneyClassName(row.equityNow)}`}>{formatMoney(row.equityNow)}</td>
                  <td className={`bg-cyan-500/5 px-2 py-1.5 text-right ${moneyClassName(row.equityAfter)}`}>{formatMoney(row.equityAfter)}</td>
                  <td className={`px-2 py-1.5 text-right ${mlClassName(row.mlNow)}`}>{Number.isFinite(Number(row.mlNow)) && Number(row.mlNow) !== 0 ? `${formatNumber(row.mlNow)}%` : "-"}</td>
                  <td className={`bg-cyan-500/5 px-2 py-1.5 text-right ${mlClassName(row.mlAfter)}`}>{Number.isFinite(Number(row.mlAfter)) && Number(row.mlAfter) !== 0 ? `${formatNumber(row.mlAfter)}%` : "-"}</td>
                  <td className={`px-2 py-1.5 text-right ${moneyClassName(row.margin)}`}>{formatMoney(row.margin)}</td>
                  <td className={`px-2 py-1.5 text-right ${moneyClassName(row.freeMarginNow)}`}>{formatMoney(row.freeMarginNow)}</td>
                  <td className={`px-2 py-1.5 text-right ${moneyClassName(row.freeMarginAfter)}`}>{formatMoney(row.freeMarginAfter)}</td>
                  <td className={`px-2 py-1.5 text-right ${moneyClassName(-Math.abs(Number(row.fundingToTarget || 0)))}`}>{formatMoney(Math.abs(Number(row.fundingToTarget || 0)) * -1)}</td>
                  <td className="px-2 py-1.5 text-left text-slate-500 dark:text-slate-400">{row.comment || ""}</td>
                </tr>
              ))}
              {result?.totals && (
                <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold dark:border-slate-700 dark:bg-slate-900/90">
                  <td className="px-2 py-2 text-left">TOTAL</td>
                  <td className="px-2 py-2 text-left" />
                  <td className="px-2 py-2 text-right">{formatNumber(result.totals.netVolume, 3)}</td>
                  <td className="px-2 py-2 text-right" />
                  <td className="px-2 py-2 text-right" />
                  <td className="px-2 py-2 text-right" />
                  <td className={`px-2 py-2 text-right ${moneyClassName(result.totals.plNow)}`}>{formatMoney(result.totals.plNow)}</td>
                  <td className={`bg-cyan-500/5 px-2 py-2 text-right ${moneyClassName(result.totals.deltaPl)}`}>{formatMoney(result.totals.deltaPl)}</td>
                  <td className={`bg-cyan-500/5 px-2 py-2 text-right ${moneyClassName(result.totals.plAfter)}`}>{formatMoney(result.totals.plAfter)}</td>
                  <td className="px-2 py-2 text-right" />
                  <td className={`px-2 py-2 text-right ${moneyClassName(result.totals.plShareUsd)}`}>{formatMoney(result.totals.plShareUsd)}</td>
                  <td className={`px-2 py-2 text-right ${moneyClassName(result.totals.equityNow)}`}>{formatMoney(result.totals.equityNow)}</td>
                  <td className={`bg-cyan-500/5 px-2 py-2 text-right ${moneyClassName(result.totals.equityAfter)}`}>{formatMoney(result.totals.equityAfter)}</td>
                  <td className={`px-2 py-2 text-right ${mlClassName(result.totals.mlNow)}`}>{Number.isFinite(Number(result.totals.mlNow)) && Number(result.totals.mlNow) !== 0 ? `${formatNumber(result.totals.mlNow)}%` : "-"}</td>
                  <td className={`bg-cyan-500/5 px-2 py-2 text-right ${mlClassName(result.totals.mlAfter)}`}>{Number.isFinite(Number(result.totals.mlAfter)) && Number(result.totals.mlAfter) !== 0 ? `${formatNumber(result.totals.mlAfter)}%` : "-"}</td>
                  <td className={`px-2 py-2 text-right ${moneyClassName(result.totals.margin)}`}>{formatMoney(result.totals.margin)}</td>
                  <td className={`px-2 py-2 text-right ${moneyClassName(result.totals.freeMarginNow)}`}>{formatMoney(result.totals.freeMarginNow)}</td>
                  <td className={`px-2 py-2 text-right ${moneyClassName(result.totals.freeMarginAfter)}`}>{formatMoney(result.totals.freeMarginAfter)}</td>
                  <td className={`px-2 py-2 text-right ${moneyClassName(-Math.abs(Number(result.totals.fundingToTarget || 0)))}`}>{formatMoney(Math.abs(Number(result.totals.fundingToTarget || 0)) * -1)}</td>
                  <td className="px-2 py-2 text-left text-slate-500 dark:text-slate-400">{result.totals.comment || ""}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
