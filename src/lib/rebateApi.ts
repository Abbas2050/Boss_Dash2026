type IbTreeNode = {
  ibId: number;
  level?: number;
  referralIbId?: number;
};

type CrmAccount = {
  login: string;
  userId: number;
  isEnabled?: number;
  groupName?: string;
};

type Mt5Position = {
  login?: number | string;
  symbol?: string;
  lots?: number;
  volume?: number;
  volumeExt?: number;
};

type Mt5Deal = {
  login?: number | string;
  symbol?: string;
  lots?: number;
  volume?: number;
  volumeExt?: number;
  commission?: number | string;
  Commission?: number | string;
  entry?: number | string;
  Entry?: number | string;
  action?: number | string;
  Action?: number | string;
};

const API_VERSION = (import.meta as any).env?.VITE_API_VERSION || "1.0.0";
const API_TOKEN = (import.meta as any).env?.VITE_API_TOKEN || "";
const API_URL = (import.meta as any).env?.VITE_API_URL || "";
const BACKEND_BASE_URL = (import.meta as any).env?.VITE_BACKEND_BASE_URL || "";

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatDateAsDDMMYYYY = (date: Date) => {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = String(date.getUTCFullYear());
  return `${day}-${month}-${year}`;
};

const getRestBase = () => {
  return "/rest";
};

const getAuthHeaders = () => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
});

export async function fetchIbTree(ibId: number): Promise<IbTreeNode[]> {
  const restBase = getRestBase();
  const endpoint = restBase ? `${restBase}/ib/tree` : "/rest/ib/tree";
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set("version", API_VERSION);
  url.searchParams.set("ibId", String(ibId));

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`IB tree API ${res.status}${text ? `: ${text}` : ""}`);
  }
  const data = (await res.json()) as Array<Partial<IbTreeNode>>;
  return (Array.isArray(data) ? data : []).map((item) => ({
    ibId: toNumber(item.ibId),
    level: toNumber(item.level),
    referralIbId: toNumber(item.referralIbId),
  }));
}

export async function fetchAccountsByUserId(userId: number): Promise<CrmAccount[]> {
  const restBase = getRestBase();
  const endpoint = restBase ? `${restBase}/accounts` : "/rest/accounts";
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set("version", API_VERSION);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Accounts API ${res.status}${text ? `: ${text}` : ""}`);
  }
  const data = (await res.json()) as Array<Partial<CrmAccount>>;
  return (Array.isArray(data) ? data : []).map((item) => ({
    login: String(item.login ?? ""),
    userId: toNumber(item.userId),
    isEnabled: toNumber(item.isEnabled),
    groupName: String(item.groupName ?? ""),
  }));
}

export async function fetchPositionsByLogin(login: string | number): Promise<Mt5Position[]> {
  const endpoint = BACKEND_BASE_URL
    ? `${String(BACKEND_BASE_URL).replace(/\/+$/, "")}/Position/GetPositionsByLogin`
    : "/Position/GetPositionsByLogin";
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set("login", String(login));

  const res = await fetch(url.toString(), {
    headers: {
      accept: "text/plain",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GetPositionsByLogin ${res.status}${text ? `: ${text}` : ""}`);
  }
  const data = (await res.json()) as Array<Partial<Mt5Position>>;
  return (Array.isArray(data) ? data : []).map((item) => ({
    login: item.login,
    symbol: String(item.symbol ?? ""),
    lots: toNumber(item.lots),
    volume: toNumber(item.volume),
    volumeExt: toNumber(item.volumeExt),
  }));
}

export async function fetchDealsByLogin(params: { login: string | number; from: Date; to: Date }): Promise<Mt5Deal[]> {
  const endpoint = BACKEND_BASE_URL
    ? `${String(BACKEND_BASE_URL).replace(/\/+$/, "")}/Deal/GetDealsByLogin`
    : "/Deal/GetDealsByLogin";
  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set("login", String(params.login));
  url.searchParams.set("from", formatDateAsDDMMYYYY(params.from));
  url.searchParams.set("to", formatDateAsDDMMYYYY(params.to));

  const res = await fetch(url.toString(), {
    headers: {
      accept: "text/plain",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GetDealsByLogin ${res.status}${text ? `: ${text}` : ""}`);
  }
  const data = (await res.json()) as Array<Partial<Mt5Deal>>;
  return (Array.isArray(data) ? data : []).map((item) => ({
    login: item.login,
    symbol: String(item.symbol ?? ""),
    lots: toNumber(item.lots),
    volume: toNumber(item.volume),
    volumeExt: toNumber(item.volumeExt),
    commission: (item as any).commission,
    Commission: (item as any).Commission,
    entry: (item as any).entry,
    Entry: (item as any).Entry,
    action: (item as any).action,
    Action: (item as any).Action,
  }));
}
