import { BACKEND_BASE_URL } from "@/lib/backendBase";
import { useEffect, useState } from 'react';
import { Wallet, ArrowUpRight, ArrowDownRight, TrendingUp, CheckCircle, AlertTriangle, X } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { fetchTransactions } from '@/lib/api';
import { formatDateTimeForAPI, getDubaiDate, getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';
import { StatusBadge } from './StatusBadge';
import { fetchWalletBalances, type WalletWidgetEntry } from '@/lib/walletApi';
import { fetchEquityOverviewDashboard } from '@/lib/equityOverviewApi';
import { fetchFabAccounts, type FabAccounts } from '@/lib/excessFundsApi';
import { ExcessFundsSection } from './ExcessFundsSection';
import { BalancesPanel } from './accounts/BalancesPanel';
import { TreasuryPanel } from './accounts/TreasuryPanel';
import type { ExcessFundsInputs } from '@/lib/excessFunds';
import { addOrNull, widgetValue as readWidgetValue } from '@/lib/excessFundsInputs';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchClientVolume, resolveVolumeRange, type ClientVolumeSummary, type VolumeRangePreset } from '@/lib/clientVolumeApi';
// /api/lp-equity-live-snapshots sits behind requireSession (server.js denies
// every /api and /rest route by default); the fetch below needs the session
// bearer or it 401s the moment the deny-by-default gate is live.
import { authHeaders } from '@/lib/auth';

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
  snapshotKey: string;
  time: string;
  lpWithdrawableEquity: number;
  clientWithdrawableEquity: number;
  difference: number;
}

type LpBucket = 'Bank' | 'Both' | 'Crypto';
const LP_EQUITY_HISTORY_DAYS = 120;

