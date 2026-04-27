import { useMemo, useState } from "react";

type Row = Record<string, any>;

type DealMatchResponse = {
  fromDate?: string;
  toDate?: string;
  totalClientDeals?: number;
  totalCentroidOrders?: number;
  matchedCount?: number;
  totalBonusClientDeals?: number;
  totalSpreadRevenueUsd?: number;
  totalCentroidOnlyRevenueUsd?: number;
  totalFixApiRevenueUsd?: number;
  totalClientCommission?: number;
  totalLpCommission?: number;
  totalLpEffectiveCommission?: number;
  fixApiOrderCount?: number;
  matches?: Row[];
  unmatchedClientDeals?: Row[];
  unmatchedCentroidOrders?: Row[];
  fixApiOrders?: Row[];
  partialFills?: Row[];
  centroidOnlyRevenues?: Row[];
  fixApiRevenues?: Row[];
  coverageLps?: Row[];
  clientRevenueSummaries?: Row[];
  clientSystems?: Row[];
};

type UnmatchedAggregateRow = {
  login: string | number;
  clientName: string;
  group: string;
  system: string;
  dealCount: number;
  lots: number;
  buyLots: number;
  sellLots: number;
  symbols: string;
  latestTime: string;
};

type RevenueRow = {
  login: string;
  name: string;
  group: string;
  system: string;
  lots: number;
  markupRevenueUsd: number;
  clientCommissionUsd: number;
  lpCommissionUsd: number;
  totalRevenueUsd: number;
};

type CoverageLpRow = {
  lpName: string;
  lpLogin: string;
  source: string;
  dealCount: number;
  lots: number;
  millionsUsd: number;
  effectiveCommission: number;
  actualCommission: number;
  calculatedCommission: number;
  configuredRatePerMillion?: number;
  effectiveRatePerMillion?: number;
  commissionSource: string;
};

