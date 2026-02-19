import { useEffect, useState } from 'react';
import { TrendingUp, Users, DollarSign, Activity } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { ForexTicker } from './ForexTicker';
import { MiniChart } from './MiniChart';
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
  netLots: number;
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

const defaultMetrics: DealingMetrics = {
  totalEquity: 0,
  totalCredit: 0,
  clientsWithCredit: 0,
  netLots: 0,
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

  useEffect(() => {
    let cancelled = false;

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
        const netLots = isToday ? buyLots - sellLots : summary.netLots;
        const totalVolume = isToday ? deals.reduce((sum, deal) => sum + getDealVolume(deal), 0) : 0;

        setTopSymbols(topSymbolsData);
        setMetrics({
          totalEquity: summary.currentEquity,
          totalCredit: summary.currentCredit,
          clientsWithCredit: summary.creditCount,
          netLots,
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
    <DepartmentCard title="Dealing" icon={TrendingUp} accentColor="primary">
      <div>
        <div className="text-xs text-muted-foreground mb-2">Top Symbols (Net Exposure)</div>
        <ForexTicker items={topSymbols} isLoading={isLoading} />
      </div>

      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">Net Lots</span>
          <span className="text-[10px] text-muted-foreground font-mono">{modeLabel}</span>
        </div>
        <MiniChart
          color="hsl(186 100% 50%)"
          value={metrics.netLots}
          variant="area"
          height={48}
        />
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
          label={`Clients with Credit (${periodLabel})`}
          value={metrics.clientsWithCredit}
          icon={<Users className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Net Lots (${periodLabel})`}
          value={metrics.netLots.toFixed(2)}
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
        <MetricRow
          label={`Trading Profit (${periodLabel})`}
          value={metrics.tradingProfit.toLocaleString()}
          prefix="$"
          icon={<DollarSign className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Deals (${periodLabel})`}
          value={metrics.dealCount}
          icon={<Activity className="w-3.5 h-3.5" />}
        />
      </div>
    </DepartmentCard>
  );
}
