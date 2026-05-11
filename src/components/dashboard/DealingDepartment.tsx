import { useEffect, useState } from 'react';
import { TrendingUp, Users, DollarSign, Activity } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { ForexTicker } from './ForexTicker';
import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { getDealsByGroup, getPositionsByGroup, getSummaryByGroup } from '@/lib/dealingApi';

interface DepartmentProps {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
}

interface DealingMetrics {
  totalEquity: number;
  totalCredit: number;
  clientsWithCredit: number;
  totalLots: number;
  buyLots: number;
  sellLots: number;
  totalVolume: number;
  tradingProfit: number;
  dealCount: number;
}

interface SymbolActivity {
  symbol: string;
  positions: number;
  netExposureLots: number;
  subSymbols: Array<{ symbol: string; netExposureLots: number }>;
}

interface LiveLotsPoint {
  snapshotTime: string;
  label: string;
  totalLots: number;
  totalVolume: number;
}

const defaultMetrics: DealingMetrics = {
  totalEquity: 0,
  totalCredit: 0,
  clientsWithCredit: 0,
  totalLots: 0,
  buyLots: 0,
  sellLots: 0,
  totalVolume: 0,
  tradingProfit: 0,
  dealCount: 0,
};

const DEAL_VOLUME_DIVISOR = 10_000;
const DEAL_VOLUME_EXT_DIVISOR = 100_000_000;

const getUtcDayStartFromLocalDate = (date: Date) => {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0));
};

const getUtcDayEndFromLocalDate = (date: Date) => {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999));
};

const addUtcDays = (date: Date, days: number) => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const isUtcTodaySelection = (from?: Date, to?: Date) => {
  const now = new Date();
  const todayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const todayEndUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const selectedFromUtc = getUtcDayStartFromLocalDate(from ?? new Date());
  const selectedToUtc = getUtcDayEndFromLocalDate(to ?? new Date());
  return selectedFromUtc.getTime() === todayStartUtc.getTime() && selectedToUtc.getTime() === todayEndUtc.getTime();
};

const normalizeSymbol = (symbol: string) => {
  const trimmed = symbol.trim();
  const dotIndex = trimmed.indexOf('.');
  return dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
};

const getDealLots = (lots: number, volume: number, volumeExt: number) => {
  if (lots > 0) return lots;
  if (volumeExt > 0) return volumeExt / DEAL_VOLUME_EXT_DIVISOR;
  return volume / DEAL_VOLUME_DIVISOR;
};

const getDealVolume = (deal: {
  value: number;
  lots: number;
  volume: number;
  volumeExt: number;
  price: number;
  contractSize: number;
}) => {
  if (deal.value > 0) return deal.value;
  const lots = getDealLots(deal.lots, deal.volume, deal.volumeExt);
  if (deal.price > 0 && deal.contractSize > 0) {
    return lots * deal.price * deal.contractSize;
  }
  return 0;
};

