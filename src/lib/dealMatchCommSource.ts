/**
 * Comm Source -- which branch of the LP-commission rule produced the LP
 * Commission figure on a Deal Match row.
 *
 * Quoted from `temporay_for_reference_pages/deal-matching 9.html`, which states
 * the rule on the LP Comm Breakdown grid's "Net LP Comm" column:
 *
 *   (a) UseCalculatedCommission=true -> ClientMillions x PerMillionRate
 *   (b) Symbol-level actual > 0      -> ClientLots x (bySymbol.ActualCommission
 *                                       / bySymbol.Lots)
 *   (c) Coverage present, symbol has no actual -> ClientMillions x PerMillionRate
 *   (d) NoCoverage                   -> ClientMillions x $10 default
 *
 * and on the "Source" column which tag each branch carries: Actual (per-lot from
 * bySymbol -- valid for CFDs and stocks), PerMillion (fallback via configured
 * rate -- CFDs only), NoCoverage (no coverage LP matched -- CFDs get the $10/M
 * default), Stock (per-million does not apply; $0 unless Actual data exists).
 * A (client, LP) parent row whose symbols hit more than one branch is "Mixed".
 *
 * This module only *labels* a figure. It never recomputes one: LP Commission,
 * Net Revenue and every other cell keep coming from exactly where they came from
 * before the column existed.
 */

export type CommSource = "Actual" | "PerMillion" | "Mixed" | "NoCoverage" | "Stock";

/** The rate flow with no resolved coverage LP is priced at, per the (d) branch.
 *  Documented here so a NoCoverage row's figure can be recognised; nothing in
 *  this repo computes LP commission, the backend does. */
export const NO_COVERAGE_RATE_PER_MILLION_USD = 10;

const KNOWN_SOURCES: readonly string[] = ["Actual", "PerMillion", "Mixed", "NoCoverage", "Stock"];

/** One row of `DealMatch/Run` -> `clientLpSymbolCommissions`: the per (client,
 *  symbol, LP) commission inputs and the net the backend derived from them. */
export type ClientLpSymbolCommission = {
  login?: string | number;
  clientName?: string;
  clientGroup?: string;
  symbol?: string;
  lpName?: string;
  lpsid?: string;
  tradeCount?: number;
  clientLots?: number;
  clientMillionsUsd?: number;
  /** coverage.BySymbol[symbol].ActualCommission -- the LP's actual charge for
   *  that symbol across every client on that LP. Branch (b) fires when non-zero. */
  coverageSymbolCommissionUsd?: number;
  /** coverage.ConfiguredRatePerMillion -- the rate branches (a) and (c) use. */
  perMillionRateUsd?: number;
  netLpCommUsd?: number;
  /** The branch tag when the backend already resolved it. Preferred over
   *  re-deriving: the backend has the coverage record, we only have its outputs. */
  source?: string;
  hasCoverage?: boolean;
  useCalculatedCommission?: boolean;
  isStock?: boolean;
  assetClass?: string;
  instrumentType?: string;
  markupRevenueUsd?: number;
  mt5MarkupUsd?: number;
  centroidMarkupUsd?: number;
  clientCommissionUsd?: number;
  grossRevenueUsd?: number;
};

const numeric = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const text = (value: unknown): string => (value == null ? "" : String(value).trim());

/** Stocks are flagged explicitly when the payload carries the flag; otherwise
 *  fall back to the instrument-class strings the backend sometimes sends
 *  instead. Symbol names are deliberately NOT pattern-matched -- "stock-looking"
 *  tickers are a guess, and a wrong guess here mislabels a real CFD row. */
function isStockRow(row: ClientLpSymbolCommission): boolean {
  if (typeof row.isStock === "boolean") return row.isStock;
  const cls = `${text(row.assetClass)} ${text(row.instrumentType)}`.toLowerCase();
  return /stock|equity|share/.test(cls);
}

/** A coverage LP resolved for this row. `hasCoverage` when the backend says so;
 *  otherwise the presence of an LP identity is the only signal available -- a
 *  NoCoverage row has nothing to name. */
function hasCoverageLp(row: ClientLpSymbolCommission): boolean {
  if (typeof row.hasCoverage === "boolean") return row.hasCoverage;
  return Boolean(text(row.lpsid) || text(row.lpName));
}

/**
 * A raw string as a branch tag, or "" when it names no branch we know. Used for
 * a tag the backend supplies directly, where deriving anything from an
 * unrecognised value would be a guess.
 */
export function commSourceTag(value: unknown): CommSource | "" {
  const tagged = text(value);
  return KNOWN_SOURCES.includes(tagged) ? (tagged as CommSource) : "";
}

/**
 * The branch tag for one per-symbol row. Returns "" only when nothing in the row
 * identifies a branch, so callers can render a dash rather than invent a label.
 */
export function classifySymbolCommSource(row: ClientLpSymbolCommission | null | undefined): CommSource | "" {
  if (!row) return "";

  // The backend's own tag wins where present -- it is the same value the
  // reference page's LP Comm Breakdown grid displays raw.
  const tagged = commSourceTag(row.source);
  if (tagged) return tagged;

  // Branch (a): the LP is billed on a calculated per-million basis, so the
  // per-lot actual is never consulted even when one exists.
  if (row.useCalculatedCommission === true) return "PerMillion";

  // Branch (b): a symbol-level actual exists, so the LP's real charge is
  // apportioned by lots. Valid for CFDs and stocks alike.
  if (Math.abs(numeric(row.coverageSymbolCommissionUsd)) > 0) return "Actual";

  // Stocks never reach the per-million fallback -- the rate is a notional-based
  // FX/CFD construct -- so with no actual they are $0.
  if (isStockRow(row)) return "Stock";

  // Branch (d): no coverage LP resolved. CFDs fall back to the $10/M default.
  if (!hasCoverageLp(row)) return "NoCoverage";

  // Branch (c): coverage present, symbol carries no actual -> configured rate.
  return "PerMillion";
}

/**
 * The tag for a (client, LP) parent row given its per-symbol children. One
 * distinct branch across the symbols is reported as that branch; more than one
 * is "Mixed" -- the parent's single LP Commission figure was assembled from
 * several rules and only the per-symbol drilldown can show the split.
 */
export function rollUpCommSource(sources: Array<CommSource | "">): CommSource | "" {
  const distinct = new Set(sources.filter((s): s is CommSource => Boolean(s)));
  if (distinct.size === 0) return "";
  if (distinct.size === 1) return [...distinct][0];
  return "Mixed";
}

/** The full rule, for a column tooltip. Kept beside the logic so the two cannot
 *  drift apart. */
export const COMM_SOURCE_TOOLTIP =
  "Which rule branch produced LP Commission for this row: " +
  "Actual (per-lot from the LP's reported symbol-level actuals), " +
  "PerMillion (Notional x configured per-M rate), " +
  `NoCoverage (no coverage LP resolved -- CFDs get the $${NO_COVERAGE_RATE_PER_MILLION_USD}/M default, stocks $0), ` +
  "Stock (stock symbols with no actual data -- $0), " +
  "Mixed (this row's symbols hit more than one branch -- expand the row for the per-symbol split).";
