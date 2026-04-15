import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Settings,
  Users,
  Database,
  TrendingUp,
  CheckCircle,
  AlertCircle,
  Shield,
  Briefcase,
  User,
  ArrowDownToLine,
  ArrowUpToLine,
  Search,
  Loader2,
  Camera,
  Maximize2,
  Minimize2,
  FileSignature,
  Clock3,
  CircleCheckBig,
  Activity,
  RefreshCw,
} from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { fetchUsers, fetchAllUsers, fetchTransactions, fetchAllTransactions, fetchAccounts, type AccountRequest, type Account } from '@/lib/api';
import { fetchDocusignOverview, type DocusignOverview } from '@/lib/docusignApi';
import { formatDateTimeForAPI, getDubaiDate, getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';
import { fetchWalletBalances } from '@/lib/walletApi';
import { SortableTable, type SortableTableColumn } from '@/components/ui/SortableTable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fetchAccountsByUserId, fetchDealsByLogin, fetchIbTree } from '@/lib/rebateApi';
import { getRateForSymbol, normalizeRebateSymbol } from '@/pages/departments/dealing/rebateUtils';

async function fetchAllAccounts(filter: Omit<AccountRequest, 'segment'>): Promise<Account[]> {
  const PAGE = 1000;
  const all: Account[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchAccounts({ ...filter, segment: { limit: PAGE, offset } }).catch(() => [] as Account[]);
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

type CashflowTx = {
  id: number | string;
  processedAt: string;
  amount: number;
  pspName: string;
  pspId: number | null;
};

type CashflowRow = {
  deposit: CashflowTx | null;
  withdrawal: CashflowTx | null;
};

type PSPBalance = {
  name: string;
  balance: number;
  status: 'active' | 'pending' | 'error';
};

type RebateCalcRow = {
  login: string;
  symbol: string;
  trades: number;
  tradedLots: number;
  eligibleLots: number;
  ineligibleLots: number;
  rebatePerLot: number;
  commissionUsd: number;
};

type RebateMode = 'all' | 'specific' | 'all-with-overrides';
type RebateCloseMode = 'deal-out-only' | 'all-close-side';
type RebateLoginScope = 'all' | 'enabled-only';
type RebateDateMode = 'crm-calendar' | 'browser-local';
type RebateCommissionSource = 'input-rate' | 'mt5-commission';

type RebatePreset = {
  name: string;
  ibId: string;
  fromDate: string;
  toDate: string;
  mode: RebateMode;
  closeMode?: RebateCloseMode;
  loginScope?: RebateLoginScope;
  dateMode?: RebateDateMode;
  commissionSource?: RebateCommissionSource;
  defaultRate: string;
  overridesText: string;
  includeSubIb: boolean;
};

const REBATE_PRESETS_STORAGE_KEY = 'backoffice-ib-rebate-presets-v1';

const parseRebateDateInput = (value: string, mode: RebateDateMode, endOfDay = false) => {
  if (mode === 'browser-local') {
    return new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`);
  }

  const [yy, mm, dd] = String(value || '').split('-').map((part) => Number(part));
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) {
    return new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`);
  }

  return new Date(Date.UTC(yy, mm - 1, dd, endOfDay ? 23 : 12, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
};

const toInputDate = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const getPositionLots = (position: { lots?: number; volume?: number; volumeExt?: number }) => {
  const lots = Number(position.lots) || 0;
  if (lots > 0) return lots;
  const volumeExt = Number(position.volumeExt) || 0;
  if (volumeExt > 0) return volumeExt / 100_000_000;
  const volume = Number(position.volume) || 0;
  return volume > 0 ? volume / 10_000 : 0;
};

const isDealOut = (deal: any, mode: RebateCloseMode) => {
  const rawEntry = (deal?.entry ?? deal?.Entry ?? '').toString().trim();
  const rawAction = (deal?.action ?? deal?.Action ?? '').toString().trim();

  if (mode === 'deal-out-only') {
    if (rawEntry === '1') return true;
    const entryOut = rawEntry.toUpperCase();
    return entryOut === 'OUT' || entryOut === 'DEAL_ENTRY_OUT';
  }

  // MT5 close-side entry enums: OUT=1, INOUT=2 (reverse), OUT_BY=3.
  if (rawEntry === '1' || rawEntry === '2' || rawEntry === '3') return true;
  const entryUpper = rawEntry.toUpperCase();
  if (
    entryUpper === 'OUT' ||
    entryUpper === 'DEAL_ENTRY_OUT' ||
    entryUpper === 'INOUT' ||
    entryUpper === 'DEAL_ENTRY_INOUT' ||
    entryUpper === 'OUT_BY' ||
    entryUpper === 'DEAL_ENTRY_OUT_BY'
  ) {
    return true;
  }

  // Optional fallback for bridges that expose close semantics only via action labels.
  const actionUpper = rawAction.toUpperCase();
  if (actionUpper.includes('OUT') || actionUpper.includes('CLOSE')) return true;

  return false;
};

export function BackOfficeDepartment({
  selectedEntity,
  fromDate,
  toDate,
  refreshKey,
  variant = 'full',
}: {
  selectedEntity: string;
  fromDate?: Date;
  toDate?: Date;
  refreshKey: number;
  variant?: 'full' | 'compact';
}) {
  const [metrics, setMetrics] = useState({
    totalIBs: 0,
    totalDeposits: 0,
    totalWithdrawals: 0,
    totalDepositCount: 0,
    totalWithdrawalCount: 0,
    totalClients: 0,
    totalMT5Accounts: 0,
    firstDeposits: 0,
    verifiedClients: 0,
    unverifiedClients: 0,
    individualClients: 0,
    corporateClients: 0,
    testProfiles: 0,
    sumsubActive: 0,
    activeAccounts: 0,
    demoAccounts: 0,
    liveAccounts: 0,
    kycApproved: 0,
    kycApprovedWithConditions: 0,
    kycPendingReview: 0,
    kycRejected: 0,
    kycAdditionalInfo: 0,
    kycOnHold: 0,
    kycUnknown: 0,
  });

  const formatCurrencyValue = (value: number) =>
    `$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const [isLoading, setIsLoading] = useState(false);

  const [lookupCrmId, setLookupCrmId] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [withdrawalDecisionAmount, setWithdrawalDecisionAmount] = useState('');
  const [lookupResult, setLookupResult] = useState<{
    crmId: number;
    deposits: CashflowTx[];
    withdrawals: CashflowTx[];
  } | null>(null);

  const [pspBalances, setPspBalances] = useState<PSPBalance[]>([]);
  const [reportDate, setReportDate] = useState('-');
  const [reportUpdated, setReportUpdated] = useState('-');
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletTotal, setWalletTotal] = useState(0);
  const [bankReceivable, setBankReceivable] = useState(0);
  const [cryptoReceivable, setCryptoReceivable] = useState(0);
  const [toBeDepositedIntoLpsK20, setToBeDepositedIntoLpsK20] = useState(0);
  const [toBeDepositedIntoLpsK21, setToBeDepositedIntoLpsK21] = useState(0);
  const [differenceBetweenActualAndExpected, setDifferenceBetweenActualAndExpected] = useState(0);
  const [netAllCurrentBalance, setNetAllCurrentBalance] = useState(0);
  const [netBalanceAfterExpectedFunds, setNetBalanceAfterExpectedFunds] = useState(0);
  const [cashflowFullscreen, setCashflowFullscreen] = useState(false);
  const [snapshottingCashflow, setSnapshottingCashflow] = useState(false);
  const [docusignOverview, setDocusignOverview] = useState<DocusignOverview | null>(null);
  const [docusignLoading, setDocusignLoading] = useState(false);
  const [docusignError, setDocusignError] = useState<string | null>(null);
  const [rebateIbId, setRebateIbId] = useState('');
  const [rebateFromDate, setRebateFromDate] = useState(() => toInputDate(fromDate || new Date()));
  const [rebateToDate, setRebateToDate] = useState(() => toInputDate(toDate || new Date()));
  const [rebateMode, setRebateMode] = useState<RebateMode>('all');
  const [rebateCloseMode, setRebateCloseMode] = useState<RebateCloseMode>('deal-out-only');
  const [rebateLoginScope, setRebateLoginScope] = useState<RebateLoginScope>('all');
  const [rebateDateMode, setRebateDateMode] = useState<RebateDateMode>('crm-calendar');
  const [rebateCommissionSource, setRebateCommissionSource] = useState<RebateCommissionSource>('input-rate');
  const [rebateDefaultRate, setRebateDefaultRate] = useState('2.00');
  const [rebateOverridesText, setRebateOverridesText] = useState('XAUUSD=2.00\nEURUSD=1.00');
  const [rebateIncludeSubIb, setRebateIncludeSubIb] = useState(true);
  const [rebateLoading, setRebateLoading] = useState(false);
  const [rebateError, setRebateError] = useState<string | null>(null);
  const [rebateInfo, setRebateInfo] = useState<string | null>(null);
  const [rebateRows, setRebateRows] = useState<RebateCalcRow[]>([]);
  const [rebateLastUpdated, setRebateLastUpdated] = useState<Date | null>(null);
  const [rebatePresetName, setRebatePresetName] = useState('');
  const [rebateSelectedPreset, setRebateSelectedPreset] = useState('');
  const [rebatePresets, setRebatePresets] = useState<RebatePreset[]>([]);
  const [rebateStats, setRebateStats] = useState({
    ibUsers: 0,
    logins: 0,
    deals: 0,
    ibBalance: 0,
    ibWithdrawnLifetime: 0,
    ibWithdrawnPeriod: 0,
  });

  const parseRateOverrides = (text: string) => {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const parsed: Array<{ symbolPattern: string; ratePerLot: number }> = [];
    lines.forEach((line, idx) => {
      const parts = line.split('=').map((p) => p.trim());
      if (parts.length !== 2) {
        throw new Error(`Invalid override on line ${idx + 1}. Use SYMBOL=RATE (example: XAUUSD=2.00).`);
      }
      const symbolPattern = normalizeRebateSymbol(parts[0]);
      const ratePerLot = Number(parts[1]);
      if (!symbolPattern) throw new Error(`Invalid symbol on line ${idx + 1}.`);
      if (!Number.isFinite(ratePerLot) || ratePerLot < 0) throw new Error(`Invalid rate on line ${idx + 1}.`);
      parsed.push({ symbolPattern, ratePerLot });
    });

    return parsed;
  };

  const runIbRebateCalculation = async () => {
    const ibId = Number(rebateIbId);
    const from = parseRebateDateInput(rebateFromDate, rebateDateMode, false);
    const to = parseRebateDateInput(rebateToDate, rebateDateMode, true);
    const defaultRateNum = Number(rebateDefaultRate);

    if (!Number.isFinite(ibId) || ibId <= 0) {
      setRebateError('Enter a valid IB CRM ID.');
      return;
    }
    if (!rebateFromDate || !rebateToDate || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      setRebateError('Select valid from and to dates.');
      return;
    }
    if (from.getTime() > to.getTime()) {
      setRebateError('From date cannot be after to date.');
      return;
    }

    try {
      setRebateLoading(true);
      setRebateError(null);
      setRebateInfo(null);
      setRebateRows([]);

      const overrides = parseRateOverrides(rebateOverridesText);
      const effectiveRules = rebateMode === 'all' ? [] : overrides;
      let tree: Array<{ ibId: number; level?: number; referralIbId?: number }> = [];
      let treeLookupFailed = false;
      if (rebateIncludeSubIb) {
        try {
          tree = await fetchIbTree(ibId);
        } catch {
          treeLookupFailed = true;
        }
      }
      const userIds = new Set<number>([ibId]);
      tree.forEach((node) => {
        if (node.ibId) userIds.add(Number(node.ibId));
        if (node.referralIbId) userIds.add(Number(node.referralIbId));
      });

      const ibUserIds = Array.from(userIds).filter((id) => Number.isFinite(id) && id > 0);
      if (!ibUserIds.length) throw new Error('No IB users found.');

      const [accountResults, ibAccounts, ibWithdrawalsLifetime, ibWithdrawalsPeriod] = await Promise.all([
        Promise.allSettled(ibUserIds.map((userId) => fetchAccountsByUserId(userId))),
        fetchAllAccounts({ userId: ibId }).catch(() => []),
        fetchAllTransactions({ fromUserId: ibId, transactionTypes: ['ib withdrawal'], statuses: ['approved'] }).catch(() => []),
        fetchAllTransactions({
          fromUserId: ibId,
          transactionTypes: ['ib withdrawal'],
          statuses: ['approved'],
          processedAt: { begin: formatDateTimeForAPI(from, false), end: formatDateTimeForAPI(to, true) },
        }).catch(() => []),
      ]);

      const allAccounts = accountResults
        .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchAccountsByUserId>>> => result.status === 'fulfilled')
        .flatMap((result) => result.value || []);

      const ibWalletAccounts = ibAccounts.filter((acc: any) => String(acc?.groupName || acc?.group || '').toLowerCase().startsWith('ib-wallet'));
      const isIbRoot = tree.length > 0 || ibWalletAccounts.length > 0;
      const scopedAccounts = isIbRoot
        ? allAccounts
        : allAccounts.filter((acc) => !String(acc.groupName || '').toLowerCase().startsWith('ib-wallet'));

      if (!isIbRoot) {
        setRebateInfo(`CRM ID ${ibId} is not an IB. Commission was calculated using this CRM user's trading accounts only.`);
      } else if (treeLookupFailed) {
        setRebateInfo('Sub-IB tree lookup failed, so only directly available accounts were used for this run.');
      }

      const logins = Array.from(
        new Set(
          scopedAccounts
            .filter((acc) => acc.login && (rebateLoginScope === 'all' || Number(acc.isEnabled ?? 1) === 1))
            .map((acc) => String(acc.login).trim())
            .filter(Boolean),
        ),
      );

      if (!logins.length) {
        throw new Error(isIbRoot ? 'No MT5 accounts/logins found for this IB tree.' : 'No trading accounts/logins found for this CRM ID.');
      }

      const dealsResults = await Promise.allSettled(logins.map((login) => fetchDealsByLogin({ login, from, to })));
      const aggregated = new Map<string, RebateCalcRow>();
      let dealsCount = 0;

      dealsResults.forEach((result, idx) => {
        if (result.status !== 'fulfilled') return;
        const login = logins[idx];
        (result.value || []).forEach((deal) => {
          if (!isDealOut(deal, rebateCloseMode)) return;
          dealsCount += 1;
          const symbol = normalizeRebateSymbol(String(deal.symbol || ''));
          if (!symbol) return;
          const lots = getPositionLots(deal);
          if (!Number.isFinite(lots) || lots <= 0) return;

          const dealCommissionRaw = Number((deal as any)?.commission ?? (deal as any)?.Commission ?? NaN);
          const mt5DealCommission = Number.isFinite(dealCommissionRaw) ? Math.abs(dealCommissionRaw) : 0;

          const effectiveDefaultRate = rebateMode === 'specific' ? 0 : (Number.isFinite(defaultRateNum) && defaultRateNum >= 0 ? defaultRateNum : 0);
          const rate = getRateForSymbol(symbol, effectiveRules, effectiveDefaultRate);
          const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 0;

          const commissionFromRate = lots * safeRate;
          const useMt5Commission = rebateCommissionSource === 'mt5-commission' && mt5DealCommission > 0;
          const commissionForDeal = useMt5Commission ? mt5DealCommission : commissionFromRate;
          const appliedRate = lots > 0 ? commissionForDeal / lots : 0;

          const key = `${login}|${symbol}`;
          const existing = aggregated.get(key);
          const eligibleLots = commissionForDeal > 0 ? lots : 0;
          const ineligibleLots = commissionForDeal > 0 ? 0 : lots;
          if (!existing) {
            aggregated.set(key, {
              login,
              symbol,
              trades: 1,
              tradedLots: lots,
              eligibleLots,
              ineligibleLots,
              rebatePerLot: appliedRate,
              commissionUsd: commissionForDeal,
            });
            return;
          }

          existing.trades += 1;
          existing.tradedLots += lots;
          existing.eligibleLots += eligibleLots;
          existing.ineligibleLots += ineligibleLots;
          existing.commissionUsd += commissionForDeal;
          if (existing.eligibleLots > 0) {
            existing.rebatePerLot = existing.commissionUsd / existing.eligibleLots;
          }
        });
      });

      const rows = Array.from(aggregated.values()).sort((a, b) => b.commissionUsd - a.commissionUsd);

      const balanceSource = ibWalletAccounts.length ? ibWalletAccounts : ibAccounts;
      const ibBalance = balanceSource.reduce((sum, acc: any) => sum + Number(acc?.balance || 0), 0);
      const withdrawnLifetime = Math.abs(
        (ibWithdrawalsLifetime as any[]).reduce((sum, tx) => sum + Number(tx?.processedAmount || 0), 0),
      );
      const withdrawnPeriod = Math.abs(
        (ibWithdrawalsPeriod as any[]).reduce((sum, tx) => sum + Number(tx?.processedAmount || 0), 0),
      );

      setRebateRows(rows);
      setRebateStats({
        ibUsers: ibUserIds.length,
        logins: logins.length,
        deals: dealsCount,
        ibBalance,
        ibWithdrawnLifetime: withdrawnLifetime,
        ibWithdrawnPeriod: withdrawnPeriod,
      });
      setRebateLastUpdated(new Date());

      if (!rows.length) {
        setRebateError('No eligible trades found for the selected date/rates.');
      }
    } catch (error: any) {
      setRebateError(error?.message || 'Failed to run IB rebate calculation.');
    } finally {
      setRebateLoading(false);
    }
  };

  const rebateTotals = useMemo(
    () =>
      rebateRows.reduce(
        (acc, row) => {
          acc.trades += row.trades;
          acc.tradedLots += row.tradedLots;
          acc.eligibleLots += row.eligibleLots;
          acc.ineligibleLots += row.ineligibleLots;
          acc.commissionUsd += row.commissionUsd;
          return acc;
        },
        { trades: 0, tradedLots: 0, eligibleLots: 0, ineligibleLots: 0, commissionUsd: 0 },
      ),
    [rebateRows],
  );

  const rebateNetPayable = useMemo(() => rebateTotals.commissionUsd - rebateStats.ibWithdrawnLifetime, [rebateTotals.commissionUsd, rebateStats.ibWithdrawnLifetime]);

  const downloadRebateCsv = () => {
    if (!rebateRows.length) return;
    const header = [
      'IB CRM ID',
      'Login',
      'Symbol',
      'Trades',
      'Traded Lots',
      'Eligible Lots',
      'Non-Eligible Lots',
      'Rate/Lot',
      'Commission USD',
    ];
    const rows = rebateRows.map((row) => [
      rebateIbId,
      row.login,
      row.symbol,
      row.trades,
      row.tradedLots,
      row.eligibleLots,
      row.ineligibleLots,
      row.rebatePerLot,
      row.commissionUsd,
    ]);
    rows.push([
      rebateIbId,
      'TOTAL',
      '',
      rebateTotals.trades,
      rebateTotals.tradedLots,
      rebateTotals.eligibleLots,
      rebateTotals.ineligibleLots,
      '',
      rebateTotals.commissionUsd,
    ]);

    const escapeCsv = (value: string | number) => {
      const raw = String(value ?? '');
      if (/[,"\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
      return raw;
    };

    const csv = [header, ...rows].map((line) => line.map((cell) => escapeCsv(cell as string | number)).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `ib-rebate-${rebateIbId || 'ib'}-${rebateFromDate}-${rebateToDate}.csv`;
    a.click();
    URL.revokeObjectURL(href);
  };

  const saveRebatePreset = () => {
    const name = rebatePresetName.trim() || `IB-${rebateIbId || 'Preset'}`;
    const preset: RebatePreset = {
      name,
      ibId: rebateIbId,
      fromDate: rebateFromDate,
      toDate: rebateToDate,
      mode: rebateMode,
      closeMode: rebateCloseMode,
      loginScope: rebateLoginScope,
      dateMode: rebateDateMode,
      commissionSource: rebateCommissionSource,
      defaultRate: rebateDefaultRate,
      overridesText: rebateOverridesText,
      includeSubIb: rebateIncludeSubIb,
    };

    setRebatePresets((prev) => {
      const next = [...prev.filter((item) => item.name !== name), preset].sort((a, b) => a.name.localeCompare(b.name));
      try {
        localStorage.setItem(REBATE_PRESETS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore localStorage failures
      }
      return next;
    });
    setRebateSelectedPreset(name);
    setRebatePresetName(name);
  };

  const loadRebatePreset = (name: string) => {
    const preset = rebatePresets.find((item) => item.name === name);
    if (!preset) return;
    setRebateIbId(preset.ibId);
    setRebateFromDate(preset.fromDate);
    setRebateToDate(preset.toDate);
    setRebateMode(preset.mode);
    setRebateCloseMode(preset.closeMode || 'deal-out-only');
    setRebateLoginScope(preset.loginScope || 'all');
    setRebateDateMode(preset.dateMode || 'crm-calendar');
    setRebateCommissionSource(preset.commissionSource || 'input-rate');
    setRebateDefaultRate(preset.defaultRate);
    setRebateOverridesText(preset.overridesText);
    setRebateIncludeSubIb(Boolean(preset.includeSubIb));
    setRebatePresetName(preset.name);
    setRebateSelectedPreset(preset.name);
  };

  const deleteRebatePreset = () => {
    if (!rebateSelectedPreset) return;
    setRebatePresets((prev) => {
      const next = prev.filter((item) => item.name !== rebateSelectedPreset);
      try {
        localStorage.setItem(REBATE_PRESETS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore localStorage failures
      }
      return next;
    });
    setRebateSelectedPreset('');
  };

  useEffect(() => {
    if (fromDate) setRebateFromDate(toInputDate(fromDate));
    if (toDate) setRebateToDate(toInputDate(toDate));
  }, [fromDate, toDate]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(REBATE_PRESETS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as RebatePreset[];
      if (!Array.isArray(parsed)) return;
      setRebatePresets(
        parsed
          .filter((item) => item && typeof item.name === 'string' && item.name.trim().length > 0)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch {
      // ignore localStorage failures
    }
  }, []);

  const formatTxDate = (value: string) => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value || '-';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getPspName = (tx: any) => {
    const pspId = Number(tx?.pspId);
    if (pspId === 13) return 'Cash';
    if ([8, 7, 16, 15].includes(pspId)) return 'Bank';
    if (Number.isFinite(pspId)) return 'Crypto';
    return 'Crypto';
  };

  const handleLookupClientCashflow = async () => {
    const crmIdRaw = String(lookupCrmId || '').trim();
    const crmId = Number(crmIdRaw);
    if (!crmIdRaw || !Number.isFinite(crmId) || crmId <= 0) {
      setLookupError('Enter a valid CRM ID first.');
      return;
    }

    try {
      setLookupLoading(true);
      setLookupError(null);
      setLookupResult(null);
      const [depositsRaw, withdrawalsRaw] = await Promise.all([
        fetchTransactions({
          fromUserId: crmId,
          transactionTypes: ['deposit'],
          statuses: ['approved'],
        }),
        fetchTransactions({
          fromUserId: crmId,
          transactionTypes: ['withdrawal'],
          statuses: ['approved'],
        }),
      ]);

      const mapTx = (tx: any): CashflowTx => ({
        id: tx?.id ?? Math.random().toString(36).slice(2),
        processedAt: String(tx?.processedAt || ''),
        amount: Math.abs(Number(tx?.processedAmount || 0)),
        pspName: getPspName(tx),
        pspId: Number.isFinite(Number(tx?.pspId)) ? Number(tx?.pspId) : null,
      });

      const deposits = (Array.isArray(depositsRaw) ? depositsRaw : [])
        .map(mapTx)
        .sort((a, b) => new Date(b.processedAt).getTime() - new Date(a.processedAt).getTime());

      const withdrawals = (Array.isArray(withdrawalsRaw) ? withdrawalsRaw : [])
        .map(mapTx)
        .sort((a, b) => new Date(b.processedAt).getTime() - new Date(a.processedAt).getTime());

      setLookupResult({
        crmId,
        deposits,
        withdrawals,
      });
    } catch (e: any) {
      setLookupError(e?.message || 'Failed to fetch client cashflow.');
    } finally {
      setLookupLoading(false);
    }
  };

  const cashflowRows = useMemo<CashflowRow[]>(() => {
    const deposits = lookupResult?.deposits || [];
    const withdrawals = lookupResult?.withdrawals || [];
    const maxLen = Math.max(deposits.length, withdrawals.length);
    return Array.from({ length: maxLen }).map((_, idx) => ({
      deposit: deposits[idx] || null,
      withdrawal: withdrawals[idx] || null,
    }));
  }, [lookupResult]);

  const cashflowColumns = useMemo<SortableTableColumn<CashflowRow>[]>(
    () => [
      {
        key: 'depId',
        label: 'Dep Txn ID',
        sortValue: (row) => String(row.deposit?.id ?? ''),
        searchValue: (row) => `${row.deposit?.id ?? ''} ${row.deposit?.pspName ?? ''}`,
        render: (row) => <span className="font-mono">{row.deposit ? String(row.deposit.id) : '-'}</span>,
      },
      {
        key: 'depDate',
        label: 'Dep Date',
        sortValue: (row) => (row.deposit?.processedAt ? new Date(row.deposit.processedAt).getTime() : 0),
        render: (row) => (row.deposit ? formatTxDate(row.deposit.processedAt) : '-'),
      },
      {
        key: 'depPsp',
        label: 'Dep PSP',
        sortValue: (row) => String(row.deposit?.pspName ?? ''),
        render: (row) => row.deposit?.pspName || '-',
      },
      {
        key: 'depAmount',
        label: 'Dep Amount',
        sortValue: (row) => Number(row.deposit?.amount ?? 0),
        headerClassName: 'text-right',
        cellClassName: 'text-right text-emerald-700 dark:text-emerald-300',
        render: (row) => (row.deposit ? `$${row.deposit.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-'),
      },
      {
        key: 'wdId',
        label: 'Wdr Txn ID',
        sortValue: (row) => String(row.withdrawal?.id ?? ''),
        searchValue: (row) => `${row.withdrawal?.id ?? ''} ${row.withdrawal?.pspName ?? ''}`,
        render: (row) => <span className="font-mono">{row.withdrawal ? String(row.withdrawal.id) : '-'}</span>,
      },
      {
        key: 'wdDate',
        label: 'Wdr Date',
        sortValue: (row) => (row.withdrawal?.processedAt ? new Date(row.withdrawal.processedAt).getTime() : 0),
        render: (row) => (row.withdrawal ? formatTxDate(row.withdrawal.processedAt) : '-'),
      },
      {
        key: 'wdPsp',
        label: 'Wdr PSP',
        sortValue: (row) => String(row.withdrawal?.pspName ?? ''),
        render: (row) => row.withdrawal?.pspName || '-',
      },
      {
        key: 'wdAmount',
        label: 'Wdr Amount',
        sortValue: (row) => Number(row.withdrawal?.amount ?? 0),
        headerClassName: 'text-right',
        cellClassName: 'text-right text-amber-700 dark:text-amber-300',
        render: (row) => (row.withdrawal ? `$${row.withdrawal.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-'),
      },
    ],
    [],
  );

  const resolvedNow = getDubaiDate();
  const resolvedFromDate = fromDate ?? getDubaiDayStart(resolvedNow);
  const resolvedToDate = toDate ?? getDubaiDayEnd(resolvedNow);
  const metricsBegin = formatDateTimeForAPI(resolvedFromDate, false);
  const metricsEnd = formatDateTimeForAPI(resolvedToDate, true);
  const entityTooltip = selectedEntity === 'all'
    ? 'Entity filter: all entities.'
    : `Entity filter: custom_change_me_field = ${selectedEntity}.`;
  const userSourceTooltip = [
    'Source: /rest/users via the local /rest proxy.',
    `Date filter: user.created between ${metricsBegin} and ${metricsEnd}.`,
    'Base filters: lead = false.',
    entityTooltip,
  ];
  const accountSourceTooltip = [
    'Source: /rest/accounts via the local /rest proxy.',
    `Date filter: account.createdAt between ${metricsBegin} and ${metricsEnd}.`,
    'Entity scoping is applied by resolving entity user IDs first and then filtering accounts by userIds.',
    entityTooltip,
  ];
  const transactionSourceTooltip = [
    'Source: /rest/transactions via the local /rest proxy.',
    `Date filter: transaction.processedAt between ${metricsBegin} and ${metricsEnd}.`,
    'Base filters: status = approved.',
    entityTooltip,
  ];
  const renderMetricTooltip = (title: string, lines: string[]): ReactNode => (
    <div className="space-y-1.5">
      <div className="font-semibold text-foreground">{title}</div>
      {lines.map((line) => (
        <div key={`${title}-${line}`} className="text-muted-foreground">
          {line}
        </div>
      ))}
    </div>
  );
  const renderMetricSurface = (content: ReactNode, tooltip: ReactNode, className?: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={className ? `${className} cursor-help` : 'cursor-help'}>{content}</div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[24rem] text-xs leading-5">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
  const createdRate = metrics.totalClients > 0 ? Math.round((metrics.totalMT5Accounts / metrics.totalClients) * 100) : 0;
  const lookupDepositTotal = lookupResult?.deposits.reduce((s, t) => s + t.amount, 0) || 0;
  const lookupWithdrawalTotal = lookupResult?.withdrawals.reduce((s, t) => s + t.amount, 0) || 0;
  const hideZeroStatsInCompact = variant === 'compact';
  const clientBreakdownItems = [
    {
      label: 'Unverified Clients',
      value: metrics.unverifiedClients,
      icon: <Shield className="h-3.5 w-3.5" />,
      tooltip: renderMetricTooltip('Unverified Clients', [
        ...userSourceTooltip,
        'Counts only non-test profiles where verified = false.',
      ]),
    },
    {
      label: 'Individual Clients',
      value: metrics.individualClients,
      icon: <User className="h-3.5 w-3.5" />,
      tooltip: renderMetricTooltip('Individual Clients', [
        ...userSourceTooltip,
        'Counts only non-test profiles where clientTypes includes Individual.',
      ]),
    },
    {
      label: 'Corporate Clients',
      value: metrics.corporateClients,
      icon: <Briefcase className="h-3.5 w-3.5" />,
      tooltip: renderMetricTooltip('Corporate Clients', [
        ...userSourceTooltip,
        'Counts only non-test profiles where clientTypes includes Corporate.',
      ]),
    },
    {
      label: 'Test Profiles',
      value: metrics.testProfiles,
      icon: <Settings className="h-3.5 w-3.5" />,
      tooltip: renderMetricTooltip('Test Profiles', [
        ...userSourceTooltip,
        'Counts users where testProfile = true.',
        'This was previously labeled Test Accounts, but the underlying source is users, not MT5 accounts.',
      ]),
    },
    {
      label: 'Active Accounts',
      value: metrics.activeAccounts,
      icon: <Database className="h-3.5 w-3.5" />,
      tooltip: renderMetricTooltip('Active Accounts', [
        ...accountSourceTooltip,
        'Counts accounts where tradingStatus = active.',
        'Excludes demo groups and ib-wallet groups.',
      ]),
    },
    {
      label: 'Demo Accounts',
      value: metrics.demoAccounts,
      icon: <Activity className="h-3.5 w-3.5" />,
      tooltip: renderMetricTooltip('Demo Accounts', [
        ...accountSourceTooltip,
        'Counts accounts whose group starts with demo.',
        'Excludes ib-wallet groups.',
      ]),
    },
    {
      label: 'Live Accounts',
      value: metrics.liveAccounts,
      icon: <TrendingUp className="h-3.5 w-3.5" />,
      tooltip: renderMetricTooltip('Live Accounts', [
        ...accountSourceTooltip,
        'Counts MT5 accounts excluding demo groups and ib-wallet groups.',
      ]),
    },
  ].filter((item) => !hideZeroStatsInCompact || item.value > 0);

  const kycItems = [
    {
      label: 'Approved',
      value: metrics.kycApproved,
      tooltip: renderMetricTooltip('KYC Approved', [
        ...userSourceTooltip,
        'Counts only non-test profiles where custom_compliance_approval = Approved.',
      ]),
      cardClass: 'rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-center',
      labelClass: 'text-[10px] text-emerald-700 dark:text-emerald-300',
      valueClass: 'mt-1 font-mono text-lg font-semibold text-emerald-800 dark:text-emerald-200',
    },
    {
      label: 'Approved w/ Conditions',
      value: metrics.kycApprovedWithConditions,
      tooltip: renderMetricTooltip('KYC Approved with Conditions', [
        ...userSourceTooltip,
        'Counts only non-test profiles where custom_compliance_approval = Approved with Conditions.',
      ]),
      cardClass: 'rounded-md border border-teal-500/30 bg-teal-500/10 p-2 text-center',
      labelClass: 'text-[10px] text-teal-700 dark:text-teal-300',
      valueClass: 'mt-1 font-mono text-lg font-semibold text-teal-800 dark:text-teal-200',
    },
    {
      label: 'Pending Review',
      value: metrics.kycPendingReview,
      tooltip: renderMetricTooltip('KYC Pending Review', [
        ...userSourceTooltip,
        'Counts only non-test profiles where custom_compliance_approval = Pending Review.',
      ]),
      cardClass: 'rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-center',
      labelClass: 'text-[10px] text-amber-700 dark:text-amber-300',
      valueClass: 'mt-1 font-mono text-lg font-semibold text-amber-800 dark:text-amber-200',
    },
    {
      label: 'Rejected',
      value: metrics.kycRejected,
      tooltip: renderMetricTooltip('KYC Rejected', [
        ...userSourceTooltip,
        'Counts only non-test profiles where custom_compliance_approval = Rejected.',
      ]),
      cardClass: 'rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-center',
      labelClass: 'text-[10px] text-rose-700 dark:text-rose-300',
      valueClass: 'mt-1 font-mono text-lg font-semibold text-rose-800 dark:text-rose-200',
    },
    {
      label: 'Additional Info Req.',
      value: metrics.kycAdditionalInfo,
      tooltip: renderMetricTooltip('KYC Additional Information Required', [
        ...userSourceTooltip,
        'Counts only non-test profiles where custom_compliance_approval = Additional Information Required.',
      ]),
      cardClass: 'rounded-md border border-orange-500/30 bg-orange-500/10 p-2 text-center',
      labelClass: 'text-[10px] text-orange-700 dark:text-orange-300',
      valueClass: 'mt-1 font-mono text-lg font-semibold text-orange-800 dark:text-orange-200',
    },
    {
      label: 'On Hold',
      value: metrics.kycOnHold,
      tooltip: renderMetricTooltip('KYC On Hold', [
        ...userSourceTooltip,
        'Counts only non-test profiles where custom_compliance_approval = On Hold.',
      ]),
      cardClass: 'rounded-md border border-sky-500/30 bg-sky-500/10 p-2 text-center',
      labelClass: 'text-[10px] text-sky-700 dark:text-sky-300',
      valueClass: 'mt-1 font-mono text-lg font-semibold text-sky-800 dark:text-sky-200',
    },
  ].filter((item) => !hideZeroStatsInCompact || item.value > 0);
  const depositByPsp = useMemo(() => {
    const m = new Map<string, number>();
    (lookupResult?.deposits || []).forEach((tx) => {
      const key = tx.pspName || '-';
      m.set(key, (m.get(key) || 0) + tx.amount);
    });
    return Array.from(m.entries())
      .map(([psp, amount]) => ({ psp, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [lookupResult?.deposits]);
  const withdrawalByPsp = useMemo(() => {
    const m = new Map<string, number>();
    (lookupResult?.withdrawals || []).forEach((tx) => {
      const key = tx.pspName || '-';
      m.set(key, (m.get(key) || 0) + tx.amount);
    });
    return Array.from(m.entries())
      .map(([psp, amount]) => ({ psp, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [lookupResult?.withdrawals]);

  const withdrawalDecision = useMemo(() => {
    if (!lookupResult) return null;

    const normalizeMethod = (pspName: string): 'Cash' | 'Crypto' => {
      const key = String(pspName || '').trim().toLowerCase();
      if (key.includes('crypto')) return 'Crypto';
      // Treat bank + cash rails as the cash bucket for payout decisioning.
      return 'Cash';
    };

    const depositsByMethod = { Cash: 0, Crypto: 0 };
    const withdrawalsByMethod = { Cash: 0, Crypto: 0 };

    (lookupResult.deposits || []).forEach((tx) => {
      const method = normalizeMethod(tx.pspName);
      depositsByMethod[method] += Number(tx.amount || 0);
    });

    (lookupResult.withdrawals || []).forEach((tx) => {
      const method = normalizeMethod(tx.pspName);
      withdrawalsByMethod[method] += Number(tx.amount || 0);
    });

    const availableCash = depositsByMethod.Cash - withdrawalsByMethod.Cash;
    const availableCrypto = depositsByMethod.Crypto - withdrawalsByMethod.Crypto;

    const requestedAmount = Number(String(withdrawalDecisionAmount || '').replace(/,/g, '').trim());
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      return {
        requestedAmount: 0,
        method: null as 'Cash' | 'Crypto' | null,
        tone: 'neutral' as 'neutral' | 'success' | 'warning',
        reason: 'Enter a valid withdrawal amount to get FIFO method recommendation.',
        availableCash,
        availableCrypto,
      };
    }

    if (availableCash >= requestedAmount && availableCrypto >= requestedAmount) {
      const method: 'Cash' | 'Crypto' = availableCash >= availableCrypto ? 'Cash' : 'Crypto';
      return {
        requestedAmount,
        method,
        tone: 'success' as 'neutral' | 'success' | 'warning',
        reason:
          method === 'Cash'
            ? 'Both methods can cover this amount. Cash has higher FIFO-eligible remaining balance after prior withdrawals, so cash is preferred.'
            : 'Both methods can cover this amount. Crypto has higher FIFO-eligible remaining balance after prior withdrawals, so crypto is preferred.',
        availableCash,
        availableCrypto,
      };
    }

    if (availableCash >= requestedAmount) {
      return {
        requestedAmount,
        method: 'Cash' as 'Cash' | 'Crypto',
        tone: 'success' as 'neutral' | 'success' | 'warning',
        reason: 'Cash bucket has sufficient FIFO-eligible balance. Crypto bucket is insufficient for this amount.',
        availableCash,
        availableCrypto,
      };
    }

    if (availableCrypto >= requestedAmount) {
      return {
        requestedAmount,
        method: 'Crypto' as 'Cash' | 'Crypto',
        tone: 'success' as 'neutral' | 'success' | 'warning',
        reason: 'Crypto bucket has sufficient FIFO-eligible balance. Cash bucket is insufficient for this amount.',
        availableCash,
        availableCrypto,
      };
    }

    const cashPositive = Math.max(0, availableCash);
    const cryptoPositive = Math.max(0, availableCrypto);
    return {
      requestedAmount,
      method: null as 'Cash' | 'Crypto' | null,
      tone: 'warning' as 'neutral' | 'success' | 'warning',
      reason: `Insufficient FIFO-eligible balance in both methods for $${requestedAmount.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })}. Available now: Cash $${cashPositive.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })}, Crypto $${cryptoPositive.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
      availableCash,
      availableCrypto,
    };
  }, [lookupResult, withdrawalDecisionAmount]);

  const handleCashflowSnapshot = () => {
    if (!cashflowRows.length) return;
    setSnapshottingCashflow(true);
    try {
      const headers = ['Dep Txn ID', 'Dep Date', 'Dep PSP', 'Dep Amount', 'Wdr Txn ID', 'Wdr Date', 'Wdr PSP', 'Wdr Amount'];
      const rows = cashflowRows.map((row) => [
        row.deposit ? String(row.deposit.id) : '-',
        row.deposit ? formatTxDate(row.deposit.processedAt) : '-',
        row.deposit?.pspName || '-',
        row.deposit ? `$${row.deposit.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-',
        row.withdrawal ? String(row.withdrawal.id) : '-',
        row.withdrawal ? formatTxDate(row.withdrawal.processedAt) : '-',
        row.withdrawal?.pspName || '-',
        row.withdrawal ? `$${row.withdrawal.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-',
      ]);

      const normalize = (v: string) => String(v ?? '');
      const measureCanvas = document.createElement('canvas');
      const measureCtx = measureCanvas.getContext('2d');
      if (!measureCtx) return;
      measureCtx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';

      const depositPspLines =
        depositByPsp.length > 0
          ? depositByPsp.map((row) => `${row.psp}: $${row.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
          : ['No deposit PSP data'];
      const withdrawalPspLines =
        withdrawalByPsp.length > 0
          ? withdrawalByPsp.map((row) => `${row.psp}: $${row.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
          : ['No withdrawal PSP data'];
      const maxPspLines = Math.max(depositPspLines.length, withdrawalPspLines.length);

      const colWidths = headers.map((header, colIdx) => {
        const headerWidth = measureCtx.measureText(header).width;
        const rowWidth = rows.reduce((max, row) => Math.max(max, measureCtx.measureText(normalize(String(row[colIdx] ?? ''))).width), 0);
        return Math.ceil(Math.max(headerWidth, rowWidth) + 24);
      });

      const rowHeight = 26;
      const headerHeight = 28;
      const titleHeight = 52;
      const summaryHeight = 70;
      const pspHeaderHeight = 26;
      const pspLineHeight = 18;
      const pspBlockHeight = pspHeaderHeight + maxPspLines * pspLineHeight + 12;
      const totalsHeight = 30;
      const tableWidth = colWidths.reduce((sum, w) => sum + w, 0);
      const imageWidth = Math.max(920, tableWidth + 24);
      const imageHeight = titleHeight + summaryHeight + pspBlockHeight + headerHeight + rowHeight * rows.length + totalsHeight + 18;

      const canvas = document.createElement('canvas');
      canvas.width = imageWidth;
      canvas.height = imageHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, imageWidth, imageHeight);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '600 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
      ctx.fillText(`Client Cashflow Snapshot - CRM ${lookupResult?.crmId ?? '-'}`, 12, 24);
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`Generated: ${new Date().toLocaleString()}`, 12, 42);

      const summaryY = titleHeight;
      const summaryW = (imageWidth - 36) / 2;
      const summaryH = 58;
      ctx.fillStyle = '#052e16';
      ctx.fillRect(12, summaryY, summaryW, summaryH);
      ctx.fillStyle = '#ecfdf5';
      ctx.font = '600 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
      ctx.fillText(`Deposits: ${lookupResult?.deposits.length ?? 0} tx`, 22, summaryY + 22);
      ctx.fillText(`Total: $${lookupDepositTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, 22, summaryY + 42);

      ctx.fillStyle = '#451a03';
      ctx.fillRect(24 + summaryW, summaryY, summaryW, summaryH);
      ctx.fillStyle = '#fffbeb';
      ctx.fillText(`Withdrawals: ${lookupResult?.withdrawals.length ?? 0} tx`, 34 + summaryW, summaryY + 22);
      ctx.fillText(`Total: $${lookupWithdrawalTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, 34 + summaryW, summaryY + 42);

      const pspY = summaryY + summaryHeight;
      const pspW = (imageWidth - 36) / 2;
      const pspH = pspBlockHeight - 8;
      ctx.fillStyle = '#0f3d2e';
      ctx.fillRect(12, pspY, pspW, pspH);
      ctx.fillStyle = '#d1fae5';
      ctx.font = '600 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
      ctx.fillText('Deposits by PSP', 22, pspY + 18);
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      depositPspLines.forEach((line, idx) => {
        ctx.fillText(line, 22, pspY + 38 + idx * pspLineHeight);
      });

      ctx.fillStyle = '#5b3410';
      ctx.fillRect(24 + pspW, pspY, pspW, pspH);
      ctx.fillStyle = '#fef3c7';
      ctx.font = '600 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto';
      ctx.fillText('Withdrawals by PSP', 34 + pspW, pspY + 18);
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      withdrawalPspLines.forEach((line, idx) => {
        ctx.fillText(line, 34 + pspW, pspY + 38 + idx * pspLineHeight);
      });

      const tableX = 12;
      const tableY = titleHeight + summaryHeight + pspBlockHeight;
      let x = tableX;
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(tableX, tableY, tableWidth, headerHeight);
      ctx.strokeStyle = '#334155';
      ctx.strokeRect(tableX, tableY, tableWidth, headerHeight);
      headers.forEach((header, idx) => {
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(header, x + 8, tableY + 18);
        x += colWidths[idx];
      });

      rows.forEach((row, rowIdx) => {
        const y = tableY + headerHeight + rowIdx * rowHeight;
        ctx.fillStyle = rowIdx % 2 === 0 ? '#111827' : '#0b1220';
        ctx.fillRect(tableX, y, tableWidth, rowHeight);
        ctx.strokeStyle = '#1f2937';
        ctx.strokeRect(tableX, y, tableWidth, rowHeight);
        let cx = tableX;
        row.forEach((cell, colIdx) => {
          ctx.fillStyle = '#cbd5e1';
          ctx.fillText(normalize(String(cell ?? '')), cx + 8, y + 17);
          cx += colWidths[colIdx];
        });
      });

      const totalY = tableY + headerHeight + rows.length * rowHeight;
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(tableX, totalY, tableWidth, totalsHeight);
      ctx.strokeStyle = '#334155';
      ctx.strokeRect(tableX, totalY, tableWidth, totalsHeight);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`Deposits Total: $${lookupDepositTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, tableX + 8, totalY + 19);
      ctx.fillText(`Withdrawals Total: $${lookupWithdrawalTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, tableX + Math.floor(tableWidth / 2), totalY + 19);

      canvas.toBlob((blob) => {
        if (!blob) return;
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = `cashflow-snapshot-${lookupResult?.crmId || 'crm'}.png`;
        a.click();
        URL.revokeObjectURL(href);
      }, 'image/png');
    } finally {
      setSnapshottingCashflow(false);
    }
  };

  useEffect(() => {
    const fetchBackOfficeData = async () => {
      try {
        setIsLoading(true);
        const now = getDubaiDate();
        const fallbackStart = getDubaiDayStart(now);
        const fallbackEnd = getDubaiDayEnd(now);

        const begin = fromDate ? formatDateTimeForAPI(fromDate, false) : formatDateTimeForAPI(fallbackStart, false);
        const end = toDate ? formatDateTimeForAPI(toDate, true) : formatDateTimeForAPI(fallbackEnd, true);

        const baseUsersFilter =
          selectedEntity !== 'all' ? { customFields: { custom_change_me_field: { value: selectedEntity } } } : {};
        const clientDateFilter = fromDate || toDate ? { created: { begin, end } } : {};
        const hasEntityFilter = selectedEntity !== 'all';

        const [allUsersInEntity, allUsers, allDepositsRaw, allWithdrawalsRaw, ibWithdrawalsRaw, verifiedUsers, unverifiedUsers, individualUsers, corporateUsers] =
          await Promise.all([
            fetchAllUsers({ ...baseUsersFilter, lead: false }),
            fetchAllUsers({ ...baseUsersFilter, ...clientDateFilter, lead: false }),
            fetchAllTransactions({
              processedAt: { begin, end },
              transactionTypes: ['deposit'],
              statuses: ['approved'],
            }),
            fetchAllTransactions({
              processedAt: { begin, end },
              transactionTypes: ['withdrawal'],
              statuses: ['approved'],
            }),
            fetchAllTransactions({
              processedAt: { begin, end },
              transactionTypes: ['ib withdrawal'],
              statuses: ['approved'],
            }),
            fetchAllUsers({ ...baseUsersFilter, ...clientDateFilter, lead: false, verified: true }).catch(() => []),
            fetchAllUsers({ ...baseUsersFilter, ...clientDateFilter, lead: false, verified: false }).catch(() => []),
            fetchAllUsers({ ...baseUsersFilter, ...clientDateFilter, lead: false, clientTypes: ['Individual'] }).catch(() => []),
            fetchAllUsers({ ...baseUsersFilter, ...clientDateFilter, lead: false, clientTypes: ['Corporate'] }).catch(() => []),
          ]);

        // KYC helper — handles both plain string and { value: "..." } object forms
        const getKycStatus = (u: any): string => {
          const raw = u?.customFields?.custom_compliance_approval;
          if (typeof raw === 'object' && raw !== null) return String(raw?.value ?? '');
          return String(raw ?? '');
        };

        // Log all distinct KYC values so you can inspect in DevTools what the API actually returns
        const kycDistinct = new Map<string, number>();
        allUsers.forEach((u: any) => {
          const v = getKycStatus(u);
          kycDistinct.set(v, (kycDistinct.get(v) ?? 0) + 1);
        });
        console.log('[KYC] distinct custom_compliance_approval values:', Object.fromEntries(kycDistinct));

        const entityUserIds = new Set(allUsersInEntity.map((user) => user.id));
        const entityUserIdsArr = Array.from(entityUserIds);

        // Accounts created in the selected date range (paginated, no hard limit)
        const accounts = hasEntityFilter
          ? entityUserIds.size > 0
            ? await fetchAllAccounts({ createdAt: { begin, end }, userIds: entityUserIdsArr })
            : []
          : await fetchAllAccounts({ createdAt: { begin, end } });

        // Active accounts = accounts created in selected date range with tradingStatus === 'active'
        const activeAccountsRaw = hasEntityFilter
          ? entityUserIds.size > 0
            ? await fetchAllAccounts({ createdAt: { begin, end }, userIds: entityUserIdsArr })
            : []
          : await fetchAllAccounts({ createdAt: { begin, end } });

        const allDeposits = hasEntityFilter
          ? allDepositsRaw.filter((tx) => entityUserIds.has(tx.fromUserId))
          : allDepositsRaw;
        const allWithdrawals = hasEntityFilter
          ? allWithdrawalsRaw.filter((tx) => entityUserIds.has(tx.fromUserId))
          : allWithdrawalsRaw;
        const ibWithdrawals = hasEntityFilter
          ? ibWithdrawalsRaw.filter((tx) => entityUserIds.has(tx.fromUserId))
          : ibWithdrawalsRaw;

        const validDeposits = allDeposits.filter((tx: any) => {
          const platformComment = String(tx?.platformComment || '').toLowerCase();
          return !platformComment.includes('negative bal');
        });

        const clients = allUsers;
        const nonTestClients = clients.filter((u: any) => u.testProfile !== true);
        const testProfiles = allUsers.filter((u: any) => u.testProfile === true).length;
        const filteredVerifiedUsers = verifiedUsers.filter((u: any) => u.testProfile !== true);
        const filteredUnverifiedUsers = unverifiedUsers.filter((u: any) => u.testProfile !== true);
        const filteredIndividualUsers = individualUsers.filter((u: any) => u.testProfile !== true);
        const filteredCorporateUsers = corporateUsers.filter((u: any) => u.testProfile !== true);

        const rangeStart = new Date(begin);
        const rangeEnd = new Date(end);
        const firstDepositCount = nonTestClients.filter((user: any) => {
          if (!user.firstDepositDate) return false;
          const userFirstDepositDate = new Date(user.firstDepositDate);
          return userFirstDepositDate >= rangeStart && userFirstDepositDate <= rangeEnd;
        }).length;

        const getAccountGroupText = (account: any) => String(account?.groupName || account?.group || '').trim().toLowerCase();
        const isDemoOrIbWalletGroup = (account: any) => {
          const group = getAccountGroupText(account);
          return group.startsWith('demo') || group.startsWith('ib-wallet');
        };
        const mt5Accounts = accounts.filter((account: any) => !getAccountGroupText(account).startsWith('ib-wallet'));
        const nonDemoNonIbAccounts = mt5Accounts.filter((account: any) => !getAccountGroupText(account).startsWith('demo'));
        const activeAccountsCount = activeAccountsRaw.filter((account: any) => account?.tradingStatus === 'active' && !isDemoOrIbWalletGroup(account)).length;

        const nextMetrics = {
          totalIBs: ibWithdrawals.length,
          totalDeposits: validDeposits.reduce((sum, tx) => sum + Number(tx.processedAmount || 0), 0),
          totalWithdrawals: Math.abs(allWithdrawals.reduce((sum, tx) => sum + Number(tx.processedAmount || 0), 0)),
          totalDepositCount: validDeposits.length,
          totalWithdrawalCount: allWithdrawals.length,
          totalClients: nonTestClients.length,
          totalMT5Accounts: mt5Accounts.length,
          firstDeposits: firstDepositCount,
          verifiedClients: filteredVerifiedUsers.length,
          unverifiedClients: filteredUnverifiedUsers.length,
          individualClients: filteredIndividualUsers.length,
          corporateClients: filteredCorporateUsers.length,
          testProfiles,
          sumsubActive: 0,
          activeAccounts: activeAccountsCount,
          demoAccounts: mt5Accounts.filter((a: any) => getAccountGroupText(a).startsWith('demo')).length,
          liveAccounts: nonDemoNonIbAccounts.length,
          kycApproved: nonTestClients.filter((u: any) => getKycStatus(u) === 'Approved').length,
          kycApprovedWithConditions: nonTestClients.filter((u: any) => getKycStatus(u) === 'Approved with Conditions').length,
          kycPendingReview: nonTestClients.filter((u: any) => getKycStatus(u) === 'Pending Review').length,
          kycRejected: nonTestClients.filter((u: any) => getKycStatus(u) === 'Rejected').length,
          kycAdditionalInfo: nonTestClients.filter((u: any) => getKycStatus(u) === 'Additional Information Required').length,
          kycOnHold: nonTestClients.filter((u: any) => getKycStatus(u) === 'On Hold').length,
          kycUnknown: nonTestClients.filter((u: any) => {
            const v = getKycStatus(u);
            return !['Approved','Approved with Conditions','Pending Review','Rejected','Additional Information Required','On Hold',''].includes(v);
          }).length,
        };

        if (import.meta.env.DEV) {
          console.groupCollapsed('[Backoffice] Operations Snapshot debug');
          console.log('Filters', {
            selectedEntity,
            begin,
            end,
            hasEntityFilter,
          });
          console.log('Users payloads', {
            allUsersInEntity,
            allUsers,
            verifiedUsers,
            unverifiedUsers,
            individualUsers,
            corporateUsers,
            nonTestClients,
          });
          console.log('Transactions payloads', {
            allDepositsRaw,
            allWithdrawalsRaw,
            ibWithdrawalsRaw,
            allDeposits,
            allWithdrawals,
            ibWithdrawals,
            validDeposits,
          });
          console.log('Accounts payloads', {
            accounts,
            activeAccountsRaw,
            mt5Accounts,
            nonDemoNonIbAccounts,
          });
          console.log('Derived metrics', nextMetrics);
          console.groupEnd();
        }

        setMetrics(nextMetrics);
      } catch {
        // silently ignore
      } finally {
        setIsLoading(false);
      }
    };

    fetchBackOfficeData();
  }, [selectedEntity, fromDate, toDate, refreshKey]);

  useEffect(() => {
    const fetchWalletData = async () => {
      const response = await fetchWalletBalances();
      if (!response?.ok || !response?.data?.widgets) {
        setWalletError(response?.error || 'Wallet API unavailable');
        setPspBalances([]);
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
        { key: 'googlesheets_deusxpay', label: 'DeusXpay' },
        { key: 'googlesheets_openpayed', label: 'OpenPayed' },
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

      const total =
        typeof response.data.total_balance === 'number'
          ? response.data.total_balance
          : mapped.reduce((sum, item) => sum + item.balance, 0);

      const bankValue = Number(response.data.bank_receivable ?? 0);
      const cryptoValue = Number(response.data.crypto_receivable ?? 0);
      const lpDepositK20 = Number(response.data.to_be_deposited_into_lps_k20 ?? 0);
      const lpDepositK21 = Number(response.data.to_be_deposited_into_lps_k21 ?? 0);
      const diffActualExpected = Number(response.data.difference_between_actual_and_expected ?? 0);
        const netCurrent = total;
      const netAfterExpected = Number(response.data.net_balance_after_expected_funds ?? (netCurrent + bankValue + cryptoValue));

      setPspBalances(mapped);
      setWalletTotal(total);
      setBankReceivable(bankValue);
      setCryptoReceivable(cryptoValue);
      setToBeDepositedIntoLpsK20(lpDepositK20);
      setToBeDepositedIntoLpsK21(lpDepositK21);
      setDifferenceBetweenActualAndExpected(diffActualExpected);
      setNetAllCurrentBalance(Number.isFinite(netCurrent) ? netCurrent : total);
      setNetBalanceAfterExpectedFunds(Number.isFinite(netAfterExpected) ? netAfterExpected : netCurrent + bankValue + cryptoValue);

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
    };

    fetchWalletData();
    const iv = setInterval(fetchWalletData, 2 * 60 * 1000);
    return () => clearInterval(iv);
  }, [refreshKey]);

  useEffect(() => {
    if (variant !== 'full') return;

    let cancelled = false;

    const loadDocusignOverview = async () => {
      try {
        if (!cancelled) setDocusignLoading(true);
        const data = await fetchDocusignOverview();
        if (cancelled) return;
        setDocusignOverview(data);
        setDocusignError(null);
      } catch (error: any) {
        if (cancelled) return;
        setDocusignError(error?.message || 'Failed to load Docusign status.');
      } finally {
        if (!cancelled) setDocusignLoading(false);
      }
    };

    loadDocusignOverview();
    const iv = setInterval(loadDocusignOverview, 30000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [refreshKey, variant]);

  const formatStatusDate = (value: string | null | undefined) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <DepartmentCard title="Back Office" icon={Settings}>
      <div className="space-y-5">
        {variant === 'full' && (
          <section className="rounded-2xl border border-border/60 bg-card/70 p-5 shadow-sm">
            <div>
              <div className="text-[11px] font-mono uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">Backoffice Command</div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Operations Snapshot</h2>
                {isLoading && <span className="animate-pulse rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-700 dark:text-cyan-300">Refreshing</span>}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                {renderMetricSurface(
                  <div className="rounded-xl border border-border/50 bg-background/80 p-3">
                    <div className="text-[10px] text-slate-500">Clients</div>
                    <div className="mt-1 font-mono text-base font-semibold">{metrics.totalClients.toLocaleString()}</div>
                  </div>,
                  renderMetricTooltip('Clients', [
                    ...userSourceTooltip,
                    'Counts only non-test client profiles.',
                  ])
                )}
                {renderMetricSurface(
                  <div className="rounded-xl border border-border/50 bg-background/80 p-3">
                    <div className="text-[10px] text-slate-500">MT5 Accounts</div>
                    <div className="mt-1 font-mono text-base font-semibold">{metrics.totalMT5Accounts.toLocaleString()}</div>
                  </div>,
                  renderMetricTooltip('MT5 Accounts', [
                    ...accountSourceTooltip,
                    'Counts MT5 accounts excluding ib-wallet groups.',
                    'Includes both demo and live accounts.',
                  ])
                )}
                {renderMetricSurface(
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                    <div className="text-[10px] text-slate-500">Deposits</div>
                    <div className="mt-1 font-mono text-base font-semibold text-emerald-700 dark:text-emerald-300">{formatCurrencyValue(metrics.totalDeposits)}</div>
                  </div>,
                  renderMetricTooltip('Deposits', [
                    ...transactionSourceTooltip,
                    'Counts only transactionTypes = deposit.',
                    'Excludes rows whose platformComment contains negative bal.',
                    'Displayed value is the sum of processedAmount.',
                  ])
                )}
                {renderMetricSurface(
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                    <div className="text-[10px] text-slate-500">Withdrawals</div>
                    <div className="mt-1 font-mono text-base font-semibold text-amber-700 dark:text-amber-300">{formatCurrencyValue(metrics.totalWithdrawals)}</div>
                  </div>,
                  renderMetricTooltip('Withdrawals', [
                    ...transactionSourceTooltip,
                    'Counts only transactionTypes = withdrawal.',
                    'Displayed value is the absolute sum of processedAmount.',
                  ])
                )}
              </div>
            </div>
          </section>
        )}

        <div className={variant === 'compact' ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]'}>
        <section className={variant === 'compact' ? 'h-full rounded-2xl border border-border/60 bg-card/70 p-4' : 'h-full rounded-2xl border border-border/60 bg-card/70 p-4'}>
          <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">{variant === 'compact' ? 'Operations Overview' : '1. Backoffice Overview'}</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {renderMetricSurface(
              <div className="rounded-xl border border-primary/20 bg-primary/10 p-3 text-center">
                <Users className="mx-auto mb-1 h-4 w-4 text-primary" />
                <div className="font-mono font-semibold">{metrics.totalIBs}</div>
                <div className="text-xs text-muted-foreground">IB Withdrawals</div>
              </div>,
              renderMetricTooltip('IB Withdrawals', [
                ...transactionSourceTooltip,
                'Counts only transactionTypes = ib withdrawal.',
                'Displayed value is the number of approved rows, not the amount.',
              ])
            )}
            {renderMetricSurface(
              <div className="rounded-xl border border-success/20 bg-success/10 p-3 text-center">
                <TrendingUp className="mx-auto mb-1 h-4 w-4 text-success" />
                <div className="font-mono font-semibold">{metrics.totalDepositCount.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">No. of Deposits</div>
              </div>,
              renderMetricTooltip('No. of Deposits', [
                ...transactionSourceTooltip,
                'Counts only approved deposit rows.',
                'Excludes rows whose platformComment contains negative bal.',
              ])
            )}
            {renderMetricSurface(
              <div className="rounded-xl border border-warning/20 bg-warning/10 p-3 text-center">
                <AlertCircle className="mx-auto mb-1 h-4 w-4 text-warning" />
                <div className="font-mono font-semibold">{metrics.totalWithdrawalCount.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">No. of Withdrawals</div>
              </div>,
              renderMetricTooltip('No. of Withdrawals', [
                ...transactionSourceTooltip,
                'Counts only approved withdrawal rows.',
              ])
            )}
            {renderMetricSurface(
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-center">
                <CheckCircle className="mx-auto mb-1 h-4 w-4 text-cyan-500" />
                <div className="font-mono font-semibold">{metrics.verifiedClients.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">Verified Clients</div>
              </div>,
              renderMetricTooltip('Verified Clients', [
                ...userSourceTooltip,
                'Counts only non-test profiles where verified = true.',
              ])
            )}
          </div>

          {renderMetricSurface(
            <div className="mt-3 rounded-lg border border-border/40 bg-background/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Accounts Created Rate</span>
                <span className="font-mono text-sm font-semibold text-primary">{createdRate}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-gradient-to-r from-primary to-cyan-500 transition-all" style={{ width: `${createdRate}%` }} />
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                {metrics.totalMT5Accounts.toLocaleString()} accounts of {metrics.totalClients.toLocaleString()} clients
              </div>
            </div>,
            renderMetricTooltip('Accounts Created Rate', [
              'Formula: Math.round((MT5 Accounts / Clients) * 100).',
              `Current formula: ${metrics.totalMT5Accounts.toLocaleString()} / ${metrics.totalClients.toLocaleString()} => ${createdRate}%.`,
              'Clients exclude test profiles.',
              'MT5 Accounts exclude ib-wallet groups and include both demo and live accounts.',
            ])
          )}

          <div className={variant === 'compact' ? 'mt-3 grid grid-cols-1 gap-3' : 'mt-3 grid grid-cols-1 gap-3 md:grid-cols-2'}>
            <div className="space-y-1 rounded-lg border border-border/40 bg-background/50 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5 text-primary" />
                Client Breakdown
              </div>
              {clientBreakdownItems.map((item) => (
                <MetricRow key={item.label} label={item.label} value={item.value} icon={item.icon} tooltip={item.tooltip} />
              ))}
            </div>

            <div className="rounded-lg border border-border/40 bg-background/50 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Shield className="h-3.5 w-3.5 text-primary" />
                KYC Status
              </div>
              <div className="grid grid-cols-2 gap-2">
                {kycItems.map((item) => (
                  <Tooltip key={item.label}>
                    <TooltipTrigger asChild>
                      <div className={`${item.cardClass} cursor-help`}>
                        <div className={item.labelClass}>{item.label}</div>
                        <div className={item.valueClass}>{item.value}</div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[24rem] text-xs leading-5">
                      {item.tooltip}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
              {metrics.kycUnknown > 0 && (
                <div className="mt-2 rounded-md border border-violet-500/30 bg-violet-500/10 p-2 text-center">
                  <div className="text-[10px] text-violet-700 dark:text-violet-300">Unknown (see console)</div>
                  <div className="mt-1 font-mono text-base font-semibold text-violet-800 dark:text-violet-200">{metrics.kycUnknown}</div>
                </div>
              )}
            </div>
          </div>
        </section>
        {variant === 'full' && (
        <section className="h-full rounded-2xl border border-border/60 bg-card/70 p-3 sm:p-4">
          <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">2. Closing Balance Report</div>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-foreground">PSP Wallet Balances</div>
              <div className="text-[10px] text-muted-foreground">Updated: {reportUpdated}</div>
            </div>
            <div className="text-[10px] text-muted-foreground">{reportDate}</div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_240px]">
            <div className="space-y-1 rounded-xl border border-border/40 bg-background/50 p-2.5">
              {walletError && <div className="text-[11px] text-destructive">{walletError}</div>}
              {pspBalances.length === 0 && !isLoading && !walletError && <div className="text-[11px] text-muted-foreground">No wallet data available.</div>}
              {pspBalances.map((psp, index) => {
                const cryptoCount = 7;
                const cryptoSubtotal = pspBalances.slice(0, cryptoCount).reduce((sum, item) => sum + item.balance, 0);

                return (
                  <div key={psp.name}>
                    <div className="flex items-center justify-between rounded-lg border border-border/40 bg-secondary/25 p-2 text-xs">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {psp.status === 'error' ? <AlertCircle className="h-3 w-3 flex-shrink-0 text-destructive" /> : <CheckCircle className="h-3 w-3 flex-shrink-0 text-success" />}
                        <span className="truncate text-foreground">{psp.name}</span>
                      </div>
                      <span className="ml-2 flex-shrink-0 text-right font-mono font-semibold">
                        ${psp.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                    {index === cryptoCount - 1 && (
                      <div className="mt-1 flex items-center justify-between rounded-lg border border-cyan-500/40 bg-cyan-500/15 p-2 text-xs">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <CheckCircle className="h-3 w-3 flex-shrink-0 text-cyan-500" />
                          <span className="truncate font-semibold text-foreground">🔐 SUBTOTAL CRYPTO</span>
                        </div>
                        <span className="ml-2 flex-shrink-0 text-right font-mono font-bold text-cyan-500">
                          ${cryptoSubtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="space-y-2.5">
              <div className="rounded-xl border border-primary/20 bg-primary/10 p-3">
                <div className="text-[10px] text-muted-foreground">💎 Total Combined</div>
                <div className="mt-1 font-mono text-base font-bold text-primary">
                  ${walletTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-warning/20 bg-warning/10 p-3">
                <div className="text-[10px] text-muted-foreground">📊 To be received in BANK</div>
                <div className="mt-1 font-mono text-sm font-semibold text-warning">
                  ${bankReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
                <div className="text-[10px] text-muted-foreground">🔐 To be received in CRYPTO</div>
                <div className="mt-1 font-mono text-sm font-semibold text-cyan-500">
                  ${cryptoReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/10 p-3">
                <div className="text-[10px] text-muted-foreground">🏦 To be deposited into LPs (Bank - USD)</div>
                <div className="mt-1 font-mono text-sm font-semibold text-fuchsia-500">
                  ${toBeDepositedIntoLpsK20.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3">
                <div className="text-[10px] text-muted-foreground">🏦 To be deposited into LPs (Crypto USDT)</div>
                <div className="mt-1 font-mono text-sm font-semibold text-rose-500">
                  ${toBeDepositedIntoLpsK21.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                <div className="text-[10px] text-muted-foreground">💼 Net all Current Balance</div>
                <div className="mt-1 font-mono text-sm font-semibold text-emerald-500">
                  ${netAllCurrentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-3">
                <div className="text-[10px] text-muted-foreground">📈 Net Balance after expected funds</div>
                <div className="mt-1 font-mono text-sm font-semibold text-indigo-500">
                  ${netBalanceAfterExpectedFunds.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-orange-500/20 bg-orange-500/10 p-3">
                <div className="text-[10px] text-muted-foreground">⚖️ Difference between actual and expected (J29)</div>
                <div className="mt-1 font-mono text-sm font-semibold text-orange-500">
                  ${differenceBetweenActualAndExpected.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
            </div>
          </div>
        </section>
        )}
        </div>

        {variant === 'full' && (
          <section className="rounded-2xl border border-border/60 bg-card/70 p-3 sm:p-4">
            <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">3. Client Cashflow Finder</div>
            <div className="rounded-xl border border-border/50 bg-background/60 p-3 sm:p-3.5">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-cyan-700 dark:text-cyan-300" />
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Lookup by CRM ID</span>
              </div>
              {lookupResult && (
                <div className="text-[11px] text-slate-600 dark:text-slate-300">
                  CRM ID: <span className="font-mono">{lookupResult.crmId}</span>
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                value={lookupCrmId}
                onChange={(e) => setLookupCrmId(e.target.value)}
                placeholder="Enter CRM ID (e.g. 10314)"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-cyan-500/40 focus:ring dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <input
                value={withdrawalDecisionAmount}
                onChange={(e) => setWithdrawalDecisionAmount(e.target.value)}
                placeholder="Withdrawal amount (e.g. 1000000)"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-cyan-500/40 focus:ring dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={handleLookupClientCashflow}
                disabled={lookupLoading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-60 sm:w-auto"
              >
                {lookupLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {lookupLoading ? 'Searching...' : 'Find'}
              </button>
            </div>

            {lookupError && (
              <div className="mt-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                {lookupError}
              </div>
            )}

            {lookupResult && (
              <>
                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                    <div className="flex items-center gap-1 text-[11px] text-emerald-800 dark:text-emerald-300">
                      <ArrowDownToLine className="h-3.5 w-3.5" /> Deposits
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-emerald-900 dark:text-emerald-100">
                      {lookupResult.deposits.length} tx | ${lookupDepositTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                    <div className="flex items-center gap-1 text-[11px] text-amber-800 dark:text-amber-300">
                      <ArrowUpToLine className="h-3.5 w-3.5" /> Withdrawals
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-amber-900 dark:text-amber-100">
                      {lookupResult.withdrawals.length} tx | ${lookupWithdrawalTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                    <div className="mb-1 text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">Deposits by PSP</div>
                    <div className="max-h-28 space-y-1 overflow-y-auto">
                      {depositByPsp.length === 0 && <div className="text-[11px] text-slate-500">No deposit PSP data.</div>}
                      {depositByPsp.map((row) => (
                        <div key={`dep-psp-${row.psp}`} className="flex items-center justify-between text-[11px]">
                          <span className="truncate text-slate-700 dark:text-slate-200">{row.psp}</span>
                          <span className="font-mono text-emerald-700 dark:text-emerald-300">${row.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                    <div className="mb-1 text-[11px] font-semibold text-amber-800 dark:text-amber-300">Withdrawals by PSP</div>
                    <div className="max-h-28 space-y-1 overflow-y-auto">
                      {withdrawalByPsp.length === 0 && <div className="text-[11px] text-slate-500">No withdrawal PSP data.</div>}
                      {withdrawalByPsp.map((row) => (
                        <div key={`wd-psp-${row.psp}`} className="flex items-center justify-between text-[11px]">
                          <span className="truncate text-slate-700 dark:text-slate-200">{row.psp}</span>
                          <span className="font-mono text-amber-700 dark:text-amber-300">${row.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-cyan-800 dark:text-cyan-300">
                    <ArrowUpToLine className="h-3.5 w-3.5" /> Withdrawal Method Decision (FIFO)
                  </div>
                  {withdrawalDecision && (
                    <div
                      className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
                        withdrawalDecision.tone === 'success'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                          : withdrawalDecision.tone === 'warning'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                            : 'border-slate-300/60 bg-slate-100/60 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300'
                      }`}
                    >
                      <div className="font-semibold">
                        Recommended Method:{' '}
                        <span className="font-mono">{withdrawalDecision.method || 'N/A'}</span>
                      </div>
                      <div className="mt-1">{withdrawalDecision.reason}</div>
                      <div className="mt-1 font-mono text-[11px] opacity-90">
                        FIFO eligible balance (Cash: ${withdrawalDecision.availableCash.toLocaleString(undefined, { maximumFractionDigits: 2 })} | Crypto: ${withdrawalDecision.availableCrypto.toLocaleString(undefined, { maximumFractionDigits: 2 })})
                      </div>
                    </div>
                  )}
                </div>

                <div
                  className={`mt-3 rounded-lg border border-slate-200 dark:border-slate-800 ${
                    cashflowFullscreen ? 'fixed inset-2 z-50 overflow-auto overscroll-contain bg-white p-2.5 shadow-2xl dark:bg-slate-950 sm:inset-3 sm:p-3' : 'overflow-x-auto'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={handleCashflowSnapshot}
                      disabled={snapshottingCashflow || !cashflowRows.length}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:border-slate-400 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      <Camera className={`h-3.5 w-3.5 ${snapshottingCashflow ? 'animate-pulse' : ''}`} />
                      {snapshottingCashflow ? 'Capturing...' : 'Snapshot'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCashflowFullscreen((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                    >
                      {cashflowFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                      {cashflowFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    </button>
                  </div>
                  <SortableTable
                    tableId="backoffice-client-cashflow-table"
                    enableColumnVisibility
                    rows={cashflowRows}
                    columns={cashflowColumns}
                    exportFilePrefix="backoffice-client-cashflow"
                    tableClassName="min-w-[960px] text-[11px] md:min-w-full md:text-xs"
                    emptyText="No deposit/withdrawal records found for this client."
                    rowClassName={(_row, idx) => (idx % 2 === 0 ? 'bg-white dark:bg-slate-950/50' : 'bg-slate-50 dark:bg-slate-900/40')}
                  />
                  <div className="mt-2 rounded-lg border border-slate-800 bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40">
                    <span className="font-semibold text-slate-600 dark:text-slate-300">Totals:</span>{' '}
                    <span className="text-slate-500 dark:text-slate-400">
                      Deposits <span className="font-mono text-emerald-700 dark:text-emerald-300">${lookupDepositTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> | Withdrawals{' '}
                      <span className="font-mono text-amber-700 dark:text-amber-300">${lookupWithdrawalTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    </span>
                  </div>
                </div>
              </>
            )}
            </div>
          </section>
        )}

        {variant === 'full' && (
          <section className="rounded-2xl border border-border/60 bg-card/70 p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">4. IB Rebate / Commission Calculator</div>
                <div className="mt-1 text-sm font-semibold text-foreground">IB -&gt; Clients -&gt; Accounts -&gt; Deals -&gt; Commission</div>
              </div>
              {rebateLastUpdated && <div className="text-[11px] text-muted-foreground">Updated {rebateLastUpdated.toLocaleTimeString()}</div>}
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-6">
              <div className="rounded-lg border border-border/50 bg-background/60 p-3 lg:col-span-1">
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">IB CRM ID</label>
                <input
                  type="number"
                  value={rebateIbId}
                  onChange={(e) => setRebateIbId(e.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  placeholder="10342"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/60 p-3 lg:col-span-1">
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">From Date</label>
                <input
                  type="date"
                  value={rebateFromDate}
                  onChange={(e) => setRebateFromDate(e.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/60 p-3 lg:col-span-1">
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">To Date</label>
                <input
                  type="date"
                  value={rebateToDate}
                  onChange={(e) => setRebateToDate(e.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                />
              </div>
              <div className="rounded-lg border border-border/50 bg-background/60 p-3 lg:col-span-1">
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Default $ / Lot</label>
                <input
                  type="number"
                  step="0.01"
                  value={rebateDefaultRate}
                  onChange={(e) => setRebateDefaultRate(e.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  placeholder="2.00"
                />
                <label className="mt-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Commission Source</label>
                <select
                  value={rebateCommissionSource}
                  onChange={(e) => setRebateCommissionSource(e.target.value as RebateCommissionSource)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                >
                  <option value="input-rate">Input rate x lots</option>
                  <option value="mt5-commission">MT5 deal commission (reconcile)</option>
                </select>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {rebateCommissionSource === 'input-rate'
                    ? 'Uses Default/Overrides you entered.'
                    : 'Uses commission reported on each MT5 deal. Best for CRM reconciliation.'}
                </div>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/60 p-3 lg:col-span-1">
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Commission Rule</label>
                <select
                  value={rebateMode}
                  onChange={(e) => setRebateMode(e.target.value as RebateMode)}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                >
                  <option value="all">Same rate for every symbol</option>
                  <option value="specific">Only symbols listed in overrides</option>
                  <option value="all-with-overrides">Default rate + symbol overrides</option>
                </select>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {rebateMode === 'all' && 'All traded symbols use Default $ / Lot. Overrides are ignored.'}
                  {rebateMode === 'specific' && 'Only symbols in the Overrides box will be paid. All others = 0.'}
                  {rebateMode === 'all-with-overrides' && 'All symbols use Default $ / Lot, but symbols in Overrides get their own rate.'}
                </div>
                <label className="mt-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Closed Trade Filter</label>
                <select
                  value={rebateCloseMode}
                  onChange={(e) => setRebateCloseMode(e.target.value as RebateCloseMode)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                >
                  <option value="deal-out-only">Deal OUT only (strict)</option>
                  <option value="all-close-side">All close-side (OUT, INOUT, OUT_BY)</option>
                </select>
                <label className="mt-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Login Scope</label>
                <select
                  value={rebateLoginScope}
                  onChange={(e) => setRebateLoginScope(e.target.value as RebateLoginScope)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                >
                  <option value="all">All logins under IB users</option>
                  <option value="enabled-only">Enabled logins only</option>
                </select>
                <label className="mt-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Date Boundary</label>
                <select
                  value={rebateDateMode}
                  onChange={(e) => setRebateDateMode(e.target.value as RebateDateMode)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                >
                  <option value="crm-calendar">CRM calendar day (recommended)</option>
                  <option value="browser-local">Browser local day (legacy)</option>
                </select>
                <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={rebateIncludeSubIb}
                    onChange={(e) => setRebateIncludeSubIb(e.target.checked)}
                  />
                  Include downline IBs (sub-IB tree)
                </label>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  ON: selected IB + all child IBs. OFF: selected IB only.
                </div>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/60 p-3 lg:col-span-1 flex items-end">
                <button
                  type="button"
                  onClick={runIbRebateCalculation}
                  disabled={rebateLoading}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-cyan-500/40 bg-cyan-500 px-3 py-2 text-xs font-medium text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${rebateLoading ? 'animate-spin' : ''}`} />
                  {rebateLoading ? 'Running...' : 'Run Calculation'}
                </button>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-border/50 bg-background/60 p-3">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Symbol Overrides (one per line: SYMBOL=RATE, example: XAUUSD=2.00)
              </label>
              {rebateMode === 'all' ? (
                <div className="rounded-md border border-slate-300/60 bg-slate-100/70 px-2 py-2 text-[11px] text-muted-foreground dark:border-slate-700 dark:bg-slate-900/50">
                  Overrides are ignored in "Same rate for every symbol" mode.
                </div>
              ) : (
                <>
                  <div className="mb-2 text-[11px] text-muted-foreground">
                    {rebateMode === 'specific'
                      ? 'Required: only symbols listed here will be paid.'
                      : 'Optional: listed symbols will override Default $ / Lot.'}
                  </div>
                  <textarea
                    value={rebateOverridesText}
                    onChange={(e) => setRebateOverridesText(e.target.value)}
                    rows={4}
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-mono text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
                  />
                </>
              )}
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg border border-border/50 bg-background/60 p-3 md:grid-cols-[1fr_1fr_auto_auto_auto]">
              <input
                value={rebatePresetName}
                onChange={(e) => setRebatePresetName(e.target.value)}
                placeholder="Preset name (e.g. Gold IB Plan)"
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
              />
              <select
                value={rebateSelectedPreset}
                onChange={(e) => {
                  setRebateSelectedPreset(e.target.value);
                  loadRebatePreset(e.target.value);
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
              >
                <option value="">Load saved preset</option>
                {rebatePresets.map((preset) => (
                  <option key={preset.name} value={preset.name}>
                    {preset.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={saveRebatePreset}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                Save Preset
              </button>
              <button
                type="button"
                onClick={deleteRebatePreset}
                disabled={!rebateSelectedPreset}
                className="rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-500/15 disabled:opacity-60 dark:text-rose-300"
              >
                Delete Preset
              </button>
              <button
                type="button"
                onClick={downloadRebateCsv}
                disabled={rebateRows.length === 0}
                className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-800 hover:bg-cyan-500/15 disabled:opacity-60 dark:text-cyan-200"
              >
                Export CSV
              </button>
            </div>

            {rebateError && (
              <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                {rebateError}
              </div>
            )}

            {rebateInfo && (
              <div className="mt-3 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-800 dark:text-cyan-200">
                {rebateInfo}
              </div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 p-2.5">
                <div className="text-[10px] text-muted-foreground">IB Users</div>
                <div className="mt-1 font-mono text-base font-semibold">{rebateStats.ibUsers.toLocaleString()}</div>
              </div>
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 p-2.5">
                <div className="text-[10px] text-muted-foreground">Logins</div>
                <div className="mt-1 font-mono text-base font-semibold">{rebateStats.logins.toLocaleString()}</div>
              </div>
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 p-2.5">
                <div className="text-[10px] text-muted-foreground">Deals Scanned</div>
                <div className="mt-1 font-mono text-base font-semibold">{rebateStats.deals.toLocaleString()}</div>
              </div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-2.5">
                <div className="text-[10px] text-muted-foreground">Commission Earned</div>
                <div className="mt-1 font-mono text-base font-semibold text-emerald-700 dark:text-emerald-300">
                  ${rebateTotals.commissionUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5">
                <div className="text-[10px] text-muted-foreground">IB Withdrawn (Lifetime)</div>
                <div className="mt-1 font-mono text-base font-semibold text-amber-700 dark:text-amber-300">
                  ${rebateStats.ibWithdrawnLifetime.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-2.5">
                <div className="text-[10px] text-muted-foreground">IB Balance</div>
                <div className="mt-1 font-mono text-base font-semibold text-primary">
                  ${rebateStats.ibBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-lg border border-violet-500/20 bg-violet-500/10 p-2.5">
                <div className="text-[10px] text-muted-foreground">Net Payable</div>
                <div className={`mt-1 font-mono text-base font-semibold ${rebateNetPayable >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                  ${rebateNetPayable.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              </div>
            </div>

            <div className="mt-2 text-[11px] text-muted-foreground">
              Selected period: Eligible lots {rebateTotals.eligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })} | Non-eligible lots{' '}
              {rebateTotals.ineligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })} | IB withdrawn in period ${rebateStats.ibWithdrawnPeriod.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>

            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Login</th>
                    <th className="px-3 py-2 text-left font-semibold uppercase tracking-wide">Symbol</th>
                    <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Trades</th>
                    <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Traded Lots</th>
                    <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Eligible Lots</th>
                    <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Non-Eligible Lots</th>
                    <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Rate/Lot</th>
                    <th className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {rebateRows.map((row) => (
                    <tr key={`${row.login}-${row.symbol}-${row.rebatePerLot}`} className="bg-slate-50 dark:bg-slate-950/30">
                      <td className="border-t border-slate-800 px-3 py-2 font-mono">{row.login}</td>
                      <td className="border-t border-slate-800 px-3 py-2 font-mono">{row.symbol}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right">{row.trades.toLocaleString()}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right">{row.tradedLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right text-emerald-700 dark:text-emerald-300">{row.eligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right text-amber-700 dark:text-amber-300">{row.ineligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right">${row.rebatePerLot.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right">${row.commissionUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    </tr>
                  ))}
                </tbody>
                {rebateRows.length > 0 && (
                  <tfoot>
                    <tr className="bg-slate-100 font-semibold text-slate-800 dark:bg-slate-900 dark:text-slate-200">
                      <td className="border-t border-slate-800 px-3 py-2" colSpan={2}>TOTAL</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right">{rebateTotals.trades.toLocaleString()}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right">{rebateTotals.tradedLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right text-emerald-700 dark:text-emerald-300">{rebateTotals.eligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right text-amber-700 dark:text-amber-300">{rebateTotals.ineligibleLots.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right">-</td>
                      <td className="border-t border-slate-800 px-3 py-2 text-right">${rebateTotals.commissionUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>
        )}

        {variant === 'full' && (
          <section className="rounded-2xl border border-border/60 bg-card/70 p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">5. Docusign</div>
                <div className="mt-1 text-sm font-semibold text-foreground">Signature Operations</div>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Activity className={`h-3.5 w-3.5 ${docusignLoading ? 'animate-pulse' : ''}`} />
                {docusignLoading ? 'Refreshing' : formatStatusDate(docusignOverview?.system?.latestUpdatedAt)}
              </div>
            </div>

            {docusignError && (
              <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                {docusignError}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 p-3">
                <div className="flex items-center gap-2 text-[11px] text-sky-700 dark:text-sky-300">
                  <FileSignature className="h-3.5 w-3.5" /> Sent for Signature
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold text-sky-900 dark:text-sky-100">{docusignOverview?.summary.sent ?? 0}</div>
              </div>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
                <div className="flex items-center gap-2 text-[11px] text-amber-700 dark:text-amber-300">
                  <Clock3 className="h-3.5 w-3.5" /> Pending Signature
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold text-amber-900 dark:text-amber-100">{docusignOverview?.summary.pending ?? 0}</div>
              </div>
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3">
                <div className="flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  <CircleCheckBig className="h-3.5 w-3.5" /> Signed Completed
                </div>
                <div className="mt-2 font-mono text-2xl font-semibold text-emerald-900 dark:text-emerald-100">{docusignOverview?.summary.completed ?? 0}</div>
              </div>
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-3">
                <div className="text-[11px] text-muted-foreground">System Status</div>
                <div className={`mt-2 inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${docusignOverview?.system.status === 'operational' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>
                  {docusignOverview?.system.status === 'operational' ? 'Working Fine' : 'Needs Attention'}
                </div>
                <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  <div>Core Config: {docusignOverview?.system.hasCoreConfig ? 'Yes' : 'No'}</div>
                  <div>OAuth: {docusignOverview?.system.oauthEnabled ? 'Enabled' : 'Disabled'}</div>
                </div>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-violet-800 dark:text-violet-300">CRM Applications (Status: Pending)</div>
                <div className="font-mono text-lg font-semibold text-violet-900 dark:text-violet-100">{docusignOverview?.pendingApplicationsCount ?? 0}</div>
              </div>
              {docusignOverview?.system.pendingApplicationsError && (
                <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
                  Pending applications fetch issue: {docusignOverview.system.pendingApplicationsError}
                </div>
              )}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-3">
              <div className="rounded-lg border border-amber-500/20 bg-background/40 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                  <Clock3 className="h-3.5 w-3.5" /> Pending Clients
                </div>
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {(docusignOverview?.pendingClients || []).length === 0 && (
                    <div className="text-[11px] text-muted-foreground">No pending signatures.</div>
                  )}
                  {(docusignOverview?.pendingClients || []).map((client) => (
                    <div key={`ds-pending-${client.applicationId}`} className="rounded-md border border-border/40 bg-secondary/20 p-2 text-xs">
                      <div className="font-medium text-foreground">{client.name || client.email}</div>
                      <div className="text-muted-foreground">{client.email}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>App ID: {client.applicationId}</span>
                        <span>{formatStatusDate(client.updatedAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-emerald-500/20 bg-background/40 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  <CircleCheckBig className="h-3.5 w-3.5" /> Completed Signatures
                </div>
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {(docusignOverview?.completedClients || []).length === 0 && (
                    <div className="text-[11px] text-muted-foreground">No completed signatures yet.</div>
                  )}
                  {(docusignOverview?.completedClients || []).map((client) => (
                    <div key={`ds-completed-${client.applicationId}`} className="rounded-md border border-border/40 bg-secondary/20 p-2 text-xs">
                      <div className="font-medium text-foreground">{client.name || client.email}</div>
                      <div className="text-muted-foreground">{client.email}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>App ID: {client.applicationId}</span>
                        <span>{formatStatusDate(client.updatedAt)}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">CRM Upload: {client.crmUploadStatus || 'pending'}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-violet-500/20 bg-background/40 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-violet-700 dark:text-violet-300">
                  <Users className="h-3.5 w-3.5" /> Pending Applications
                </div>
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {(docusignOverview?.pendingApplications || []).length === 0 && (
                    <div className="text-[11px] text-muted-foreground">No pending applications in CRM.</div>
                  )}
                  {(docusignOverview?.pendingApplications || []).map((app) => (
                    <div key={`ds-app-pending-${app.applicationId}`} className="rounded-md border border-border/40 bg-secondary/20 p-2 text-xs">
                      <div className="font-medium text-foreground">{app.fullName || `User ID ${app.userId ?? '-'}`}</div>
                      <div className="text-muted-foreground">Created By: {app.createdBy || '-'}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>App ID: {app.applicationId}</span>
                        <span>{formatStatusDate(app.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </DepartmentCard>
  );
}




