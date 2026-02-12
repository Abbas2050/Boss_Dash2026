import { useEffect, useState } from 'react';
import { Wallet, ArrowUpRight, ArrowDownRight, TrendingUp, CheckCircle } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { fetchTransactions } from '@/lib/api';
import { formatDateTimeForAPI, getDubaiDate } from '@/lib/dubaiTime';
import { StatusBadge } from './StatusBadge';

interface PSPBalance {
  name: string;
  balance: number;
  status: 'active' | 'pending';
}

export function AccountsDepartment({ selectedEntity, fromDate, toDate, refreshKey }: { selectedEntity: string; fromDate?: Date; toDate?: Date; refreshKey: number }) {
  const [metrics, setMetrics] = useState({
    depositsToday: 0,
    withdrawalsToday: 0,
    netFlow: 0,
    totalBalance: 2869781.44,
  });

  const [pspBalances, setPspBalances] = useState<PSPBalance[]>([
    { name: 'Bitpace', balance: 84.47, status: 'active' },
    { name: 'LetKnow Pay', balance: 108082.27, status: 'active' },
    { name: 'OwnBit', balance: 112914.73, status: 'active' },
    { name: 'HeroPayment', balance: 173959.67, status: 'active' },
    { name: 'Match2Pay', balance: 504.50, status: 'active' },
    { name: 'Gold Souq', balance: 1395052.17, status: 'active' },
    { name: 'FAB Bank', balance: 1076429.89, status: 'active' },
    { name: 'MBME', balance: 2753.74, status: 'active' },
  ]);

  const [bankReceivable] = useState(0);
  const [cryptoReceivable] = useState(350000);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchTodayData = async () => {
      try {
        setIsLoading(true);
        
        // Use custom dates if provided, otherwise use TODAY
        let startDate: Date, endDate: Date;
        if (fromDate && toDate) {
          startDate = new Date(fromDate);
          startDate.setHours(0, 0, 0, 0);
          endDate = new Date(toDate);
          endDate.setHours(23, 59, 59, 999);
        } else {
          const now = getDubaiDate();
          startDate = new Date(now);
          startDate.setHours(0, 0, 0, 0);
          endDate = new Date(now);
          endDate.setHours(23, 59, 59, 999);
        }

        const begin = formatDateTimeForAPI(startDate, false);
        const end = formatDateTimeForAPI(endDate, true);

        // Build filter params with entity if selected
        const filterParams: any = { 
          processedAt: { begin, end },
          transactionTypes: ['deposit'], 
          statuses: ['approved'] 
        };
        if (selectedEntity && selectedEntity !== 'all') {
          filterParams.customFields = { 'custom_change_me_field': selectedEntity };
        }

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

        setMetrics({
          depositsToday: totalDeposits / 1000000,
          withdrawalsToday: totalWithdrawals / 1000000,
          netFlow: netFlow / 1000000,
          totalBalance: 2869781.44,
        });
      } catch (err) {
        // silently ignore
      } finally {
        setIsLoading(false);
      }
    };

    fetchTodayData();
  }, [selectedEntity, fromDate, toDate, refreshKey]);

  return (
    <DepartmentCard title="Accounts" icon={Wallet} accentColor="success">
      {/* TODAY Deposits & Withdrawals */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-2 rounded-lg bg-success/10 border border-success/20">
          <div className="flex items-center gap-1 text-success mb-1">
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span className="text-xs">Deposits</span>
          </div>
          <div className="font-mono font-semibold text-lg">${metrics.depositsToday.toFixed(2)}M</div>
          <div className="text-xs text-muted-foreground">Today (Real)</div>
        </div>
        <div className="p-2 rounded-lg bg-destructive/10 border border-destructive/20">
          <div className="flex items-center gap-1 text-destructive mb-1">
            <ArrowDownRight className="w-3.5 h-3.5" />
            <span className="text-xs">Withdrawals</span>
          </div>
          <div className="font-mono font-semibold text-lg">${metrics.withdrawalsToday.toFixed(2)}M</div>
          <div className="text-xs text-muted-foreground">Today (Real)</div>
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
            ${metrics.netFlow.toFixed(2)}M
          </span>
        </div>
      </div>

      {/* PSP Closing Balance Report */}
      <div className="pt-2 border-t border-border/30">
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-foreground">Closing Balance Report</span>
            <span className="text-[10px] text-muted-foreground">2026-02-05</span>
          </div>
          <div className="text-[10px] text-muted-foreground">Updated: Feb 05, 12:00:13</div>
        </div>
        
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {pspBalances.map((psp) => (
            <div key={psp.name} className="flex items-center justify-between p-1.5 rounded-md bg-secondary/30 border border-border/40 text-xs">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <CheckCircle className="w-3 h-3 text-success flex-shrink-0" />
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
