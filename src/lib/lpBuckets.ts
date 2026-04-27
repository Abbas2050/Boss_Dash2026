export type LpBucket = "Bank" | "Both" | "Crypto";

const normalizeLpName = (value: unknown) => String(value || "").trim().toLowerCase();

const normalizeLpForMatch = (value: unknown) =>
  normalizeLpName(value)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const LP_BUCKET_ALIASES: Record<LpBucket, string[]> = {
  Bank: [
    "CMC MARKETS MIDDLE EAST LIMITED",
    "CMC Coverage",
    "CMC 2 Coverage",
    "Coverage XopenHub2nd Acc (101797)",
    "FXCM",
    "FXCM Coverage",
    "FXCM 2 Coverage",
    "IG Coverage (101971)",
    "Noor Capital",
    "XTB",
    "XTB Bonus 1(Coverage)",
    "XTB Bonus 1 (Coverage)",
  ],
  Both: [
    "AFS Global Limited - Amana",
    "Amana 1",
    "Amana2",
    "ATFX",
    "ATFX 2 coverage acc #186",
    "FINALTO",
    "Finalto Coverage 33931 REV",
    "Coverage Finalto 2nd acc",
    "Finalto 3rd account coverage",
    "FX-EDGE SC LTD",
    "FX Edge Coverage",
    "Hantec Markets",
    "Hantec",
    "LMAX",
    "LMAX 2nd ACC TOB1 OmnibusAc",
    "Lmax 3rd acc TOBS",
    "Lmax 3rd acc TOB5",
    "LMAX Old",
    "ICM Capital Limited",
    "ICM",
  ],
  Crypto: [
    "AIDI Financial",
    "AIDI",
    "B2Prime",
    "B2B Coverage account",
    "Broctagon Prime Markets Limited",
    "Broctagon1",
    "Broctagon2",
    "CFI - Credit Financier Invest International LTD",
    "CFI",
    "Infinox Limited",
    "Infinox",
    "Logan Capital (PTY) LTD - LP PRIME",
    "LP Prime",
    "Mex Atlantic Corporation - Multi Bank",
    "Multi Bank",
    "Startrader Financial Markets Limited (Star Prime)",
    "Taurex (Zenfinex Global Limited)",
    "Taurex",
    "Taurex2",
  ],
};

const LP_BUCKET_MATCHERS: Record<LpBucket, string[]> = {
  Bank: LP_BUCKET_ALIASES.Bank.map(normalizeLpForMatch),
  Both: LP_BUCKET_ALIASES.Both.map(normalizeLpForMatch),
  Crypto: LP_BUCKET_ALIASES.Crypto.map(normalizeLpForMatch),
};

export const EMPTY_LP_BUCKET_TOTALS: Record<LpBucket, number> = {
  Bank: 0,
  Both: 0,
  Crypto: 0,
};

export const classifyLpBucket = (lpName: unknown): LpBucket | null => {
  const normalized = normalizeLpForMatch(lpName);
  if (!normalized) return null;

  for (const alias of LP_BUCKET_MATCHERS.Bank) {
    if (alias && (normalized.includes(alias) || alias.includes(normalized))) return "Bank";
  }
  for (const alias of LP_BUCKET_MATCHERS.Both) {
    if (alias && (normalized.includes(alias) || alias.includes(normalized))) return "Both";
  }
  for (const alias of LP_BUCKET_MATCHERS.Crypto) {
    if (alias && (normalized.includes(alias) || alias.includes(normalized))) return "Crypto";
  }
  return null;
};

export const aggregateRealEquityByLpBucket = (
  items: Array<{ lp?: unknown; realEquity?: unknown }>,
): Record<LpBucket, number> => {
  const next = { ...EMPTY_LP_BUCKET_TOTALS };
  for (const row of items || []) {
    const bucket = classifyLpBucket(row?.lp);
    if (!bucket) continue;
    next[bucket] += Number(row?.realEquity) || 0;
  }
  return next;
};
