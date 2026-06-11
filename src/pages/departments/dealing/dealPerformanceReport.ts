import { deriveBaseRows, type DealMatchResponse, type DealMatchRevenueRow } from "@/lib/dealMatchApi";

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
