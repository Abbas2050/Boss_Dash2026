import { useEffect, useState } from 'react';
import { TrendingUp, Users, DollarSign, Activity } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { ForexTicker } from './ForexTicker';
import { MiniChart } from './MiniChart';
import { getMT5AccountsBatch, getMT5DailyReportsBatch, getMT5PositionsBatch, getMT5UserLogins, getMT5DealsBatch } from '@/lib/mt5Api';
import type { MT5AccountState, MT5Position, MT5DailyReport, MT5Trade } from '@/lib/mt5Types';

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
  totalLotsLive: number;
  buyLotsLive: number;
  sellLotsLive: number;
  totalVolume: number;
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
  totalLots: 0,
  totalLotsLive: 0,
  buyLotsLive: 0,
  sellLotsLive: 0,
  totalVolume: 0,
};

// MT5 volume divisors (from MT5 docs):
//   Volume:    1 unit = 1/10,000 lot
//   VolumeExt: 1 unit = 1/100,000,000 lot (higher precision)
const MT5_VOLUME_DIVISOR = 10_000;
const MT5_VOLUME_EXT_DIVISOR = 100_000_000;

const toNum = (value: unknown) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const getLots = (volume: number | string, volumeExt?: number | string) => {
  const volExt = toNum(volumeExt);
  if (volExt > 0) return volExt / MT5_VOLUME_EXT_DIVISOR;
  return toNum(volume) / MT5_VOLUME_DIVISOR;
};

const normalizeSymbol = (symbol: string) => {
  const trimmed = symbol.trim();
  const dotIndex = trimmed.indexOf('.');
  return dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
};

const getUtcDayStartFromLocalDate = (date: Date) => {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0));
};

const getUtcDayEndFromLocalDate = (date: Date) => {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999));
};

const isUtcTodaySelection = (from?: Date, to?: Date) => {
  const now = new Date();
  const todayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const todayEndUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const selectedFromUtc = getUtcDayStartFromLocalDate(from ?? new Date());
  const selectedToUtc = getUtcDayEndFromLocalDate(to ?? new Date());
  return selectedFromUtc.getTime() === todayStartUtc.getTime() && selectedToUtc.getTime() === todayEndUtc.getTime();
};


