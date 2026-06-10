export const CRM_API_VERSION = (import.meta as any).env?.VITE_API_VERSION || "1.0.0";
export const CRM_API_TOKEN = (import.meta as any).env?.VITE_API_TOKEN || "";

export type DealMatchRevenueRow = {
  login: string;
  name: string;
  lots: number;
  markup: number;
  clientComm: number;
  lpComm: number;
  totalRev: number;
  ibCommission: number;
  netRevenue: number;
};

export type DealMatchResponse = {
  clientRevenueSummaries?: Array<{
    login?: string | number;
    name?: string;
    lots?: number;
    markupRevenueUsd?: number;
    clientCommissionUsd?: number;
    lpCommissionUsd?: number;
    totalRevenueUsd?: number;
  }>;
  matches?: Array<{
    clientLogin?: string | number;
    clientName?: string;
    clientVolume?: number;
    spreadRevenueUsd?: number;
    clientCommission?: number;
    lpCommission?: number;
  }>;
};

export function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function toUnixRange(fromDate: string, toDate: string) {
  return {
    from: Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000),
    to: Math.floor(new Date(`${toDate}T23:59:59Z`).getTime() / 1000),
  };
}

export const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const money = (value: number) =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function mapWithConcurrency<T, R>(items: T[], worker: (item: T, idx: number) => Promise<R>, limit = 8): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, limit) }).map(async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function fetchDealMatch(baseUrl: string, fromYmd: string, toYmd: string): Promise<DealMatchResponse> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const params = new URLSearchParams({ group: "*", from: String(from), to: String(to), symbol: "", lite: "false" });
  const resp = await fetch(`${baseUrl}/DealMatch/Run?${params.toString()}`);
  if (!resp.ok) throw new Error(`DealMatch API ${resp.status}`);
  return (await resp.json()) as DealMatchResponse;
}

export function deriveBaseRows(report: DealMatchResponse): DealMatchRevenueRow[] {
  if (Array.isArray(report.clientRevenueSummaries) && report.clientRevenueSummaries.length) {
    return report.clientRevenueSummaries.map((row) => {
      const markup = num(row.markupRevenueUsd);
      const clientComm = num(row.clientCommissionUsd);
      const lpComm = Math.abs(num(row.lpCommissionUsd));
      const totalRev = Number.isFinite(num(row.totalRevenueUsd)) && num(row.totalRevenueUsd) !== 0 ? num(row.totalRevenueUsd) : markup + clientComm - lpComm;
      return {
        login: String(row.login ?? ""),
        name: String(row.name ?? "-"),
        lots: num(row.lots),
        markup,
        clientComm,
        lpComm,
        totalRev,
        ibCommission: 0,
        netRevenue: totalRev,
      };
    });
  }

  const byLogin = new Map<string, DealMatchRevenueRow>();
  (report.matches || []).forEach((m) => {
    const login = String(m.clientLogin ?? "").trim();
    if (!login) return;
    const current = byLogin.get(login) || {
      login,
      name: String(m.clientName || "-"),
      lots: 0,
      markup: 0,
      clientComm: 0,
      lpComm: 0,
      totalRev: 0,
      ibCommission: 0,
      netRevenue: 0,
    };
    current.lots += num(m.clientVolume);
    current.markup += num(m.spreadRevenueUsd);
    current.clientComm += num(m.clientCommission);
    current.lpComm += Math.abs(num(m.lpCommission));
    current.totalRev = current.markup + current.clientComm - current.lpComm;
    byLogin.set(login, current);
  });

  return Array.from(byLogin.values());
}

export async function fetchCrmUserIdByLogin(login: string): Promise<number | null> {
  const resp = await fetch(`/rest/accounts?version=${encodeURIComponent(CRM_API_VERSION)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({ login, segment: { limit: 1, offset: 0 } }),
  });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as Array<{ userId?: number }>;
  const id = num(rows?.[0]?.userId);
  return id > 0 ? id : null;
}

export async function isIb(crmId: number): Promise<boolean> {
  const resp = await fetch(`/rest/ib/tree?version=${encodeURIComponent(CRM_API_VERSION)}&ibId=${encodeURIComponent(String(crmId))}`, {
    headers: {
      Accept: "application/json",
      ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
    },
  });
  if (!resp.ok) return false;
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0;
}

export async function fetchIbPeriodTransactions(crmId: number, fromDate: string, toDate: string): Promise<number> {
  const resp = await fetch(`/rest/transactions?version=${encodeURIComponent(CRM_API_VERSION)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      fromUserId: crmId,
      statuses: ["approved"],
      transactionTypes: ["ib transfer to account", "ib withdrawal"],
      processedAt: {
        begin: `${fromDate} 00:00:00`,
        end: `${toDate} 23:59:59`,
      },
      segment: { limit: 5000, offset: 0 },
    }),
  });
  if (!resp.ok) return 0;
  const rows = (await resp.json()) as Array<{ processedAmount?: number; requestedAmount?: number }>;
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum, r) => sum + (Number.isFinite(num(r.processedAmount)) ? num(r.processedAmount) : num(r.requestedAmount)),
    0,
  );
}
