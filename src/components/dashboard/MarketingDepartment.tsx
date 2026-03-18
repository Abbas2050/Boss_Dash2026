import { useEffect, useMemo, useState } from "react";
import { Megaphone, UserPlus, Target, TrendingUp } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { DepartmentCard } from "./DepartmentCard";
import { ProgressBar } from "./ProgressBar";

type MarketingProps = {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
};

type MarketingData = {
  meta?: {
    source?: string;
    propertyId?: string;
    startDate?: string;
    endDate?: string;
    generatedAt?: string;
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
  campaigns?: Array<{
    source?: string;
    medium?: string;
    campaign?: string;
    sessions?: number;
    conversions?: number;
  }>;
  activeUsersByCountry?: Array<{ country: string; activeUsers: number }>;
  userTrend?: Array<{
    date: string;
    label: string;
    activeUsers: number;
    newUsers: number;
    returningUsers: number;
  }>;
  campaignTrend?: Array<{
    date: string;
    label: string;
    sessions: number;
    conversions: number;
  }>;
};

const COUNTRY_COORDS: Record<string, { lat: number; lon: number }> = {
  "united states": { lat: 37.1, lon: -95.7 },
  usa: { lat: 37.1, lon: -95.7 },
  canada: { lat: 56.1, lon: -106.3 },
  mexico: { lat: 23.6, lon: -102.5 },
  brazil: { lat: -14.2, lon: -51.9 },
  uk: { lat: 55.3, lon: -3.4 },
  "united kingdom": { lat: 55.3, lon: -3.4 },
  france: { lat: 46.2, lon: 2.2 },
  germany: { lat: 51.2, lon: 10.4 },
  italy: { lat: 41.9, lon: 12.6 },
  spain: { lat: 40.5, lon: -3.7 },
  netherlands: { lat: 52.1, lon: 5.3 },
  russia: { lat: 61.5, lon: 105.3 },
  turkey: { lat: 39.0, lon: 35.2 },
  uae: { lat: 24.4, lon: 54.4 },
  "united arab emirates": { lat: 24.4, lon: 54.4 },
  saudi: { lat: 23.9, lon: 45.1 },
  "saudi arabia": { lat: 23.9, lon: 45.1 },
  india: { lat: 20.6, lon: 78.9 },
  pakistan: { lat: 30.4, lon: 69.3 },
  china: { lat: 35.9, lon: 104.2 },
  japan: { lat: 36.2, lon: 138.3 },
  korea: { lat: 36.5, lon: 127.8 },
  "south korea": { lat: 36.5, lon: 127.8 },
  singapore: { lat: 1.3, lon: 103.8 },
  australia: { lat: -25.3, lon: 133.8 },
  "south africa": { lat: -30.6, lon: 22.9 },
  nigeria: { lat: 9.1, lon: 8.7 },
  egypt: { lat: 26.8, lon: 30.8 },
};

function getCountryCoords(country: string) {
  const key = String(country || "").trim().toLowerCase();
  return COUNTRY_COORDS[key];
}

function countryCode(country: string): string {
  const key = String(country || "").trim().toLowerCase();
  const flags: Record<string, string> = {
    "united arab emirates": "AE",
    uae: "AE",
    "united states": "US",
    usa: "US",
    pakistan: "PK",
    china: "CN",
    singapore: "SG",
    india: "IN",
    "united kingdom": "UK",
    uk: "UK",
    germany: "DE",
    france: "FR",
    italy: "IT",
    spain: "ES",
    canada: "CA",
    brazil: "BR",
    australia: "AU",
    japan: "JP",
    "south korea": "KR",
    korea: "KR",
    saudi: "SA",
    "saudi arabia": "SA",
    turkey: "TR",
    russia: "RU",
    egypt: "EG",
    nigeria: "NG",
    "south africa": "ZA",
    netherlands: "NL",
    mexico: "MX",
  };
  return flags[key] || "--";
}

export function MarketingDepartment({
  selectedEntity: _selectedEntity,
  fromDate,
  toDate,
  refreshKey,
}: MarketingProps) {
  const [metrics, setMetrics] = useState({
    sessions: 0,
    activeUsers: 0,
    newUsers: 0,
    returningUsers: 0,
    conversions: 0,
    engagementDuration: 0,
    bounceRate: 0,
  });
  const [campaigns, setCampaigns] = useState<MarketingData["campaigns"]>([]);
  const [meta, setMeta] = useState<MarketingData["meta"] | null>(null);
  const [activeUsersByCountry, setActiveUsersByCountry] = useState<
    MarketingData["activeUsersByCountry"]
  >([]);
  const [userTrend, setUserTrend] = useState<MarketingData["userTrend"]>([]);
  const [campaignTrend, setCampaignTrend] = useState<MarketingData["campaignTrend"]>([]);
  const [loading, setLoading] = useState(true);
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
    setLoading(true);
    setError(null);

    const fetchData = async () => {
      try {
        const params = new URLSearchParams({
          start: dateRange.start,
          end: dateRange.end,
        });

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

        if (!data) {
          throw new Error(lastError || "Failed to load marketing insights");
        }

        setMetrics((prev) => ({ ...prev, ...(data.main || {}) }));
        setCampaigns(Array.isArray(data.campaigns) ? data.campaigns : []);
        setMeta(data.meta || null);
        setActiveUsersByCountry(
          Array.isArray(data.activeUsersByCountry) ? data.activeUsersByCountry : []
        );
        setUserTrend(Array.isArray(data.userTrend) ? data.userTrend : []);
        setCampaignTrend(Array.isArray(data.campaignTrend) ? data.campaignTrend : []);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setError(e?.message || "Failed to load marketing insights");
        setCampaigns([]);
        setMeta(null);
        setActiveUsersByCountry([]);
        setUserTrend([]);
        setCampaignTrend([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchData();
    return () => controller.abort();
  }, [refreshKey, dateRange.start, dateRange.end, marketingBaseUrl]);

  const countryRows = useMemo(() => {
    return [...(activeUsersByCountry || [])]
      .filter((r) => r && Number(r.activeUsers) > 0)
      .sort((a, b) => Number(b.activeUsers || 0) - Number(a.activeUsers || 0))
      .slice(0, 8);
  }, [activeUsersByCountry]);

  const countryTotal = useMemo(
    () => countryRows.reduce((sum, row) => sum + Number(row.activeUsers || 0), 0),
    [countryRows]
  );

  const countryMapPoints = useMemo(() => {
    const rows = countryRows
      .map((r) => {
        const coords = getCountryCoords(r.country);
        if (!coords) return null;
        return {
          country: r.country,
          activeUsers: Number(r.activeUsers || 0),
          ...coords,
        };
      })
      .filter(Boolean) as Array<{ country: string; activeUsers: number; lat: number; lon: number }>;
    const maxUsers = rows.reduce((m, r) => Math.max(m, r.activeUsers), 1);
    // Dynamic zoom bounds based on visible points.
    let minX = 0;
    let minY = 0;
    let maxX = 1000;
    let maxY = 420;
    if (rows.length > 0) {
      const xs = rows.map((p) => ((p.lon + 180) / 360) * 1000);
      const ys = rows.map((p) => ((90 - p.lat) / 180) * 420);
      const padX = 55;
      const padY = 35;
      minX = Math.max(0, Math.min(...xs) - padX);
      maxX = Math.min(1000, Math.max(...xs) + padX);
      minY = Math.max(0, Math.min(...ys) - padY);
      maxY = Math.min(420, Math.max(...ys) + padY);
      // Prevent over-zooming on tiny ranges.
      if (maxX - minX < 220) {
        const c = (maxX + minX) / 2;
        minX = Math.max(0, c - 110);
        maxX = Math.min(1000, c + 110);
      }
      if (maxY - minY < 90) {
        const c = (maxY + minY) / 2;
        minY = Math.max(0, c - 45);
        maxY = Math.min(420, c + 45);
      }
    }
    return { rows, maxUsers, viewBox: `${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}` };
  }, [countryRows]);

  const userTrendResolved = useMemo(() => {
    if (userTrend && userTrend.length > 0) return userTrend;
    const totalNew = Number(metrics.newUsers || 0);
    const totalReturning = Number(metrics.returningUsers || 0);
    if (totalNew === 0 && totalReturning === 0) return [];
    return [
      {
        date: `${dateRange.end}`,
        label: "Selected Range",
        activeUsers: Number(metrics.activeUsers || 0),
        newUsers: totalNew,
        returningUsers: totalReturning,
      },
    ];
  }, [userTrend, metrics.newUsers, metrics.returningUsers, dateRange.start, dateRange.end]);

  return (
    <DepartmentCard title="Marketing" icon={Megaphone} accentColor="destructive">
      {loading ? (
        <div className="py-12 text-center text-muted-foreground">
          Loading marketing insights...
        </div>
      ) : error ? (
        <div className="py-8 px-4 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
              <div className="flex items-center gap-1 text-primary mb-1">
                <Target className="w-3.5 h-3.5" />
                <span className="text-xs">Sessions</span>
              </div>
              <div className="font-mono font-semibold text-lg">
                {metrics.sessions.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">Website Traffic</div>
            </div>
            <div className="p-2 rounded-lg bg-success/10 border border-success/20">
              <div className="flex items-center gap-1 text-success mb-1">
                <UserPlus className="w-3.5 h-3.5" />
                <span className="text-xs">Active Users</span>
              </div>
              <div className="font-mono font-semibold text-lg">
                {metrics.activeUsers.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">Selected Range</div>
            </div>
            <div className="p-2 rounded-lg bg-warning/10 border border-warning/20">
              <div className="flex items-center gap-1 text-warning mb-1">
                <UserPlus className="w-3.5 h-3.5" />
                <span className="text-xs">New Users</span>
              </div>
              <div className="font-mono font-semibold text-lg">
                {metrics.newUsers.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">Selected Range</div>
            </div>

            <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
              <div className="flex items-center gap-1 text-primary mb-1">
                <TrendingUp className="w-3.5 h-3.5" />
                <span className="text-xs">Conversions</span>
              </div>
              <div className="font-mono font-semibold text-lg">
                {metrics.conversions.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">Selected Range</div>
            </div>
          </div>

          <div className="pt-2 border-t border-border/30 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">Bounce Rate</span>
                <span className="text-xs font-mono text-primary">
                  {metrics.bounceRate.toFixed(2)}%
                </span>
              </div>
              <ProgressBar
                value={metrics.bounceRate}
                color={
                  metrics.bounceRate < 40
                    ? "success"
                    : metrics.bounceRate < 60
                      ? "warning"
                      : "destructive"
                }
                label="Bounce Rate"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">
                  Engagement Duration
                </span>
                <span className="text-xs font-mono text-primary">
                  {(metrics.engagementDuration / 60).toFixed(1)} min
                </span>
              </div>
              <ProgressBar
                value={Math.min(metrics.engagementDuration / 60, 100)}
                color={metrics.engagementDuration / 60 > 2 ? "success" : "warning"}
                label="Avg. Engagement (min)"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-border/30 grid grid-cols-1 xl:grid-cols-2 gap-3">
            <div className="rounded-xl border border-border/40 bg-gradient-to-br from-primary/10 to-primary/0 p-2">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wide">
                  Active Users by Country
                </div>
                <div className="text-[11px] font-mono text-primary">
                  Total {countryTotal.toLocaleString()}
                </div>
              </div>
              <div className="mb-2 flex items-center justify-between text-[10px] text-muted-foreground">
                <span className="px-2 py-0.5 rounded bg-primary/15 text-primary border border-primary/30 font-mono">
                  {meta?.source === "google-analytics-4" ? "GA4 LIVE DATA" : "SOURCE UNKNOWN"}
                </span>
                {meta?.generatedAt && (
                  <span>
                    {new Date(meta.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-12 h-64 rounded-lg border border-border/40 bg-background/30 overflow-hidden relative">
                  <svg viewBox={countryMapPoints.viewBox} className="w-full h-full">
                    <defs>
                      <linearGradient id="mapBg" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="rgba(59,130,246,0.12)" />
                        <stop offset="100%" stopColor="rgba(14,165,233,0.04)" />
                      </linearGradient>
                    </defs>
                    <rect x="0" y="0" width="1000" height="420" fill="url(#mapBg)" />
                    {[70, 140, 210, 280, 350].map((y) => (
                      <line key={`lat-${y}`} x1="0" y1={y} x2="1000" y2={y} stroke="rgba(148,163,184,0.12)" strokeWidth="1" />
                    ))}
                    {[125, 250, 375, 500, 625, 750, 875].map((x) => (
                      <line key={`lon-${x}`} x1={x} y1="0" x2={x} y2="420" stroke="rgba(148,163,184,0.10)" strokeWidth="1" />
                    ))}

                    {countryMapPoints.rows.map((p) => {
                      const x = ((p.lon + 180) / 360) * 1000;
                      const y = ((90 - p.lat) / 180) * 420;
                      const r = 4 + (p.activeUsers / countryMapPoints.maxUsers) * 8;
                      const code = countryCode(p.country);
                      return (
                        <g key={`${p.country}-${x}-${y}`}>
                          <circle cx={x} cy={y} r={r + 4} fill="rgba(56,189,248,0.18)" />
                          <circle cx={x} cy={y} r={r} fill="rgba(14,165,233,0.9)" stroke="rgba(255,255,255,0.8)" strokeWidth="1.2" />
                          <text
                            x={x + r + 7}
                            y={y + 4}
                            fill="rgba(226,232,240,0.98)"
                            fontSize="16"
                            fontWeight="700"
                            fontFamily="ui-sans-serif, system-ui"
                          >
                            {p.country} ({code}) {p.activeUsers}
                          </text>
                          <title>{`${p.country}: ${p.activeUsers}`}</title>
                        </g>
                      );
                    })}
                  </svg>
                </div>
                {countryMapPoints.rows.length === 0 && (
                  <div className="col-span-12 text-xs text-muted-foreground">
                    No mappable country coordinates found for the current data.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-border/40 bg-gradient-to-br from-success/10 to-success/0 p-2">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wide">
                  New vs Returning users
                </div>
                <div className="text-[11px] font-mono text-success">
                  {dateRange.start} to {dateRange.end}
                </div>
              </div>
              <div className="h-52 rounded-lg border border-border/40 bg-background/30 p-2">
                {userTrendResolved && userTrendResolved.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={userTrendResolved}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="newUsers" name="new" stroke="#3b82f6" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="returningUsers" name="returning" stroke="#65a30d" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                    No user trend data available for selected dates.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="pt-2 border-t border-border/30">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">Campaign Performance</span>
              <span className="text-xs text-muted-foreground">{dateRange.start} to {dateRange.end}</span>
            </div>
              <div className="h-52 rounded-lg border border-border/40 bg-background/30 p-2">
                {(campaignTrend && campaignTrend.length > 0) || (campaigns && campaigns.length > 0) ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={
                        campaignTrend && campaignTrend.length > 0
                          ? campaignTrend
                          : campaigns
                              .slice()
                              .sort((a, b) => (b.sessions || 0) - (a.sessions || 0))
                              .slice(0, 12)
                              .map((c) => ({
                                label: c.campaign || `${c.source || "unknown"} / ${c.medium || ""}`,
                                sessions: Number(c.sessions || 0),
                                conversions: Number(c.conversions || 0),
                              }))
                      }
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--background))",
                        border: "1px solid hsl(var(--border))",
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="sessions" name="sessions" stroke="#3b82f6" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="conversions" name="conversions" stroke="#10b981" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  No campaign data available.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </DepartmentCard>
  );
}