export function DealingDepartment({ selectedEntity, fromDate, toDate, refreshKey }: DepartmentProps) {
  const [metrics, setMetrics] = useState<DealingMetrics>(defaultMetrics);
  const [topSymbols, setTopSymbols] = useState<SymbolActivity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [dataSnapshot, setDataSnapshot] = useState({
    positions: 0,
    accounts: 0,
    reports: 0,
  });

  useEffect(() => {
    let cancelled = false;

    const fetchLiveData = async () => {
      if (cancelled) return;
      setIsLoading(true);

      try {
        // Dealing section uses UTC day boundaries for MT5
        const effectiveFromDate = fromDate ?? new Date();
        const effectiveToDate = toDate ?? new Date();

        const mt5FromDate = getUtcDayStartFromLocalDate(effectiveFromDate);
        const mt5ToDate = getUtcDayEndFromLocalDate(effectiveToDate);

        const reportsFrom = Math.floor(mt5FromDate.getTime() / 1000);
        const reportsTo = Math.floor(mt5ToDate.getTime() / 1000);


        const mt5Groups = ['skylinkscapital\\*'];

        // Check if querying TODAY's data (real-time) or PAST data (historical)
        const isToday = isUtcTodaySelection(effectiveFromDate, effectiveToDate);

        // Get positions for symbol breakdown
        const positionsResponse = await getMT5PositionsBatch({ groups: mt5Groups, fields: ['Login', 'Symbol', 'Volume', 'VolumeExt', 'Action'] });
        if (cancelled) return;
        const positions: MT5Position[] = positionsResponse.success && positionsResponse.data ? positionsResponse.data : [];

        // Get deals for period-based calculations (volume)
        const dealsResponse = await getMT5DealsBatch({
          groups: mt5Groups,
          from: reportsFrom,
          to: reportsTo,
          fields: ['Volume', 'VolumeExt', 'Price', 'ContractSize'],
        });
        if (cancelled) return;
        const deals: MT5Trade[] = dealsResponse.success && dealsResponse.data ? dealsResponse.data : [];




        let accounts: MT5AccountState[] = [];
        let reports: MT5DailyReport[] = [];

        // For TODAY: Use accounts-batch endpoint (real-time/live data)
        if (isToday) {
          const accountsResponse = await getMT5AccountsBatch({ groups: mt5Groups, fields: ['Login', 'Equity', 'Credit'] });
          if (cancelled) return;

          accounts = accountsResponse.success && accountsResponse.data ? accountsResponse.data : [];

          if (accounts.length === 0) {
            const loginsResponse = await getMT5UserLogins({ groups: mt5Groups });
            if (cancelled) return;
            const logins = loginsResponse.success && loginsResponse.data ? loginsResponse.data : [];
            if (logins.length > 0) {
              const fallbackAccountsResponse = await getMT5AccountsBatch({ logins, fields: ['Login', 'Equity', 'Credit'] });
              if (cancelled) return;
              accounts = fallbackAccountsResponse.success && fallbackAccountsResponse.data ? fallbackAccountsResponse.data : [];
            }
          }
        }
        // For PAST dates: Use daily-batch endpoint (historical reports)
        else {
          const reportsResponse = await getMT5DailyReportsBatch({
            groups: mt5Groups,
            from: reportsFrom,
            to: reportsTo,
            fields: ['Login', 'Timestamp', 'ProfitEquity', 'Balance', 'Profit', 'Credit'],
          });
          if (cancelled) return;
          reports = reportsResponse.success && reportsResponse.data ? reportsResponse.data : [];
        }

        const symbolPositionsMap = new Map<
          string,
          { positions: number; netExposureLots: number; subSymbols: Map<string, number> }
        >();
        positions.forEach((position) => {
          const rawSymbol = position.Symbol || 'UNKNOWN';
          const symbol = normalizeSymbol(rawSymbol);
          const lots = getLots(position.Volume, position.VolumeExt);
          const isSell = Number(position.Action) === 1;
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

        // Calculate Total Lots from DEALS (period)
        const totalLots = deals.reduce((sum, deal) => sum + getLots(deal.Volume, deal.VolumeExt), 0);

        // Calculate Total Lots (live) from OPEN POSITIONS (buy vs sell)
        const buyLotsLive = positions.reduce((sum, position) => {
          const lots = getLots(position.Volume, position.VolumeExt);
          return Number(position.Action) === 1 ? sum : sum + lots;
        }, 0);
        const sellLotsLive = positions.reduce((sum, position) => {
          const lots = getLots(position.Volume, position.VolumeExt);
          return Number(position.Action) === 1 ? sum + lots : sum;
        }, 0);
        const totalLotsLive = buyLotsLive + sellLotsLive;

        // Calculate Total Volume (notional) from DEALS in period
        const totalVolume = deals.reduce((sum, deal) => {
          const contractSize = toNum(deal.ContractSize);
          const lots = getLots(deal.Volume, deal.VolumeExt);
          const price = toNum(deal.Price);
          const notional = contractSize && price ? lots * price * contractSize : 0;
          return sum + notional;
        }, 0);

        // Calculate metrics based on data source (TODAY vs PAST)
        let totalEquity = 0;
        let totalCredit = 0;
        let clientsWithCredit = 0;

        if (isToday && accounts.length > 0) {
          totalEquity = accounts.reduce((sum, account) => sum + toNum(account.Equity), 0);
          totalCredit = accounts.reduce((sum, account) => sum + toNum(account.Credit), 0);
          clientsWithCredit = accounts.filter((account) => toNum(account.Credit) > 0).length;
        } else if (!isToday && reports.length > 0) {
          const latestReportByLogin = new Map<number, MT5DailyReport>();
          reports.forEach((report) => {
            const login = report.Login;
            const ts = Number(report.Timestamp) || 0;
            const existing = latestReportByLogin.get(login);
            const existingTs = existing ? Number(existing.Timestamp) || 0 : 0;
            if (!existing || ts > existingTs) {
              latestReportByLogin.set(login, report);
            }
          });

          const latestReports = Array.from(latestReportByLogin.values());

          totalEquity = latestReports.reduce((sum, report) => {
            const equity = toNum(report.ProfitEquity);
            if (equity > 0) return sum + equity;
            const balance = toNum(report.Balance);
            const profit = toNum(report.Profit);
            return sum + balance + profit;
          }, 0);

          totalCredit = latestReports.reduce((sum, report) => sum + toNum(report.Credit), 0);
          clientsWithCredit = latestReports.filter((report) => toNum(report.Credit) > 0).length;
        }

        if (cancelled) return;

        setTopSymbols(topSymbolsData);
        setMetrics({
          totalEquity,
          totalCredit,
          clientsWithCredit,
          totalLots,
          totalLotsLive,
          buyLotsLive,
          sellLotsLive,
          totalVolume,
        });
        setDataSnapshot({
          positions: positions.length,
          accounts: accounts.length,
          reports: deals.length,
        });
      } catch (error) {
        // silently ignore
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
  }, [fromDate, toDate, refreshKey, selectedEntity]);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const formatShortDateUtc = (date: Date) => {
    return `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')}`;
  };

  // Build date label based on UTC day boundaries
  const labelFrom = getUtcDayStartFromLocalDate(fromDate ?? new Date());
  const labelTo = getUtcDayEndFromLocalDate(toDate ?? new Date());
  const periodLabel = `${formatShortDateUtc(labelFrom)}–${formatShortDateUtc(labelTo)}`;
  const dataSourceLabel = isUtcTodaySelection(fromDate, toDate) ? 'UTC today (live)' : 'UTC (reports)';

  return (
    <DepartmentCard title="Dealing" icon={TrendingUp} accentColor="primary">
      <div>
        <div className="text-xs text-muted-foreground mb-2">Top Symbols (Net Exposure)</div>
        <ForexTicker items={topSymbols} isLoading={isLoading} />
      </div>

      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">Total Lots (live)</span>
          <span className="text-[10px] text-muted-foreground font-mono">1m refresh</span>
        </div>
        <MiniChart
          color="hsl(186 100% 50%)"
          value={metrics.totalLotsLive}
          variant="area"
          height={48}
        />
      </div>

      {dataSnapshot.positions === 0 && dataSnapshot.accounts === 0 && !isLoading && (
        <div className="text-[11px] text-warning/90">
          No MT5 data returned. Check MT5 proxy, groups, or date range.
        </div>
      )}

      <div className="space-y-1 pt-2 border-t border-border/30">
        <MetricRow
          label={`Total Equity (${periodLabel}, ${dataSourceLabel})`}
          value={metrics.totalEquity}
          prefix="$"
          icon={<DollarSign className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Total Credit (${periodLabel}, ${dataSourceLabel})`}
          value={metrics.totalCredit}
          prefix="$"
          icon={<DollarSign className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Clients with Credit (${periodLabel}, ${dataSourceLabel})`}
          value={metrics.clientsWithCredit}
          icon={<Users className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Total Lots (${periodLabel})`}
          value={metrics.totalLots.toFixed(2)}
          suffix=" lots"
          icon={<Activity className="w-3.5 h-3.5" />}
        />
        <MetricRow
          label={`Total Volume (${periodLabel})`}
          value={metrics.totalVolume.toLocaleString()}
          prefix="$"
          icon={<DollarSign className="w-3.5 h-3.5" />}
        />
      </div>
    </DepartmentCard>
  );
}
