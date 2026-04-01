import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { fetchUsers, fetchAllUsers, fetchTransactions, fetchAllTransactions, fetchAccounts, type AccountRequest, type Account } from '@/lib/api';
import { fetchDocusignOverview, type DocusignOverview } from '@/lib/docusignApi';
import { formatDateTimeForAPI, getDubaiDate, getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';
import { fetchWalletBalances } from '@/lib/walletApi';

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

type PSPBalance = {
  name: string;
  balance: number;
  status: 'active' | 'pending' | 'error';
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
    testAccounts: 0,
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
  const [cashflowFullscreen, setCashflowFullscreen] = useState(false);
  const [snapshottingCashflow, setSnapshottingCashflow] = useState(false);
  const [docusignOverview, setDocusignOverview] = useState<DocusignOverview | null>(null);
  const [docusignLoading, setDocusignLoading] = useState(false);
  const [docusignError, setDocusignError] = useState<string | null>(null);

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

  const cashflowRows = useMemo(() => {
    const deposits = lookupResult?.deposits || [];
    const withdrawals = lookupResult?.withdrawals || [];
    const maxLen = Math.max(deposits.length, withdrawals.length);
    return Array.from({ length: maxLen }).map((_, idx) => ({
      deposit: deposits[idx] || null,
      withdrawal: withdrawals[idx] || null,
    }));
  }, [lookupResult]);

  const createdRate = metrics.totalClients > 0 ? Math.round((metrics.totalMT5Accounts / metrics.totalClients) * 100) : 0;
  const lookupDepositTotal = lookupResult?.deposits.reduce((s, t) => s + t.amount, 0) || 0;
  const lookupWithdrawalTotal = lookupResult?.withdrawals.reduce((s, t) => s + t.amount, 0) || 0;
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
        const activeAccountsCount = hasEntityFilter
          ? entityUserIds.size > 0
            ? (await fetchAllAccounts({ createdAt: { begin, end }, userIds: entityUserIdsArr })).filter((a: any) => a.tradingStatus === 'active').length
            : 0
          : (await fetchAllAccounts({ createdAt: { begin, end } })).filter((a: any) => a.tradingStatus === 'active').length;

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

        // Exclude test profiles from all client-derived counts (mirrors CRM behaviour)
        const clients = allUsers;
        const testAccounts = allUsers.filter((u: any) => u.testProfile === true).length;
        const filteredVerifiedUsers = verifiedUsers.filter((u: any) => u.testProfile !== true);
        const filteredIndividualUsers = individualUsers.filter((u: any) => u.testProfile !== true);
        const filteredCorporateUsers = corporateUsers.filter((u: any) => u.testProfile !== true);

        const rangeStart = new Date(begin);
        const rangeEnd = new Date(end);
        const firstDepositCount = clients.filter((user: any) => {
          if (!user.firstDepositDate) return false;
          const userFirstDepositDate = new Date(user.firstDepositDate);
          return userFirstDepositDate >= rangeStart && userFirstDepositDate <= rangeEnd;
        }).length;

        setMetrics({
          totalIBs: ibWithdrawals.length,
          totalDeposits: validDeposits.reduce((sum, tx) => sum + Number(tx.processedAmount || 0), 0),
          totalWithdrawals: Math.abs(allWithdrawals.reduce((sum, tx) => sum + Number(tx.processedAmount || 0), 0)),
          totalDepositCount: validDeposits.length,
          totalWithdrawalCount: allWithdrawals.length,
          totalClients: clients.length,
          totalMT5Accounts: accounts.length,
          firstDeposits: firstDepositCount,
          verifiedClients: verifiedUsers.length,
          unverifiedClients: unverifiedUsers.length,
          individualClients: individualUsers.length,
          corporateClients: corporateUsers.length,
          testAccounts,
          sumsubActive: 0,
          activeAccounts: activeAccountsCount,
          demoAccounts: accounts.filter((a: any) => String(a.groupName || '').toLowerCase().startsWith('demo')).length,
          liveAccounts: accounts.filter((a: any) => !String(a.groupName || '').toLowerCase().startsWith('demo')).length,
          kycApproved: clients.filter((u: any) => getKycStatus(u) === 'Approved').length,
          kycApprovedWithConditions: clients.filter((u: any) => getKycStatus(u) === 'Approved with Conditions').length,
          kycPendingReview: clients.filter((u: any) => getKycStatus(u) === 'Pending Review').length,
          kycRejected: clients.filter((u: any) => getKycStatus(u) === 'Rejected').length,
          kycAdditionalInfo: clients.filter((u: any) => getKycStatus(u) === 'Additional Information Required').length,
          kycOnHold: clients.filter((u: any) => getKycStatus(u) === 'On Hold').length,
          kycUnknown: clients.filter((u: any) => {
            const v = getKycStatus(u);
            return !['Approved','Approved with Conditions','Pending Review','Rejected','Additional Information Required','On Hold',''].includes(v);
          }).length,
        });
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

      setPspBalances(mapped);
      setWalletTotal(total);
      setBankReceivable(Number(response.data.bank_receivable ?? 0));
      setCryptoReceivable(Number(response.data.crypto_receivable ?? 0));

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
                <div className="rounded-xl border border-border/50 bg-background/80 p-3">
                  <div className="text-[10px] text-slate-500">Clients</div>
                  <div className="mt-1 font-mono text-base font-semibold">{metrics.totalClients.toLocaleString()}</div>
                </div>
                <div className="rounded-xl border border-border/50 bg-background/80 p-3">
                  <div className="text-[10px] text-slate-500">MT5 Accounts</div>
                  <div className="mt-1 font-mono text-base font-semibold">{metrics.totalMT5Accounts.toLocaleString()}</div>
                </div>
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                  <div className="text-[10px] text-slate-500">Deposits</div>
                  <div className="mt-1 font-mono text-base font-semibold text-emerald-700 dark:text-emerald-300">{formatCurrencyValue(metrics.totalDeposits)}</div>
                </div>
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                  <div className="text-[10px] text-slate-500">Withdrawals</div>
                  <div className="mt-1 font-mono text-base font-semibold text-amber-700 dark:text-amber-300">{formatCurrencyValue(metrics.totalWithdrawals)}</div>
                </div>
              </div>
            </div>
          </section>
        )}

        <div className={variant === 'compact' ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]'}>
        <section className={variant === 'compact' ? 'h-full rounded-2xl border border-border/60 bg-card/70 p-4' : 'h-full rounded-2xl border border-border/60 bg-card/70 p-4'}>
          <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">{variant === 'compact' ? 'Operations Overview' : '1. Backoffice Overview'}</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-primary/20 bg-primary/10 p-3 text-center">
              <Users className="mx-auto mb-1 h-4 w-4 text-primary" />
              <div className="font-mono font-semibold">{metrics.totalIBs}</div>
              <div className="text-xs text-muted-foreground">IB Withdrawals</div>
            </div>
            <div className="rounded-xl border border-success/20 bg-success/10 p-3 text-center">
              <TrendingUp className="mx-auto mb-1 h-4 w-4 text-success" />
              <div className="font-mono font-semibold">{metrics.totalDepositCount.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">No. of Deposits</div>
            </div>
            <div className="rounded-xl border border-warning/20 bg-warning/10 p-3 text-center">
              <AlertCircle className="mx-auto mb-1 h-4 w-4 text-warning" />
              <div className="font-mono font-semibold">{metrics.totalWithdrawalCount.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">No. of Withdrawals</div>
            </div>
            <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-center">
              <CheckCircle className="mx-auto mb-1 h-4 w-4 text-cyan-500" />
              <div className="font-mono font-semibold">{metrics.verifiedClients.toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Verified Clients</div>
            </div>
          </div>

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
          </div>

          <div className={variant === 'compact' ? 'mt-3 grid grid-cols-1 gap-3' : 'mt-3 grid grid-cols-1 gap-3 md:grid-cols-2'}>
            <div className="space-y-1 rounded-lg border border-border/40 bg-background/50 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5 text-primary" />
                Client Breakdown
              </div>
              <MetricRow label="Unverified Clients" value={metrics.unverifiedClients} icon={<Shield className="h-3.5 w-3.5" />} />
              <MetricRow label="Individual Clients" value={metrics.individualClients} icon={<User className="h-3.5 w-3.5" />} />
              <MetricRow label="Corporate Clients" value={metrics.corporateClients} icon={<Briefcase className="h-3.5 w-3.5" />} />
              <MetricRow label="Test Accounts" value={metrics.testAccounts} icon={<Settings className="h-3.5 w-3.5" />} />
              <MetricRow label="Active Accounts" value={metrics.activeAccounts} icon={<Database className="h-3.5 w-3.5" />} />
              <MetricRow label="Demo Accounts" value={metrics.demoAccounts} icon={<Activity className="h-3.5 w-3.5" />} />
              <MetricRow label="Live Accounts" value={metrics.liveAccounts} icon={<TrendingUp className="h-3.5 w-3.5" />} />
            </div>

            <div className="rounded-lg border border-border/40 bg-background/50 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Shield className="h-3.5 w-3.5 text-primary" />
                KYC Status
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-center">
                  <div className="text-[10px] text-emerald-700 dark:text-emerald-300">Approved</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-emerald-800 dark:text-emerald-200">{metrics.kycApproved}</div>
                </div>
                <div className="rounded-md border border-teal-500/30 bg-teal-500/10 p-2 text-center">
                  <div className="text-[10px] text-teal-700 dark:text-teal-300">Approved w/ Conditions</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-teal-800 dark:text-teal-200">{metrics.kycApprovedWithConditions}</div>
                </div>
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-center">
                  <div className="text-[10px] text-amber-700 dark:text-amber-300">Pending Review</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-amber-800 dark:text-amber-200">{metrics.kycPendingReview}</div>
                </div>
                <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-center">
                  <div className="text-[10px] text-rose-700 dark:text-rose-300">Rejected</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-rose-800 dark:text-rose-200">{metrics.kycRejected}</div>
                </div>
                <div className="rounded-md border border-orange-500/30 bg-orange-500/10 p-2 text-center">
                  <div className="text-[10px] text-orange-700 dark:text-orange-300">Additional Info Req.</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-orange-800 dark:text-orange-200">{metrics.kycAdditionalInfo}</div>
                </div>
                <div className="rounded-md border border-sky-500/30 bg-sky-500/10 p-2 text-center">
                  <div className="text-[10px] text-sky-700 dark:text-sky-300">On Hold</div>
                  <div className="mt-1 font-mono text-lg font-semibold text-sky-800 dark:text-sky-200">{metrics.kycOnHold}</div>
                </div>
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
              {pspBalances.map((psp) => (
                <div key={psp.name} className="flex items-center justify-between rounded-lg border border-border/40 bg-secondary/25 p-2 text-xs">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {psp.status === 'error' ? <AlertCircle className="h-3 w-3 flex-shrink-0 text-destructive" /> : <CheckCircle className="h-3 w-3 flex-shrink-0 text-success" />}
                    <span className="truncate text-foreground">{psp.name}</span>
                  </div>
                  <span className="ml-2 flex-shrink-0 text-right font-mono font-semibold">
                    ${psp.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>

            <div className="space-y-2.5">
              <div className="rounded-xl border border-primary/20 bg-primary/10 p-3">
                <div className="text-[10px] text-muted-foreground">Total Combined</div>
                <div className="mt-1 font-mono text-base font-bold text-primary">
                  ${walletTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-warning/20 bg-warning/10 p-3">
                <div className="text-[10px] text-muted-foreground">To be received in BANK</div>
                <div className="mt-1 font-mono text-sm font-semibold text-warning">
                  ${bankReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
                <div className="text-[10px] text-muted-foreground">To be received in CRYPTO</div>
                <div className="mt-1 font-mono text-sm font-semibold text-cyan-500">
                  ${cryptoReceivable.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
              <button
                type="button"
                onClick={handleLookupClientCashflow}
                disabled={lookupLoading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-60 sm:w-auto"
              >
                {lookupLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {lookupLoading ? 'Searching...' : 'Find Cashflow'}
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
                  <table className="min-w-[960px] text-[11px] md:min-w-full md:text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
                      <tr>
                        <th className="px-2 py-2 text-left font-semibold uppercase tracking-wide" colSpan={4}>Deposits</th>
                        <th className="px-2 py-2 text-left font-semibold uppercase tracking-wide" colSpan={4}>Withdrawals</th>
                      </tr>
                      <tr>
                        <th className="px-2 py-2 text-left font-semibold uppercase tracking-wide">Txn ID</th>
                        <th className="px-2 py-2 text-left font-semibold uppercase tracking-wide">Date</th>
                        <th className="px-2 py-2 text-left font-semibold uppercase tracking-wide">PSP</th>
                        <th className="px-2 py-2 text-right font-semibold uppercase tracking-wide">Amount</th>
                        <th className="px-2 py-2 text-left font-semibold uppercase tracking-wide">Txn ID</th>
                        <th className="px-2 py-2 text-left font-semibold uppercase tracking-wide">Date</th>
                        <th className="px-2 py-2 text-left font-semibold uppercase tracking-wide">PSP</th>
                        <th className="px-2 py-2 text-right font-semibold uppercase tracking-wide">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cashflowRows.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-3 py-4 text-center text-slate-500 dark:text-slate-400">
                            No deposit/withdrawal records found for this client.
                          </td>
                        </tr>
                      )}
                      {cashflowRows.map((row, idx) => (
                        <tr key={`cashflow-${idx}`} className="bg-white odd:bg-slate-50 dark:bg-slate-950/50 dark:odd:bg-slate-900/40">
                          <td className="border-t border-slate-200 px-2 py-2 font-mono dark:border-slate-800">{row.deposit ? String(row.deposit.id) : '-'}</td>
                          <td className="border-t border-slate-200 px-2 py-2 dark:border-slate-800">{row.deposit ? formatTxDate(row.deposit.processedAt) : '-'}</td>
                          <td className="border-t border-slate-200 px-2 py-2 dark:border-slate-800">{row.deposit?.pspName || '-'}</td>
                          <td className="border-t border-slate-200 px-2 py-2 text-right text-emerald-700 dark:border-slate-800 dark:text-emerald-300">
                            {row.deposit ? `$${row.deposit.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-'}
                          </td>
                          <td className="border-t border-slate-200 px-2 py-2 font-mono dark:border-slate-800">{row.withdrawal ? String(row.withdrawal.id) : '-'}</td>
                          <td className="border-t border-slate-200 px-2 py-2 dark:border-slate-800">{row.withdrawal ? formatTxDate(row.withdrawal.processedAt) : '-'}</td>
                          <td className="border-t border-slate-200 px-2 py-2 dark:border-slate-800">{row.withdrawal?.pspName || '-'}</td>
                          <td className="border-t border-slate-200 px-2 py-2 text-right text-amber-700 dark:border-slate-800 dark:text-amber-300">
                            {row.withdrawal ? `$${row.withdrawal.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-200/80 font-semibold text-slate-700 dark:bg-slate-900/95 dark:text-slate-200">
                        <td className="px-2 py-2">TOTAL</td>
                        <td className="px-2 py-2" />
                        <td className="px-2 py-2 text-right text-emerald-700 dark:text-emerald-300">
                          ${lookupDepositTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-2 py-2" />
                        <td className="px-2 py-2">TOTAL</td>
                        <td className="px-2 py-2" />
                        <td className="px-2 py-2 text-right text-amber-700 dark:text-amber-300">
                          ${lookupWithdrawalTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-2 py-2" />
                      </tr>
                    </tfoot>
                  </table>
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
                <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">4. Docusign</div>
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




