import { BACKEND_BASE_URL } from "@/lib/backendBase";
import { toUnixRange } from "@/lib/dealMatchApi";
import { authHeaders } from "@/lib/auth";

/**
 * One account's swap total for the period. The client and LP halves of the
 * report carry the same fields except for the name: clients have `name`, LPs
 * have `lpName`.
 *
 * These names come from temporay_for_reference_pages/swaps-report 1.html.
 * /api/SwapsReport IS deployed now -- it answers, slowly (a single day has been
 * measured at over 45 seconds), which is why the timeout classification below
 * exists. The earlier note here said the endpoint was undeployed and the field
 * names therefore unverified; that is no longer true and leaving it would send
 * the next reader looking for a staging server that isn't the problem.
 *
 * THE THREE SWAP SOURCES, WHICH ARE NOT THE SAME NUMBER
 * `totalSwap`        -- MT5 closed-deal Storage summed over the window.
 * `unrealizedSwap`   -- accrued swap on positions open RIGHT NOW, read live.
 *                       Not a window figure at all; it is a snapshot.
 * `statementSwap`    -- TotalSwaps from the LP Statement DB (broker PDFs
 *                       uploaded on the LP Statements page), summed over the
 *                       statement rows whose date falls in the window.
 * They are three independent measurements of the same underlying cost and they
 * disagree; that disagreement is the point of showing all three side by side,
 * so none of them may be folded into another.
 */
export type SwapAccountRow = {
  /** LpAccount row id. Present on LP rows only; the LP drilldown is keyed on it. */
  id?: number;
  login: number;
  name?: string;
  lpName?: string;
  source?: string;
  totalSwap: number;
  /** Live snapshot, not a window figure. Terminal LPs send nothing here. */
  unrealizedSwap?: number | null;
  /** LP Statement DB. Absent/null when no statements were uploaded for the range. */
  statementSwap?: number | null;
  /** How many statement rows fed statementSwap, for the cell tooltip. */
  statementRowCount?: number | null;
  dealVolume?: number;
  realizedVolume?: number;
};

export type SwapTotals = { totalSwap: number; accountCount: number };

export type SwapsReport = {
  clients: SwapAccountRow[];
  clientTotals: SwapTotals | null;
  lps: SwapAccountRow[];
  lpTotals: SwapTotals | null;
  /**
   * Partial-success notes. The backend answers 200 with these set when some of
   * the report could not be built -- an API LP whose vendor isn't wired, or an
   * LP whose credentials failed. Surfacing them is the difference between "no
   * swaps for that LP" and "we never asked that LP".
   */
  skippedApiLpCount: number;
  clientPanelError: string | null;
  lpErrors: string[];
};

/** Per-position rollup in a drilldown: closed deals grouped by PositionID. */
export type SwapPositionRow = {
  positionId?: number | string;
  symbol?: string;
  dealCount?: number;
  totalSwap?: number;
  dealVolume?: number;
  realizedVolume?: number;
  firstDealUnixSec?: number | null;
  lastDealUnixSec?: number | null;
};

/** Raw closed deals in a drilldown. `storage` is MT5's name for booked swap. */
export type SwapDealRow = {
  dealId?: number | string;
  timeUtc?: string | null;
  positionId?: number | string;
  symbol?: string;
  action?: string;
  entry?: string;
  lots?: number;
  closedLegLots?: number;
  storage?: number;
};

/** Currently-open positions in a drilldown -- the unrealized half. */
export type SwapOpenPositionRow = {
  ticket?: number | string;
  symbol?: string;
  type?: string;
  lots?: number;
  timeCreateUtc?: string | null;
  swap?: number;
  profit?: number;
};

/**
 * Finalto's per-instrument per-day cost rows, from GetCFDCost.
 *
 * `tradeDate` is deliberately typed as a string and rendered verbatim: it is a
 * CALENDAR DAY the vendor booked a cost against, not an instant. Pushing it
 * through a timezone formatter would shift it into the neighbouring day's
 * bucket and silently reassign the cost.
 */
export type FinaltoDailyCostRow = {
  subAccountId?: number | string | null;
  instrument?: string;
  tradeDate?: string | null;
  longPosCost?: number;
  shortPosCost?: number;
  total?: number;
  eodRate?: number | null;
};

/** One account's drilldown. `isFinalto` switches which half is populated. */
export type SwapDetail = {
  isFinalto: boolean;
  totalSwap: number;
  openSwapAccrued: number;
  dealVolume: number;
  realizedVolume: number;
  positions: SwapPositionRow[];
  deals: SwapDealRow[];
  openPositions: SwapOpenPositionRow[];
  finaltoDailyCosts: FinaltoDailyCostRow[];
};

/**
 * Why a failure taxonomy rather than one Error.
 *
 * Three outcomes have to stay apart on screen or the page repeats the bug that
 * hid three broken settings pages for weeks:
 *   - "loaded and empty"  -- the report ran, there were no swaps. Not an error.
 *   - "not authorised"    -- our own session gate refused it (401/403). The
 *                            operator needs to sign in, not to narrow the range.
 *   - "took too long"     -- the proxy gave up (504 proxy_timeout). The report
 *                            is fine; the WINDOW is too wide. Naming this as a
 *                            generic error sends the operator hunting a bug
 *                            that isn't there.
 * Anything else is "failed", which keeps its own message.
 */
export type SwapsFailureKind = "timeout" | "unauthorized" | "failed";