export function DealingDepartment({ selectedEntity: _selectedEntity, fromDate, toDate, refreshKey }: DepartmentProps) {
  const [metrics, setMetrics] = useState<DealingMetrics>(defaultMetrics);
  const [topSymbols, setTopSymbols] = useState<SymbolActivity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [liveLotsSeries, setLiveLotsSeries] = useState<LiveLotsPoint[]>([]);

  const formatSnapshotTime = (value: string) => {
    const dt = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(dt.getTime())) return value;
    const h = String(dt.getHours()).padStart(2, '0');
    const m = String(dt.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  };

  const buildSnapshotTimeKey = () => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const h = String(now.getUTCHours()).padStart(2, '0');
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:00`;
  };

  useEffect(() => {
    let cancelled = false;

    const loadLiveLotsSeries = async () => {
      try {
        const response = await fetch('/api/dealing-client-lots-snapshots?hours=72');
        if (!response.ok) return;
        const payload = await response.json();
        if (payload?.warning) {
          console.warn('[Dealing Client Lots] history warning:', payload.warning, payload?.message || '');
        } else {
          console.info('[Dealing Client Lots] history DB connected, rows:', Array.isArray(payload?.rows) ? payload.rows.length : 0);
        }
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const mapped = rows
          .map((row: any) => {
            const snapshotTime = String(row?.snapshotTime || '').trim();
            if (!snapshotTime) return null;
            return {
              snapshotTime,
              label: formatSnapshotTime(snapshotTime),
              totalLots: Number(row?.totalLots ?? 0) || 0,
              totalVolume: Number(row?.totalVolume ?? 0) || 0,
            } satisfies LiveLotsPoint;
          })
          .filter((row: LiveLotsPoint | null): row is LiveLotsPoint => Boolean(row));
        if (!cancelled) setLiveLotsSeries(mapped.slice(-120));
      } catch {
        // ignore
      }
    };

    const upsertLiveLotsPoint = async (point: LiveLotsPoint) => {
      try {
        const response = await fetch('/api/dealing-client-lots-snapshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            snapshotTime: point.snapshotTime,
            totalLots: point.totalLots,
            totalVolume: point.totalVolume,
            source: 'dashboard',
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (payload?.ok) {
          console.info('[Dealing Client Lots] snapshot saved:', point.snapshotTime);
        } else if (payload?.warning || payload?.error) {
          console.warn('[Dealing Client Lots] snapshot warning:', payload?.warning || payload?.error, payload?.message || '');
        }
      } catch {
        // ignore
      }
    };

    const fetchLiveData = async () => {
      if (cancelled) return;
      setIsLoading(true);

      try {
        const effectiveFromDate = fromDate ?? new Date();
        const effectiveToDate = toDate ?? new Date();
        const fromUtc = getUtcDayStartFromLocalDate(effectiveFromDate);
        const toUtc = getUtcDayEndFromLocalDate(effectiveToDate);
        const apiToUtcExclusive = addUtcDays(getUtcDayStartFromLocalDate(effectiveToDate), 1);
        const isToday = isUtcTodaySelection(effectiveFromDate, effectiveToDate);

        const group = '*';

        const summaryPromise = getSummaryByGroup({ group, from: fromUtc, to: apiToUtcExclusive });
        const positionsPromise = isToday ? getPositionsByGroup({ group }) : Promise.resolve([]);
        const dealsPromise = isToday ? getDealsByGroup({ group, from: fromUtc, to: apiToUtcExclusive }) : Promise.resolve([]);

        const [summary, positions, deals] = await Promise.all([summaryPromise, positionsPromise, dealsPromise]);
        if (cancelled) return;

        const symbolPositionsMap = new Map<
          string,
          { positions: number; netExposureLots: number; subSymbols: Map<string, number> }
        >();

        positions.forEach((position) => {
          const rawSymbol = position.symbol || 'UNKNOWN';
          const symbol = normalizeSymbol(rawSymbol);
          const lots = position.lots;
          const isSell = Number(position.action) === 1;
          const signedLots = isSell ? -lots : lots;
          const existing = symbolPositionsMap.get(symbol) || { positions: 0, netExposureLots: 0, subSymbols: new Map() };
          existing.subSymbols.set(rawSymbol, (existing.subSymbols.get(rawSymbol) || 0) + signedLots);
          symbolPositionsMap.set(symbol, {
            positions: existing.positions + 1,
            netExposureLots: existing.netExposureLots + signedLots,
            subSymbols: existing.subSymbols,
          });
        });

        const topSymbolsData = Array.from(symbolPositionsMap.entries())
          .map(([symbol, data]) => ({
            symbol,
            positions: data.positions,
            netExposureLots: data.netExposureLots,
            subSymbols: Array.from(data.subSymbols.entries())
              .map(([subSymbol, netExposureLots]) => ({ symbol: subSymbol, netExposureLots }))
              .sort((a, b) => Math.abs(b.netExposureLots) - Math.abs(a.netExposureLots)),
          }))
          .sort((a, b) => Math.abs(b.netExposureLots) - Math.abs(a.netExposureLots))
          .slice(0, 6);

        const buyLots = isToday
          ? deals.reduce((sum, deal) => {
              if (deal.action !== 0) return sum;
              return sum + getDealLots(deal.lots, deal.volume, deal.volumeExt);
            }, 0)
          : summary.netLotsBuy;
        const sellLots = isToday
          ? deals.reduce((sum, deal) => {
              if (deal.action !== 1) return sum;
              return sum + getDealLots(deal.lots, deal.volume, deal.volumeExt);
            }, 0)
          : summary.netLotsSell;
        const totalLots = buyLots + sellLots;
        const totalVolume = isToday ? deals.reduce((sum, deal) => sum + getDealVolume(deal), 0) : 0;

        setTopSymbols(topSymbolsData);
        setMetrics({
          totalEquity: summary.currentEquity,
          totalCredit: summary.currentCredit,
          clientsWithCredit: summary.creditCount,
          totalLots,
          buyLots,
          sellLots,
          totalVolume,
          tradingProfit: summary.tradingProfit,
          dealCount: isToday ? deals.length : summary.dealCount,
        });
        setHasData(
          (isToday ? deals.length > 0 : summary.dealCount > 0) ||
          summary.currentEquity > 0 ||
          summary.currentCredit > 0 ||
          (isToday ? positions.length > 0 : false)
        );
        if (isToday) {
          const snapshotTime = buildSnapshotTimeKey();
          const point = {
            snapshotTime,
            label: formatSnapshotTime(snapshotTime),
            totalLots,
            totalVolume,
          } satisfies LiveLotsPoint;
          await upsertLiveLotsPoint(point);
          if (!cancelled) {
            setLiveLotsSeries((prev) => {
              const withoutCurrent = prev.filter((p) => p.snapshotTime !== point.snapshotTime);
              return [...withoutCurrent, point].slice(-120);
            });
          }
        }
      } catch {
        if (!cancelled) {
          setMetrics(defaultMetrics);
          setTopSymbols([]);
          setHasData(false);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadLiveLotsSeries();
    fetchLiveData();
    const interval = setInterval(fetchLiveData, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fromDate, toDate, refreshKey]);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const formatShortDateUtc = (date: Date) => {
    return `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')}`;
  };

  const labelFrom = getUtcDayStartFromLocalDate(fromDate ?? new Date());
  const labelTo = getUtcDayEndFromLocalDate(toDate ?? new Date());
  const periodLabel = `${formatShortDateUtc(labelFrom)}-${formatShortDateUtc(labelTo)}`;
  const modeLabel = isUtcTodaySelection(fromDate, toDate) ? 'Live' : 'Reports';
  const totalVolumeDisplay = modeLabel === 'Live' ? metrics.totalVolume.toLocaleString() : 'N/A';

  return (
    <DepartmentCard title="Dealing (Client)" icon={TrendingUp} accentColor="primary">
      <div>
        <div className="text-xs text-muted-foreground mb-2">Top Symbols (Net Exposure)</div>
        <ForexTicker items={topSymbols} isLoading={isLoading} />
      </div>

      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">Total Lots</span>
          <span className="text-[10px] text-muted-foreground font-mono">{modeLabel}</span>
        </div>
        <div style={{ height: 56 }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={liveLotsSeries.length ? liveLotsSeries : [{ snapshotTime: '', label: '', totalLots: metrics.totalLots, totalVolume: metrics.totalVolume }]}>
              <defs>
                <linearGradient id="totalLotsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(186 100% 50%)" stopOpacity={0.42} />
                  <stop offset="100%" stopColor="hsl(186 100% 50%)" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="totalVolumeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.14} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748b' }} minTickGap={26} />
              <YAxis yAxisId="lots" hide domain={['auto', 'auto']} />
              <YAxis yAxisId="volume" hide domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{
                  background: 'rgba(15,23,42,0.92)',
                  border: '1px solid rgba(148,163,184,0.35)',
                  borderRadius: 8,
                  color: '#e2e8f0',
                  fontSize: 11,
                }}
                labelStyle={{ color: '#cbd5e1' }}
                formatter={(value: number, name: string) => {
                  if (name === 'totalVolume') return [`$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`, 'Total Volume'];
                  return [Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 }), 'Total Lots'];
                }}
                labelFormatter={(label) => `Time: ${label}`}
              />
              <Area
                type="monotone"
                dataKey="totalLots"
                yAxisId="lots"
                stroke="hsl(186 100% 50%)"
                strokeWidth={2.2}
                fill="url(#totalLotsGradient)"
                dot={false}
                isAnimationActive
              />
              <Area
                type="monotone"
                yAxisId="volume"
                dataKey="totalVolume"
                stroke="#22c55e"
                strokeWidth={1.6}
                fill="url(#totalVolumeGradient)"
                dot={false}
                isAnimationActive
              />
              <Line type="monotone" yAxisId="volume" dataKey="totalVolume" stroke="#22c55e" strokeWidth={2.1} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-cyan-400" />Total Lots</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" />Total Volume</span>
        </div>
      </div>

      {!hasData && !isLoading && (
        <div className="text-[11px] text-warning/90">
          No dealing data returned. Check group or date range.
        </div>
      )}

      <div className="space-y-1 pt-2 border-t border-border/30">
        <MetricRow
          label={`Total Equity (${periodLabel})`}
          value={metrics.totalEquity}
          prefix="$"
          icon={<DollarSign className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Total Credit (${periodLabel})`}
          value={metrics.totalCredit}
          prefix="$"
          icon={<DollarSign className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Total Lots (${periodLabel})`}
          value={metrics.totalLots.toFixed(2)}
          suffix=" lots"
          icon={<Activity className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Buy Lots (${periodLabel})`}
          value={metrics.buyLots.toFixed(2)}
          suffix=" lots"
          icon={<Activity className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Sell Lots (${periodLabel})`}
          value={metrics.sellLots.toFixed(2)}
          suffix=" lots"
          icon={<Activity className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Total Volume (${periodLabel})`}
          value={totalVolumeDisplay}
          prefix={modeLabel === 'Live' ? '$' : ''}
          icon={<DollarSign className="w-3.5 h-3.5" />}
        />
      </div>
    </DepartmentCard>
  );
}
