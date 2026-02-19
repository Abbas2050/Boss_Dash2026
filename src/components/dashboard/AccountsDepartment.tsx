import { useEffect, useState } from 'react';
import { Wallet, ArrowUpRight, ArrowDownRight, TrendingUp, CheckCircle, AlertTriangle } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { fetchTransactions } from '@/lib/api';
import { formatDateTimeForAPI, getDubaiDate, getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';
import { StatusBadge } from './StatusBadge';
import { fetchWalletBalances } from '@/lib/walletApi';

interface PSPBalance {
  name: string;
  balance: number;
  status: 'active' | 'pending' | 'error';
}

export function AccountsDepartment({ selectedEntity, fromDate, toDate, refreshKey }: { selectedEntity: string; fromDate?: Date; toDate?: Date; refreshKey: number }) {
  const [metrics, setMetrics] = useState({
    depositsToday: 0,
    withdrawalsToday: 0,
    netFlow: 0,
    totalBalance: 0,
  });

  const [pspBalances, setPspBalances] = useState<PSPBalance[]>([]);
  const [bankReceivable, setBankReceivable] = useState(0);
  const [cryptoReceivable, setCryptoReceivable] = useState(0);
  const [reportDate, setReportDate] = useState('—');
  const [reportUpdated, setReportUpdated] = useState('—');
  const [walletError, setWalletError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchTodayData = async () => {
      try {
        setIsLoading(true);

        const now = getDubaiDate();
        const startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(now);
        endDate.setHours(23, 59, 59, 999);

        const begin = formatDateTimeForAPI(startDate, false);
        const end = formatDateTimeForAPI(endDate, true);

        // Always all entities for Accounts
        const filterParams: any = { 
          processedAt: { begin, end },
          transactionTypes: ['deposit'], 
          statuses: ['approved'] 
        };

        // Fetch deposits and withdrawals
        const [depositsData, withdrawalsData] = await Promise.all([
          fetchTransactions(filterParams),
          fetchTransactions({ 
            ...filterParams,
            transactionTypes: ['withdrawal']
          }),
        ]);

        const filteredDeposits = depositsData.filter(tx => {
          const platformComment = (tx.platformComment || '').toLowerCase();
          return !platformComment.includes('negative bal');
        });
        const totalDeposits = filteredDeposits.reduce((sum, tx) => sum + tx.processedAmount, 0);
        const totalWithdrawals = Math.abs(withdrawalsData.reduce((sum, tx) => sum + tx.processedAmount, 0));
        const netFlow = totalDeposits - totalWithdrawals;

        setMetrics(prev => ({
          ...prev,
          depositsToday: totalDeposits,
          withdrawalsToday: totalWithdrawals,
          netFlow,
        }));
      } catch (err) {
        // silently ignore
      } finally {
        setIsLoading(false);
      }
    };

    const fetchWalletData = async () => {
      const response = await fetchWalletBalances();
      if (!response?.ok || !response?.data?.widgets) {
        setWalletError(response?.error || 'Wallet API unavailable');
        return;
      }

      setWalletError(null);

      const widgets = response.data.widgets;
      const widgetMap = new Map(widgets.map((widget) => [widget.id, widget]));
      const order = [
        { key: 'bitpace', label: 'Bitpace' },
        { key: 'letknowpay', label: 'LetKnow Pay' },
        { key: 'ownbit', label: 'OwnBit' },
        { key: 'heropayment', label: 'HeroPayment' },
        { key: 'googlesheets_match2pay', label: 'Match2Pay' },
        { key: 'googlesheets_goldsouq', label: 'Gold Souq' },
        { key: 'googlesheets_fab', label: 'FAB Bank' },
        { key: 'googlesheets_mbme', label: 'MBME' },
      ];

      const mapped = order.map(({ key, label }) => {
        const entry = widgetMap.get(key);
        const status = (entry?.status || 'ok') as 'ok' | 'pending' | 'error';
        const balance = status === 'error' ? 0 : Number(entry?.balance ?? 0);
        return {
          name: entry?.name || label,
          balance,
          status: status === 'error' ? 'error' : 'active',
        } as PSPBalance;
      });

      const total = typeof response.data.total_balance === 'number'
        ? response.data.total_balance
        : mapped.reduce((sum, item) => sum + item.balance, 0);

      if (response.timestamp) {
        const ts = new Date(response.timestamp.replace(' ', 'T'));
        if (!Number.isNaN(ts.getTime())) {
          setReportDate(ts.toISOString().slice(0, 10));
          setReportUpdated(
            ts.toLocaleString('en-US', {
              month: 'short',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            })
          );
        }
      }

      setPspBalances(mapped);
      setMetrics(prev => ({ ...prev, totalBalance: total }));
      setBankReceivable(Number(response.data.bank_receivable ?? 0));
      setCryptoReceivable(Number(response.data.crypto_receivable ?? 0));
    };

    fetchTodayData();
    fetchWalletData();
    const interval = setInterval(fetchWalletData, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refreshKey]);

  const periodLabel = 'Today';

  return (
    <DepartmentCard title="Accounts" icon={Wallet} accentColor="success">
      {/* TODAY Deposits & Withdrawals */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-2 rounded-lg bg-success/10 border border-success/20">
          <div className="flex items-center gap-1 text-success mb-1">
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span className="text-xs">Deposits</span>
          </div>
          <div className="font-mono font-semibold text-lg">
            ${metrics.depositsToday.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-muted-foreground">{periodLabel}</div>
        </div>
        <div className="p-2 rounded-lg bg-destructive/10 border border-destructive/20">
          <div className="flex items-center gap-1 text-destructive mb-1">
            <ArrowDownRight className="w-3.5 h-3.5" />
            <span className="text-xs">Withdrawals</span>
          </div>
          <div className="font-mono font-semibold text-lg">
            ${metrics.withdrawalsToday.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-muted-foreground">{periodLabel}</div>
        </div>
      </div>

      {/* Net Flow */}
      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground">Net Flow (Today)</span>
          </div>
          <span className={`font-mono font-semibold ${metrics.netFlow >= 0 ? 'text-success' : 'text-destructive'}`}>
            ${metrics.netFlow.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>

      {/* PSP Closing Balance Report */}
      <div className="pt-2 border-t border-border/30">
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-foreground">Closing Balance Report</span>
            <span className="text-[10px] text-muted-foreground">{reportDate}</span>
          </div>
          <div className="text-[10px] text-muted-foreground">Updated: {reportUpdated}</div>
        </div>
        
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {walletError && (
            <div className="text-[11px] text-destructive">{walletError}</div>
          )}
          {pspBalances.length === 0 && !isLoading && (
            <div className="text-[11px] text-muted-foreground">No wallet data available.</div>
          )}
          {pspBalances.map((psp) => (
            <div key={psp.name} className="flex items-center justify-between p-1.5 rounded-md bg-secondary/30 border border-border/40 text-xs">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {psp.status === 'error' ? (
                  <AlertTriangle className="w-3 h-3 text-destructive flex-shrink-0" />
                ) : (
                  <CheckCircle className="w-3 h-3 text-success flex-shrink-0" />
                )}
                <span className="text-foreground truncate">{psp.name}</span>
              </div>
              <span className="font-mono font-semibold text-right ml-2 flex-shrink-0">
                ${psp.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="mt-2 p-2 rounded-lg bg-primary/10 border border-primary/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-foreground">💎 Total Combined</span>
            <span className="font-mono font-bold text-primary">
              ${metrics.totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      </div>

      {/* Receivables */}
      <div className="pt-2 border-t border-border/30 space-y-1.5">
        <div className="p-2 rounded-md bg-warning/10 border border-warning/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">📊 To be received in BANK</div>
          <div className="font-mono font-semibold text-warning">${bankReceivable.toFixed(2)}</div>
        </div>
        <div className="p-2 rounded-md bg-cyan-500/10 border border-cyan-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">🔐 To be received in CRYPTO</div>
          <div className="font-mono font-semibold text-cyan-500">${cryptoReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>
    </DepartmentCard>
  );
}
