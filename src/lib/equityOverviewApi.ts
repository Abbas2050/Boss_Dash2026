const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export type EquityAccount = {
  login: number | string;
  source: "Live" | "Bonus" | string;
  name?: string;
  equity: number;
  withdrawableEquity: number;
  credit: number;
  balance: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
};

export type EquityGroup = {
  liveWithdrawableEquity: number;
  bonusWithdrawableEquity: number;
  netWithdrawableEquity: number;
  items: EquityAccount[];
};

export type EquityDashboard = {
  clients: EquityGroup;
  lps: EquityGroup;
  netDifference: number;
};

function normalizeAccount(item: any): EquityAccount {
  return {
    login: item?.login ?? "",
    source: String(item?.source || ""),
    name: item?.name ? String(item.name) : undefined,
    equity: toNumber(item?.equity),
    withdrawableEquity: toNumber(item?.withdrawableEquity),
    credit: toNumber(item?.credit),
    balance: toNumber(item?.balance),
    margin: toNumber(item?.margin),
    freeMargin: toNumber(item?.freeMargin),
    marginLevel: toNumber(item?.marginLevel),
  };
}

function normalizeGroup(group: any, includeItems: boolean): EquityGroup {
  return {
    liveWithdrawableEquity: toNumber(group?.liveWithdrawableEquity),
    bonusWithdrawableEquity: toNumber(group?.bonusWithdrawableEquity),
    netWithdrawableEquity: toNumber(group?.netWithdrawableEquity),
    items: includeItems && Array.isArray(group?.items) ? group.items.map(normalizeAccount) : [],
  };
}

function normalizeDashboard(payload: any, includeItems: boolean): EquityDashboard {
  return {
    clients: normalizeGroup(payload?.clients, includeItems),
    lps: normalizeGroup(payload?.lps, includeItems),
    netDifference: toNumber(payload?.netDifference),
  };
}

export async function fetchEquityOverviewDashboard(options?: { includeDetails?: boolean }): Promise<EquityDashboard> {
  const includeDetails = options?.includeDetails === true;
  const query = includeDetails ? "" : "?includeDetails=false";
  const response = await fetch(`${BACKEND_BASE_URL}/EquityOverview/dashboard${query}`);

  if (!response.ok) {
    throw new Error(`EquityOverview ${response.status}`);
  }

  const json = await response.json();
  return normalizeDashboard(json, includeDetails);
}

export async function fetchEquityOverviewNames(): Promise<Record<string, string>> {
  const response = await fetch(`${BACKEND_BASE_URL}/EquityOverview/names`);

  if (!response.ok) {
    throw new Error(`EquityOverview names ${response.status}`);
  }

  const json = await response.json();
  return json && typeof json === "object" ? json : {};
}