export class SwapsReportError extends Error {
  readonly kind: SwapsFailureKind;
  constructor(kind: SwapsFailureKind, message: string) {
    super(message);
    this.name = "SwapsReportError";
    this.kind = kind;
  }
}

/**
 * The proxy budget for this route is 180s (commit 67d9f76). When it is exceeded
 * the caller sees HTTP 504 with a `proxy_timeout` body; some intermediaries use
 * 408 or 524 for the same thing. The body sniff is a second net for the case
 * where a middlebox rewrites the status but keeps the wording.
 */
export function classifySwapsFailure(status: number, body: string): SwapsFailureKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 408 || status === 504 || status === 524) return "timeout";
  if (/proxy_timeout|gateway ?time|timed out|timeout/i.test(body)) return "timeout";
  return "failed";
}

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

function readCount(payload: unknown, key: string): number {
  if (!payload || typeof payload !== "object") return 0;
  const value = Number((payload as Record<string, unknown>)[key]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function readMessage(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readMessages(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== "object") return [];
  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter((entry) => entry.trim().length > 0);
}

/**
 * Shared response reader. Classifies the HTTP failure before anything else so
 * the caller can tell a slow report from a refused one, then guards the JSON
 * parse: IIS can answer 200 with an HTML body (an SPA fallback, say), and an
 * unguarded res.json() throws a bare "Unexpected token '<'" that never names
 * which fetch in the app broke.
 */
async function readJson(res: Response, path: string): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SwapsReportError(
      classifySwapsFailure(res.status, body),
      `${path} returned HTTP ${res.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
    );
  }
  try {
    return await res.json();
  } catch (e) {
    throw new SwapsReportError("failed", `${path}: response was not valid JSON (${(e as Error)?.message || e})`);
  }
}

/**
 * Drilldown payloads are read leniently on purpose, and that is NOT the same
 * decision as unwrapSwapRows above. The top-level report is the figure the
 * business reads, so a shape change there must be loud. A drilldown is
 * explanatory detail beneath a figure that has already rendered; an absent
 * sub-array there means "this account has none of those", and throwing would
 * take down the number the operator actually came for.
 */
export function readSwapDetail(payload: unknown, path: string): SwapDetail {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SwapsReportError("failed", `${path}: expected an object, got ${describeShape(payload)}`);
  }
  const p = payload as Record<string, unknown>;
  const list = <T,>(key: string): T[] => (Array.isArray(p[key]) ? (p[key] as T[]) : []);
  const figure = (key: string): number => {
    const value = Number(p[key]);
    return Number.isFinite(value) ? value : 0;
  };
  return {
    isFinalto: p.isFinalto === true,
    totalSwap: figure("totalSwap"),
    openSwapAccrued: figure("openSwapAccrued"),
    dealVolume: figure("dealVolume"),
    realizedVolume: figure("realizedVolume"),
    positions: list<SwapPositionRow>("positions"),
    deals: list<SwapDealRow>("deals"),
    openPositions: list<SwapOpenPositionRow>("openPositions"),
    finaltoDailyCosts: list<FinaltoDailyCostRow>("finaltoDailyCosts"),
  };
}

/**
 * `liveFinalto` is a cost switch, not a display option. Off, the backend reads
 * cached FinaltoCosts rows and only live-fetches the (sub-account, day) tuples
 * it is missing. On, it bypasses the cache entirely and calls Finalto's CFDCost
 * SOAP endpoint once per business day per sub-account -- which is why the
 * caller has to make the cost visible before firing it.
 */
export async function fetchSwapsReport(
  fromYmd: string,
  toYmd: string,
  liveFinalto = false,
): Promise<SwapsReport> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const res = await fetch(
    `${BACKEND_BASE_URL}/api/SwapsReport?from=${from}&to=${to}&liveFinalto=${liveFinalto}`,
    { headers: { Accept: "application/json", ...authHeaders() } },
  );
  const payload = await readJson(res, "/api/SwapsReport");
  return {
    clients: unwrapSwapRows(payload, "clients"),
    clientTotals: readTotals(payload, "clientTotals"),
    lps: unwrapSwapRows(payload, "lps"),
    lpTotals: readTotals(payload, "lpTotals"),
    skippedApiLpCount: readCount(payload, "skippedApiLpCount"),
    clientPanelError: readMessage(payload, "clientPanelError"),
    lpErrors: readMessages(payload, "lpErrors"),
  };
}

export async function fetchClientSwapDetail(login: number | string, fromYmd: string, toYmd: string): Promise<SwapDetail> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const path = `/api/SwapsReport/client/${encodeURIComponent(String(login))}`;
  const res = await fetch(`${BACKEND_BASE_URL}${path}?from=${from}&to=${to}`, {
    headers: { Accept: "application/json", ...authHeaders() },
  });
  return readSwapDetail(await readJson(res, path), path);
}

/**
 * Keyed on the LpAccount row id, not the MT5 login: an API LP may have no MT5
 * login at all (the reference falls back to "id N" in its own title for exactly
 * that case), so the login is not a usable key here.
 */
export async function fetchLpSwapDetail(
  lpAccountId: number | string,
  fromYmd: string,
  toYmd: string,
  liveFinalto = false,
): Promise<SwapDetail> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const path = `/api/SwapsReport/lp-by-id/${encodeURIComponent(String(lpAccountId))}`;
  const res = await fetch(`${BACKEND_BASE_URL}${path}?from=${from}&to=${to}&liveFinalto=${liveFinalto}`, {
    headers: { Accept: "application/json", ...authHeaders() },
  });
  return readSwapDetail(await readJson(res, path), path);
}
