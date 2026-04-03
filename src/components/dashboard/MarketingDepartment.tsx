import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Megaphone } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { DepartmentCard } from "./DepartmentCard";
import { useIsMobile } from "@/hooks/use-mobile";

type MarketingProps = {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
  variant?: "full" | "compact";
};

type MetricSummary = {
  activeUsers?: number;
  activeUsersPrev?: number;
  activeUsersDeltaPct?: number;
  newUsers?: number;
  newUsersPrev?: number;
  newUsersDeltaPct?: number;
  newUserPct?: number;
  newUserPctPrev?: number;
  newUserPctDeltaPct?: number;
  pctEngaged?: number;
  pctEngagedPrev?: number;
  pctEngagedDeltaPct?: number;
  pageviewsPerUser?: number;
  pageviewsPerUserPrev?: number;
  pageviewsPerUserDeltaPct?: number;
  engagementTimeSec?: number;
  engagementTimeSecPrev?: number;
  engagementTimeSecDeltaPct?: number;
};

type MarketingData = {
  meta?: {
    source?: string;
    propertyId?: string;
    startDate?: string;
    endDate?: string;
    generatedAt?: string;
    warning?: string;
  };
  main?: {
    sessions?: number;
    activeUsers?: number;
    newUsers?: number;
    returningUsers?: number;
    conversions?: number;
    engagementDuration?: number;
    bounceRate?: number;
  };
  summary?: MetricSummary;
  campaigns?: Array<{
    source?: string;
    medium?: string;
    campaign?: string;
    sessions?: number;
    conversions?: number;
  }>;
  activeUsersByCountry?: Array<{ country: string; activeUsers: number }>;
  userTrend?: Array<{ date: string; label: string; activeUsers: number; newUsers: number; returningUsers: number }>;
  campaignTrend?: Array<{ date: string; label: string; sessions: number; conversions: number }>;
  activeUsersTrend?: Array<{ date: string; label: string; activeUsers: number; previousUsers: number }>;
  monthlyUsersSessions?: Array<{ month: string; label: string; activeUsers: number; sessions: number }>;
  countryTrend?: Array<{ date: string; label: string; country: string; activeUsers: number }>;
  deviceCategory?: Array<{ device: string; activeUsers: number }>;
  osBreakdown?: Array<{ operatingSystem: string; activeUsers: number }>;
  browserBreakdown?: Array<{ browser: string; activeUsers: number }>;
  browserTrend?: Array<{ date: string; label: string; browser: string; activeUsers: number }>;
  sessionSourceTable?: Array<{ source: string; medium: string; sessions: number }>;
  sessionSourceTrend?: Array<{ date: string; label: string; source: string; sessions: number }>;
  topPages?: Array<{ pagePath: string; views: number; activeUsers: number }>;
  topPagesTrend?: Array<{ date: string; label: string; pagePath: string; views: number }>;
  topEvents?: Array<{ eventName: string; eventCount: number; activeUsers: number }>;
  topEventsTrend?: Array<{ date: string; label: string; eventName: string; eventCount: number }>;
};

const SERIES_COLORS = ["#3b82f6", "#ef4444", "#f59e0b", "#10b981", "#8b5cf6", "#06b6d4", "#84cc16"];

function fmtNumber(value: number, max = 0) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: max });
}

function fmtPct(value: number, digits = 1) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

