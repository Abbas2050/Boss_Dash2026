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
 * Describe what a payload actually looked like, for an error message. Not
 * the payload itself -- these responses can carry account-level financial
 * data and shouldn't be dumped into a thrown Error that might end up in a
 * log or a toast.
 */
function describeShape(payload: unknown): string {
  if (payload === null) return "null";
  if (payload === undefined) return "undefined";
  if (Array.isArray(payload)) return "an array";
  if (typeof payload === "object") return `an object with keys [${Object.keys(payload as object).join(", ")}]`;
  return `a ${typeof payload}`;
}

/**
 * /History/deals answers with an object whose rows sit under `deals`.
 * Verified against the live API on 2026-08-25 (every sample happened to
 * come back `deals: []`, which is why that shape is worth testing on its
 * own). A shape we don't recognise -- an error body, a renamed key, a
 * malformed response -- must throw rather than come back as `[]`: an empty
 * array here is legitimately "this LP had no deals in the period", and
 * silently returning the same `[]` for a broken payload would make a real
 * failure indistinguishable from that.
 */
export function unwrapDeals(payload: unknown): DealRow[] {
  if (Array.isArray(payload)) return payload as DealRow[];
  if (payload && typeof payload === "object") {
    const rows = (payload as { deals?: unknown }).deals;
    if (Array.isArray(rows)) return rows as DealRow[];
  }
  throw new Error(`/History/deals: expected an array or an object with a "deals" array, got ${describeShape(payload)}`);
}

/**
 * /History/aggregate and /History/volume both nest their rows under `items`
 * (aggregate also carries `totals`, `fromTimestamp`, `toTimestamp` — see
 * RevenueShareRow's doc comment for why those aren't reported here). Same
 * rule as unwrapDeals: a genuinely empty `items: []` is a legitimate "no
 * rows for this period" and returns `[]`; any other shape throws, naming
 * the endpoint so the failure is traceable to which fetch produced it.
 */
export function unwrapItems<T>(payload: unknown, endpoint: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const rows = (payload as { items?: unknown }).items;
    if (Array.isArray(rows)) return rows as T[];
  }
  throw new Error(`${endpoint}: expected an array or an object with an "items" array, got ${describeShape(payload)}`);
}

/** The backend marks a row it could not compute. Its figures are meaningless. */
export function isErrorRow(row: { isError?: boolean }): boolean {
  return row?.isError === true;
}

/**
 * An LP with no revenue-share agreement reports ntpPercent as the number 0
 * and has nothing to show on the Revenue Share view -- a screen of 0.00 rows
 * would bury the LPs that actually have an agreement. This is a strict
 * comparison, not a coercion: `Number(null)` and `Number("0")` both equal 0
 * too, but a null or string "0" is missing/malformed data, not a zero
 * agreement, and hiding it would make the row vanish silently instead of
 * surfacing the problem. Error rows are always shown regardless of their
 * (meaningless) ntpPercent, so a failed fetch surfaces as an error, not a
 * silent disappearance.
 */
export function hidesFromRevenueShare(row: { ntpPercent?: number | null; isError?: boolean }): boolean {
  return !isErrorRow(row) && row.ntpPercent === 0;
}

// How much of a non-2xx response body to fold into the thrown Error. Enough
// to show a real backend error message (a JSON {message: "..."} body, a
// plain-text stack trace header), short enough that a runaway HTML error
// page doesn't blow up the error string.
const ERROR_BODY_LIMIT = 500;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    headers: { Accept: "application/json", ...authHeaders() },
  });
  if (!res.ok) {
    // Read the body before throwing -- it's the difference between "HTTP
    // 500" and "HTTP 500: upstream LP feed timed out", and the latter is
    // the one that actually helps whoever sees the error next. Body read
    // can itself fail (already consumed, connection dropped); don't let
    // that mask the real HTTP-status error.
    const body = await res.text().catch(() => "");
    const truncated = body.length > ERROR_BODY_LIMIT ? `${body.slice(0, ERROR_BODY_LIMIT)}…` : body;
    const suffix = truncated ? `: ${truncated}` : "";
    throw new Error(`${path.split("?")[0]} returned HTTP ${res.status}${suffix}`);
  }
  return res.json();
}

export async function fetchRevenueShare(fromYmd: string, toYmd: string): Promise<RevenueShareRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const payload = await getJson(`/History/aggregate?from=${from}&to=${to}`);
  return unwrapItems<RevenueShareRow>(payload, "/History/aggregate");
}

export async function fetchVolume(fromYmd: string, toYmd: string): Promise<VolumeRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const payload = await getJson(`/History/volume?from=${from}&to=${to}`);
  return unwrapItems<VolumeRow>(payload, "/History/volume");
}

export async function fetchDeals(login: number | string, fromYmd: string, toYmd: string): Promise<DealRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  return unwrapDeals(await getJson(`/History/deals?login=${encodeURIComponent(String(login))}&from=${from}&to=${to}`));
}
