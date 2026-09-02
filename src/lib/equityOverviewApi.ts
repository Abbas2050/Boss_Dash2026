import { BACKEND_BASE_URL } from "@/lib/backendBase";
import { authHeaders } from "@/lib/auth";

// Deliberately lenient: most fields here are display-only and a zero default is
// the right answer for them. Do not tighten it -- the treasury-critical fields
// are vetted separately by assertDashboardPayload below, before this ever runs.
const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// The three fields the Excess Funds section is built on. A 200 that simply does
// not carry them would otherwise pass through toNumber as a confident
// netDifference of 0.00 with equityLoaded true -- a silent zero into a treasury
// figure, by exactly the route the widget-status guard was written to close.
const REQUIRED_NUMERIC_FIELDS = [
  "netDifference",
  "lps.netWithdrawableEquity",
  "clients.netWithdrawableEquity",
] as const;

function readPath(payload: any, path: string): unknown {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), payload);
}

// A number, or a numeric string: the backend has sent both. An empty string,
// null, undefined, a boolean or anything non-numeric is a breach, not a zero.
function isNumericField(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") return Number.isFinite(Number(value));
  return false;
}

function describePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return String(payload);
  if (Array.isArray(payload)) return `array of ${payload.length}`;
  if (typeof payload !== "object") return typeof payload;
  const keys = Object.keys(payload as object);
  return keys.length ? `object with keys: ${keys.join(", ")}` : "object with no keys";
}

export function assertDashboardPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`EquityOverview/dashboard returned ${describePayload(payload)}; expected an object.`);
  }
  const missing = REQUIRED_NUMERIC_FIELDS.filter((path) => !isNumericField(readPath(payload, path)));
  if (missing.length) {
    throw new Error(
      `EquityOverview/dashboard is missing usable ${missing.join(", ")}. Received ${describePayload(payload)}.`,
    );
  }
}

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
  // The path and query string are unchanged; only the base moved onto the
  // same-origin proxy, which puts this call behind our own session gate — hence
  // the session bearer that was never needed while the request went straight to
  // the backend origin.
  const response = await fetch(`${BACKEND_BASE_URL}/EquityOverview/dashboard${query}`, {
    headers: { ...authHeaders() },
  });

  if (!response.ok) {
    throw new Error(`EquityOverview ${response.status}`);
  }

  const json = await response.json();
  assertDashboardPayload(json);
  return normalizeDashboard(json, includeDetails);
}

export async function fetchEquityOverviewNames(): Promise<Record<string, string>> {
  const response = await fetch(`${BACKEND_BASE_URL}/EquityOverview/names`, {
    headers: { ...authHeaders() },
  });

  if (!response.ok) {
    throw new Error(`EquityOverview names ${response.status}`);
  }

  const json = await response.json();
  return json && typeof json === "object" ? json : {};
}
