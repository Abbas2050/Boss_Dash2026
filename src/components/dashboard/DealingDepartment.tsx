import { useEffect, useState } from 'react';
import { TrendingUp, Users, DollarSign, Activity } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { ForexTicker } from './ForexTicker';
import { MiniChart } from './MiniChart';
import { getDubaiDate, getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';
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
  totalVolume: number;
}

interface SymbolActivity {
  symbol: string;
  positions: number;
}

const defaultMetrics: DealingMetrics = {
  totalEquity: 0,
  totalCredit: 0,
  clientsWithCredit: 0,
  totalLots: 0,
  totalVolume: 0,
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
        // Always use the selected/applied dates, never fall back
        const effectiveFromDate = fromDate ?? getDubaiDayStart();
        const effectiveToDate = toDate ?? getDubaiDayEnd();

        const mt5FromDate = new Date(effectiveFromDate);
        mt5FromDate.setHours(0, 0, 0, 0);
        const mt5ToDate = new Date(effectiveToDate);
        mt5ToDate.setHours(23, 59, 59, 999);

        const reportsFrom = Math.floor(mt5FromDate.getTime() / 1000);
        const reportsTo = Math.floor(mt5ToDate.getTime() / 1000);

        const mt5Groups = ['*'];

        // Check if querying TODAY's data (real-time) or PAST data (historical)
        const dubaiNow = getDubaiDate();
        const todayStart = new Date(dubaiNow);
        todayStart.setHours(0, 0, 0, 0);
        const isToday = mt5ToDate >= todayStart;

        // Get positions for symbol breakdown
        const positionsResponse = await getMT5PositionsBatch({ groups: mt5Groups });
        if (cancelled) return;
        const positions: MT5Position[] = positionsResponse.success && positionsResponse.data ? positionsResponse.data : [];

        // Get deals for total lots calculation
        const dealsResponse = await getMT5DealsBatch({ groups: mt5Groups, from: reportsFrom, to: reportsTo });
        if (cancelled) return;
        const deals: MT5Trade[] = dealsResponse.success && dealsResponse.data ? dealsResponse.data : [];

        let accounts: MT5AccountState[] = [];
        let reports: MT5DailyReport[] = [];

        // For TODAY: Use accounts-batch endpoint (real-time/live data)
        if (isToday) {
          const positionLogins = Array.from(new Set(positions.map((position) => position.Login).filter(Boolean)));
          const accountsResponse = positionLogins.length > 0
            ? await getMT5AccountsBatch({ logins: positionLogins })
            : await getMT5AccountsBatch({ groups: mt5Groups });
          if (cancelled) return;

          accounts = accountsResponse.success && accountsResponse.data ? accountsResponse.data : [];

          if (accounts.length === 0) {
            const loginsResponse = await getMT5UserLogins({ groups: mt5Groups });
            if (cancelled) return;
            const logins = loginsResponse.success && loginsResponse.data ? loginsResponse.data : [];
            if (logins.length > 0) {
              const fallbackAccountsResponse = await getMT5AccountsBatch({ logins });
              if (cancelled) return;
              accounts = fallbackAccountsResponse.success && fallbackAccountsResponse.data ? fallbackAccountsResponse.data : [];
            }
          }
        }
        // For PAST dates: Use daily-batch endpoint (historical reports)
        else {
          const reportsResponse = await getMT5DailyReportsBatch({ groups: mt5Groups, from: reportsFrom, to: reportsTo });
          if (cancelled) return;
          reports = reportsResponse.success && reportsResponse.data ? reportsResponse.data : [];
        }

        const toNum = (value: unknown) => {
          const num = Number(value);
          return Number.isFinite(num) ? num : 0;
        };

        const getLots = (volume: number | string, volumeExt?: number | string, contractSize: number | string = 100000) => {
          const volExt = toNum(volumeExt);
          const vol = toNum(volume);
          const contract = toNum(contractSize);
          if (volExt > 0 && contract > 0) return volExt / (contract * 1000);
          return vol / 10000;
        };

        const symbolPositionsMap = new Map<string, number>();
        positions.forEach((position) => {
          const symbol = position.Symbol || 'UNKNOWN';
          symbolPositionsMap.set(symbol, (symbolPositionsMap.get(symbol) || 0) + 1);
        });

        const topSymbolsData = Array.from(symbolPositionsMap.entries())
          .map(([symbol, count]) => ({ symbol, positions: count }))
          .sort((a, b) => b.positions - a.positions)
          .slice(0, 6);

        // Calculate Total Lots from DEALS (all executed trades in period)
        const totalLots = deals.reduce((sum, deal) => sum + getLots(deal.Volume, deal.VolumeExt, deal.ContractSize), 0);

        // Calculate Total Volume from current open POSITIONS
        const totalVolume = positions.reduce((sum, position) => {
          const contractSize = toNum(position.ContractSize);
          const lots = getLots(position.Volume, position.VolumeExt, contractSize);
          const price = toNum(position.PriceCurrent) || toNum(position.PriceOpen);
          const notional = contractSize && price ? lots * price * contractSize : 0;
          return sum + notional;
        }, 0);

        // Calculate metrics based on data source (TODAY vs PAST)
        let totalEquity = 0;
        let totalCredit = 0;
        let clientsWithCredit = 0;

        if (isToday && accounts.length > 0) {
          totalEquity = accounts.reduce((sum, account) => {
            const equity = toNum(account.Equity);
            if (equity > 0) return sum + equity;
            const balance = toNum(account.Balance);
            const credit = toNum(account.Credit);
            const floating = toNum(account.Floating);
            if (floating !== 0) return sum + balance + credit + floating;
            const profit = toNum(account.Profit);
            return sum + balance + credit + profit;
          }, 0);

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
            const balance = toNum(report.Balance);
            const profit = toNum(report.Profit);
            return sum + (equity > 0 ? equity : balance + profit);
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
  const formatShortDate = (date: Date) => {
    return `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')}`;
  };

  // Build date label based on the selected dates
  const effectiveFromDate = fromDate ?? getDubaiDayStart();
  const effectiveToDate = toDate ?? getDubaiDayEnd();
  const periodLabel = `${formatShortDate(effectiveFromDate)}–${formatShortDate(effectiveToDate)}`;

  return (
    <DepartmentCard title="Dealing" icon={TrendingUp} accentColor="primary">
      <div>
        <div className="text-xs text-muted-foreground mb-2">Top Symbols (Open Positions)</div>
        <ForexTicker items={topSymbols} isLoading={isLoading} />
      </div>

      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">Total Lots (live)</span>
          <span className="text-[10px] text-muted-foreground font-mono">1m refresh</span>
        </div>
        <MiniChart color="hsl(186 100% 50%)" value={metrics.totalLots} variant="area" height={48} />
      </div>

      {dataSnapshot.positions === 0 && dataSnapshot.accounts === 0 && !isLoading && (
        <div className="text-[11px] text-warning/90">
          No MT5 data returned. Check MT5 proxy, groups, or date range.
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