const formatSnapshotLabel = (snapshotDateTime: string) => {
  const dt = new Date(snapshotDateTime.includes('T') ? snapshotDateTime : snapshotDateTime.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(dt.getTime())) return snapshotDateTime;
  return dt.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const buildUtcMinuteKey = () => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:00`;
};

const normalizeLpName = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const LP_BUCKET_ALIASES: Record<LpBucket, string[]> = {
  Bank: [
    'CMC MARKETS MIDDLE EAST LIMITED',
    'CMC Coverage',
    'CMC 2 Coverage',
    'FXCM',
    'FXCM Coverage',
    'FXCM 2 Coverage',
    'LMAX',
    'LMAX 2nd ACC TOB1 OmnibusAc',
    'Lmax 3rd acc TOBS',
    'Lmax 3rd acc TOB5',
    'LMAX Old',
    'Noor Capital',
    'XTB',
    'XTB Bonus 1(Coverage)',
    'XTB Bonus 1 (Coverage)',
  ],
  Both: [
    'AFS Global Limited - Amana',
    'Amana 1',
    'Amana2',
    'ATFX',
    'ATFX 2 coverage acc #186',
    'FINALTO',
    'Finalto Coverage 33931 REV',
    'Coverage Finalto 2nd acc',
    'Finalto 3rd account coverage',
    'FX-EDGE SC LTD',
    'FX Edge Coverage',
    'Hantec Markets',
    'Hantec',
  ],
  Crypto: [
    'AIDI Financial',
    'AIDI',
    'B2Prime',
    'B2B Coverage account',
    'Broctagon Prime Markets Limited',
    'Broctagon1',
    'Broctagon2',
    'CFI - Credit Financier Invest International LTD',
    'CFI',
    'ICM Capital Limited',
    'ICM',
    'Infinox Limited',
    'Infinox',
    'Logan Capital (PTY) LTD - LP PRIME',
    'LP Prime',
    'Mex Atlantic Corporation - Multi Bank',
    'Multi Bank',
    'Startrader Financial Markets Limited (Star Prime)',
    'Taurex (Zenfinex Global Limited)',
    'Taurex',
    'Taurex2',
  ],
};

const LP_BUCKET_MATCHERS: Record<LpBucket, string[]> = {
  Bank: LP_BUCKET_ALIASES.Bank.map(normalizeLpName),
  Both: LP_BUCKET_ALIASES.Both.map(normalizeLpName),
  Crypto: LP_BUCKET_ALIASES.Crypto.map(normalizeLpName),
};

const classifyLpBucket = (lpName: unknown): LpBucket | null => {
  const normalized = normalizeLpName(lpName);
  if (!normalized) return null;

  for (const alias of LP_BUCKET_MATCHERS.Bank) {
    if (alias && (normalized.includes(alias) || alias.includes(normalized))) return 'Bank';
  }
  for (const alias of LP_BUCKET_MATCHERS.Both) {
    if (alias && (normalized.includes(alias) || alias.includes(normalized))) return 'Both';
  }
  for (const alias of LP_BUCKET_MATCHERS.Crypto) {
    if (alias && (normalized.includes(alias) || alias.includes(normalized))) return 'Crypto';
  }
  return null;
};

// Row order for the Closing Balance Report, and the crypto/bank split that
// drives the subtotal divider. Declared here rather than inline so the count
// can be derived: a hardcoded `cryptoCount = 7` silently mis-grouped the rows
// the moment an eighth crypto wallet was added.
// NOTE: BackOfficeDepartment.tsx renders the same report and carries an
// identical copy. Change one, change the other.
const PSP_ORDER = [
  { key: 'bitpace', label: 'Bitpace', group: 'crypto' },
  { key: 'letknowpay', label: 'LetKnow Pay', group: 'crypto' },
  { key: 'ownbit', label: 'OwnBit', group: 'crypto' },
  { key: 'ownbitnew', label: 'OwnBit New', group: 'crypto' },
  { key: 'heropayment', label: 'HeroPayment', group: 'crypto' },
  { key: 'googlesheets_match2pay', label: 'Match2Pay', group: 'crypto' },
  { key: 'googlesheets_deusxpay', label: 'DeusXpay', group: 'crypto' },
  { key: 'googlesheets_openpayed', label: 'OpenPayed', group: 'crypto' },
  { key: 'googlesheets_goldsouq', label: 'Gold Souq', group: 'bank' },
  { key: 'googlesheets_fab', label: 'FAB Bank', group: 'bank' },
  { key: 'googlesheets_mbme', label: 'MBME', group: 'bank' },
] as const;

const CRYPTO_PSP_COUNT = PSP_ORDER.filter((p) => p.group === 'crypto').length;

// Display names of the wallet widgets that failed their balance check, for
// TreasuryPanel's "understated" notice.
//
// Built from the RAW walletWidgets, not from pspBalances: that array has
// already had status:'error' flattened to a balance of 0.00 so the row can
// still render, so it can no longer tell a failure from a real zero -- the
// same reasoning as widgetValue() inside the component.
//
// Exported and lifted out of the component body so it can be unit-tested on
// its own. It was previously an inline .filter().map() covered only by a
// regex over this file's source, which matched three unrelated places and
// still passed when the derivation was replaced with `.filter(() => false)`
// -- the mutation that permanently silences the understatement notice.
export function failedProviderNames(widgets: readonly WalletWidgetEntry[]): string[] {
  return widgets.filter((widget) => widget.status === 'error').map((widget) => widget.name);
}

export function AccountsDepartment({
  selectedEntity,
  fromDate,
  toDate,
  refreshKey,
  title = 'Accounts',
  mode = 'accounts',
  // (home dashboard, MainDashboard) alongside other small live-summary
  // panels. The Revenue Share panel is a full table with its own date
  // pickers and a Run button, which only belongs on the dedicated
  // /departments/accounts page. Only that mount site should pass true.
  //
  // 'page' is the redesigned full-page composition built for
  // /departments/accounts. AccountsDepartment mounts five times across the
  // app and the home dashboard was explicitly excluded from this redesign --
  // there it sits in a third-width column, and a full-width layout would look
  // worse than what it has now. Only DepartmentPages.tsx passes 'page'; every
  // other call site keeps the default and renders exactly what it renders
  // today. See accountsLayout.test.ts.
  layout = 'card',
}: {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
  title?: string;
  mode?: 'accounts' | 'lp';
  layout?: 'card' | 'page';
}) {
  const isLpMode = mode === 'lp';
  const [volumePreset, setVolumePreset] = useState<VolumeRangePreset>('today');
  const [volume, setVolume] = useState<ClientVolumeSummary | null>(null);
  const [volumeLoading, setVolumeLoading] = useState(isLpMode);
  const [volumeError, setVolumeError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLpMode) return;
    const controller = new AbortController();
    const { from, to } = resolveVolumeRange(volumePreset, new Date());
    setVolumeLoading(true);
    setVolumeError(null);
    fetchClientVolume({ from, to, signal: controller.signal })
      .then((data) => setVolume(data))
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setVolumeError(err instanceof Error ? err.message : 'Failed to load client volume');
        setVolume(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setVolumeLoading(false);
      });
    return () => controller.abort();
  }, [isLpMode, volumePreset, refreshKey]);

  const volumeSeries = volume?.byDate ?? [];
  const volumeIsSingleDay = volumeSeries.length < 2;
  const volumeHasData = volumeSeries.length > 0;
  const fmtLots = (n: number) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDayLabel = (value: string) => {
    const parts = String(value || '').split('-');
    if (parts.length !== 3) return String(value || '');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) return String(value || '');
    const d = new Date(y, m - 1, day);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  };
  const renderVolumeTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;
    const datum = payload[0]?.payload;
    if (!datum) return null;
    return (
      <div
        style={{
          background: 'rgba(15,23,42,0.92)',
          border: '1px solid rgba(148,163,184,0.35)',
          borderRadius: 8,
          color: '#e2e8f0',
          fontSize: 11,
          padding: '6px 8px',
        }}
      >
        <div style={{ color: '#cbd5e1', marginBottom: 4 }}>{fmtDayLabel(String(label))}</div>
        <div>Equity: {fmtLots(Number(datum.stocksLots))} lots</div>
        <div>CFD: {fmtLots(Number(datum.cfdLots))} lots</div>
        <div>Total: {fmtLots(Number(datum.lots))} lots</div>
      </div>
    );
  };
  const VOLUME_PRESETS: Array<{ key: VolumeRangePreset; label: string; title: string }> = [
    { key: 'today', label: 'Today', title: 'Today' },
    { key: 'yesterday', label: 'Yest', title: 'Yesterday' },
    { key: 'week', label: 'Week', title: 'This week (from Monday)' },
    { key: 'month', label: 'Month', title: 'This month (from the 1st)' },
  ];
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
  const [lpRealEquityBuckets, setLpRealEquityBuckets] = useState<Record<LpBucket, number>>({
    Bank: 0,
    Both: 0,
    Crypto: 0,
  });
  const [showLpBreakdownTooltip, setShowLpBreakdownTooltip] = useState(false);

  const [pspBalances, setPspBalances] = useState<PSPBalance[]>([]);
  // The raw widgets, before status:'error' is flattened to a balance of 0 for
  // display. The Excess Funds figures need to tell a real zero from a failed
  // read; pspBalances cannot, by design, because a zero row still has to render.
  const [walletWidgets, setWalletWidgets] = useState<WalletWidgetEntry[]>([]);
  // Sheet field keys the backend could not parse into a number. A widget built
  // on one of them arrives status:'ok' with a balance of 0 that was never a
  // balance, so this is the only thing standing between a shifted spreadsheet
  // row and a confident, wrong treasury figure.
  const [unreadableSheetFields, setUnreadableSheetFields] = useState<string[]>([]);
  const [fabAccounts, setFabAccounts] = useState<FabAccounts | null>(null);
  // lpEquitySummary initialises to zeroes below, so a failed equity fetch would
  // otherwise present as a real netDifference of 0.00. This tracks whether the
  // fetch has ever actually succeeded.
  const [equityLoaded, setEquityLoaded] = useState(false);
  // equityLoaded never goes back to false once the first fetch succeeds, so a
  // later failure leaves lpEquitySummary frozen at its last good value while the
  // wallet half keeps moving. The figures then read complete and current when
  // half of them is neither. This carries the last failure so the section can
  // say so on itself.
  const [equityError, setEquityError] = useState<string | null>(null);
  // The equity endpoint carries no timestamp of its own. The page layout's
  // header shows three source freshness times (Wallet, Equity, FAB sheet);
  // this is the client-side read time for the second one, set only on a
  // successful fetch so a failure leaves it at the last good value rather
  // than claiming freshness it doesn't have. Display only -- read on the page
  // branch below, never touches any figure.
  const [equityUpdatedAt, setEquityUpdatedAt] = useState<string | null>(null);
  const [bankReceivable, setBankReceivable] = useState(0);
  const [cryptoReceivable, setCryptoReceivable] = useState(0);
  const [toBeDepositedIntoLpsK20, setToBeDepositedIntoLpsK20] = useState(0);
  const [toBeDepositedIntoLpsK21, setToBeDepositedIntoLpsK21] = useState(0);
  const [differenceBetweenActualAndExpected, setDifferenceBetweenActualAndExpected] = useState(0);
  const [creditByLps, setCreditByLps] = useState(0);
  const [netAllCurrentBalance, setNetAllCurrentBalance] = useState(0);
  const [netBalanceAfterExpectedFunds, setNetBalanceAfterExpectedFunds] = useState(0);
  const [reportDate, setReportDate] = useState('—');
  const [reportUpdated, setReportUpdated] = useState('—');
  const [walletError, setWalletError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // This component mounts twice on the home page and the effect re-runs on
    // every refresh, so an in-flight response must not write state into a torn
    // down mount.
    let cancelled = false;

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
      // The raw widgets, before status:'error' is flattened to a balance of 0 for
      // display. The Excess Funds figures need to tell a real zero from a failed
      // read; pspBalances cannot, by design, because a zero row still has to render.
      setWalletWidgets(widgets);
      setUnreadableSheetFields(
        Array.isArray(response.data.unreadableSheetFields) ? response.data.unreadableSheetFields : [],
      );
      const widgetMap = new Map(widgets.map((widget) => [widget.id, widget]));
      const order = PSP_ORDER;

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
      const bankValue = Number(response.data.bank_receivable ?? 0);
      const cryptoValue = Number(response.data.crypto_receivable ?? 0);
      const lpDepositK20 = Number(response.data.to_be_deposited_into_lps_k20 ?? 0);
      const lpDepositK21 = Number(response.data.to_be_deposited_into_lps_k21 ?? 0);
      const diffActualExpected = Number(response.data.difference_between_actual_and_expected ?? 0);
      const creditByLpsValue = Number(response.data.credit_by_lps ?? 0);
      const netCurrent = Number(response.data.net_all_current_balance ?? total);
      const netAfterExpected = Number(response.data.net_balance_after_expected_funds ?? (netCurrent + bankValue + cryptoValue));

      setBankReceivable(bankValue);
      setCryptoReceivable(cryptoValue);
      setToBeDepositedIntoLpsK20(lpDepositK20);
      setToBeDepositedIntoLpsK21(lpDepositK21);
      setDifferenceBetweenActualAndExpected(diffActualExpected);
      setCreditByLps(creditByLpsValue);
      setNetAllCurrentBalance(Number.isFinite(netCurrent) ? netCurrent : total);
      setNetBalanceAfterExpectedFunds(Number.isFinite(netAfterExpected) ? netAfterExpected : netCurrent + bankValue + cryptoValue);
    };

    // Snapshots are still written for persistence/history; the dashboard no longer
    // reads them back, so there is no loader here.
    const upsertLpEquitySnapshot = async (point: LpEquityPoint) => {
      try {
        await fetch('/api/lp-equity-live-snapshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            snapshotTime: point.snapshotKey,
            lpWithdrawableEquity: point.lpWithdrawableEquity,
            clientWithdrawableEquity: point.clientWithdrawableEquity,
            difference: point.difference,
            source: 'dashboard',
          }),
        });
      } catch (_err) {
        // silently ignore
      }
    };

    // One equity call at a time. The non-LP path polls a minute apart and the LP
    // path five seconds apart, but the call also POSTs a snapshot row, and a
    // response slower than the interval would otherwise land after a newer one
    // and write a stale equity back over a fresher one.
    let equityInFlight = false;

    const fetchLpEquitySummary = async () => {
      if (equityInFlight) return;
      equityInFlight = true;
      try {
        const data = await fetchEquityOverviewDashboard({ includeDetails: false });
        if (cancelled) return;
        const lpWithdrawableEquity = data.lps.netWithdrawableEquity;
        const clientWithdrawableEquity = data.clients.netWithdrawableEquity;
        const difference = data.netDifference;
        setLpEquitySummary({
          lpWithdrawableEquity,
          clientWithdrawableEquity,
          difference,
        });
        setEquityLoaded(true);
        setEquityError(null);
        setEquityUpdatedAt(new Date().toISOString());
        const snapshotKey = buildUtcMinuteKey();
        const pointTs = new Date(snapshotKey.replace(' ', 'T') + 'Z').getTime();
        const nextPoint: LpEquityPoint = {
          ts: Number.isFinite(pointTs) ? pointTs : Date.now(),
          snapshotKey,
          time: formatSnapshotLabel(snapshotKey),
          lpWithdrawableEquity,
          clientWithdrawableEquity,
          difference,
        };
        await upsertLpEquitySnapshot(nextPoint);
      } catch (err) {
        // Swallowing this used to leave equityLoaded true forever, so the
        // section kept printing an arithmetically complete figure off an
        // arbitrarily old equity read with no sign anywhere that it was old.
        if (!cancelled) setEquityError((err as Error)?.message || String(err));
      } finally {
        equityInFlight = false;
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

        const coverageEndpoint = `${BACKEND_BASE_URL}/Coverage/position-match-table`;
        const metricsEndpoint = `${BACKEND_BASE_URL}/Metrics/lp`;
        const swapEndpoint = `${BACKEND_BASE_URL}/Swap/positions`;
        const historyEndpoint = `${BACKEND_BASE_URL}/History/aggregate?from=${fromTs}&to=${toTs}`;

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
        const nextBuckets: Record<LpBucket, number> = { Bank: 0, Both: 0, Crypto: 0 };

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

          for (const item of items) {
            const bucket = classifyLpBucket(item?.lp);
            if (!bucket) continue;
            nextBuckets[bucket] += Number(item?.realEquity) || 0;
          }
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
        setLpRealEquityBuckets(nextBuckets);
      } catch (err) {
        // silently ignore
      }
    };

    const fetchFab = async () => {
      try {
        setFabAccounts(await fetchFabAccounts());
      } catch (error) {
        // Its own catch: the FAB workbook is a separate dependency and its
        // absence must cost the Net Excess Fund card, not the page.
        console.warn('[ExcessFunds] FAB accounts unavailable:', (error as Error)?.message || error);
        setFabAccounts(null);
      }
    };

    let walletInterval: ReturnType<typeof setInterval> | null = null;
    let lpInterval: ReturnType<typeof setInterval> | null = null;
    // The equity fetch used to run only in LP mode. The Accounts page's Excess
    // Funds section needs netDifference too, so this now runs unconditionally
    // instead of being gated on isLpMode.
    fetchLpEquitySummary();
    if (!isLpMode) {
      fetchTodayData();
      fetchWalletData();
      // The FAB workbook feeds the Excess Funds section, which only renders when
      // !isLpMode. Ungated, the home page's Dealing (LP) card called
      // /api/fab-accounts on every mount and refresh, took a 502 and logged a
      // warning for data it never shows.
      void fetchFab();
      walletInterval = setInterval(fetchWalletData, 2 * 60 * 1000);
      // walletWidgets re-polls above, but until now nothing re-fetched equity
      // here, so netDifference/lpEquity/clientEquity went stale forever after
      // mount while the wallet figures kept moving -- a reader can't tell half
      // a treasury figure is frozen.
      //
      // 60s, not LP mode's 5s: this call also POSTs to
      // /api/lp-equity-live-snapshots, so 5s is 12 external calls and 12 database
      // upserts a minute per mount, and this component mounts twice on the home
      // page. It buys nothing either -- the wallet half refreshes every 2
      // minutes, so the section can never be fresher than that.
      lpInterval = setInterval(fetchLpEquitySummary, 60 * 1000);
    } else {
      fetchLpOverview();
      fetchWalletData();
      lpInterval = setInterval(() => {
        fetchLpEquitySummary();
        fetchLpOverview();
      }, 5000);
      walletInterval = setInterval(fetchWalletData, 2 * 60 * 1000);
    }
    return () => {
      cancelled = true;
      if (walletInterval) clearInterval(walletInterval);
      if (lpInterval) clearInterval(lpInterval);
    };
  }, [refreshKey, isLpMode]);

  const periodLabel = 'Today';
  const lpDepositsTotal = toBeDepositedIntoLpsK20 + toBeDepositedIntoLpsK21;
  // Credit by LPs (J30) is intentionally NOT subtracted here — it is shown as its own
  // tile instead. Do not add it back into this formula.
  const lpPlusPspDifference =
    lpEquitySummary.difference +
    metrics.totalBalance +
    cryptoReceivable +
    bankReceivable +
    lpDepositsTotal;
  const equityDifferenceTooltip = `Formula: fetched difference + PSP total balance + To be received in CRYPTO + To be received in BANK + To be deposited into LPs (Bank - USD) + To be deposited into LPs (Crypto USDT)\n(${lpEquitySummary.difference.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + ${metrics.totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + ${cryptoReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + ${bankReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + ${toBeDepositedIntoLpsK20.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + ${toBeDepositedIntoLpsK21.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;

  // Built from the RAW widgets, not from pspBalances: that array has already had
  // status:'error' flattened to a balance of 0 so the row can still render, and a
  // treasury figure must never treat a failed read as a zero balance. The
  // unreadable-field list does the same job one level down, for a sheet cell the
  // backend could not parse while the widget still reported ok.
  const widgetValue = (id: string): number | null =>
    readWidgetValue(walletWidgets, id, unreadableSheetFields);

  const cryptoKeys = PSP_ORDER.filter((p) => p.group === 'crypto').map((p) => p.key);

  const excessInputs: ExcessFundsInputs = {
    // equityLoaded, not the value itself: lpEquitySummary initialises to zeroes,
    // so a failed equity fetch would otherwise present as a real netDifference
    // of 0.00 and produce a confident, wrong treasury figure.
    netDifference: equityLoaded ? lpEquitySummary.difference : null,
    netCrypto: addOrNull(...cryptoKeys.map(widgetValue)),
    fabAndMbme: addOrNull(widgetValue('googlesheets_fab'), widgetValue('googlesheets_mbme')),
    // Through addOrNull like its neighbours: a non-error widget with an absent
    // balance yields NaN, and NaN must arrive as null, not as a number.
    goldSouq: addOrNull(widgetValue('googlesheets_goldsouq')),
    fabOperating: fabAccounts ? fabAccounts.fabOperating : null,
    fabHolding: fabAccounts ? fabAccounts.fabHolding : null,
  };

  const failedProviders = failedProviderNames(walletWidgets);

  // Time-only formatting for the page header's three freshness stamps. Local
  // to the page branch: the section this mirrors (ExcessFundsSection.tsx) has
  // its own private clockTime() but doesn't export it, and that file is out
  // of scope for this task.
  const formatClock = (iso?: string | null): string => {
    if (!iso) return '—';
    const dt = new Date(iso);
    if (!Number.isFinite(dt.getTime())) return '—';
    return dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  if (layout === 'page') {
    return (
      <div>
        {/* Page header: title on the left, the three source freshness stamps
            on the right -- wallet, LP/client equity and the FAB workbook, the
            same three sources the Excess Funds figures below are built from. */}
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Departments</p>
            <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Wallet <span className="font-medium text-foreground">{reportUpdated}</span></span>
            <span>Equity <span className="font-medium text-foreground">{formatClock(equityUpdatedAt)}</span></span>
            <span>FAB sheet <span className="font-medium text-foreground">{formatClock(fabAccounts?.fetchedAt)}</span></span>
          </div>
        </div>

        {/* The day's flow strip. */}
        <div className="mb-5 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border/60 bg-border/40 sm:grid-cols-3">
          <div className="bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Deposits today</div>
            <div className="mt-0.5 font-mono text-lg font-medium text-success">
              ${metrics.depositsToday.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className="bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Withdrawals today</div>
            <div className="mt-0.5 font-mono text-lg font-medium text-destructive">
              ${metrics.withdrawalsToday.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className="bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Net flow today</div>
            <div className={`mt-0.5 font-mono text-lg font-medium ${metrics.netFlow >= 0 ? 'text-success' : 'text-destructive'}`}>
              ${metrics.netFlow.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        {/* Excess funds, full width. Same component and same inputs as the
            card branch below -- only the surrounding chrome differs, because
            on this page it stands alone as its own panel instead of living
            inside DepartmentCard's border-topped stack of sections. */}
        <div className="mb-5 rounded-lg border border-border/60 bg-card p-3">
          <ExcessFundsSection
            inputs={excessInputs}
            lpEquity={equityLoaded ? lpEquitySummary.lpWithdrawableEquity : null}
            clientEquity={equityLoaded ? lpEquitySummary.clientWithdrawableEquity : null}
            fabFetchedAt={fabAccounts?.fetchedAt}
            walletError={walletError}
            equityError={equityError}
            walletUpdated={reportUpdated}
          />
        </div>

        {/* The card branch's two wallet-failure signals, carried onto this
            page. Both panels below are built from the same wallet fetch, and
            without these a failed or still-pending first fetch renders a
            Crypto heading with no rows, a $0.00 total combined and eight
            Treasury tiles all reading $0.00 -- a page of confident zeroes
            exactly where the card branch said why. A never-loaded page must
            not present itself as a loaded one. Above the pair rather than
            inside Balances, because the zeroes are in both panels. */}
        {walletError && (
          <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {walletError}
          </div>
        )}
        {pspBalances.length === 0 && !isLoading && (
          <div className="mb-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            No wallet data available.
          </div>
        )}

        {/* Balances (wider) and Treasury side by side; single column below lg. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.15fr_1fr]">
          <BalancesPanel
            widgets={walletWidgets}
            totalBalance={metrics.totalBalance}
            reportDate={reportDate === '—' ? null : reportDate}
            order={PSP_ORDER}
          />
          <TreasuryPanel
            bankReceivable={bankReceivable}
            cryptoReceivable={cryptoReceivable}
            toLpsBank={toBeDepositedIntoLpsK20}
            toLpsCrypto={toBeDepositedIntoLpsK21}
            netAllCurrentBalance={netAllCurrentBalance}
            netAfterExpectedFunds={netBalanceAfterExpectedFunds}
            differenceActualVsExpected={differenceBetweenActualAndExpected}
            creditByLps={creditByLps}
            failedProviders={failedProviders}
          />
        </div>
      </div>
    );
  }

  // --- Card layout (default) ---
  // This is the JSX that mounts on the home dashboard (Index.tsx x2,
  // MainDashboard.tsx) and MT5Examples.tsx, none of which opted into the
  // redesign above. It is intentionally left byte-for-byte as it was before
  // this task: the home dashboard was explicitly excluded from the redesign,
  // and this markup renders there four times over. That duplicates markup
  // with the page branch above -- deliberate and scoped. Unifying the two
  // needs its own approval, because it would change what renders on the home
  // dashboard.
  return (
    <DepartmentCard title={title} icon={Wallet} accentColor="success">
      {/* LP Equity Summary or Deposits/Withdrawals */}
      {isLpMode ? (
        <div className="space-y-2">
          <div className="grid grid-cols-1 min-[440px]:grid-cols-3 gap-2">
            <div
              className="relative p-2 rounded-lg bg-success/10 border border-success/20"
              onMouseEnter={() => setShowLpBreakdownTooltip(true)}
            >
              <div className="text-xs text-muted-foreground mb-1">LP Withdrawable Equity</div>
              <div className="font-mono font-semibold text-sm sm:text-base">
                ${lpEquitySummary.lpWithdrawableEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              {showLpBreakdownTooltip && (
                <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-md border border-slate-300 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-950">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">LP Real Equity Breakdown</div>
                    <button
                      type="button"
                      onClick={() => setShowLpBreakdownTooltip(false)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      aria-label="Close breakdown"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sky-700 dark:text-sky-300">Bank</span>
                      <span className="font-mono text-slate-700 dark:text-slate-200">${lpRealEquityBuckets.Bank.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-amber-700 dark:text-amber-300">Both</span>
                      <span className="font-mono text-slate-700 dark:text-slate-200">${lpRealEquityBuckets.Both.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-violet-700 dark:text-violet-300">Crypto</span>
                      <span className="font-mono text-slate-700 dark:text-slate-200">${lpRealEquityBuckets.Crypto.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
              <div className="text-xs text-muted-foreground mb-1">Client Withdrawable Equity</div>
              <div className="font-mono font-semibold text-sm sm:text-base">
                ${lpEquitySummary.clientWithdrawableEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="p-2 rounded-lg bg-destructive/10 border border-destructive/20">
              <div className="text-xs text-muted-foreground mb-1">LP-Client WD Equity Difference</div>
              <div className={`font-mono font-semibold text-sm sm:text-base ${lpEquitySummary.difference >= 0 ? 'text-success' : 'text-destructive'}`}>
                ${lpEquitySummary.difference.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="text-xs text-muted-foreground mb-1">Total PSP balance</div>
              <div className="font-mono font-semibold text-sm sm:text-base">
                ${metrics.totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="p-2 rounded-lg bg-violet-500/10 border border-violet-500/20">
              <div
                className="text-xs text-muted-foreground mb-1 cursor-help"
                title={equityDifferenceTooltip}
              >
                Equity Difference
              </div>
              <div
                className={`font-mono font-semibold text-sm sm:text-base ${lpPlusPspDifference >= 0 ? 'text-success' : 'text-destructive'}`}
                title={equityDifferenceTooltip}
              >
                ${lpPlusPspDifference.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                Counts every PSP, plus receivables and to-LP amounts
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/10 via-background to-success/10 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">Client Volume</div>
              <div className="flex items-center gap-1">
                {VOLUME_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    title={p.title}
                    aria-pressed={volumePreset === p.key}
                    onClick={() => setVolumePreset(p.key)}
                    className={`rounded px-1.5 py-0.5 text-[10px] transition focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
                      volumePreset === p.key
                        ? 'bg-primary/20 text-primary font-semibold'
                        : 'text-muted-foreground hover:text-foreground hover:bg-primary/10'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-2 grid grid-cols-2 gap-2">
              <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
                <div className="text-xs text-muted-foreground mb-1">Equity Volume</div>
                <div className="font-mono font-semibold text-sm sm:text-base text-cyan-600 dark:text-cyan-300">
                  {volume ? (
                    <>
                      {fmtLots(volume.totalStocksLots)}
                      <span className="text-xs text-muted-foreground"> lots</span>
                    </>
                  ) : (
                    '—'
                  )}
                </div>
              </div>
              <div className="p-2 rounded-lg bg-violet-500/10 border border-violet-500/20">
                <div className="text-xs text-muted-foreground mb-1">CFD Volume</div>
                <div className="font-mono font-semibold text-sm sm:text-base text-violet-600 dark:text-violet-300">
                  {volume ? (
                    <>
                      {fmtLots(volume.totalCfdLots)}
                      <span className="text-xs text-muted-foreground"> lots</span>
                    </>
                  ) : (
                    '—'
                  )}
                </div>
              </div>
            </div>

            {volumeError && (
              <div className="mb-1 text-[11px] text-warning/90">{volumeError}</div>
            )}

            <div className="h-32">
              {!volumeHasData ? (
                <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
                  {volumeLoading ? 'Loading…' : 'No client volume in this range.'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  {volumeIsSingleDay ? (
                    <BarChart data={volumeSeries}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.16} />
                      <XAxis dataKey="date" tickFormatter={fmtDayLabel} tick={{ fontSize: 10 }} />
                      <YAxis hide domain={[0, 'auto']} />
                      <Tooltip
                        cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                        content={renderVolumeTooltip}
                      />
                      <Bar dataKey="stocksLots" stackId="vol" fill="hsl(186 100% 50%)" radius={[0, 0, 0, 0]} maxBarSize={54} />
                      <Bar dataKey="cfdLots" stackId="vol" fill="#a78bfa" radius={[3, 3, 0, 0]} maxBarSize={54} />
                    </BarChart>
                  ) : (
                    <AreaChart data={volumeSeries}>
                      <defs>
                        <linearGradient id="cvEquityGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="hsl(186 100% 50%)" stopOpacity={0.42} />
                          <stop offset="100%" stopColor="hsl(186 100% 50%)" stopOpacity={0.04} />
                        </linearGradient>
                        <linearGradient id="cvCfdGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.42} />
                          <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.04} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.16} />
                      <XAxis dataKey="date" tickFormatter={fmtDayLabel} tick={{ fontSize: 10 }} minTickGap={22} />
                      <YAxis hide domain={[0, 'auto']} />
                      <Tooltip content={renderVolumeTooltip} />
                      <Area
                        type="monotone"
                        dataKey="stocksLots"
                        stackId="vol"
                        stroke="hsl(186 100% 50%)"
                        strokeWidth={2.2}
                        fill="url(#cvEquityGradient)"
                        isAnimationActive
                      />
                      <Area
                        type="monotone"
                        dataKey="cfdLots"
                        stackId="vol"
                        stroke="#a78bfa"
                        strokeWidth={2.2}
                        fill="url(#cvCfdGradient)"
                        isAnimationActive
                      />
                    </AreaChart>
                  )}
                </ResponsiveContainer>
              )}
            </div>

            <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: 'hsl(186 100% 50%)' }} />Equity</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-violet-400" />CFD</span>
              {volumeLoading && volumeHasData && <span className="text-muted-foreground/70">updating…</span>}
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
        
        <div className="space-y-1">
          {walletError && (
            <div className="text-[11px] text-destructive">{walletError}</div>
          )}
          {pspBalances.length === 0 && !isLoading && (
            <div className="text-[11px] text-muted-foreground">No wallet data available.</div>
          )}
          {pspBalances.map((psp, index) => {
            const cryptoCount = CRYPTO_PSP_COUNT;
            const cryptoSubtotal = pspBalances.slice(0, cryptoCount).reduce((sum, item) => sum + item.balance, 0);
            
            return (
              <div key={psp.name}>
                <div className="flex items-center justify-between p-1.5 rounded-md bg-secondary/30 border border-border/40 text-xs">
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
                {index === cryptoCount - 1 && (
                  <div className="flex items-center justify-between p-1.5 rounded-md bg-cyan-500/15 border border-cyan-500/40 text-xs mt-1">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <CheckCircle className="w-3 h-3 text-cyan-500 flex-shrink-0" />
                      <span className="text-foreground font-semibold truncate">🔐 SUBTOTAL CRYPTO</span>
                    </div>
                    <span className="font-mono font-bold text-right ml-2 flex-shrink-0 text-cyan-500">
                      ${cryptoSubtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
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
      {!isLpMode && <div className="pt-2 border-t border-border/30 grid grid-cols-2 gap-1.5">
        <div className="p-2 rounded-md bg-warning/10 border border-warning/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">📊 To be received in BANK</div>
          <div className="font-mono font-semibold text-warning">${bankReceivable.toFixed(2)}</div>
        </div>
        <div className="p-2 rounded-md bg-cyan-500/10 border border-cyan-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">🔐 To be received in CRYPTO</div>
          <div className="font-mono font-semibold text-cyan-500">${cryptoReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="p-2 rounded-md bg-fuchsia-500/10 border border-fuchsia-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">🏦 To be deposited into LPs (Bank - USD)</div>
          <div className="font-mono font-semibold text-fuchsia-500">${toBeDepositedIntoLpsK20.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="p-2 rounded-md bg-rose-500/10 border border-rose-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">🏦 To be deposited into LPs (Crypto USDT)</div>
          <div className="font-mono font-semibold text-rose-500">${toBeDepositedIntoLpsK21.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="p-2 rounded-md bg-emerald-500/10 border border-emerald-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">💼 Net all Current Balance</div>
          <div className="font-mono font-semibold text-emerald-500">${netAllCurrentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="p-2 rounded-md bg-indigo-500/10 border border-indigo-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">📈 Net Balance after expected funds</div>
          <div className="font-mono font-semibold text-indigo-500">${netBalanceAfterExpectedFunds.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="p-2 rounded-md bg-orange-500/10 border border-orange-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">⚖️ Difference between actual and expected (J29)</div>
          <div className="font-mono font-semibold text-orange-500">${differenceBetweenActualAndExpected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="p-2 rounded-md bg-sky-500/10 border border-sky-500/20">
          <div className="text-[10px] text-muted-foreground mb-0.5">Credit by LPs (J30)</div>
          <div className="font-mono font-semibold text-sky-500">${creditByLps.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>}

      {!isLpMode && (
        <ExcessFundsSection
          inputs={excessInputs}
          lpEquity={equityLoaded ? lpEquitySummary.lpWithdrawableEquity : null}
          clientEquity={equityLoaded ? lpEquitySummary.clientWithdrawableEquity : null}
          fabFetchedAt={fabAccounts?.fetchedAt}
          // The staleness signals belong ON this section. walletError already
          // renders inside the Closing Balance block further up, but a reader
          // looking at Gross Excess Fund has no reason to connect the two.
          walletError={walletError}
          equityError={equityError}
          walletUpdated={reportUpdated}
        />
      )}
    </DepartmentCard>
  );
}