type SystemRow = {
  system: string;
  lots: number | null;
  markupRevenueUsd: number;
  commission: number;
};

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function safe(value: any): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function fmtNum(value: any, digits = 2): string {
  return num(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtInt(value: any): string {
  return Math.round(num(value)).toLocaleString();
}

function money(value: any): string {
  const n = num(value);
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedClass(value: any): string {
  const n = num(value);
  if (n > 0.000001) return "text-emerald-700 dark:text-emerald-300";
  if (n < -0.000001) return "text-rose-700 dark:text-rose-300";
  return "text-slate-500 dark:text-slate-400";
}

function ymdToUnixRange(fromDate: string, toDate: string) {
  const from = Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000);
  const to = Math.floor(new Date(`${toDate}T23:59:59Z`).getTime() / 1000);
  return { from, to };
}

function collapseTitleClass(open: boolean) {
  return open
    ? "border-cyan-300/60 bg-cyan-50 text-cyan-900 shadow-sm transition-colors duration-200 hover:bg-cyan-100 dark:border-cyan-500/40 dark:bg-cyan-500/10 dark:text-cyan-200 dark:hover:bg-cyan-500/20"
    : "border-slate-300 bg-white text-slate-700 shadow-sm transition-colors duration-200 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-200 dark:hover:bg-slate-900/70";
}

function aggregateUnmatchedMt5(unmatchedDeals: Row[]): UnmatchedAggregateRow[] {
  const rows = new Map<string, Omit<UnmatchedAggregateRow, "symbols"> & { symbols: Set<string> }>();
  for (const u of unmatchedDeals) {
    const key = String(u.login || "");
    if (!rows.has(key)) {
      rows.set(key, {
        login: u.login || "",
        clientName: u.clientName || "",
        group: u.group || "",
        system: u.isBonus ? "Bonus" : "Client",
        dealCount: 0,
        lots: 0,
        buyLots: 0,
        sellLots: 0,
        symbols: new Set<string>(),
        latestTime: "",
      });
    }

    const row = rows.get(key)!;
    const lots = num(u.volume);
    row.dealCount += 1;
    row.lots += lots;
    if (String(u.side || "").toLowerCase() === "buy") row.buyLots += lots;
    if (String(u.side || "").toLowerCase() === "sell") row.sellLots += lots;
    if (u.symbol) row.symbols.add(String(u.symbol));
    if (u.time && (!row.latestTime || String(u.time) > row.latestTime)) row.latestTime = String(u.time);
  }

  return Array.from(rows.values())
    .map((r) => ({ ...r, symbols: Array.from(r.symbols).sort().join(", ") }))
    .sort((a, b) => num(b.lots) - num(a.lots));
}

export function DealMatchingTab({ baseUrl }: { baseUrl: string }) {
  const today = useMemo(() => toYmd(new Date()), []);

  const [group, setGroup] = useState("*");
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [symbol, setSymbol] = useState("");
  const [login, setLogin] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadDetailsLoading, setLoadDetailsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("");
  const [report, setReport] = useState<DealMatchResponse | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [systemsOpen, setSystemsOpen] = useState(false);
  const [clientRevenueOpen, setClientRevenueOpen] = useState(true);
  const [coverageLpOpen, setCoverageLpOpen] = useState(true);
  const [matchedOpen, setMatchedOpen] = useState(true);
  const [unmatchedMt5Open, setUnmatchedMt5Open] = useState(true);
  const [unmatchedCenOpen, setUnmatchedCenOpen] = useState(true);
  const [partialOpen, setPartialOpen] = useState(true);

  const [clientRevenueDetailRows, setClientRevenueDetailRows] = useState<Row[]>([]);
  const [clientRevenueDetailLabel, setClientRevenueDetailLabel] = useState("");
  const [clientRevenueDetailLoading, setClientRevenueDetailLoading] = useState(false);

  const [selectedLpDetail, setSelectedLpDetail] = useState<Row | null>(null);
  const [selectedPartial, setSelectedPartial] = useState<Row | null>(null);

  const matches = report?.matches || [];
  const unmatchedClientDeals = report?.unmatchedClientDeals || [];
  const unmatchedCentroidOrders = (report?.unmatchedCentroidOrders || []).concat(report?.fixApiOrders || []);
  const partialRows = report?.partialFills || matches.filter((m) => String(m.matchStatus || "").toLowerCase() === "partial");

  const derivedClientRevenue = useMemo<RevenueRow[]>(() => {
    if (Array.isArray(report?.clientRevenueSummaries) && report!.clientRevenueSummaries!.length) {
      return report!.clientRevenueSummaries! as RevenueRow[];
    }

    const byLogin: Record<string, RevenueRow> = {};
    for (const m of matches) {
      const key = String(m.clientLogin || "-");
      if (!byLogin[key]) {
        byLogin[key] = {
          login: key,
          name: safe(m.clientName),
          group: safe(m.clientGroup),
          system: m.isBonus ? "Bonus" : "Client",
          lots: 0,
          markupRevenueUsd: 0,
          clientCommissionUsd: 0,
          lpCommissionUsd: 0,
          totalRevenueUsd: 0,
        };
      }
      byLogin[key].lots += num(m.clientVolume);
      byLogin[key].markupRevenueUsd += num(m.spreadRevenueUsd);
      byLogin[key].clientCommissionUsd += num(m.clientCommission);
      byLogin[key].lpCommissionUsd += Math.abs(num(m.lpCommission));
    }

    return Object.values(byLogin)
      .map((r) => ({ ...r, totalRevenueUsd: num(r.markupRevenueUsd) + num(r.clientCommissionUsd) - num(r.lpCommissionUsd) }))
      .sort((a, b) => num(b.totalRevenueUsd) - num(a.totalRevenueUsd));
  }, [matches, report]);

  const derivedCoverageLps = useMemo<CoverageLpRow[]>(() => {
    if (Array.isArray(report?.coverageLps) && report!.coverageLps!.length) {
      return report!.coverageLps! as CoverageLpRow[];
    }

    const byLp: Record<string, CoverageLpRow> = {};
    for (const m of matches) {
      const key = `${safe(m.lpName)}|${safe(m.lpsid)}`;
      if (!byLp[key]) {
        byLp[key] = {
          lpName: safe(m.lpName),
          lpLogin: safe(m.lpsid),
          source: safe(m.lpSource),
          dealCount: 0,
          lots: 0,
          millionsUsd: 0,
          effectiveCommission: 0,
          actualCommission: 0,
          calculatedCommission: 0,
          configuredRatePerMillion: m.configuredRatePerMillion,
          effectiveRatePerMillion: m.effectiveRatePerMillion,
          commissionSource: safe(m.commissionSource),
        };
      }
      byLp[key].dealCount += 1;
      byLp[key].lots += num(m.lpVolume);
      byLp[key].millionsUsd += num(m.lpVolume) * num(m.lpPrice) * num(m.contractSize) / 1_000_000;
      const lpCommission = Math.abs(num(m.lpCommission));
      byLp[key].effectiveCommission += lpCommission;
      byLp[key].actualCommission += lpCommission;
      byLp[key].calculatedCommission += lpCommission;
    }

    return Object.values(byLp).sort((a, b) => num(b.effectiveCommission) - num(a.effectiveCommission));
  }, [matches, report]);

  const derivedSystems = useMemo<SystemRow[]>(() => {
    if (Array.isArray(report?.clientSystems) && report!.clientSystems!.length) {
      const systems = [...(report!.clientSystems! as SystemRow[])];
      const lpEffective = derivedCoverageLps.reduce<number>((sum, x) => sum + num(x.effectiveCommission), 0);
      const clientComm = systems.reduce<number>((sum, x) => sum + num(x.commission), 0);
      const markup = systems.reduce<number>((sum, x) => sum + num(x.markupRevenueUsd), 0);
      systems.push({ system: "LP Charged", lots: null, markupRevenueUsd: 0, commission: lpEffective });
      systems.push({ system: "Net (Client - LP)", lots: null, markupRevenueUsd: markup, commission: clientComm + markup - lpEffective });
      return systems;
    }

    const live = derivedClientRevenue.filter((r) => String(r.system).toLowerCase() !== "bonus");
    const bonus = derivedClientRevenue.filter((r) => String(r.system).toLowerCase() === "bonus");
    const lpEffective = derivedCoverageLps.reduce<number>((sum, x) => sum + num(x.effectiveCommission), 0);

    const clientMarkup = live.reduce<number>((sum, r) => sum + num(r.markupRevenueUsd), 0);
    const clientComm = live.reduce<number>((sum, r) => sum + num(r.clientCommissionUsd), 0);
    const clientLots = live.reduce<number>((sum, r) => sum + num(r.lots), 0);

    const bonusMarkup = bonus.reduce<number>((sum, r) => sum + num(r.markupRevenueUsd), 0);
    const bonusComm = bonus.reduce<number>((sum, r) => sum + num(r.clientCommissionUsd), 0);
    const bonusLots = bonus.reduce<number>((sum, r) => sum + num(r.lots), 0);

    return [
      { system: "Client", lots: clientLots, markupRevenueUsd: clientMarkup, commission: clientComm },
      { system: "Bonus", lots: bonusLots, markupRevenueUsd: bonusMarkup, commission: bonusComm },
      { system: "LP Charged", lots: null, markupRevenueUsd: 0, commission: lpEffective },
      { system: "Net (Client - LP)", lots: null, markupRevenueUsd: clientMarkup + bonusMarkup, commission: clientComm + bonusComm + clientMarkup + bonusMarkup - lpEffective },
    ];
  }, [derivedClientRevenue, derivedCoverageLps, report]);

  const unmatchedByClientRows = useMemo(() => aggregateUnmatchedMt5(unmatchedClientDeals), [unmatchedClientDeals]);

  const summaryRows = useMemo(() => {
    if (!detailsLoaded || !report) return [];

    const bonusTotalDeals = num(report.totalBonusClientDeals);
    const liveTotalDeals = Math.max(num(report.totalClientDeals) - bonusTotalDeals, 0);

    const bonusMatches = matches.filter((m) => !!m.isBonus);
    const liveMatches = matches.filter((m) => !m.isBonus);
    const bonusUnmatched = unmatchedClientDeals.filter((u) => !!u.isBonus);
    const liveUnmatched = unmatchedClientDeals.filter((u) => !u.isBonus);

    const matchedLpLots = matches.reduce((s, m) => s + num(m.lpVolume), 0);
    const unmatchedCenLots = unmatchedCentroidOrders.reduce((s, o) => s + num(o.fill_volume || o.volume), 0);
    const unmatchedMt5Lots = unmatchedClientDeals.reduce((s, d) => s + num(d.volume), 0);

    const mt5Lots = unmatchedMt5Lots + matches.reduce((s, m) => s + num(m.clientVolume), 0);
    const liveLots = liveMatches.reduce((s, m) => s + num(m.clientVolume), 0) + liveUnmatched.reduce((s, u) => s + num(u.volume), 0);
    const bonusLots = bonusMatches.reduce((s, m) => s + num(m.clientVolume), 0) + bonusUnmatched.reduce((s, u) => s + num(u.volume), 0);

    return [
      {
        source: "MT5 Deals",
        deals: num(report.totalClientDeals),
        lots: mt5Lots,
        unmatchedDeals: unmatchedClientDeals.length,
        matchPct: num(report.totalClientDeals) > 0 ? (matches.length / num(report.totalClientDeals)) * 100 : 0,
      },
      {
        source: "Client",
        deals: liveTotalDeals,
        lots: liveLots,
        unmatchedDeals: liveUnmatched.length,
        matchPct: liveTotalDeals > 0 ? (liveMatches.length / liveTotalDeals) * 100 : 0,
      },
      {
        source: "Bonus",
        deals: bonusTotalDeals,
        lots: bonusLots,
        unmatchedDeals: bonusUnmatched.length,
        matchPct: bonusTotalDeals > 0 ? (bonusMatches.length / bonusTotalDeals) * 100 : 0,
      },
      {
        source: "Centroid Orders",
        deals: num(report.totalCentroidOrders),
        lots: matchedLpLots + unmatchedCenLots,
        unmatchedDeals: unmatchedCentroidOrders.length,
        matchPct: num(report.totalCentroidOrders) > 0 ? (matches.length / num(report.totalCentroidOrders)) * 100 : 0,
      },
    ];
  }, [detailsLoaded, matches, report, unmatchedCentroidOrders, unmatchedClientDeals]);

  const runMatch = async () => {
    if (!fromDate || !toDate) {
      setError("Please select From and To dates.");
      return;
    }

    const loginTrimmed = login.trim();
    if (loginTrimmed && !/^\d+$/.test(loginTrimmed)) {
      setError("Login must be a positive integer.");
      return;
    }

    setLoading(true);
    setError(null);
    setReport(null);
    setDetailsLoaded(false);
    setStatusLine("Loading...");
    setClientRevenueDetailRows([]);
    setClientRevenueDetailLabel("");
    setSelectedLpDetail(null);
    setSelectedPartial(null);

    const range = ymdToUnixRange(fromDate, toDate);
    const params = new URLSearchParams({
      group: group || "*",
      from: String(range.from),
      to: String(range.to),
      symbol: symbol.trim(),
      lite: "true",
    });
    if (loginTrimmed) params.set("login", loginTrimmed);

    try {
      const resp = await fetch(`${baseUrl}/DealMatch/Run?${params.toString()}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `DealMatch API ${resp.status}`);
      }
      const data = (await resp.json()) as DealMatchResponse;
      setReport(data || {});
      setStatusLine(`${data.fromDate || fromDate} to ${data.toDate || toDate} | ${fmtInt(data.totalClientDeals)} MT5 deals, ${fmtInt(data.totalCentroidOrders)} Centroid orders, ${fmtInt(data.matchedCount)} matched`);
    } catch (e: any) {
      setError(e?.message || "Failed to run deal matching.");
      setStatusLine("");
    } finally {
      setLoading(false);
    }
  };

  const loadMatchDetails = async () => {
    if (!report || detailsLoaded) return;

    const loginTrimmed = login.trim();
    setLoadDetailsLoading(true);
    setError(null);

    const range = ymdToUnixRange(fromDate, toDate);
    const params = new URLSearchParams({
      group: group || "*",
      from: String(range.from),
      to: String(range.to),
      symbol: symbol.trim(),
      lite: "false",
    });
    if (loginTrimmed) params.set("login", loginTrimmed);

    try {
      const resp = await fetch(`${baseUrl}/DealMatch/Run?${params.toString()}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `DealMatch details API ${resp.status}`);
      }
      const data = (await resp.json()) as DealMatchResponse;
      setReport(data || {});
      setDetailsLoaded(true);
      setSummaryOpen(true);
      setSystemsOpen(true);
    } catch (e: any) {
      setError(e?.message || "Failed to load match details.");
    } finally {
      setLoadDetailsLoading(false);
    }
  };

  const onClientRevenueRowClick = async (row: Row) => {
    const selectedLogin = String(row.login || "").trim();
    if (!selectedLogin || selectedLogin === "-") return;

    setClientRevenueDetailLoading(true);
    setClientRevenueDetailRows([]);
    setClientRevenueDetailLabel(`${selectedLogin} | ${safe(row.name)} | loading...`);

    try {
      const resp = await fetch(`${baseUrl}/DealMatch/ClientRevenueDetail?login=${encodeURIComponent(selectedLogin)}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `ClientRevenueDetail API ${resp.status}`);
      }
      const rows = (await resp.json()) as Row[];
      const totalClientLots = (rows || []).reduce((s, r) => s + num(r.clientLotsPlaced), 0);
      const totalLpComm = (rows || []).reduce((s, r) => s + num(r.lpCommissionUsd), 0);
      setClientRevenueDetailRows(Array.isArray(rows) ? rows : []);
      setClientRevenueDetailLabel(`${selectedLogin} | ${safe(row.name)} | ${fmtNum(totalClientLots)} lots | LP comm ${money(totalLpComm)}`);
    } catch (e: any) {
      setClientRevenueDetailRows([]);
      setClientRevenueDetailLabel(`${selectedLogin} | ${safe(row.name)} | Error: ${e?.message || "failed"}`);
    } finally {
      setClientRevenueDetailLoading(false);
    }
  };

  const totalMarkup = num(report?.totalSpreadRevenueUsd);
  const totalClientCommission = num(report?.totalClientCommission);
  const totalLpComm = Math.abs(num(report?.totalLpEffectiveCommission) || num(report?.totalLpCommission) || derivedCoverageLps.reduce((s, x) => s + num(x.effectiveCommission), 0));
  const totalNetRevenue = totalMarkup + totalClientCommission - totalLpComm;

  return (
    <section className="space-y-3 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="rounded-xl border border-slate-200 bg-gradient-to-r from-cyan-50 via-white to-indigo-50 p-3 shadow-sm dark:border-slate-800 dark:from-cyan-500/10 dark:via-slate-900/50 dark:to-indigo-500/10">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-semibold text-cyan-700 dark:text-cyan-200">Deal Match Analysis</h2>
          <label className="text-xs text-slate-600 dark:text-slate-300">Group
            <input value={group} onChange={(e) => setGroup(e.target.value)} className="ml-1 w-16 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">From
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="ml-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">To
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="ml-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">Symbol
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="all" className="ml-1 w-20 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="text-xs text-slate-600 dark:text-slate-300">Login
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="all" className="ml-1 w-24 rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <button
            type="button"
            onClick={runMatch}
            disabled={loading}
            className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-800 shadow-sm transition hover:bg-cyan-500/25 hover:shadow disabled:cursor-not-allowed disabled:opacity-60 dark:text-cyan-100"
          >
            {loading ? "Running..." : "Run Match"}
          </button>
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{statusLine}</span>
        </div>
      </div>

      {error && <div className="rounded border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{error}</div>}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-emerald-300/40 bg-emerald-50 p-2 dark:bg-emerald-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Markup Revenue</div>
              <div className={`mt-1 text-sm font-semibold ${signedClass(totalMarkup)}`}>{money(totalMarkup)}</div>
            </div>
            <div className="rounded-lg border border-amber-300/40 bg-amber-50 p-2 dark:bg-amber-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Commission Revenue</div>
              <div className={`mt-1 text-sm font-semibold ${signedClass(totalClientCommission)}`}>{money(totalClientCommission)}</div>
            </div>
            <div className="rounded-lg border border-rose-300/40 bg-rose-50 p-2 dark:bg-rose-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">LP Commission</div>
              <div className="mt-1 text-sm font-semibold text-rose-700 dark:text-rose-300">-{money(totalLpComm).replace("-", "")}</div>
            </div>
            <div className="rounded-lg border border-cyan-300/50 bg-gradient-to-r from-cyan-50 to-emerald-50 p-2 dark:from-cyan-500/10 dark:to-emerald-500/10">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Total Net Revenue</div>
              <div className={`mt-1 text-sm font-semibold ${signedClass(totalNetRevenue)}`}>{money(totalNetRevenue)}</div>
            </div>
          </div>

          <div className="space-y-2">
            <button type="button" onClick={() => setSummaryOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(summaryOpen)}`}>
              {summaryOpen ? "-" : "+"} Overall Summary - MT5 / Client / Bonus / Centroid
            </button>
            {summaryOpen && (
              <div className="max-h-[30vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                <table className="min-w-full text-[11px]">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left">Source</th>
                      <th className="px-3 py-2 text-right">Deals</th>
                      <th className="px-3 py-2 text-right">Lots</th>
                      <th className="px-3 py-2 text-right">Unmatched</th>
                      <th className="px-3 py-2 text-right">Match %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryRows.map((r) => (
                      <tr key={String(r.source)} className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/30">
                        <td className="px-3 py-2 font-semibold">{r.source}</td>
                        <td className="px-3 py-2 text-right">{fmtInt(r.deals)}</td>
                        <td className="px-3 py-2 text-right">{fmtNum(r.lots)}</td>
                        <td className="px-3 py-2 text-right">{fmtInt(r.unmatchedDeals)}</td>
                        <td className="px-3 py-2 text-right">{fmtNum(r.matchPct)}%</td>
                      </tr>
                    ))}
                    {!summaryRows.length && (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">Load match details to view summary grid.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <button type="button" onClick={() => setSystemsOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(systemsOpen)}`}>
              {systemsOpen ? "-" : "+"} Client Systems - Lots & Commission Charged
            </button>
            {systemsOpen && (
              <div className="max-h-[34vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                <table className="min-w-full text-[11px]">
                  <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                    <tr>
                      <th className="px-3 py-2 text-left">System</th>
                      <th className="px-3 py-2 text-right">Lots</th>
                      <th className="px-3 py-2 text-right">Markup Revenue</th>
                      <th className="px-3 py-2 text-right">Commission Charged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {derivedSystems.map((r, idx) => (
                      <tr key={`sys-${idx}`} className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/30">
                        <td className="px-3 py-2 font-semibold">{safe(r.system)}</td>
                        <td className="px-3 py-2 text-right">{r.lots == null ? "-" : fmtNum(r.lots)}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.markupRevenueUsd)}`}>{money(r.markupRevenueUsd)}</td>
                        <td className={`px-3 py-2 text-right ${signedClass(r.commission)}`}>{money(r.commission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <button type="button" onClick={() => setClientRevenueOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(clientRevenueOpen)}`}>
              {clientRevenueOpen ? "-" : "+"} Revenue by Client
            </button>
            {clientRevenueOpen && (
              <div className="space-y-2">
                <div className="max-h-[38vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                  <table className="min-w-full text-[11px]">
                    <thead className="sticky top-0 bg-slate-100/95 text-slate-700 backdrop-blur dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left">Login</th>
                        <th className="px-3 py-2 text-left">Name</th>
                        <th className="px-3 py-2 text-left">Group</th>
                        <th className="px-3 py-2 text-left">System</th>
                        <th className="px-3 py-2 text-right">Lots</th>
                        <th className="px-3 py-2 text-right">Markup</th>
                        <th className="px-3 py-2 text-right">Client Comm</th>
                        <th className="px-3 py-2 text-right">LP Comm</th>
                        <th className="px-3 py-2 text-right">Total Rev</th>
                      </tr>
                    </thead>
                    <tbody>
                      {derivedClientRevenue.map((r, idx) => (
                        <tr key={`cr-${idx}`} onClick={() => onClientRevenueRowClick(r)} className="cursor-pointer border-t border-slate-200 bg-white hover:bg-cyan-50 dark:border-slate-800 dark:bg-slate-950/30 dark:hover:bg-cyan-500/10">
                          <td className="px-3 py-2 font-mono">{safe(r.login)}</td>
                          <td className="px-3 py-2">{safe(r.name)}</td>
                          <td className="px-3 py-2">{safe(r.group)}</td>
                          <td className="px-3 py-2">{safe(r.system)}</td>
                          <td className="px-3 py-2 text-right">{fmtNum(r.lots)}</td>
                          <td className={`px-3 py-2 text-right ${signedClass(r.markupRevenueUsd)}`}>{money(r.markupRevenueUsd)}</td>
                          <td className={`px-3 py-2 text-right ${signedClass(r.clientCommissionUsd)}`}>{money(r.clientCommissionUsd)}</td>
                          <td className="px-3 py-2 text-right text-rose-700 dark:text-rose-300">{money(r.lpCommissionUsd)}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${signedClass(r.totalRevenueUsd)}`}>{money(r.totalRevenueUsd)}</td>
                        </tr>
                      ))}
                      {!derivedClientRevenue.length && (
                        <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">No client revenue rows.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {(clientRevenueDetailLoading || clientRevenueDetailRows.length > 0 || clientRevenueDetailLabel) && (
                  <div className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-cyan-700 dark:text-cyan-200">Client LP Allocation Detail</h3>
                      <span className="text-xs text-slate-500 dark:text-slate-400">{clientRevenueDetailLabel}</span>
                    </div>
                    {clientRevenueDetailLoading ? (
                      <div className="py-4 text-xs text-slate-500">Loading detail...</div>
                    ) : (
                      <div className="max-h-[30vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                        <table className="min-w-full text-[11px]">
                          <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                            <tr>
                              <th className="px-2 py-1.5 text-left">LP</th>
                              <th className="px-2 py-1.5 text-left">TEM</th>
                              <th className="px-2 py-1.5 text-right">Trades</th>
                              <th className="px-2 py-1.5 text-left">Symbols</th>
                              <th className="px-2 py-1.5 text-right">Client Lots</th>
                              <th className="px-2 py-1.5 text-right">LP Lots</th>
                              <th className="px-2 py-1.5 text-right">Alloc %</th>
                              <th className="px-2 py-1.5 text-right">Markup</th>
                              <th className="px-2 py-1.5 text-right">Client Comm</th>
                              <th className="px-2 py-1.5 text-right">LP Comm</th>
                              <th className="px-2 py-1.5 text-right">Net</th>
                            </tr>
                          </thead>
                          <tbody>
                            {clientRevenueDetailRows.map((r, idx) => {
                              const net = num(r.netRevenueUsd) || (num(r.markupRevenueUsd) + num(r.clientCommissionUsd) - num(r.lpCommissionUsd));
                              return (
                                <tr key={`crd-${idx}`} className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/30">
                                  <td className="px-2 py-1.5">{safe(r.lpsid)}</td>
                                  <td className="px-2 py-1.5">{safe(r.lpName)}</td>
                                  <td className="px-2 py-1.5 text-right">{fmtInt(r.tradeCount)}</td>
                                  <td className="px-2 py-1.5">{safe(r.symbols)}</td>
                                  <td className="px-2 py-1.5 text-right">{fmtNum(r.clientLotsPlaced)}</td>
                                  <td className="px-2 py-1.5 text-right">{fmtNum(r.lpLotsSent)}</td>
                                  <td className="px-2 py-1.5 text-right">{fmtNum(r.allocationPct)}%</td>
                                  <td className={`px-2 py-1.5 text-right ${signedClass(r.markupRevenueUsd)}`}>{money(r.markupRevenueUsd)}</td>
                                  <td className={`px-2 py-1.5 text-right ${signedClass(r.clientCommissionUsd)}`}>{money(r.clientCommissionUsd)}</td>
                                  <td className="px-2 py-1.5 text-right text-rose-700 dark:text-rose-300">{money(r.lpCommissionUsd)}</td>
                                  <td className={`px-2 py-1.5 text-right font-semibold ${signedClass(net)}`}>{money(net)}</td>
                                </tr>
                              );
                            })}
                            {!clientRevenueDetailRows.length && (
                              <tr><td colSpan={11} className="px-2 py-6 text-center text-slate-500">Select a client row to view LP allocation detail.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <button type="button" onClick={() => setCoverageLpOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(coverageLpOpen)}`}>
              {coverageLpOpen ? "-" : "+"} Commission Charged by LP
            </button>
            {coverageLpOpen && (
              <div className="space-y-2">
                <div className="max-h-[38vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                  <table className="min-w-full text-[11px]">
                    <thead className="sticky top-0 bg-slate-100/95 text-slate-700 backdrop-blur dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="px-3 py-2 text-left">LP</th>
                        <th className="px-3 py-2 text-left">Login</th>
                        <th className="px-3 py-2 text-right">Lots</th>
                        <th className="px-3 py-2 text-right">$M</th>
                        <th className="px-3 py-2 text-right">LP Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {derivedCoverageLps.map((r, idx) => (
                        <tr key={`lp-${idx}`} onClick={() => setSelectedLpDetail(r)} className="cursor-pointer border-t border-slate-200 bg-white hover:bg-cyan-50 dark:border-slate-800 dark:bg-slate-950/30 dark:hover:bg-cyan-500/10">
                          <td className="px-3 py-2 font-semibold">{safe(r.lpName)}</td>
                          <td className="px-3 py-2">{safe(r.lpLogin)}</td>
                          <td className="px-3 py-2 text-right">{fmtNum(r.lots)}</td>
                          <td className="px-3 py-2 text-right">{fmtNum(r.millionsUsd)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-cyan-700 dark:text-cyan-300">{money(r.effectiveCommission)}</td>
                        </tr>
                      ))}
                      {!derivedCoverageLps.length && (
                        <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500">No LP coverage rows.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {selectedLpDetail && (
                  <div className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-cyan-700 dark:text-cyan-200">LP Detail</h3>
                      <span className="text-xs text-slate-500 dark:text-slate-400">{safe(selectedLpDetail.lpName)} | {safe(selectedLpDetail.lpLogin)} | {safe(selectedLpDetail.source)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Source</div><div className="font-semibold">{safe(selectedLpDetail.source)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Deals</div><div className="font-semibold">{fmtInt(selectedLpDetail.dealCount)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Method</div><div className="font-semibold">{safe(selectedLpDetail.commissionSource)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Actual Commission</div><div className="font-semibold">{money(selectedLpDetail.actualCommission)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Calculated Commission</div><div className="font-semibold">{money(selectedLpDetail.calculatedCommission)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Configured $/M</div><div className="font-semibold">{fmtNum(selectedLpDetail.configuredRatePerMillion)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Live $/M</div><div className="font-semibold">{fmtNum(selectedLpDetail.effectiveRatePerMillion)}</div></div>
                      <div className="rounded border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-950/30"><div className="text-[10px] text-slate-500">Lots</div><div className="font-semibold">{fmtNum(selectedLpDetail.lots)}</div></div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="rounded-lg border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-amber-700 dark:text-amber-300">Match Details</h3>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Matched / Unmatched / Partial fills - on demand</div>
                </div>
                <button
                  type="button"
                  onClick={loadMatchDetails}
                  disabled={loadDetailsLoading || detailsLoaded}
                  className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-3 py-1.5 text-xs font-semibold text-cyan-800 shadow-sm transition hover:bg-cyan-500/25 hover:shadow disabled:cursor-not-allowed disabled:opacity-60 dark:text-cyan-100"
                >
                  {detailsLoaded ? "Loaded" : loadDetailsLoading ? "Loading..." : "Load Match Details"}
                </button>
              </div>

              {detailsLoaded && (
                <div className="space-y-2">
                  <button type="button" onClick={() => setMatchedOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(matchedOpen)}`}>{matchedOpen ? "-" : "+"} Matched Trades</button>
                  {matchedOpen && (
                    <div className="max-h-[52vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                      <table className="min-w-full text-[11px]">
                        <thead className="sticky top-0 bg-slate-100/95 text-slate-700 backdrop-blur dark:bg-slate-900/90 dark:text-slate-300">
                          <tr>
                            <th className="px-2 py-1.5 text-left">Login</th>
                            <th className="px-2 py-1.5 text-left">Name</th>
                            <th className="px-2 py-1.5 text-left">Symbol</th>
                            <th className="px-2 py-1.5 text-left">Side</th>
                            <th className="px-2 py-1.5 text-left">Entry</th>
                            <th className="px-2 py-1.5 text-right">Client Lots</th>
                            <th className="px-2 py-1.5 text-right">Client Price</th>
                            <th className="px-2 py-1.5 text-right">LP Lots</th>
                            <th className="px-2 py-1.5 text-right">LP Price</th>
                            <th className="px-2 py-1.5 text-right">Markup Rev</th>
                            <th className="px-2 py-1.5 text-right">Client Comm</th>
                            <th className="px-2 py-1.5 text-right">LP Comm</th>
                            <th className="px-2 py-1.5 text-right">Total Rev</th>
                            <th className="px-2 py-1.5 text-left">Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {matches.map((m, idx) => {
                            const totalRev = num(m.spreadRevenueUsd) + num(m.clientCommission) - Math.abs(num(m.lpCommission));
                            return (
                              <tr key={`m-${idx}`} className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/30">
                                <td className="px-2 py-1.5 font-mono">{safe(m.clientLogin)}</td>
                                <td className="px-2 py-1.5">{safe(m.clientName)}</td>
                                <td className="px-2 py-1.5 font-semibold">{safe(m.symbol)}</td>
                                <td className="px-2 py-1.5">{safe(m.side)}</td>
                                <td className="px-2 py-1.5">{safe(m.entry)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(m.clientVolume, 4)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(m.clientPrice, 5)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(m.lpVolume, 4)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(m.lpPrice, 5)}</td>
                                <td className={`px-2 py-1.5 text-right ${signedClass(m.spreadRevenueUsd)}`}>{money(m.spreadRevenueUsd)}</td>
                                <td className={`px-2 py-1.5 text-right ${signedClass(m.clientCommission)}`}>{money(m.clientCommission)}</td>
                                <td className="px-2 py-1.5 text-right text-rose-700 dark:text-rose-300">{money(Math.abs(num(m.lpCommission)))}</td>
                                <td className={`px-2 py-1.5 text-right font-semibold ${signedClass(totalRev)}`}>{money(totalRev)}</td>
                                <td className="px-2 py-1.5">{safe(m.dealTime)}</td>
                              </tr>
                            );
                          })}
                          {!matches.length && <tr><td colSpan={14} className="px-2 py-8 text-center text-slate-500">No matched trades.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <button type="button" onClick={() => setUnmatchedMt5Open((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(unmatchedMt5Open)}`}>{unmatchedMt5Open ? "-" : "+"} Unmatched MT5 Deals by Client</button>
                  {unmatchedMt5Open && (
                    <div className="max-h-[36vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                      <table className="min-w-full text-[11px]">
                        <thead className="sticky top-0 bg-slate-100/95 text-slate-700 backdrop-blur dark:bg-slate-900/90 dark:text-slate-300">
                          <tr>
                            <th className="px-2 py-1.5 text-left">Login</th>
                            <th className="px-2 py-1.5 text-left">Name</th>
                            <th className="px-2 py-1.5 text-left">Group</th>
                            <th className="px-2 py-1.5 text-left">System</th>
                            <th className="px-2 py-1.5 text-right">Deals</th>
                            <th className="px-2 py-1.5 text-right">Lots</th>
                            <th className="px-2 py-1.5 text-right">Buy Lots</th>
                            <th className="px-2 py-1.5 text-right">Sell Lots</th>
                            <th className="px-2 py-1.5 text-left">Symbols</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unmatchedByClientRows.map((r, idx) => (
                            <tr key={`um-${idx}`} className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/30">
                              <td className="px-2 py-1.5 font-mono">{safe(r.login)}</td>
                              <td className="px-2 py-1.5">{safe(r.clientName)}</td>
                              <td className="px-2 py-1.5">{safe(r.group)}</td>
                              <td className="px-2 py-1.5">{safe(r.system)}</td>
                              <td className="px-2 py-1.5 text-right">{fmtInt(r.dealCount)}</td>
                              <td className="px-2 py-1.5 text-right">{fmtNum(r.lots)}</td>
                              <td className="px-2 py-1.5 text-right">{fmtNum(r.buyLots)}</td>
                              <td className="px-2 py-1.5 text-right">{fmtNum(r.sellLots)}</td>
                              <td className="px-2 py-1.5">{safe(r.symbols)}</td>
                            </tr>
                          ))}
                          {!unmatchedByClientRows.length && <tr><td colSpan={9} className="px-2 py-8 text-center text-slate-500">No unmatched MT5 deals.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <button type="button" onClick={() => setUnmatchedCenOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(unmatchedCenOpen)}`}>{unmatchedCenOpen ? "-" : "+"} Unmatched Centroid Orders</button>
                  {unmatchedCenOpen && (
                    <div className="max-h-[36vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                      <table className="min-w-full text-[11px]">
                        <thead className="sticky top-0 bg-slate-100/95 text-slate-700 backdrop-blur dark:bg-slate-900/90 dark:text-slate-300">
                          <tr>
                            <th className="px-2 py-1.5 text-left">Symbol</th>
                            <th className="px-2 py-1.5 text-left">Side</th>
                            <th className="px-2 py-1.5 text-right">LP Exec Price</th>
                            <th className="px-2 py-1.5 text-right">Volume</th>
                            <th className="px-2 py-1.5 text-right">Fill Vol</th>
                            <th className="px-2 py-1.5 text-left">Maker</th>
                            <th className="px-2 py-1.5 text-left">Node Account</th>
                            <th className="px-2 py-1.5 text-left">Login</th>
                            <th className="px-2 py-1.5 text-left">Ext Order</th>
                            <th className="px-2 py-1.5 text-left">Cen Ord ID</th>
                            <th className="px-2 py-1.5 text-left">State</th>
                            <th className="px-2 py-1.5 text-left">Create Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unmatchedCentroidOrders.map((o, idx) => {
                            const execPrice = num(o.avg_price) > 0 ? o.avg_price : o.price;
                            return (
                              <tr key={`ucen-${idx}`} className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/30">
                                <td className="px-2 py-1.5 font-semibold">{safe(o.symbol)}</td>
                                <td className="px-2 py-1.5">{safe(o.side)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(execPrice, 5)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(o.volume, 4)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(o.fill_volume, 4)}</td>
                                <td className="px-2 py-1.5">{safe(o.maker)}</td>
                                <td className="px-2 py-1.5">{safe(o.node_account)}</td>
                                <td className="px-2 py-1.5">{safe(o.ext_login)}</td>
                                <td className="px-2 py-1.5">{safe(o.ext_order) === "0" ? "FIX API" : safe(o.ext_order)}</td>
                                <td className="px-2 py-1.5">{safe(o.cen_ord_id)}</td>
                                <td className="px-2 py-1.5">{safe(o.state)}</td>
                                <td className="px-2 py-1.5">{safe(o.create_time)}</td>
                              </tr>
                            );
                          })}
                          {!unmatchedCentroidOrders.length && <tr><td colSpan={12} className="px-2 py-8 text-center text-slate-500">No unmatched centroid orders.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <button type="button" onClick={() => setPartialOpen((v) => !v)} className={`w-full rounded-lg border px-3 py-2 text-left text-xs font-semibold ${collapseTitleClass(partialOpen)}`}>{partialOpen ? "-" : "+"} Partial Fills</button>
                  {partialOpen && (
                    <div className="space-y-2">
                      <div className="max-h-[28vh] overflow-auto rounded border border-slate-300 shadow-sm dark:border-slate-700">
                        <table className="min-w-full text-[11px]">
                          <thead className="sticky top-0 bg-slate-100/95 text-slate-700 backdrop-blur dark:bg-slate-900/90 dark:text-slate-300">
                            <tr>
                              <th className="px-2 py-1.5 text-left">Deal</th>
                              <th className="px-2 py-1.5 text-left">Login</th>
                              <th className="px-2 py-1.5 text-left">Symbol</th>
                              <th className="px-2 py-1.5 text-left">Side</th>
                              <th className="px-2 py-1.5 text-right">Client Lots</th>
                              <th className="px-2 py-1.5 text-right">LP Lots</th>
                              <th className="px-2 py-1.5 text-left">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {partialRows.map((p, idx) => (
                              <tr key={`pf-${idx}`} onClick={() => setSelectedPartial(p)} className="cursor-pointer border-t border-slate-200 bg-white hover:bg-cyan-50 dark:border-slate-800 dark:bg-slate-950/30 dark:hover:bg-cyan-500/10">
                                <td className="px-2 py-1.5">{safe(p.dealTicket)}</td>
                                <td className="px-2 py-1.5">{safe(p.clientLogin)}</td>
                                <td className="px-2 py-1.5 font-semibold">{safe(p.symbol)}</td>
                                <td className="px-2 py-1.5">{safe(p.side)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(p.clientVolume, 4)}</td>
                                <td className="px-2 py-1.5 text-right">{fmtNum(p.lpVolume, 4)}</td>
                                <td className="px-2 py-1.5">{safe(p.matchStatus)}</td>
                              </tr>
                            ))}
                            {!partialRows.length && <tr><td colSpan={7} className="px-2 py-8 text-center text-slate-500">No partial fills.</td></tr>}
                          </tbody>
                        </table>
                      </div>

                      {selectedPartial && (
                        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                          <div className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                            <h4 className="mb-2 text-xs font-semibold text-cyan-700 dark:text-cyan-200">MT5 Deal Details</h4>
                            <div className="space-y-1 text-xs">
                              {[
                                ["Deal Ticket", selectedPartial.dealTicket],
                                ["Order Ticket", selectedPartial.orderTicket],
                                ["External ID", selectedPartial.externalDealId],
                                ["Login", selectedPartial.clientLogin],
                                ["Name", selectedPartial.clientName],
                                ["Group", selectedPartial.clientGroup],
                                ["Symbol", selectedPartial.symbol],
                                ["Side", selectedPartial.side],
                                ["Entry", selectedPartial.entry],
                                ["Client Price", selectedPartial.clientPrice],
                                ["Client Lots", fmtNum(selectedPartial.clientVolume, 4)],
                                ["Commission", money(selectedPartial.clientCommission)],
                                ["Time", selectedPartial.dealTime],
                              ].map(([k, v]) => (
                                <div key={String(k)} className="flex justify-between border-b border-slate-200 py-0.5 dark:border-slate-800"><span className="text-slate-500">{String(k)}</span><span>{safe(v)}</span></div>
                              ))}
                            </div>
                          </div>
                          <div className="rounded border border-slate-300 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                            <h4 className="mb-2 text-xs font-semibold text-cyan-700 dark:text-cyan-200">Centroid Legs</h4>
                            <div className="space-y-1 text-xs">
                              {[
                                ["LP Name", selectedPartial.lpName],
                                ["LP SID", selectedPartial.lpsid],
                                ["Cen Ord ID", selectedPartial.centroidOrderId],
                                ["Cen Ext Order", selectedPartial.centroidExtOrder],
                                ["LP Price", fmtNum(selectedPartial.lpPrice, 5)],
                                ["LP Lots", fmtNum(selectedPartial.lpVolume, 4)],
                                ["Fill Count", selectedPartial.centroidFillCount],
                                ["Spread", fmtNum(selectedPartial.spread, 6)],
                                ["Spread Revenue", money(selectedPartial.spreadRevenueUsd)],
                                ["LP Commission", money(Math.abs(num(selectedPartial.lpCommission)))],
                                ["Status", selectedPartial.matchStatus],
                                ["Method", selectedPartial.matchMethod],
                              ].map(([k, v]) => (
                                <div key={String(k)} className="flex justify-between border-b border-slate-200 py-0.5 dark:border-slate-800"><span className="text-slate-500">{String(k)}</span><span>{safe(v)}</span></div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}


