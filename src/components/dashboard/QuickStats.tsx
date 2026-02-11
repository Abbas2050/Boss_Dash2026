
import { useEffect, useState } from 'react';
import { TrendingUp, Users, DollarSign, Activity, UserPlus } from 'lucide-react';
import { fetchAccounts, fetchTransactions, fetchTrades, fetchUsers, Account, Transaction, Trade } from '@/lib/api';
import { formatDateTimeForAPI, getDubaiDate } from '@/lib/dubaiTime';
import { getContractSize } from '@/lib/contractSizes';

interface QuickStat {
  label: string;
  value: string;
  change: number;
  icon: typeof TrendingUp;
}


interface QuickStatsProps {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
}


export function QuickStats({ selectedEntity, fromDate, toDate, refreshKey }: QuickStatsProps) {
  const [stats, setStats] = useState<QuickStat[]>([
    { label: 'Total Deposit', value: '-', change: 0, icon: DollarSign },
    { label: 'Total Withdrawal', value: '-', change: 0, icon: DollarSign },
    { label: 'Net Deposit', value: '-', change: 0, icon: TrendingUp },
    { label: 'Total IB Withdrawal', value: '-', change: 0, icon: DollarSign },
    { label: 'New MT5 Accounts/New Clients', value: '-/-', change: 0, icon: Users },
  ]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Default to last 30 days if no filter provided
    const fallbackEnd = getDubaiDate();
    const fallbackStart = new Date(fallbackEnd);
    fallbackStart.setDate(fallbackStart.getDate() - 30);

    const begin = fromDate ? formatDateTimeForAPI(fromDate, false) : formatDateTimeForAPI(fallbackStart, false);
    const end = toDate ? formatDateTimeForAPI(toDate, true) : formatDateTimeForAPI(fallbackEnd, true);
    
    console.log('📊 QUICKSTATS: Applying filters', {
      selectedEntity,
      fromDate: fromDate?.toISOString(),
      toDate: toDate?.toISOString(),
      formattedBegin: begin,
      formattedEnd: end,
      refreshKey,
    });

    const baseBody: any = {
      createdAt: begin && end ? { begin, end } : undefined,
      processedAt: begin && end ? { begin, end } : undefined,
      statuses: ['approved'],
    };
    
    console.log('🔧 Transaction Request Body (baseBody):', JSON.stringify(baseBody, null, 2));
    const tradesBody: any = {
      openDate: begin && end ? { begin, end } : undefined,
      closeDate: begin && end ? { begin, end } : undefined,
      ticketType: ['buy', 'sell'],
    };
    const usersBody: any = {
      created: begin && end ? { begin, end } : undefined,
      customFields: selectedEntity && selectedEntity !== 'all' ? { custom_change_me_field: selectedEntity } : undefined,
    };
    
    // Remove undefined keys from request bodies
    Object.keys(baseBody).forEach(key => baseBody[key] === undefined && delete baseBody[key]);
    Object.keys(tradesBody).forEach(key => tradesBody[key] === undefined && delete tradesBody[key]);
    Object.keys(usersBody).forEach(key => usersBody[key] === undefined && delete usersBody[key]);

    setIsLoading(true);
    setErrorMessage(null);

    // Step 1: Fetch users by entity if entity filter is applied
    const fetchUserIdsPromise = selectedEntity && selectedEntity !== 'all'
      ? fetchUsers({ customFields: { custom_change_me_field: selectedEntity } })
          .then(users => users.map(u => u.id))
          .catch(err => {
            console.error('Failed to fetch users by entity:', err);
            return []; // Return empty array on error
          })
      : Promise.resolve(undefined); // No entity filter

    // Step 2: Fetch all data in parallel, then filter client-side by user IDs
    fetchUserIdsPromise.then(userIds => {
      console.log('👥 User IDs for entity filter:', userIds);

      return Promise.all([
        fetchTransactions({ ...baseBody, transactionTypes: ['deposit'] }),
        fetchTransactions({ ...baseBody, transactionTypes: ['withdrawal'] }),
        fetchTransactions({ ...baseBody, transactionTypes: ['ib withdrawal'] }),
        fetchTrades(tradesBody),
        fetchUsers(usersBody),
        Promise.resolve(userIds) // Pass userIds through the promise chain
      ]);
    })
      .then(async ([allDeposits, allWithdrawals, allIBWithdrawals, allTrades, newUsers, userIds]) => {
        // Filter ALL data client-side by user IDs if entity filter is applied
        let deposits = allDeposits;
        let withdrawals = allWithdrawals;
        let ibWithdrawals = allIBWithdrawals;
        let trades = allTrades;
        let accounts: Account[] = [];
        
        if (userIds && userIds.length > 0) {
          trades = allTrades.filter((t: Trade) => userIds.includes(t.userId));
          console.log(`🔍 Filtered trades by entity (${selectedEntity}):`, {
            trades: `${allTrades.length} → ${trades.length}`,
          });
        }

        const entityUserIds = userIds && userIds.length > 0 ? userIds : undefined;

        const accountsBody: any = {
          createdAt: begin && end ? { begin, end } : undefined,
          userIds: entityUserIds && entityUserIds.length > 0 ? entityUserIds : undefined,
          orders: [{ field: 'createdAt', direction: 'DESC' }],
          segment: { limit: 500, offset: 0 },
        };
        Object.keys(accountsBody).forEach(key => accountsBody[key] === undefined && delete accountsBody[key]);

        console.log('🔧 Accounts Request Body (entity/date):', JSON.stringify(accountsBody, null, 2));

        const accountsResponse = await fetchAccounts(accountsBody);
        accounts = accountsResponse as Account[];

        if (entityUserIds && entityUserIds.length > 0) {
          deposits = allDeposits.filter((tx: Transaction) => entityUserIds.includes(tx.fromUserId));
          withdrawals = allWithdrawals.filter((tx: Transaction) => entityUserIds.includes(tx.fromUserId));
          ibWithdrawals = allIBWithdrawals.filter((tx: Transaction) => entityUserIds.includes(tx.fromUserId));
        }

        console.log('🔍 Filtered by entity (no trade filter) for transactions:', {
          entityUsers: entityUserIds?.length ?? 'all',
          deposits: `${allDeposits.length} → ${deposits.length}`,
          withdrawals: `${allWithdrawals.length} → ${withdrawals.length}`,
          ibWithdrawals: `${allIBWithdrawals.length} → ${ibWithdrawals.length}`,
          accounts: accounts.length,
        });
        
        const excludedDeposits = deposits.filter((tx: Transaction) => {
          const platformComment = (tx.platformComment || '').toLowerCase();
          return platformComment.includes('negative bal');
        });
        const filteredDeposits = deposits.filter((tx: Transaction) => {
          const platformComment = (tx.platformComment || '').toLowerCase();
          return !platformComment.includes('negative bal');
        });
        let totalDeposit = filteredDeposits.reduce((sum, tx) => sum + tx.processedAmount, 0);
        // Withdrawals are stored as negative, so use absolute value for correct math
        let totalWithdrawal = Math.abs(withdrawals.reduce((sum, tx) => sum + tx.processedAmount, 0));
        let totalIBWithdrawal = Math.abs(ibWithdrawals.reduce((sum, tx) => sum + tx.processedAmount, 0));
        
        // Calculate volume from CRM trades (already filtered by entity)
        const totalVolume = trades.reduce((sum, t: Trade) => sum + (t.volume || 0), 0);
        
        // Calculate million/yards for each trade
        const tradeDetails = trades.map((t: Trade) => {
          const volume = t.volume || 0;
          const openPrice = Number(t.openPrice) || 0;
          const contractSize = getContractSize(t.symbol);
          const tradeMillionYards = volume * openPrice * contractSize;
          return {
            symbol: t.symbol,
            volume,
            openPrice,
            contractSize,
            millionYards: tradeMillionYards,
          };
        });
        
        const millionYards = tradeDetails.reduce((sum, t) => sum + t.millionYards, 0);
        
        console.log('📊 Million/Yards Calculation (per-trade breakdown):', {
          totalTrades: trades.length,
          sampleTrades: tradeDetails.slice(0, 5),
          totalMillionYards: millionYards,
        });
        
        console.log('📊 Volume Calculation:', {
          totalTrades: trades.length,
          totalVolume,
          sampleTrade: trades[0],
        });
        const newMt5AccountsCount = accounts.length;
        const newUsersCount = newUsers.length;
        // Net = deposit - withdrawal
        const netDeposit = totalDeposit - totalWithdrawal;

        console.info('QuickStats fetched', {
          selectedEntity,
          fromDate,
          toDate,
          deposits: deposits.length,
          excludedDeposits: excludedDeposits.length,
          withdrawals: withdrawals.length,
          ibWithdrawals: ibWithdrawals.length,
          trades: trades.length,
          newUsers: newUsers.length,
          totalDeposit,
          totalWithdrawal,
          totalIBWithdrawal,
          totalVolume,
          millionYards,
          newMt5AccountsCount,
          newUsersCount,
          netDeposit,
        });

        setStats([
          { label: 'Total Deposit', value: `$${totalDeposit.toLocaleString()}`, change: 0, icon: DollarSign },
          { label: 'Total Withdrawal', value: `$${totalWithdrawal.toLocaleString()}`, change: 0, icon: DollarSign },
          { label: 'Net Deposit', value: `$${netDeposit.toLocaleString()}`, change: 0, icon: TrendingUp },
          { label: 'Total IB Withdrawal', value: `$${totalIBWithdrawal.toLocaleString()}`, change: 0, icon: DollarSign },
          { label: 'New MT5 Accounts/New Clients', value: `${newMt5AccountsCount}/${newUsersCount}`, change: 0, icon: Users },
        ]);
        setErrorMessage(null);
      })
      .catch((err) => {
        console.error('API error in QuickStats:', err);
        setErrorMessage(err?.message || 'Unable to fetch data');
        setStats(prev => prev.map(s => ({ ...s, value: '-', change: 0 })));
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [selectedEntity, fromDate, toDate, refreshKey]);

  return (
    <div className="space-y-2">
      {errorMessage && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2 font-mono">
          API Error: {errorMessage}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {stats.map((stat, index) => (
          <div 
            key={stat.label}
            className="cyber-card p-5 flex items-center gap-4 group hover:scale-[1.02] transition-all duration-300 hover:shadow-lg hover:shadow-primary/10"
            style={{ animationDelay: `${index * 100}ms` }}
          >
            <div className="p-3 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 group-hover:from-primary/30 group-hover:to-primary/10 transition-all duration-300 shadow-inner">
              <stat.icon className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                {stat.label}
                {isLoading && <span className="text-[10px] text-primary">loading...</span>}
              </p>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="font-mono text-xl font-bold tracking-tight truncate">{stat.value}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
