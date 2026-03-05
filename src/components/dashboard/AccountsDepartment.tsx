import { useEffect, useState } from 'react';
import { Wallet, ArrowUpRight, ArrowDownRight, TrendingUp, CheckCircle, AlertTriangle } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { fetchTransactions } from '@/lib/api';
import { formatDateTimeForAPI, getDubaiDate, getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';
import { StatusBadge } from './StatusBadge';
import { fetchWalletBalances } from '@/lib/walletApi';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';

interface PSPBalance {
  name: string;
  balance: number;
  status: 'active' | 'pending' | 'error';
}

interface LpOverview {
  totalUncovered: number;
  topUncoveredSymbol: string;
  swapsDueTonight: number;
  realLpPL: number;
  lpAccounts: number;
  totalEquity: number;
  totalMargin: number;
  avgMarginLevel: number;
}

interface LpEquityPoint {
  ts: number;
  time: string;
  lpWithdrawableEquity: number;
  clientWithdrawableEquity: number;
  difference: number;
}

export function AccountsDepartment({
  selectedEntity,
  fromDate,
  toDate,
  refreshKey,
  title = 'Accounts',
  mode = 'accounts',
}: {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
  title?: string;
  mode?: 'accounts' | 'lp';
}) {
  const isLpMode = mode === 'lp';
  const [metrics, setMetrics] = useState({
    depositsToday: 0,
    withdrawalsToday: 0,
    netFlow: 0,
    totalBalance: 0,
  });
  const [lpEquitySummary, setLpEquitySummary] = useState({
    lpWithdrawableEquity: 0,
    clientWithdrawableEquity: 0,
    difference: 0,
  });
  const [lpOverview, setLpOverview] = useState<LpOverview>({
    totalUncovered: 0,
    topUncoveredSymbol: '-',
    swapsDueTonight: 0,
    realLpPL: 0,
    lpAccounts: 0,
    totalEquity: 0,
    totalMargin: 0,
    avgMarginLevel: 0,
  });
  const [lpEquitySeries, setLpEquitySeries] = useState<LpEquityPoint[]>([]);

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

    const fetchLpEquitySummary = async () => {
      try {
        const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || '').replace(/\/+$/, '');
        const endpoint = backendBaseUrl ? `${backendBaseUrl}/Metrics/equity-summary` : '/Metrics/equity-summary';
        const resp = await fetch(endpoint);
        if (!resp.ok) throw new Error(`LP equity summary API ${resp.status}`);
        const data = await resp.json();
        setLpEquitySummary({
          lpWithdrawableEquity: Number(data?.lpWithdrawableEquity) || 0,
          clientWithdrawableEquity: Number(data?.clientWithdrawableEquity) || 0,
          difference: Number(data?.difference) || 0,
        });
        const nextPoint: LpEquityPoint = {
          ts: Date.now(),
          time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
          lpWithdrawableEquity: Number(data?.lpWithdrawableEquity) || 0,
          clientWithdrawableEquity: Number(data?.clientWithdrawableEquity) || 0,
          difference: Number(data?.difference) || 0,
        };
        setLpEquitySeries((prev) => {
          const next = [...prev, nextPoint];
          return next.slice(-36);
        });
      } catch (err) {
        // silently ignore
      }
    };

    const fetchLpOverview = async () => {
      try {
        const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || '').replace(/\/+$/, '');
        const now = getDubaiDate();
        const startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(now);
        endDate.setHours(23, 59, 59, 999);
        const fromTs = Math.floor(startDate.getTime() / 1000);
        const toTs = Math.floor(endDate.getTime() / 1000);

        const coverageEndpoint = backendBaseUrl ? `${backendBaseUrl}/Coverage/position-match-table` : '/Coverage/position-match-table';
        const metricsEndpoint = backendBaseUrl ? `${backendBaseUrl}/Metrics/lp` : '/Metrics/lp';
        const swapEndpoint = backendBaseUrl ? `${backendBaseUrl}/Swap/positions` : '/Swap/positions';
        const historyEndpoint = backendBaseUrl ? `${backendBaseUrl}/History/aggregate?from=${fromTs}&to=${toTs}` : `/History/aggregate?from=${fromTs}&to=${toTs}`;

        const [coverageResp, metricsResp, swapResp, historyResp] = await Promise.allSettled([
          fetch(coverageEndpoint),
          fetch(metricsEndpoint),
          fetch(swapEndpoint),
          fetch(historyEndpoint),
        ]);

        let totalUncovered = 0;
        let topUncoveredSymbol = '-';
        let swapsDueTonight = 0;
        let realLpPL = 0;
        let lpAccounts = 0;
        let totalEquity = 0;
        let totalMargin = 0;
        let avgMarginLevel = 0;

        if (coverageResp.status === 'fulfilled' && coverageResp.value.ok) {
          const coverageData = await coverageResp.value.json();
          const rows = Array.isArray(coverageData?.rows) ? coverageData.rows : [];
          const totalsClientNet =
            typeof coverageData?.totals?.clientNet === 'number'
              ? coverageData.totals.clientNet
              : rows.reduce((sum: number, row: any) => sum + (Number(row?.clientNet) || 0), 0);
          const totalsUncovered =
            typeof coverageData?.totals?.uncovered === 'number'
              ? coverageData.totals.uncovered
              : rows.reduce((sum: number, row: any) => sum + (Number(row?.uncovered) || 0), 0);
          const _coverageClientAbs = Math.abs(totalsClientNet);
          const _coverageUncoveredAbs = Math.abs(totalsUncovered);
          totalUncovered = rows.reduce((sum: number, row: any) => sum + Math.abs(Number(row?.uncovered) || 0), 0);
          const top = [...rows].sort((a: any, b: any) => Math.abs(Number(b?.uncovered) || 0) - Math.abs(Number(a?.uncovered) || 0))[0];
          topUncoveredSymbol = top?.symbol || '-';
        }

        if (swapResp.status === 'fulfilled' && swapResp.value.ok) {
          const swapData = await swapResp.value.json();
          const rows = Array.isArray(swapData) ? swapData : [];
          swapsDueTonight = rows.filter((row: any) => Boolean(row?.willChargeTonight)).length;
        }

        if (metricsResp.status === 'fulfilled' && metricsResp.value.ok) {
          const metricsData = await metricsResp.value.json();
          const items = Array.isArray(metricsData?.items) ? metricsData.items : [];
          lpAccounts = items.length;
          totalEquity = Number(metricsData?.totals?.equity) || 0;
          totalMargin = Number(metricsData?.totals?.margin) || 0;
          const marginLevels = items.map((item: any) => Number(item?.marginLevel)).filter((v: number) => Number.isFinite(v));
          avgMarginLevel = marginLevels.length ? marginLevels.reduce((sum: number, v: number) => sum + v, 0) / marginLevels.length : 0;
        }

        if (historyResp.status === 'fulfilled' && historyResp.value.ok) {
          const historyData = await historyResp.value.json();
          realLpPL = Number(historyData?.totals?.realLpPL) || 0;
        }

        setLpOverview({
          totalUncovered,
          topUncoveredSymbol,
          swapsDueTonight,
          realLpPL,
          lpAccounts,
          totalEquity,
          totalMargin,
          avgMarginLevel,
        });
      } catch (err) {
        // silently ignore
      }
    };

    let walletInterval: ReturnType<typeof setInterval> | null = null;
    let lpInterval: ReturnType<typeof setInterval> | null = null;
    if (!isLpMode) {
      fetchTodayData();
      fetchWalletData();
      walletInterval = setInterval(fetchWalletData, 2 * 60 * 1000);
    } else {
      fetchLpEquitySummary();
      fetchLpOverview();
      fetchWalletData();
      lpInterval = setInterval(() => {
        fetchLpEquitySummary();
        fetchLpOverview();
      }, 5000);
      walletInterval = setInterval(fetchWalletData, 2 * 60 * 1000);
    }
    return () => {
      if (walletInterval) clearInterval(walletInterval);
      if (lpInterval) clearInterval(lpInterval);
    };
  }, [refreshKey, isLpMode]);

  const periodLabel = 'Today';
  const lpPlusPspDifference = lpEquitySummary.difference + metrics.totalBalance;

  return (
    <DepartmentCard title={title} icon={Wallet} accentColor="success">
      {/* LP Equity Summary or Deposits/Withdrawals */}
      {isLpMode ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <div className="p-2 rounded-lg bg-success/10 border border-success/20">
              <div className="text-xs text-muted-foreground mb-1">LP Withdrawable Equity</div>
              <div className="font-mono font-semibold text-lg">
                ${lpEquitySummary.lpWithdrawableEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
              <div className="text-xs text-muted-foreground mb-1">Client Withdrawable Equity</div>
              <div className="font-mono font-semibold text-lg">
                ${lpEquitySummary.clientWithdrawableEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="p-2 rounded-lg bg-destructive/10 border border-destructive/20">
              <div className="text-xs text-muted-foreground mb-1">LP-Client WD Equity Difference</div>
              <div className={`font-mono font-semibold text-lg ${lpEquitySummary.difference >= 0 ? 'text-success' : 'text-destructive'}`}>
                ${lpEquitySummary.difference.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="text-xs text-muted-foreground mb-1">Total PSP balance</div>
              <div className="font-mono font-semibold text-lg">
                ${metrics.totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="p-2 rounded-lg bg-violet-500/10 border border-violet-500/20">
              <div className="text-xs text-muted-foreground mb-1">equity difference</div>
              <div className={`font-mono font-semibold text-lg ${lpPlusPspDifference >= 0 ? 'text-success' : 'text-destructive'}`}>
                ${lpPlusPspDifference.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/10 via-background to-success/10 p-2">
            <div className="mb-2 text-xs text-muted-foreground">Live Equity Trend (time)</div>
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={lpEquitySeries}>
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={24} />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip
                    formatter={(value: number) => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    labelFormatter={(label) => `Time: ${label}`}
                  />
                  <Area type="monotone" dataKey="lpWithdrawableEquity" stroke="#22c55e" fill="#22c55e22" strokeWidth={2} />
                  <Area type="monotone" dataKey="clientWithdrawableEquity" stroke="#38bdf8" fill="#38bdf822" strokeWidth={2} />
                  <Area type="monotone" dataKey="difference" stroke="#f43f5e" fill="#f43f5e22" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" />LP WD</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-400" />Client WD</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-500" />Difference</span>
            </div>
          </div>
          <div className="space-y-1 pt-2 border-t border-border/30">
            <MetricRow
              label="Total Uncovered"
              value={lpOverview.totalUncovered.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            />
            <MetricRow label="Top Symbol Uncovered" value={lpOverview.topUncoveredSymbol} />
            <MetricRow label="Swap Due Tonight" value={lpOverview.swapsDueTonight} />
            <MetricRow label="LP Accounts" value={lpOverview.lpAccounts} />
            <MetricRow
              label="Total Equity"
              value={lpOverview.totalEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              prefix="$"
            />
            <MetricRow
              label="Total Margin"
              value={lpOverview.totalMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              prefix="$"
            />
            <MetricRow
              label="Avg Margin Level"
              value={lpOverview.avgMarginLevel.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              suffix="%"
            />
          </div>
        </div>
      ) : (
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
      )}

      {/* Net Flow */}
      {!isLpMode && (
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
      )}

      {/* PSP Closing Balance Report */}
      {!isLpMode && <div className="pt-2 border-t border-border/30">
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
      </div>}

      {/* Receivables */}
      {!isLpMode && <div className="pt-2 border-t border-border/30 space-y-1.5">
        <div className="p-2 rounded-md bg-warning/10 border border-warning/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">📊 To be received in BANK</div>
          <div className="font-mono font-semibold text-warning">${bankReceivable.toFixed(2)}</div>
        </div>
        <div className="p-2 rounded-md bg-cyan-500/10 border border-cyan-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">🔐 To be received in CRYPTO</div>
          <div className="font-mono font-semibold text-cyan-500">${cryptoReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>}
    </DepartmentCard>
  );
}


