import {
  deriveBaseRows,
  fetchCrmUserIdByLogin,
  fetchDealMatch,
  fetchIbPeriodTransactions,
  isIb,
  mapWithConcurrency,
  toYmd,
  type DealMatchResponse,
  type DealMatchRevenueRow,
} from "@/lib/dealMatchApi";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const ymdLocal = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export type MonthBucket = { key: string; label: string; startYmd: string; endYmd: string };

export type MonthAggregate = {
  lots: number;
  markup: number;
  clientComm: number;
  lpComm: number;
  totalRev: number;
  clients: DealMatchRevenueRow[];
};

export type MonthRow = {
  key: string;
  label: string;
  lots: number;
  totalRev: number;
  ibComm: number;
  lpComm: number;
  netRevenue: number;
};

export type TopClient = {
  login: string;
  name: string;
  lots: number;
  totalRev: number;
  ibComm: number;
  netRevenue: number;
};

export type ReportData = {
  meta: { fromYmd: string; toYmd: string; generatedAt: string };
  months: MonthRow[];
  totals: { lots: number; totalRev: number; netRevenue: number; ibComm: number; lpComm: number; clients: number };
  topClients: TopClient[];
  warnings: string[];
};

export function enumerateMonths(from: Date, to: Date): MonthBucket[] {
  const months: MonthBucket[] = [];
  if (from > to) return months;
  let y = from.getFullYear();
  let m = from.getMonth();
  const endY = to.getFullYear();
  const endM = to.getMonth();
  while (y < endY || (y === endY && m <= endM)) {
    const firstOfMonth = new Date(y, m, 1);
    const lastOfMonth = new Date(y, m + 1, 0);
    const start = firstOfMonth < from ? from : firstOfMonth;
    const end = lastOfMonth > to ? to : lastOfMonth;
    months.push({
      key: `${y}-${pad2(m + 1)}`,
      label: `${MONTH_NAMES[m]} ${y}`,
      startYmd: ymdLocal(start),
      endYmd: ymdLocal(end),
    });
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return months;
}

export function aggregateMonth(report: DealMatchResponse): MonthAggregate {
  const clients = deriveBaseRows(report).filter((r) => r.lots > 0);
  const base = clients.reduce(
    (acc, r) => {
      acc.lots += r.lots;
      acc.markup += r.markup;
      acc.clientComm += r.clientComm;
      acc.lpComm += r.lpComm;
      return acc;
    },
    { lots: 0, markup: 0, clientComm: 0, lpComm: 0 },
  );
  const totalRev = base.markup + base.clientComm - base.lpComm;
  return { ...base, totalRev, clients };
}

export async function buildReport(
  baseUrl: string,
  from: Date,
  to: Date,
  onProgress?: (msg: string) => void,
): Promise<ReportData> {
  const months = enumerateMonths(from, to);
  const warnings: string[] = [];
  const clientAcc = new Map<string, { login: string; name: string; lots: number; totalRev: number }>();
  const monthAggregates: (MonthAggregate | null)[] = [];

  // 1) Monthly revenue / LP / lots + per-client accumulation
  for (let i = 0; i < months.length; i++) {
    const mb = months[i];
    onProgress?.(`Fetching month ${i + 1}/${months.length} (${mb.label})…`);
    try {
      const report = await fetchDealMatch(baseUrl, mb.startYmd, mb.endYmd);
      const agg = aggregateMonth(report);
      monthAggregates.push(agg);
      agg.clients.forEach((c) => {
        const cur = clientAcc.get(c.login) || { login: c.login, name: c.name, lots: 0, totalRev: 0 };
        cur.lots += c.lots;
        cur.totalRev += c.totalRev;
        if ((!cur.name || cur.name === "-") && c.name) cur.name = c.name;
        clientAcc.set(c.login, cur);
      });
    } catch (e: any) {
      warnings.push(`Month ${mb.label} failed to load (${e?.message || "error"})`);
      monthAggregates.push(null);
    }
  }

  // 2) Identify IB clients (crmId + isIb cached; range-independent)
  onProgress?.("Identifying IB clients…");
  const logins = Array.from(clientAcc.keys());
  const ibInfo = new Map<string, number>();
  await mapWithConcurrency(
    logins,
    async (login) => {
      try {
        const crmId = await fetchCrmUserIdByLogin(login);
        if (!crmId) return;
        if (await isIb(crmId)) ibInfo.set(login, crmId);
      } catch {
        /* ignore individual lookup errors */
      }
    },
    6,
  );

  // 3) Monthly IB commission per IB client × month
  const ibByMonth = new Map<string, number>();
  const ibByClient = new Map<string, number>();
  const ibEntries = Array.from(ibInfo.entries());
  let processed = 0;
  await mapWithConcurrency(
    ibEntries,
    async ([login, crmId]) => {
      for (const mb of months) {
        try {
          const amt = await fetchIbPeriodTransactions(crmId, mb.startYmd, mb.endYmd);
          ibByMonth.set(mb.key, (ibByMonth.get(mb.key) || 0) + amt);
          ibByClient.set(login, (ibByClient.get(login) || 0) + amt);
        } catch {
          /* ignore individual month errors */
        }
      }
      processed++;
      onProgress?.(`IB commissions ${processed}/${ibEntries.length}…`);
    },
    6,
  );

  // 4) Month rows
  const monthRows: MonthRow[] = months.map((mb, idx) => {
    const agg = monthAggregates[idx];
    const totalRev = agg ? agg.totalRev : 0;
    const lpComm = agg ? agg.lpComm : 0;
    const lots = agg ? agg.lots : 0;
    const ibComm = ibByMonth.get(mb.key) || 0;
    return { key: mb.key, label: mb.label, lots, totalRev, ibComm, lpComm, netRevenue: totalRev - ibComm };
  });

  // 5) Top clients (by net revenue)
  const topClients: TopClient[] = Array.from(clientAcc.values())
    .map((c) => {
      const ibComm = ibByClient.get(c.login) || 0;
      return { login: c.login, name: c.name, lots: c.lots, totalRev: c.totalRev, ibComm, netRevenue: c.totalRev - ibComm };
    })
    .sort((a, b) => b.netRevenue - a.netRevenue)
    .slice(0, 20);

  // 6) Totals
  const totals = monthRows.reduce(
    (acc, r) => {
      acc.lots += r.lots;
      acc.totalRev += r.totalRev;
      acc.netRevenue += r.netRevenue;
      acc.ibComm += r.ibComm;
      acc.lpComm += r.lpComm;
      return acc;
    },
    { lots: 0, totalRev: 0, netRevenue: 0, ibComm: 0, lpComm: 0, clients: clientAcc.size },
  );

  return {
    meta: { fromYmd: toYmd(from), toYmd: toYmd(to), generatedAt: new Date().toLocaleString() },
    months: monthRows,
    totals,
    topClients,
    warnings,
  };
}
