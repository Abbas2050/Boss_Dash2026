import { useEffect, useState } from 'react';
import { TrendingUp, PieChart as PieChartIcon, Users, DollarSign, BarChart3, Calendar, AlertCircle, Briefcase } from 'lucide-react';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart } from 'recharts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { fetchTransactions, fetchUsers, fetchAccounts } from '@/lib/api';
import { formatDateTimeForAPI, getDubaiDate } from '@/lib/dubaiTime';

interface AnalyticsSectionProps {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
}

export function AnalyticsSection({ selectedEntity, fromDate, toDate, refreshKey }: AnalyticsSectionProps) {
  const [timelineMode, setTimelineMode] = useState<'today' | 'week' | 'month' | 'year'>('month');
  const [revenueData, setRevenueData] = useState<any[]>([]);
  const [funnelData, setFunnelData] = useState<any[]>([]);
  const [clientFunnelData, setClientFunnelData] = useState<any[]>([]);
  const [transactionBreakdown, setTransactionBreakdown] = useState<any[]>([]);
  const [clientSegmentation, setClientSegmentation] = useState<any[]>([]);
  const [pspDeposits, setPspDeposits] = useState<any[]>([]);
  const [pspWithdrawals, setPspWithdrawals] = useState<any[]>([]);
  const [entityClientsData, setEntityClientsData] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

  // Calculate date range based on timeline mode
  const getDateRangeByTimeline = () => {
    const now = getDubaiDate();
    let start = new Date(now);
    
    switch (timelineMode) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'week':
        start.setDate(now.getDate() - 7);
        break;
      case 'month':
        start.setDate(now.getDate() - 30);
        break;
      case 'year':
        start.setFullYear(now.getFullYear() - 1);
        break;
    }
    return { start, end: now };
  };

  const getEntityName = (user: any) => {
    const entityField = user?.customFields?.custom_change_me_field;
    if (typeof entityField === 'object' && entityField?.value) return String(entityField.value);
    if (typeof entityField === 'string' && entityField.trim()) return entityField;
    return 'Default';
  };

  const normalizePspName = (tx: any) => {
    if (tx?.psp) return String(tx.psp).trim();
    if (tx?.comment) return String(tx.comment).trim();
    return 'Unknown';
  };

  const isNegativeBalanceDeposit = (tx: any) => {
    const platformComment = String(tx?.platformComment || '').toLowerCase();
    return platformComment.includes('negative bal');
  };

  useEffect(() => {
    const fetchAnalyticsData = async () => {
      try {
        setIsLoading(true);
        const now = getDubaiDate();
        
        // Use timeline mode if no custom dates provided
        let begin: string;
        let end: string;
        
        if (fromDate || toDate) {
          const endDate = toDate ? new Date(toDate) : new Date(now);
          let startDate: Date;
          if (fromDate) {
            startDate = new Date(fromDate);
          } else {
            startDate = new Date(endDate);
            startDate.setDate(startDate.getDate() - 30);
          }
          begin = formatDateTimeForAPI(startDate, false);
          end = formatDateTimeForAPI(endDate, true);
        } else {
          const { start, end: endDate } = getDateRangeByTimeline();
          begin = formatDateTimeForAPI(start, false);
          end = formatDateTimeForAPI(endDate, true);
        }

        const baseUsersFilter = selectedEntity !== 'all'
          ? { customFields: { custom_change_me_field: { value: selectedEntity } } }
          : {};
        const clientDateFilter = { created: { begin, end } };
        const hasEntityFilter = selectedEntity !== 'all';

        // Fetch all data in parallel
        const [
          allDeposits,
          allWithdrawals,
          allIBWithdrawals,
          allUsers,
          verifiedUsers,
          individualUsers,
          corporateUsers,
        ] = await Promise.all([
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
          fetchTransactions({ 
            processedAt: { begin, end },
            transactionTypes: ['ib withdrawal'],
            statuses: ['approved']
          }),
          fetchUsers({ ...baseUsersFilter, ...clientDateFilter }),
          fetchUsers({ ...baseUsersFilter, ...clientDateFilter, verified: true }).catch(() => []),
          fetchUsers({ ...baseUsersFilter, ...clientDateFilter, clientTypes: ['Individual'] }).catch(() => []),
          fetchUsers({ ...baseUsersFilter, ...clientDateFilter, clientTypes: ['Corporate'] }).catch(() => []),
        ]);

        const allAccounts = await fetchAccounts({
          createdAt: { begin, end },
          userIds: hasEntityFilter ? allUsers.map((user) => user.id) : undefined,
          segment: { limit: 1000, offset: 0 },
        }).catch(() => []);

        const entityUserIds = new Set((allUsers || []).map((user) => user.id));
        const filteredDeposits = hasEntityFilter
          ? (allDeposits || []).filter((tx) => entityUserIds.has(tx.fromUserId))
          : (allDeposits || []);
        const filteredWithdrawals = hasEntityFilter
          ? (allWithdrawals || []).filter((tx) => entityUserIds.has(tx.fromUserId))
          : (allWithdrawals || []);
        const filteredIbWithdrawals = hasEntityFilter
          ? (allIBWithdrawals || []).filter((tx) => entityUserIds.has(tx.fromUserId))
          : (allIBWithdrawals || []);
        const validDeposits = filteredDeposits.filter((tx) => !isNegativeBalanceDeposit(tx));
        const accountsByUser = new Map<number, any[]>();
        (allAccounts || []).forEach((acc: any) => {
          if (!accountsByUser.has(acc.userId)) {
            accountsByUser.set(acc.userId, []);
          }
          accountsByUser.get(acc.userId)?.push(acc);
        });

        // 1. CLIENT FUNNEL - Total Clients → MT5 Accounts → Depositors
        const totalClients = allUsers.length;
        const clientsWithAccounts = new Set(
          Array.from(accountsByUser.keys()).filter((userId) => entityUserIds.has(userId) || !hasEntityFilter),
        );
        const clientsWithDeposits = new Set(validDeposits.map((deposit) => deposit.fromUserId));
        const clientFunnel = [
          { stage: 'Total Clients', count: totalClients, percentage: 100 },
          { stage: 'Created MT5', count: clientsWithAccounts.size, percentage: totalClients > 0 ? Math.round((clientsWithAccounts.size / totalClients) * 100) : 0 },
          { stage: 'Made Deposits', count: clientsWithDeposits.size, percentage: totalClients > 0 ? Math.round((clientsWithDeposits.size / totalClients) * 100) : 0 },
        ];
        setClientFunnelData(clientFunnel);

        // 2. REVENUE TREND - Daily deposits vs withdrawals with net flow
        const dailyData: { [key: string]: any } = {};
        validDeposits.forEach(tx => {
          const date = new Date(tx.processedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          if (!dailyData[date]) dailyData[date] = { date, deposits: 0, withdrawals: 0, netFlow: 0 };
          dailyData[date].deposits += tx.processedAmount / 1000000;
        });
        filteredWithdrawals.forEach(tx => {
          const date = new Date(tx.processedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          if (!dailyData[date]) dailyData[date] = { date, deposits: 0, withdrawals: 0, netFlow: 0 };
          dailyData[date].withdrawals += Math.abs(tx.processedAmount) / 1000000;
        });
        // Calculate net flow for each day
        Object.values(dailyData).forEach((day: any) => {
          day.netFlow = day.deposits - day.withdrawals;
        });
        const sortedRevenueData = Object.values(dailyData).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        setRevenueData(timelineMode === 'today' ? sortedRevenueData : sortedRevenueData.slice(-15));

        // 3. ACQUISITION FUNNEL - Registered → MT5 Created → Funded
        const clientsWithMT5 = clientsWithAccounts.size;
        const clientsWhoFunded = clientsWithDeposits.size;
        const funnelSteps = [
          { stage: 'Registered', count: totalClients, percentage: 100, fill: '#3b82f6' },
          { stage: 'Created MT5', count: clientsWithMT5, percentage: totalClients > 0 ? Math.round((clientsWithMT5 / totalClients) * 100) : 0, fill: '#10b981' },
          { stage: 'Funded Account', count: clientsWhoFunded, percentage: totalClients > 0 ? Math.round((clientsWhoFunded / totalClients) * 100) : 0, fill: '#f59e0b' },
        ];
        setFunnelData(funnelSteps);

        // 4. TRANSACTION BREAKDOWN
        const totalDep = validDeposits.reduce((sum, tx) => sum + tx.processedAmount, 0) / 1000000;
        const totalWd = filteredWithdrawals.reduce((sum, tx) => sum + Math.abs(tx.processedAmount), 0) / 1000000;
        const totalIB = filteredIbWithdrawals.reduce((sum, tx) => sum + Math.abs(tx.processedAmount), 0) / 1000000;
        const transactionData = [
          { name: 'Deposits', value: parseFloat(totalDep.toFixed(2)), count: validDeposits.length },
          { name: 'Withdrawals', value: parseFloat(totalWd.toFixed(2)), count: filteredWithdrawals.length },
          { name: 'IB Withdrawals', value: parseFloat(totalIB.toFixed(2)), count: filteredIbWithdrawals.length },
        ];
        setTransactionBreakdown(transactionData);

        // 5. CLIENT SEGMENTATION - Individual/Corporate × Verified/Not Verified (use top-level fields)
        // Defensive: support both u.clientType and u['clientType'] (API may return as property or in object)
        const getClientType = (u: any) => u.clientType || u['clientType'];
        const getVerified = (u: any) => u.verified ?? u['verified'];
        const individualVerified = allUsers.filter(u => getClientType(u) === 'Individual' && getVerified(u) === true).length;
        const individualNotVerified = allUsers.filter(u => getClientType(u) === 'Individual' && getVerified(u) !== true).length;
        const corporateVerified = allUsers.filter(u => getClientType(u) === 'Corporate' && getVerified(u) === true).length;
        const corporateNotVerified = allUsers.filter(u => getClientType(u) === 'Corporate' && getVerified(u) !== true).length;
        const segmentationData = [
          { name: 'Individual Verified', value: individualVerified, color: '#3b82f6', type: 'Individual', status: 'Verified' },
          { name: 'Individual Not Verified', value: individualNotVerified, color: '#93c5fd', type: 'Individual', status: 'Not Verified' },
          { name: 'Corporate Verified', value: corporateVerified, color: '#10b981', type: 'Corporate', status: 'Verified' },
          { name: 'Corporate Not Verified', value: corporateNotVerified, color: '#86efac', type: 'Corporate', status: 'Not Verified' },
        ];
        setClientSegmentation(segmentationData);

        // 6. PSP DEPOSITS BREAKDOWN - Sum by PSP field (if available)
        const pspDepMap: { [key: string]: { amount: number; count: number } } = {};
        validDeposits.forEach(tx => {
          const psp = normalizePspName(tx);
          if (!pspDepMap[psp]) pspDepMap[psp] = { amount: 0, count: 0 };
          pspDepMap[psp].amount += tx.processedAmount / 1000000;
          pspDepMap[psp].count += 1;
        });
        const pspDepositData = Object.entries(pspDepMap)
          .map(([name, data]) => ({ name, value: parseFloat(data.amount.toFixed(2)), count: data.count }))
          .sort((a, b) => b.value - a.value);
        setPspDeposits(pspDepositData);

        // 7. PSP WITHDRAWALS + IB BREAKDOWN
        const pspWdMap: { [key: string]: { amount: number; type: string; count: number } } = {};
        filteredWithdrawals.forEach(tx => {
          const psp = normalizePspName(tx);
          if (!pspWdMap[psp]) pspWdMap[psp] = { amount: 0, type: 'Withdrawal', count: 0 };
          pspWdMap[psp].amount += Math.abs(tx.processedAmount) / 1000000;
          pspWdMap[psp].count += 1;
        });
        filteredIbWithdrawals.forEach(tx => {
          const ibLabel = 'IB Withdrawal';
          if (!pspWdMap[ibLabel]) pspWdMap[ibLabel] = { amount: 0, type: 'IB Withdrawal', count: 0 };
          pspWdMap[ibLabel].amount += Math.abs(tx.processedAmount) / 1000000;
          pspWdMap[ibLabel].count += 1;
        });
        const pspWithdrawalData = Object.entries(pspWdMap)
          .map(([name, data]) => ({ name, value: parseFloat(data.amount.toFixed(2)), type: data.type, count: data.count }))
          .sort((a, b) => b.value - a.value);
        setPspWithdrawals(pspWithdrawalData);

        // 8. ENTITY CLIENTS - Respect selected date range and entity filter
        const entityMap: { [key: string]: { clients: number; accounts: number } } = {};

        allUsers.forEach((user: any) => {
          const entity = getEntityName(user);
          if (!entityMap[entity]) entityMap[entity] = { clients: 0, accounts: 0 };
          entityMap[entity].clients += 1;
        });

        allAccounts.forEach((acc: any) => {
          const user = allUsers.find((candidate: any) => candidate.id === acc.userId);
          if (!user) return;
          const entity = getEntityName(user);
          if (!entityMap[entity]) entityMap[entity] = { clients: 0, accounts: 0 };
          entityMap[entity].accounts += 1;
        });

        const entityData = Object.entries(entityMap)
          .filter(([name]) => name !== 'Default')
          .map(([name, data]) => ({ name, clients: data.clients, accounts: data.accounts }))
          .sort((a, b) => b.clients - a.clients);

        setEntityClientsData(entityData);
      } catch (err) {
        // silently ignore
      } finally {
        setIsLoading(false);
      }
    };

    fetchAnalyticsData();
  }, [selectedEntity, fromDate, toDate, refreshKey, timelineMode]);

  const transactionBreakdownTotal = transactionBreakdown.reduce((sum, item) => sum + item.value, 0);
  const maxTransactionBreakdown = Math.max(0, ...transactionBreakdown.map((item) => item.value));

  return (
    <div className="space-y-5">
      {/* Section Header with Timeline Controls */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Analytics & Insights</h2>
          {isLoading && <span className="text-xs text-primary animate-pulse">Loading charts...</span>}
        </div>
        
        {/* Timeline Selector */}
        {!fromDate && !toDate && (
          <div className="flex w-full sm:w-auto items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <div className="flex max-w-full overflow-x-auto gap-1 p-1 rounded-lg bg-secondary/50 border border-border/30">
              {['today', 'week', 'month', 'year'].map(mode => (
                <Button
                  key={mode}
                  size="sm"
                  variant={timelineMode === mode ? 'default' : 'ghost'}
                  onClick={() => setTimelineMode(mode as any)}
                  className="shrink-0 text-xs"
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-12 gap-5">
        {/* Revenue Trend - Full width row */}
        <div className="col-span-12">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold">Revenue Trend</h3>
              <span className="text-xs text-muted-foreground">(Deposits vs Withdrawals + Net Flow)</span>
            </div>
            {revenueData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={revenueData} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} label={{ value: '$M', angle: -90, position: 'insideLeft' }} />
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }} />
                  <Legend />
                  <Line type="monotone" dataKey="deposits" stroke="#10b981" strokeWidth={2} dot={{ fill: '#10b981', r: 4 }} name="Deposits" />
                  <Line type="monotone" dataKey="withdrawals" stroke="#ef4444" strokeWidth={2} dot={{ fill: '#ef4444', r: 4 }} name="Withdrawals" />
                  <Line type="monotone" dataKey="netFlow" stroke="#3b82f6" strokeWidth={3} dot={{ fill: '#3b82f6', r: 5 }} strokeDasharray="5 5" name="Net Flow" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </Card>
        </div>

        {/* Acquisition Funnel */}
        <div className="col-span-12 lg:col-span-6">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold">Client Acquisition Funnel</h3>
            </div>
            {funnelData.length > 0 ? (
              <div className="space-y-3">
                {funnelData.map((step, index) => (
                  <div key={index} className="relative overflow-hidden">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-muted-foreground">{step.stage}</span>
                      <span className="text-sm font-semibold">{step.count} <span className="text-xs text-muted-foreground">({step.percentage}%)</span></span>
                    </div>
                    <div 
                      className="h-16 rounded-lg flex items-center justify-center text-foreground font-semibold transition-all"
                      style={{
                        backgroundColor: step.fill,
                        width: `${step.percentage}%`,
                        minWidth: '48px',
                        maxWidth: 'calc(100% - 16px)',
                        marginLeft: `${(100 - step.percentage) / 2}%`,
                        boxShadow: `0 4px 12px ${step.fill}40`,
                        overflow: 'hidden'
                      }}
                    >
                      {step.count}
                    </div>
                    {index < funnelData.length - 1 && (
                      <div className="flex justify-center my-1">
                        <div className="w-0 h-0 border-l-[8px] border-r-[8px] border-t-[12px] border-l-transparent border-r-transparent" style={{ borderTopColor: step.fill }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </Card>
        </div>

        {/* Transaction Breakdown */}
        <div className="col-span-12 lg:col-span-6">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold">Transaction Breakdown</h3>
              </div>
              <span className="text-xs font-mono text-muted-foreground">
                Total: ${transactionBreakdownTotal.toFixed(2)}M
              </span>
            </div>
            {transactionBreakdown.length > 0 ? (
              <div className="space-y-3">
                {transactionBreakdown.map((item, idx) => (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: idx === 0 ? '#10b981' : idx === 1 ? '#ef4444' : '#f59e0b' }} />
                        <span className="font-semibold">{item.name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground">{item.count} txns</span>
                        <span className="font-bold text-foreground">${item.value.toFixed(2)}M</span>
                      </div>
                    </div>
                    <div className="relative w-full h-10 rounded-lg overflow-hidden bg-secondary/20 border border-border/30">
                      <div 
                        className="h-full flex items-center justify-end pr-3 text-foreground text-sm font-bold transition-all shadow-lg"
                        style={{
                          width: `${Math.max(maxTransactionBreakdown > 0 ? (item.value / maxTransactionBreakdown) * 100 : 0, 5)}%`,
                          backgroundColor: idx === 0 ? '#10b981' : idx === 1 ? '#ef4444' : '#f59e0b',
                          boxShadow: `inset 0 2px 4px rgba(0,0,0,0.1)`
                        }}
                      >
                        {item.value > 0 && `$${item.value.toFixed(2)}M`}
                      </div>
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-muted-foreground">
                        {Math.round(transactionBreakdownTotal > 0 ? (item.value / transactionBreakdownTotal) * 100 : 0)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </Card>
        </div>

        {/* Client Segmentation */}
        <div className="col-span-12 lg:col-span-6">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <PieChartIcon className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold">Client Segmentation</h3>
              </div>
              <span className="text-xs font-mono text-muted-foreground">
                Total: {clientSegmentation.reduce((sum, item) => sum + item.value, 0)}
              </span>
            </div>
            {clientSegmentation.length > 0 && clientSegmentation.some(s => s.value > 0) ? (
              <div className="flex flex-col items-center">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={clientSegmentation.filter(s => s.value > 0)}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, value, percent }) => value > 0 ? `${(percent * 100).toFixed(0)}%` : ''}
                      outerRadius={80}
                      innerRadius={45}
                      fill="#8884d8"
                      dataKey="value"
                      paddingAngle={3}
                    >
                      {clientSegmentation.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }} 
                      formatter={(value, name, props) => [`${value} clients (${((value as number / clientSegmentation.reduce((sum, item) => sum + item.value, 0)) * 100).toFixed(1)}%)`, props.payload.name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-4 grid grid-cols-2 gap-2 text-xs w-full">
                  {clientSegmentation.map((item, idx) => {
                    const total = clientSegmentation.reduce((sum, i) => sum + i.value, 0);
                    const percentage = total > 0 ? ((item.value / total) * 100).toFixed(1) : '0';
                    return (
                      <div key={idx} className="flex items-center gap-2 p-1.5 rounded bg-secondary/20">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                        <div className="flex-1 truncate">
                          <div className="font-medium text-foreground">{item.name}</div>
                          <div className="text-muted-foreground">{item.value} ({percentage}%)</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </Card>
        </div>

        {/* PSP Deposits Breakdown */}
        <div className="col-span-12 lg:col-span-6">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <DollarSign className="w-4 h-4 text-success" />
              <h3 className="text-sm font-semibold">Total Deposits by PSP</h3>
            </div>
            {pspDeposits.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={pspDeposits} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} label={{ value: '$M', angle: -90, position: 'insideLeft' }} />
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }} formatter={(value) => {
                    let v = value;
                    if (Array.isArray(v)) v = v[0];
                    const num = typeof v === 'number' ? v : parseFloat(v);
                    return [`$${isNaN(num) ? v : num.toFixed(2)}M`, 'Deposits'];
                  }} />
                  <Bar dataKey="value" fill="#10b981" radius={[8, 8, 0, 0]}>
                    {pspDeposits.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </Card>
        </div>

        {/* PSP Withdrawals + IB */}
        <div className="col-span-12 lg:col-span-6">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <h3 className="text-sm font-semibold">Withdrawals & IB by PSP</h3>
            </div>
            {pspWithdrawals.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={pspWithdrawals} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} label={{ value: '$M', angle: -90, position: 'insideLeft' }} />
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }} formatter={(value) => {
                    let v = value;
                    if (Array.isArray(v)) v = v[0];
                    const num = typeof v === 'number' ? v : parseFloat(v);
                    return [`$${isNaN(num) ? v : num.toFixed(2)}M`, 'Amount'];
                  }} />
                  <Bar dataKey="value" fill="#ef4444" radius={[8, 8, 0, 0]}>
                    {pspWithdrawals.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </Card>
        </div>

        {/* Entity Clients & Accounts */}
        <div className="col-span-12">
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-4">
              <Briefcase className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold">Client Registration & MT5 Account Creation by Entity</h3>
              <span className="text-xs text-muted-foreground">(3 Core Entities)</span>
            </div>
            {entityClientsData.length > 0 ? (
              <div className="space-y-4">
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={entityClientsData} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} label={{ value: 'Count', angle: -90, position: 'insideLeft' }} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }}
                      formatter={(value: any, name: string) => {
                        if (name === 'clients') return [value, 'Registered Clients'];
                        if (name === 'accounts') return [value, 'MT5 Accounts'];
                        return value;
                      }}
                      labelFormatter={(label) => `Entity: ${label}`}
                    />
                    <Legend />
                    <Bar dataKey="clients" fill="#3b82f6" name="Registered Clients" radius={[8, 8, 0, 0]} />
                    <Line 
                      type="monotone" 
                      dataKey="accounts" 
                      stroke="#10b981" 
                      strokeWidth={3} 
                      dot={{ fill: '#10b981', r: 6 }} 
                      name="MT5 Accounts"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {entityClientsData.map((entity, idx) => {
                    const conversionRate = entity.clients > 0 ? ((entity.accounts / entity.clients) * 100).toFixed(1) : '0';
                    const colors = ['#3b82f6', '#10b981', '#f59e0b'];
                    const color = colors[idx % colors.length];
                    return (
                      <div key={idx} className="p-4 rounded-lg border border-border/50 bg-secondary/30">
                        <div className="flex items-center justify-between mb-3">
                          <h4 className="font-semibold text-sm">{entity.name}</h4>
                          <span className="px-2 py-1 rounded-full text-xs font-bold text-foreground" style={{ backgroundColor: color }}>
                            {conversionRate}%
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">Registered</div>
                            <div className="text-2xl font-bold" style={{ color }}>{entity.clients}</div>
                          </div>
                          <div>
                            <div className="text-xs text-muted-foreground mb-1">MT5 Created</div>
                            <div className="text-2xl font-bold" style={{ color }}>{entity.accounts}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
