import { useEffect, useMemo, useState } from "react";

type EquityAccount = {
  login: number | string;
  source: "Live" | "Bonus" | string;
  name?: string;
  equity: number;
  withdrawableEquity: number;
  credit: number;
  balance: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
};

type EquityGroup = {
  liveWithdrawableEquity: number;
  bonusWithdrawableEquity: number;
  netWithdrawableEquity: number;
  items: EquityAccount[];
};

type EquityDashboard = {
  clients: EquityGroup;
  lps: EquityGroup;
  netDifference: number;
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
  const [clientSearch, setClientSearch] = useState("");
  const [lpSearch, setLpSearch] = useState("");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const resp = await fetch(`/EquityOverview/dashboard?includeDetails=false`);
        if (!resp.ok) throw new Error(`EquityOverview ${resp.status}`);
        const json = (await resp.json()) as EquityDashboard;
        if (cancelled) return;
        setData({
          clients: {
            liveWithdrawableEquity: Number(json?.clients?.liveWithdrawableEquity || 0),
            bonusWithdrawableEquity: Number(json?.clients?.bonusWithdrawableEquity || 0),
            netWithdrawableEquity: Number(json?.clients?.netWithdrawableEquity || 0),
            items: [],
          },
          lps: {
            liveWithdrawableEquity: Number(json?.lps?.liveWithdrawableEquity || 0),
            bonusWithdrawableEquity: Number(json?.lps?.bonusWithdrawableEquity || 0),
            netWithdrawableEquity: Number(json?.lps?.netWithdrawableEquity || 0),
            items: [],
          },
          netDifference: Number(json?.netDifference || 0),
        });
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
        fetch(`/EquityOverview/dashboard`),
        fetch(`/EquityOverview/names`).catch(() => null as any),
      ]);
      if (!dashResp.ok) throw new Error(`EquityOverview details ${dashResp.status}`);

      const dashboard = (await dashResp.json()) as EquityDashboard;
      const namesJson = namesResp && namesResp.ok ? ((await namesResp.json()) as Record<string, string>) : {};

      setClientItems(Array.isArray(dashboard?.clients?.items) ? dashboard.clients.items : []);
      setLpItems(Array.isArray(dashboard?.lps?.items) ? dashboard.lps.items : []);
      setNamesByLogin(namesJson || {});
      setDetailsLoaded(true);
    } catch (e: any) {
      setDetailsError(e?.message || "Failed to load client/LP details.");
    } finally {
      setDetailsLoading(false);
    }
  };

  const formatMoney = (v: number) =>
    `${v < 0 ? "-" : ""}$${Math.abs(Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const colorClass = (v: number) => (v > 0 ? "text-emerald-700 dark:text-emerald-300" : v < 0 ? "text-rose-700 dark:text-rose-300" : "text-slate-500");

  const filterItems = (items: EquityAccount[], source: string, q: string) => {
    const query = q.trim().toLowerCase();
    return items.filter((item) => {
      if (source && String(item.source || "") !== source) return false;
      if (!query) return true;
      const login = String(item.login || "");
      const name = String(item.name || namesByLogin[login] || "").toLowerCase();
      return login.includes(query) || name.includes(query);
    });
  };

  const clientRows = useMemo(() => filterItems(clientItems || [], clientSourceFilter, clientSearch), [clientItems, clientSourceFilter, clientSearch, namesByLogin]);
  const lpRows = useMemo(() => filterItems(lpItems || [], lpSourceFilter, lpSearch), [lpItems, lpSourceFilter, lpSearch, namesByLogin]);

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
        <div className="rounded-lg border border-slate-200 dark:border-slate-800">
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
                <input value={clientSearch} onChange={(e) => setClientSearch(e.target.value)} placeholder="Search login/name" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/70" />
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">Name</th><th className="px-2 py-2 text-left">Login</th><th className="px-2 py-2 text-left">Source</th><th className="px-2 py-2 text-right">Equity</th><th className="px-2 py-2 text-right">WD Equity</th><th className="px-2 py-2 text-right">Credit</th><th className="px-2 py-2 text-right">Balance</th><th className="px-2 py-2 text-right">Margin</th><th className="px-2 py-2 text-right">Free Margin</th><th className="px-2 py-2 text-right">Margin Level</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientRows.map((row, idx) => {
                      const login = String(row.login || "");
                      const marginLevel = Number(row.marginLevel) || 0;
                      return (
                        <tr key={`eq-client-${login}-${idx}`} className="border-t border-slate-200 dark:border-slate-800">
                          <td className="px-2 py-1.5">{row.name || namesByLogin[login] || "-"}</td>
                          <td className="px-2 py-1.5 font-mono">{login}</td>
                          <td className="px-2 py-1.5">{row.source || "-"}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.equity || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.withdrawableEquity || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.credit || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.balance || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.margin || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.freeMargin || 0))}</td>
                          <td className={`px-2 py-1.5 text-right ${marginLevel >= 100 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{marginLevel.toFixed(2)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800">
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
                <input value={lpSearch} onChange={(e) => setLpSearch(e.target.value)} placeholder="Search login/name" className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/70" />
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900/80">
                    <tr>
                      <th className="px-2 py-2 text-left">Name</th><th className="px-2 py-2 text-left">Login</th><th className="px-2 py-2 text-left">Source</th><th className="px-2 py-2 text-right">Equity</th><th className="px-2 py-2 text-right">WD Equity</th><th className="px-2 py-2 text-right">Credit</th><th className="px-2 py-2 text-right">Balance</th><th className="px-2 py-2 text-right">Margin</th><th className="px-2 py-2 text-right">Free Margin</th><th className="px-2 py-2 text-right">Margin Level</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lpRows.map((row, idx) => {
                      const login = String(row.login || "");
                      const marginLevel = Number(row.marginLevel) || 0;
                      return (
                        <tr key={`eq-lp-${login}-${idx}`} className="border-t border-slate-200 dark:border-slate-800">
                          <td className="px-2 py-1.5">{row.name || namesByLogin[login] || "-"}</td>
                          <td className="px-2 py-1.5 font-mono">{login}</td>
                          <td className="px-2 py-1.5">{row.source || "-"}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.equity || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.withdrawableEquity || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.credit || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.balance || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.margin || 0))}</td>
                          <td className="px-2 py-1.5 text-right">{formatMoney(Number(row.freeMargin || 0))}</td>
                          <td className={`px-2 py-1.5 text-right ${marginLevel >= 100 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{marginLevel.toFixed(2)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