function fmtDuration(seconds: number) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function DeltaBadge({ value }: { value: number }) {
  const positive = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        positive
          ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
      }`}
    >
      {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {fmtPct(Math.abs(value))}
    </span>
  );
}

function SectionRefreshOverlay({ show, rows = 3 }: { show: boolean; rows?: number }) {
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 rounded-xl border border-border/40 bg-background/55 backdrop-blur-[1px]">
      <div className="space-y-2 p-3">
        {Array.from({ length: rows }).map((_, idx) => (
          <div key={idx} className="h-3 animate-pulse rounded bg-muted/70" style={{ width: `${70 - idx * 10}%` }} />
        ))}
      </div>
    </div>
  );
}

function AccordionOrBlock({
  isMobile,
  title,
  defaultOpen = false,
  children,
}: {
  isMobile: boolean;
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  if (!isMobile) return <>{children}</>;
  return (
    <details open={defaultOpen} className="rounded-xl border border-border/40 bg-card/50 p-2">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-1 py-1 text-sm font-semibold text-foreground">
        <span>{title}</span>
        {!defaultOpen && <span className="text-[10px] font-medium text-muted-foreground">Tap to expand</span>}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function buildTrendSeries<T extends { label: string }>(
  rows: T[],
  keyField: keyof T,
  valueField: keyof T,
  topN: number,
) {
  const totals = new Map<string, number>();
  rows.forEach((row) => {
    const key = String(row[keyField] || "-");
    const value = Number(row[valueField] || 0);
    totals.set(key, (totals.get(key) || 0) + value);
  });

  const topKeys = Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key]) => key);

  const byDate = new Map<string, Record<string, number>>();
  rows.forEach((row) => {
    const label = String(row.label || "-");
    const key = String(row[keyField] || "-");
    if (!topKeys.includes(key)) return;
    const value = Number(row[valueField] || 0);
    if (!byDate.has(label)) byDate.set(label, {});
    const bucket = byDate.get(label)!;
    bucket[key] = (bucket[key] || 0) + value;
  });

  return {
    keys: topKeys,
    rows: Array.from(byDate.entries()).map(([label, vals]) => ({ label, ...vals })),
  };
}

function SimpleDataTable({
  title,
  columns,
  rows,
  showRank = false,
  isRefreshing = false,
}: {
  title: string;
  columns: Array<{ key: string; label: string; align?: "left" | "right" }>;
  rows: Array<Record<string, any>>;
  showRank?: boolean;
  isRefreshing?: boolean;
}) {
  return (
    <div className="relative rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
      <div className="mb-2 text-sm font-semibold text-foreground">{title}</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs md:text-sm">
          <thead>
            <tr className="border-b border-border/40 bg-muted/20 text-muted-foreground">
              {showRank && <th className="w-10 px-2 py-1.5 text-left font-medium">#</th>}
              {columns.map((col) => (
                <th key={col.key} className={`px-2 py-1.5 font-medium ${col.align === "right" ? "text-right" : "text-left"}`}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-2 py-3 text-center text-muted-foreground">
                  No data available.
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => (
                <tr key={idx} className="border-b border-border/20 last:border-b-0 odd:bg-muted/5">
                  {showRank && <td className="px-2 py-1.5 text-muted-foreground">{idx + 1}.</td>}
                  {columns.map((col) => (
                    <td key={col.key} className={`px-2 py-1.5 ${col.align === "right" ? "text-right" : "text-left"}`}>
                      {row[col.key]}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <SectionRefreshOverlay show={isRefreshing} rows={2} />
    </div>
  );
}

export function MarketingDepartment({ selectedEntity: _selectedEntity, fromDate, toDate, refreshKey, variant = "full" }: MarketingProps) {
  const isMobile = useIsMobile();
  const [expandCountrySeries, setExpandCountrySeries] = useState(false);
  const [expandBrowserSeries, setExpandBrowserSeries] = useState(false);
  const [expandSourceSeries, setExpandSourceSeries] = useState(false);
  const [expandPagesSeries, setExpandPagesSeries] = useState(false);
  const [expandEventsSeries, setExpandEventsSeries] = useState(false);
  const [metrics, setMetrics] = useState({
    sessions: 0,
    activeUsers: 0,
    newUsers: 0,
    returningUsers: 0,
    conversions: 0,
    engagementDuration: 0,
    bounceRate: 0,
  });
  const [summary, setSummary] = useState<MetricSummary>({});
  const [campaigns, setCampaigns] = useState<MarketingData["campaigns"]>([]);
  const [meta, setMeta] = useState<MarketingData["meta"] | null>(null);
  const [activeUsersByCountry, setActiveUsersByCountry] = useState<MarketingData["activeUsersByCountry"]>([]);
  const [userTrend, setUserTrend] = useState<MarketingData["userTrend"]>([]);
  const [campaignTrend, setCampaignTrend] = useState<MarketingData["campaignTrend"]>([]);
  const [activeUsersTrend, setActiveUsersTrend] = useState<MarketingData["activeUsersTrend"]>([]);
  const [monthlyUsersSessions, setMonthlyUsersSessions] = useState<MarketingData["monthlyUsersSessions"]>([]);
  const [countryTrend, setCountryTrend] = useState<MarketingData["countryTrend"]>([]);
  const [deviceCategory, setDeviceCategory] = useState<MarketingData["deviceCategory"]>([]);
  const [osBreakdown, setOsBreakdown] = useState<MarketingData["osBreakdown"]>([]);
  const [browserBreakdown, setBrowserBreakdown] = useState<MarketingData["browserBreakdown"]>([]);
  const [browserTrend, setBrowserTrend] = useState<MarketingData["browserTrend"]>([]);
  const [sessionSourceTable, setSessionSourceTable] = useState<MarketingData["sessionSourceTable"]>([]);
  const [sessionSourceTrend, setSessionSourceTrend] = useState<MarketingData["sessionSourceTrend"]>([]);
  const [topPages, setTopPages] = useState<MarketingData["topPages"]>([]);
  const [topPagesTrend, setTopPagesTrend] = useState<MarketingData["topPagesTrend"]>([]);
  const [topEvents, setTopEvents] = useState<MarketingData["topEvents"]>([]);
  const [topEventsTrend, setTopEventsTrend] = useState<MarketingData["topEventsTrend"]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const marketingBaseUrl = String((import.meta as any).env?.VITE_MARKETING_API_BASE_URL || "").replace(/\/+$/, "");

  const dateRange = useMemo(() => {
    const end = toDate ? new Date(toDate) : new Date();
    const start = fromDate ? new Date(fromDate) : new Date(end);
    if (!fromDate) start.setDate(end.getDate() - 30);
    const toYmd = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    return { start: toYmd(start), end: toYmd(end) };
  }, [fromDate, toDate]);

  useEffect(() => {
    const controller = new AbortController();
    if (hasLoadedOnce) setIsRefreshing(true);
    else setLoading(true);
    setError(null);

    const fetchData = async () => {
      try {
        const params = new URLSearchParams({ start: dateRange.start, end: dateRange.end });
        const candidateUrls = marketingBaseUrl
          ? [`/api/marketing-insights?${params.toString()}`, `${marketingBaseUrl}/api/marketing-insights?${params.toString()}`]
          : [`/api/marketing-insights?${params.toString()}`];

        let data: MarketingData | null = null;
        let lastError = "";

        for (const url of candidateUrls) {
          try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) {
              const text = await res.text().catch(() => "<no body>");
              lastError = `Marketing API ${res.status}: ${text}`;
              continue;
            }
            const json = (await res.json()) as MarketingData;
            if ((json as any)?.error) {
              lastError = String((json as any).error);
              continue;
            }
            data = json;
            break;
          } catch (e: any) {
            if (e?.name === "AbortError") return;
            lastError = e?.message || "Failed to load marketing insights";
          }
        }

        if (!data) throw new Error(lastError || "Failed to load marketing insights");

        setMetrics((prev) => ({ ...prev, ...(data.main || {}) }));
        setSummary(data.summary || {});
        setCampaigns(Array.isArray(data.campaigns) ? data.campaigns : []);
        setMeta(data.meta || null);
        setActiveUsersByCountry(Array.isArray(data.activeUsersByCountry) ? data.activeUsersByCountry : []);
        setUserTrend(Array.isArray(data.userTrend) ? data.userTrend : []);
        setCampaignTrend(Array.isArray(data.campaignTrend) ? data.campaignTrend : []);
        setActiveUsersTrend(Array.isArray(data.activeUsersTrend) ? data.activeUsersTrend : []);
        setMonthlyUsersSessions(Array.isArray(data.monthlyUsersSessions) ? data.monthlyUsersSessions : []);
        setCountryTrend(Array.isArray(data.countryTrend) ? data.countryTrend : []);
        setDeviceCategory(Array.isArray(data.deviceCategory) ? data.deviceCategory : []);
        setOsBreakdown(Array.isArray(data.osBreakdown) ? data.osBreakdown : []);
        setBrowserBreakdown(Array.isArray(data.browserBreakdown) ? data.browserBreakdown : []);
        setBrowserTrend(Array.isArray(data.browserTrend) ? data.browserTrend : []);
        setSessionSourceTable(Array.isArray(data.sessionSourceTable) ? data.sessionSourceTable : []);
        setSessionSourceTrend(Array.isArray(data.sessionSourceTrend) ? data.sessionSourceTrend : []);
        setTopPages(Array.isArray(data.topPages) ? data.topPages : []);
        setTopPagesTrend(Array.isArray(data.topPagesTrend) ? data.topPagesTrend : []);
        setTopEvents(Array.isArray(data.topEvents) ? data.topEvents : []);
        setTopEventsTrend(Array.isArray(data.topEventsTrend) ? data.topEventsTrend : []);
        setHasLoadedOnce(true);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setError(e?.message || "Failed to load marketing insights");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    };

    fetchData();
    return () => controller.abort();
  }, [refreshKey, dateRange.start, dateRange.end, marketingBaseUrl, hasLoadedOnce]);

  const summaryCards = useMemo(
    () => [
      {
        label: "Active users",
        value: fmtNumber(Number(summary.activeUsers || metrics.activeUsers), 0),
        delta: Number(summary.activeUsersDeltaPct || 0),
      },
      {
        label: "New users",
        value: fmtNumber(Number(summary.newUsers || metrics.newUsers), 0),
        delta: Number(summary.newUsersDeltaPct || 0),
      },
      {
        label: "New User %",
        value: fmtPct(Number(summary.newUserPct || 0), 0),
        delta: Number(summary.newUserPctDeltaPct || 0),
      },
      {
        label: "Pct Engaged",
        value: fmtPct(Number(summary.pctEngaged || 0), 0),
        delta: Number(summary.pctEngagedDeltaPct || 0),
      },
      {
        label: "Pageviews per User",
        value: Number(summary.pageviewsPerUser || 0).toFixed(1),
        delta: Number(summary.pageviewsPerUserDeltaPct || 0),
      },
      {
        label: "Engagement Time",
        value: fmtDuration(Number(summary.engagementTimeSec || 0)),
        delta: Number(summary.engagementTimeSecDeltaPct || 0),
      },
    ],
    [summary, metrics.activeUsers, metrics.newUsers],
  );

  const devicePie = useMemo(
    () => (deviceCategory || []).map((row, idx) => ({ name: String(row.device || "Unknown"), value: Number(row.activeUsers || 0), color: SERIES_COLORS[idx % SERIES_COLORS.length] })),
    [deviceCategory],
  );

  const browserTrendSeries = useMemo(() => buildTrendSeries(browserTrend || [], "browser", "activeUsers", 5), [browserTrend]);
  const countryTrendSeries = useMemo(() => buildTrendSeries(countryTrend || [], "country", "activeUsers", 5), [countryTrend]);
  const sourceTrendSeries = useMemo(() => buildTrendSeries(sessionSourceTrend || [], "source", "sessions", 5), [sessionSourceTrend]);
  const topPagesTrendSeries = useMemo(() => buildTrendSeries(topPagesTrend || [], "pagePath", "views", 5), [topPagesTrend]);
  const topEventsTrendSeries = useMemo(() => buildTrendSeries(topEventsTrend || [], "eventName", "eventCount", 5), [topEventsTrend]);

  const visibleCountryKeys = useMemo(
    () => (isMobile && !expandCountrySeries ? countryTrendSeries.keys.slice(0, 3) : countryTrendSeries.keys),
    [isMobile, expandCountrySeries, countryTrendSeries.keys],
  );
  const visibleBrowserKeys = useMemo(
    () => (isMobile && !expandBrowserSeries ? browserTrendSeries.keys.slice(0, 3) : browserTrendSeries.keys),
    [isMobile, expandBrowserSeries, browserTrendSeries.keys],
  );
  const visibleSourceKeys = useMemo(
    () => (isMobile && !expandSourceSeries ? sourceTrendSeries.keys.slice(0, 3) : sourceTrendSeries.keys),
    [isMobile, expandSourceSeries, sourceTrendSeries.keys],
  );
  const visiblePagesKeys = useMemo(
    () => (isMobile && !expandPagesSeries ? topPagesTrendSeries.keys.slice(0, 3) : topPagesTrendSeries.keys),
    [isMobile, expandPagesSeries, topPagesTrendSeries.keys],
  );
  const visibleEventsKeys = useMemo(
    () => (isMobile && !expandEventsSeries ? topEventsTrendSeries.keys.slice(0, 3) : topEventsTrendSeries.keys),
    [isMobile, expandEventsSeries, topEventsTrendSeries.keys],
  );

  const totalSessionsBySource = useMemo(() => {
    return (sessionSourceTable || []).reduce((sum, row) => sum + Number(row.sessions || 0), 0);
  }, [sessionSourceTable]);

  const compactCountryRows = useMemo(
    () => [...(activeUsersByCountry || [])].sort((a, b) => Number(b.activeUsers || 0) - Number(a.activeUsers || 0)).slice(0, 8),
    [activeUsersByCountry],
  );

  const compactUserTrend = useMemo(() => {
    if ((userTrend || []).length > 0) return userTrend;
    return (activeUsersTrend || []).map((row) => ({
      date: row.date,
      label: row.label,
      activeUsers: Number(row.activeUsers || 0),
      newUsers: 0,
      returningUsers: Number(row.activeUsers || 0),
    }));
  }, [userTrend, activeUsersTrend]);

  const compactCampaignTrend = useMemo(() => {
    if ((campaignTrend || []).length > 0) return campaignTrend;
    return [];
  }, [campaignTrend]);

  if (variant === "compact") {
    return (
      <DepartmentCard title="Marketing" icon={Megaphone} accentColor="destructive">
        {loading && !hasLoadedOnce ? (
          <div className="py-8 text-center text-muted-foreground">Loading marketing insights...</div>
        ) : (
          <div className="space-y-3">
            {error && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-2">
                <div className="text-[11px] text-primary">Sessions</div>
                <div className="font-mono text-2xl font-semibold text-foreground">{fmtNumber(metrics.sessions || 0, 0)}</div>
                <div className="text-[11px] text-muted-foreground">Website Traffic</div>
              </div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-2">
                <div className="text-[11px] text-emerald-700 dark:text-emerald-300">Active Users</div>
                <div className="font-mono text-2xl font-semibold text-foreground">{fmtNumber(metrics.activeUsers || 0, 0)}</div>
                <div className="text-[11px] text-muted-foreground">Selected Range</div>
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2">
                <div className="text-[11px] text-amber-700 dark:text-amber-300">New Users</div>
                <div className="font-mono text-2xl font-semibold text-foreground">{fmtNumber(metrics.newUsers || 0, 0)}</div>
                <div className="text-[11px] text-muted-foreground">Selected Range</div>
              </div>
              <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-2">
                <div className="text-[11px] text-sky-700 dark:text-sky-300">Conversions</div>
                <div className="font-mono text-2xl font-semibold text-foreground">{fmtNumber(metrics.conversions || 0, 0)}</div>
                <div className="text-[11px] text-muted-foreground">Selected Range</div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="rounded-lg border border-border/40 bg-card/60 p-2">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Bounce Rate</span>
                  <span className="font-mono text-primary">{fmtPct(Number(metrics.bounceRate || 0), 2)}</span>
                </div>
                <div className="h-2 rounded bg-muted/50">
                  <div className="h-2 rounded bg-primary" style={{ width: `${Math.min(100, Number(metrics.bounceRate || 0))}%` }} />
                </div>
              </div>
              <div className="rounded-lg border border-border/40 bg-card/60 p-2">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Engagement Duration</span>
                  <span className="font-mono text-primary">{(Number(metrics.engagementDuration || 0) / 60).toFixed(1)} min</span>
                </div>
                <div className="h-2 rounded bg-muted/50">
                  <div className="h-2 rounded bg-emerald-500" style={{ width: `${Math.min(100, (Number(metrics.engagementDuration || 0) / 120) * 100)}%` }} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-border/40 bg-card/60 p-2">
                <div className="mb-2 flex items-center justify-between text-xs font-semibold text-muted-foreground">
                  <span>Active Users by Country</span>
                  <span className="font-mono text-primary">Total {fmtNumber(compactCountryRows.reduce((s, r) => s + Number(r.activeUsers || 0), 0), 0)}</span>
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={compactCountryRows} layout="vertical" margin={{ left: 8, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="country" width={120} tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Bar dataKey="activeUsers" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="rounded-lg border border-border/40 bg-card/60 p-2">
                <div className="mb-2 text-xs font-semibold text-muted-foreground">New vs Returning Users</div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={compactUserTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="newUsers" name="new" stroke="#2563eb" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="returningUsers" name="returning" stroke="#65a30d" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/60 p-2">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">Campaign Performance</div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={compactCampaignTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="sessions" name="sessions" stroke="#3b82f6" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="conversions" name="conversions" stroke="#10b981" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </DepartmentCard>
    );
  }

  return (
    <DepartmentCard title="Marketing" icon={Megaphone} accentColor="destructive">
      {loading && !hasLoadedOnce ? (
        <div className="py-12 text-center text-muted-foreground">Loading marketing insights...</div>
      ) : (
        <div className="space-y-5">
          <div className="sticky top-2 z-20 rounded-lg border border-border/60 bg-background/90 px-3 py-2 text-xs backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">Date range: {dateRange.start} to {dateRange.end}</span>
              <span className="text-muted-foreground">
                {meta?.source ? `Source: ${meta.source}` : "Source: -"}
                {meta?.generatedAt ? ` | Updated: ${new Date(meta.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                {isRefreshing ? " | Refreshing..." : ""}
              </span>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {error}
            </div>
          )}

          <AccordionOrBlock isMobile={isMobile} title="Summary" defaultOpen>
          <div className="relative rounded-xl border border-border/50 bg-card/80 p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-2xl font-semibold text-foreground">Summary</div>
              <div className="text-[11px] text-muted-foreground">
                {dateRange.start} to {dateRange.end}
                {meta?.generatedAt ? ` | ${new Date(meta.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                {isRefreshing ? " | Refreshing..." : ""}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {summaryCards.map((card) => (
                <div key={card.label} className="rounded-lg border border-border/40 bg-background/80 p-3">
                  <div className="text-xs text-muted-foreground">{card.label}</div>
                  <div className="mt-1 font-mono text-4xl leading-none font-semibold text-foreground">{card.value}</div>
                  <div className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
                    <DeltaBadge value={card.delta} />
                    <span>vs Prev Period</span>
                  </div>
                </div>
              ))}
            </div>
            <SectionRefreshOverlay show={isRefreshing} rows={3} />
          </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Trends" defaultOpen>
          <div className="relative rounded-xl border border-border/50 bg-card/80 p-4 shadow-sm">
            <div className="mb-2 text-2xl font-semibold text-foreground">Trends</div>
            <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={activeUsersTrend || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="activeUsers" name="Active users" stroke="#2563eb" strokeWidth={2.2} dot={false} />
                  <Line type="monotone" dataKey="previousUsers" name="Prev period" stroke="#93c5fd" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <SectionRefreshOverlay show={isRefreshing} rows={2} />
          </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Active users and Sessions by Month">
            <div className="relative rounded-xl border border-border/50 bg-card/80 p-4 shadow-sm">
              <div className="mb-2 text-[32px] leading-tight font-semibold text-foreground">Active users and Sessions by Month</div>
              <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyUsersSessions || []} layout="vertical" margin={{ left: 12, right: 12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis type="number" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={60} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="activeUsers" name="Active users" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="sessions" name="Sessions" fill="#ef4444" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <SectionRefreshOverlay show={isRefreshing} rows={2} />
            </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Active users over time by Country">
            <div className="relative rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
              <div className="mb-2 text-sm font-semibold text-foreground">Active users over time by Country</div>
              {isMobile && countryTrendSeries.keys.length > 3 && (
                <button
                  type="button"
                  onClick={() => setExpandCountrySeries((v) => !v)}
                  className="mb-2 rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  {expandCountrySeries ? "Show top 3" : `Show all (${countryTrendSeries.keys.length})`}
                </button>
              )}
              <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={countryTrendSeries.rows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    {!isMobile && <Legend wrapperStyle={{ fontSize: 11 }} />}
                    {visibleCountryKeys.map((key, idx) => (
                      <Line key={key} type="monotone" dataKey={key} stroke={SERIES_COLORS[idx % SERIES_COLORS.length]} strokeWidth={2} dot={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <SectionRefreshOverlay show={isRefreshing} rows={2} />
            </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Device and Operating System">
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <div className="rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
              <div className="mb-2 text-sm font-semibold text-foreground">Device category by Active users</div>
              <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={devicePie} dataKey="value" nameKey="name" outerRadius={85} label={(entry) => `${entry.name} ${fmtPct((entry.percent || 0) * 100, 1)}`}>
                      {devicePie.map((entry, idx) => (
                        <Cell key={`cell-${entry.name}-${idx}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
              <div className="mb-2 text-sm font-semibold text-foreground">Active users by Operating system</div>
              <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={osBreakdown || []} layout="vertical" margin={{ left: 12, right: 12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis type="number" />
                    <YAxis type="category" dataKey="operatingSystem" width={110} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="activeUsers" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Browser Insights">
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <div className="rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
              <div className="mb-2 text-sm font-semibold text-foreground">Active users by Browser</div>
              <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={browserBreakdown || []} layout="vertical" margin={{ left: 12, right: 12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis type="number" />
                    <YAxis type="category" dataKey="browser" width={90} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="activeUsers" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
              <div className="mb-2 text-sm font-semibold text-foreground">Active users over time by Browser</div>
              {isMobile && browserTrendSeries.keys.length > 3 && (
                <button
                  type="button"
                  onClick={() => setExpandBrowserSeries((v) => !v)}
                  className="mb-2 rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  {expandBrowserSeries ? "Show top 3" : `Show all (${browserTrendSeries.keys.length})`}
                </button>
              )}
              <div className="h-64 rounded-lg border border-border/40 bg-background/40 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={browserTrendSeries.rows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    {!isMobile && <Legend wrapperStyle={{ fontSize: 11 }} />}
                    {visibleBrowserKeys.map((key, idx) => (
                      <Line key={key} type="monotone" dataKey={key} stroke={SERIES_COLORS[idx % SERIES_COLORS.length]} strokeWidth={2} dot={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Sessions over time by Session source">
          <div className="relative rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-foreground">Sessions over time by Session source</div>
            {isMobile && sourceTrendSeries.keys.length > 3 && (
              <button
                type="button"
                onClick={() => setExpandSourceSeries((v) => !v)}
                className="mb-2 rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
              >
                {expandSourceSeries ? "Show top 3" : `Show all (${sourceTrendSeries.keys.length})`}
              </button>
            )}
            <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sourceTrendSeries.rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  {!isMobile && <Legend wrapperStyle={{ fontSize: 11 }} />}
                  {visibleSourceKeys.map((key, idx) => (
                    <Line key={key} type="monotone" dataKey={key} stroke={SERIES_COLORS[idx % SERIES_COLORS.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <SectionRefreshOverlay show={isRefreshing} rows={2} />
          </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Page Views over time">
          <div className="relative rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-foreground">Page Views over time</div>
            {isMobile && topPagesTrendSeries.keys.length > 3 && (
              <button
                type="button"
                onClick={() => setExpandPagesSeries((v) => !v)}
                className="mb-2 rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
              >
                {expandPagesSeries ? "Show top 3" : `Show all (${topPagesTrendSeries.keys.length})`}
              </button>
            )}
            <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={topPagesTrendSeries.rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  {!isMobile && <Legend wrapperStyle={{ fontSize: 11 }} />}
                  {visiblePagesKeys.map((key, idx) => (
                    <Line key={key} type="monotone" dataKey={key} stroke={SERIES_COLORS[idx % SERIES_COLORS.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <SectionRefreshOverlay show={isRefreshing} rows={2} />
          </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Event count over time">
          <div className="relative rounded-xl border border-border/40 bg-card/70 p-3 shadow-sm">
            <div className="mb-2 text-sm font-semibold text-foreground">Event count over time</div>
            {isMobile && topEventsTrendSeries.keys.length > 3 && (
              <button
                type="button"
                onClick={() => setExpandEventsSeries((v) => !v)}
                className="mb-2 rounded border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
              >
                {expandEventsSeries ? "Show top 3" : `Show all (${topEventsTrendSeries.keys.length})`}
              </button>
            )}
            <div className="h-56 md:h-64 rounded-lg border border-border/40 bg-background/40 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={topEventsTrendSeries.rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  {!isMobile && <Legend wrapperStyle={{ fontSize: 11 }} />}
                  {visibleEventsKeys.map((key, idx) => (
                    <Line key={key} type="monotone" dataKey={key} stroke={SERIES_COLORS[idx % SERIES_COLORS.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <SectionRefreshOverlay show={isRefreshing} rows={2} />
          </div>
          </AccordionOrBlock>

          <AccordionOrBlock isMobile={isMobile} title="Final Tables" defaultOpen={isMobile ? false : true}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <SimpleDataTable
              title="Top Pages"
              showRank
              isRefreshing={isRefreshing}
              columns={[
                { key: "page", label: "Page path" },
                { key: "views", label: "Views", align: "right" },
                { key: "pct", label: "% Views", align: "right" },
                { key: "activeUsers", label: "Active users", align: "right" },
              ]}
              rows={(topPages || []).map((row) => {
                const totalViews = (topPages || []).reduce((sum, item) => sum + Number(item.views || 0), 0);
                const views = Number(row.views || 0);
                const pct = totalViews > 0 ? (views / totalViews) * 100 : 0;
                return {
                  page: row.pagePath || "/",
                  views: fmtNumber(views, 0),
                  pct: fmtPct(pct, 1),
                  activeUsers: fmtNumber(Number(row.activeUsers || 0), 0),
                };
              })}
            />

            <SimpleDataTable
              title="Session source table"
              showRank
              isRefreshing={isRefreshing}
              columns={[
                { key: "source", label: "Session source" },
                { key: "medium", label: "Session medium" },
                { key: "sessions", label: "Sessions", align: "right" },
                { key: "pct", label: "% Sessions", align: "right" },
              ]}
              rows={(sessionSourceTable || []).map((row) => {
                const sessions = Number(row.sessions || 0);
                const pct = totalSessionsBySource > 0 ? (sessions / totalSessionsBySource) * 100 : 0;
                return {
                  source: row.source || "(not set)",
                  medium: row.medium || "(none)",
                  sessions: fmtNumber(sessions, 0),
                  pct: fmtPct(pct, 1),
                };
              })}
            />

            <SimpleDataTable
              title="Top Events"
              showRank
              isRefreshing={isRefreshing}
              columns={[
                { key: "event", label: "Event name" },
                { key: "count", label: "Event count", align: "right" },
                { key: "pct", label: "% Events", align: "right" },
                { key: "activeUsers", label: "Active users", align: "right" },
              ]}
              rows={(topEvents || []).map((row) => {
                const totalEvents = (topEvents || []).reduce((sum, item) => sum + Number(item.eventCount || 0), 0);
                const count = Number(row.eventCount || 0);
                const pct = totalEvents > 0 ? (count / totalEvents) * 100 : 0;
                return {
                  event: row.eventName || "(not set)",
                  count: fmtNumber(count, 0),
                  pct: fmtPct(pct, 1),
                  activeUsers: fmtNumber(Number(row.activeUsers || 0), 0),
                };
              })}
            />

            <SimpleDataTable
              title="Active users by country"
              showRank
              isRefreshing={isRefreshing}
              columns={[
                { key: "country", label: "Country" },
                { key: "activeUsers", label: "Active users", align: "right" },
              ]}
              rows={(activeUsersByCountry || []).map((row) => ({
                country: row.country,
                activeUsers: fmtNumber(Number(row.activeUsers || 0), 0),
              }))}
            />
          </div>
          </AccordionOrBlock>

          {meta?.warning && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {meta.warning}
            </div>
          )}
        </div>
      )}
    </DepartmentCard>
  );
}
