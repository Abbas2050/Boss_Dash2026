import { useEffect, useState } from 'react';
import { Settings, Users, Database, TrendingUp, CheckCircle, AlertCircle, Shield, Briefcase, User } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { StatusBadge } from './StatusBadge';
import { fetchUsers, fetchAccounts, fetchTransactions } from '@/lib/api';
import { formatDateTimeForAPI, getDubaiDate } from '@/lib/dubaiTime';

export function BackOfficeDepartment({ selectedEntity, fromDate, toDate, refreshKey }: { selectedEntity: string; fromDate?: Date; toDate?: Date; refreshKey: number }) {
  const [metrics, setMetrics] = useState({
    totalIBs: 0,
    totalDeposits: 0,
    totalWithdrawals: 0,
    totalClients: 0,
    totalMT5Accounts: 0,
    firstDeposits: 0,
    verifiedClients: 8,
    individualClients: 10,
    corporateClients: 4,
    sumsubActive: 11,
  });

  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchBackOfficeData = async () => {
      try {
        setIsLoading(true);
        const now = getDubaiDate();
        const fallbackEnd = now;
        const fallbackStart = new Date(fallbackEnd);
        fallbackStart.setDate(fallbackStart.getDate() - 30);

        const begin = fromDate ? formatDateTimeForAPI(fromDate, false) : formatDateTimeForAPI(fallbackStart, false);
        const end = toDate ? formatDateTimeForAPI(toDate, true) : formatDateTimeForAPI(fallbackEnd, true);

        console.log('🔧 BackOfficeDepartment - Fetching data with filters:', { 
          selectedEntity, 
          begin, 
          end, 
          fromDate: fromDate?.toISOString(), 
          toDate: toDate?.toISOString() 
        });

        // Fetch all data in parallel
        const baseUsersFilter = selectedEntity !== 'all'
          ? { customFields: { custom_change_me_field: { value: selectedEntity } } }
          : {};
        const clientDateFilter = fromDate || toDate
          ? { created: { begin, end } }
          : {};
        const [
          allUsers,
          allAccounts,
          ibWithdrawals,
          allDeposits,
          allWithdrawals,
          verifiedUsers,
          individualUsers,
          corporateUsers,
        ] = await Promise.all([
          fetchUsers({ ...baseUsersFilter, ...clientDateFilter }),
          fetchAccounts({ 
            createdAt: { begin, end },
            segment: { limit: 1000, offset: 0 } 
          }),
          fetchTransactions({ 
            processedAt: { begin, end },
            transactionTypes: ['ib withdrawal'],
            statuses: ['approved']
          }),
          fetchTransactions({ 
            processedAt: { begin, end },
            transactionTypes: ['deposit'],
            statuses: ['approved']
          }),
          fetchTransactions({ 
            processedAt: { begin, end },
            transactionTypes: ['withdrawal'],
            statuses: ['approved']
          }),
          fetchUsers({ ...baseUsersFilter, ...clientDateFilter, verified: true }).catch(() => []),
          fetchUsers({ ...baseUsersFilter, ...clientDateFilter, clientTypes: ['Individual'] }).catch(() => []),
          fetchUsers({ ...baseUsersFilter, ...clientDateFilter, clientTypes: ['Corporate'] }).catch(() => []),
        ]);

        // Filter by entity if needed
        let clients = allUsers;
        let accounts = allAccounts;
        if (selectedEntity !== 'all') {
          const entityUserIds = allUsers.map(u => u.id);
          clients = allUsers;
          accounts = (allAccounts as any[]).filter(a => entityUserIds.includes(a.userId));
        }

        // Count users whose firstDepositDate falls in the selected date range
        const rangeStart = new Date(begin);
        const rangeEnd = new Date(end);
        const firstDepositCount = allUsers.filter(user => {
          if (!user.firstDepositDate) return false;
          const userFirstDepositDate = new Date(user.firstDepositDate);
          return userFirstDepositDate >= rangeStart && userFirstDepositDate <= rangeEnd;
        }).length;

        const verifiedClients = verifiedUsers.length;
        const individualClients = individualUsers.length;
        const corporateClients = corporateUsers.length;

        console.log('📊 BackOffice Data Fetched:', {
          totalIBs: ibWithdrawals.length,
          totalClients: clients.length,
          totalMT5Accounts: accounts.length,
          totalDeposits: allDeposits.length,
          totalWithdrawals: allWithdrawals.length,
          corporateClients,
          firstDepositsInRange: firstDepositCount,
        });

        setMetrics({
          totalIBs: ibWithdrawals.length,
          totalDeposits: allDeposits.length,
          totalWithdrawals: allWithdrawals.length,
          totalClients: clients.length,
          totalMT5Accounts: accounts.length,
          firstDeposits: firstDepositCount,
          verifiedClients,
          individualClients,
          corporateClients,
          sumsubActive: 11, // Hardcoded - active KYC verifications
        });
      } catch (err) {
        console.error('Error fetching back office data:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchBackOfficeData();
  }, [selectedEntity, fromDate, toDate, refreshKey]);

  return (
    <DepartmentCard title="Back Office" icon={Settings}>
      {/* Transaction Counts */}
      <div className="grid grid-cols-3 gap-2">
        <div className="text-center p-2 rounded-lg bg-primary/10 border border-primary/20">
          <Users className="w-4 h-4 text-primary mx-auto mb-1" />
          <div className="font-mono font-semibold">{metrics.totalIBs}</div>
          <div className="text-xs text-muted-foreground">IB's</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-success/10 border border-success/20">
          <TrendingUp className="w-4 h-4 text-success mx-auto mb-1" />
          <div className="font-mono font-semibold">{metrics.totalDeposits}</div>
          <div className="text-xs text-muted-foreground">Deposits</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-warning/10 border border-warning/20">
          <AlertCircle className="w-4 h-4 text-warning mx-auto mb-1" />
          <div className="font-mono font-semibold">{metrics.totalWithdrawals}</div>
          <div className="text-xs text-muted-foreground">Withdrawals</div>
        </div>
      </div>

      {/* Growth Rate */}
      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center justify-between mb-2">
          <div>
            <span className="text-xs text-muted-foreground">Accounts Created Rate</span>
            <div className="text-lg font-semibold">{metrics.totalClients > 0 ? Math.round((metrics.totalMT5Accounts / metrics.totalClients) * 100) : 0}%</div>
          </div>
          <div className="text-right">
            <div className="text-sm font-mono text-primary">{metrics.totalMT5Accounts}</div>
            <div className="text-[10px] text-muted-foreground">of {metrics.totalClients}</div>
          </div>
        </div>
        <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-primary to-blue-500 transition-all"
            style={{width: metrics.totalClients > 0 ? `${(metrics.totalMT5Accounts / metrics.totalClients) * 100}%` : '0%'}}
          />
        </div>
      </div>

      {/* Growth Metrics Chart */}
      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs text-muted-foreground">Growth Summary</span>
          {isLoading && <span className="text-[10px] text-primary animate-pulse">loading...</span>}
        </div>
        <div className="space-y-2">
          {/* Total Clients */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs text-muted-foreground">Total Clients</span>
              <span className="text-sm font-semibold text-primary">{metrics.totalClients}</span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-primary to-cyan-500 transition-all"
                style={{width: `${Math.min((metrics.totalClients / 100) * 100, 100)}%`}}
              />
            </div>
          </div>

          {/* MT5 Accounts Created */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs text-muted-foreground">MT5 Accounts Created</span>
              <span className="text-sm font-semibold text-success">{metrics.totalMT5Accounts}</span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-success to-emerald-500 transition-all"
                style={{width: `${Math.min((metrics.totalMT5Accounts / 100) * 100, 100)}%`}}
              />
            </div>
          </div>

          {/* First Deposits */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs text-muted-foreground">First Deposits</span>
              <span className="text-sm font-semibold text-amber-500">{metrics.firstDeposits}</span>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-amber-500 to-orange-500 transition-all"
                style={{width: `${Math.min((metrics.firstDeposits / 100) * 100, 100)}%`}}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Client Types & Verification */}
      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center gap-2 mb-2">
          <Users className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs text-muted-foreground">Client Breakdown</span>
        </div>
        <div className="space-y-1">
          <MetricRow 
            label="Verified Clients" 
            value={metrics.verifiedClients}
            icon={<Shield className="w-3.5 h-3.5" />}
          />
          <MetricRow 
            label="Individual Clients" 
            value={metrics.individualClients}
            icon={<User className="w-3.5 h-3.5" />}
          />
          <MetricRow 
            label="Corporate Clients" 
            value={metrics.corporateClients}
            icon={<Briefcase className="w-3.5 h-3.5" />}
          />
        </div>
      </div>

      {/* KYC/AML Status */}
      <div className="pt-2 border-t border-border/30 flex items-center justify-between p-2 rounded-lg bg-success/10 border border-success/20">
        <div className="flex items-center gap-2">
          <CheckCircle className="w-3.5 h-3.5 text-success" />
          <span className="text-xs text-muted-foreground">SumSub KYC</span>
        </div>
        <StatusBadge 
          status="online"
          label="Active" 
        />
      </div>
    </DepartmentCard>
  );
}
