import { BACKEND_BASE_URL } from "@/lib/backendBase";
import { toUnixRange } from "@/lib/dealMatchApi";
import { authHeaders } from "@/lib/auth";

/**
 * One LP's revenue share for the period.
 *
 * realLpPL, ntpPercent and lpPL are computed by the backend and rendered as
 * received. Recomputing lpPL here would create a second source of truth for a
 * number that decides what an LP is paid — the same split that had the Deal
 * Match tab and the weekly email disagreeing on Net Revenue.
 */
export type RevenueShareRow = {
  lpName: string;
  login: number;
  source: string;
  effectiveFrom: string;
  effectiveTo: string;
  startEquity: number;
  endEquity: number;
  credit: number;
  deposit: number;
  withdrawal: number;
  netDeposits: number;
  grossProfit: number;
  totalCommission: number;
  totalSwap: number;
  netPL: number;
  realLpPL: number;
  ntpPercent: number;
  lpPL: number;
  isError?: boolean;
  errorMessage?: string;
};

export type VolumeRow = {
  lpName: string;
  login: number;
  source: string;
  tradeCount: number;
  totalLots: number;
  notionalUsd: number;
  volumeYards: number;
  isError?: boolean;
  errorMessage?: string;
};

/**
 * A single deal. These field names come from the reference page
 * (temporay_for_reference_pages/history 4.html), NOT from a live payload —
 * every /History/deals response sampled on 2026-08-25 had deals: []. Confirm
 * them against a non-empty response before trusting them; wrong names render
 * blank columns rather than failing.
 */
export type DealRow = {
  dealTicket: number;
  symbol: string;
  timeString: string;
  direction: string;
  entry: string;
  volume: number;
  price: number;
  contractSize: number;
  marketValue: number;
  profit: number;
  commission: number;
  fee: number;
  swap: number;
  lpCommission: number;
  lpCommPerLot: number;
};

/**
 * /History/deals answers with an object whose rows sit under `deals`, unlike
 * /History/aggregate and /History/volume which answer with bare arrays.
 * Handling it like the other two produces an empty grid and no error at all.
 */
export function unwrapDeals(payload: unknown): DealRow[] {
  if (Array.isArray(payload)) return payload as DealRow[];
  if (payload && typeof payload === "object") {
    const rows = (payload as { deals?: unknown }).deals;
    if (Array.isArray(rows)) return rows as DealRow[];
  }
  return [];
}

/** The backend marks a row it could not compute. Its figures are meaningless. */
export function isErrorRow(row: { isError?: boolean }): boolean {
  return row?.isError === true;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    headers: { Accept: "application/json", ...authHeaders() },
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]} returned HTTP ${res.status}`);
  return res.json();
}

const asArray = <T,>(payload: unknown): T[] => (Array.isArray(payload) ? (payload as T[]) : []);

export async function fetchRevenueShare(fromYmd: string, toYmd: string): Promise<RevenueShareRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  return asArray<RevenueShareRow>(await getJson(`/History/aggregate?from=${from}&to=${to}`));
}

export async function fetchVolume(fromYmd: string, toYmd: string): Promise<VolumeRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  return asArray<VolumeRow>(await getJson(`/History/volume?from=${from}&to=${to}`));
}

export async function fetchDeals(login: number | string, fromYmd: string, toYmd: string): Promise<DealRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  return unwrapDeals(await getJson(`/History/deals?login=${encodeURIComponent(String(login))}&from=${from}&to=${to}`));
}
