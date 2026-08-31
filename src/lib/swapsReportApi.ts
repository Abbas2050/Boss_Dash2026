import { BACKEND_BASE_URL } from "@/lib/backendBase";
import { toUnixRange } from "@/lib/dealMatchApi";
import { authHeaders } from "@/lib/auth";

/**
 * One account's swap total for the period. The client and LP halves of the
 * report carry the same fields except for the name: clients have `name`, LPs
 * have `lpName`.
 *
 * These names come from temporay_for_reference_pages/swaps-report.html.
 * /api/SwapsReport is not deployed yet, so they are unverified.
 */
export type SwapAccountRow = {
  login: number;
  name?: string;
  lpName?: string;
  source: string;
  totalSwap: number;
  dealVolume: number;
  realizedVolume: number;
};

export type SwapTotals = { totalSwap: number; accountCount: number };

export type SwapsReport = {
  clients: SwapAccountRow[];
  clientTotals: SwapTotals | null;
  lps: SwapAccountRow[];
  lpTotals: SwapTotals | null;
};

function describeShape(payload: unknown): string {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return `an array of ${payload.length}`;
  if (typeof payload !== "object") return typeof payload;
  const keys = Object.keys(payload as object);
  return keys.length ? `an object with keys: ${keys.join(", ")}` : "an empty object";
}

/**
 * Rows live under `clients` or `lps`. An empty array there is a real answer --
 * a period with no swaps -- and returns []. Anything else throws, because a
 * silent [] is indistinguishable from "no swaps this period" and would hide a
 * shape change on the day the endpoint finally ships.
 *
 * The envelope check above (object with a `clients`/`lps` array) says nothing
 * about what's INSIDE each row. If the backend ships `swapTotal`/`clientName`
 * instead of `totalSwap`/`login`, every row still passes that check, then
 * renders as "-" everywhere -- money(undefined) is "-", the name falls back
 * to "-" -- with no error at all. That is a worse failure than a thrown
 * error: it looks like a legitimate zero-swap period instead of a broken
 * response. So once we know the array is non-empty, assert the fields the UI
 * actually reads are present on a row, and throw naming what the row has
 * instead if not.
 *
 * Only the first row is checked, not all of them. The backend returns one
 * homogeneous array from one query -- there's no realistic path where row 0
 * has `totalSwap` and row 5 has `swapTotal` instead; a shape change is a
 * property of the endpoint's response format, not of an individual record.
 * Checking every row would multiply the cost of every fetch for a case that
 * doesn't happen, while checking zero rows (the previous state) missed the
 * failure entirely. Checking exactly one is what actually distinguishes
 * "endpoint sends what we expect" from "it doesn't", at O(1) per fetch.
 */
export function unwrapSwapRows(payload: unknown, key: "clients" | "lps"): SwapAccountRow[] {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const rows = (payload as Record<string, unknown>)[key];
    if (Array.isArray(rows)) {
      if (rows.length > 0) {
        const first = rows[0];
        const missing = ["totalSwap", "login"].filter(
          (field) => !first || typeof first !== "object" || !(field in first),
        );
        if (missing.length) {
          throw new Error(
            `/api/SwapsReport: row under "${key}" is missing ${missing.join(", ")}; got ${describeShape(first)}`,
          );
        }
      }
      return rows as SwapAccountRow[];
    }
  }
  throw new Error(`/api/SwapsReport: expected an object with a "${key}" array, got ${describeShape(payload)}`);
}

/**
 * The backend computes the totals. Returning null when they are missing lets the
 * UI say "unavailable"; summing the rows here would create a second answer to
 * what we paid in swaps.
 *
 * NaN and Infinity pass a typeof check but are not valid totals. Use Number.isFinite
 * to reject them so the UI renders "unavailable" instead of silently rendering "-"
 * or "NaN" while believing it has a genuine figure.
 */
export function readTotals(payload: unknown, key: "clientTotals" | "lpTotals"): SwapTotals | null {
  if (!payload || typeof payload !== "object") return null;
  const totals = (payload as Record<string, unknown>)[key];
  if (!totals || typeof totals !== "object") return null;
  const t = totals as Record<string, unknown>;
  if (!Number.isFinite(t.totalSwap) || !Number.isFinite(t.accountCount)) return null;
  return { totalSwap: t.totalSwap as number, accountCount: t.accountCount as number };
}

export async function fetchSwapsReport(fromYmd: string, toYmd: string): Promise<SwapsReport> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const res = await fetch(`${BACKEND_BASE_URL}/api/SwapsReport?from=${from}&to=${to}`, {
    headers: { Accept: "application/json", ...authHeaders() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/api/SwapsReport returned HTTP ${res.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  // IIS can return a 200 with an HTML body (an SPA fallback, say) instead of
  // the JSON the res.ok check above assumed. Unguarded, res.json() throws a
  // bare "Unexpected token '<'" that never names /api/SwapsReport, leaving
  // whoever hits it to guess which fetch in the app broke.
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (e) {
    throw new Error(`/api/SwapsReport: response was not valid JSON (${(e as Error)?.message || e})`);
  }
  return {
    clients: unwrapSwapRows(payload, "clients"),
    clientTotals: readTotals(payload, "clientTotals"),
    lps: unwrapSwapRows(payload, "lps"),
    lpTotals: readTotals(payload, "lpTotals"),
  };
}
