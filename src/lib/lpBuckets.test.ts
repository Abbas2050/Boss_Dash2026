import { describe, expect, it } from "vitest";
import { aggregateRealEquityByLpBucket, classifyLpBucket, type LpBucket } from "./lpBuckets";

/**
 * Every LP name returned live by GET /Metrics/lp, mapped to the bucket required by
 * the LP/Broker category sheet (Crypto flag + Bank flag -> Crypto | Bank | Both).
 * If the backend renames an LP this test fails loudly rather than silently
 * dropping that LP's equity out of every bucket.
 */
const LIVE_LP_EXPECTATIONS: Array<[string, LpBucket]> = [
  // Crypto only (Crypto=Yes, Bank=No)
  ["AIDI (56720794)", "Crypto"],
  ["Broctagon1 (101823)", "Crypto"],
  ["Broctagon2 (101824)", "Crypto"],
  ["CFI (19010008)", "Crypto"],
  ["Infinox (87037247)", "Crypto"],
  ["LP Prime (10054)", "Crypto"],
  ["Multi Bank (810597)", "Crypto"],
  ["Taurex (120008722)", "Crypto"],
  ["Taurex2 (120029047)", "Crypto"],
  ["ICM (5101163)", "Crypto"],

  // Bank only (Crypto=No, Bank=Yes)
  ["CMC Coverage (101059)", "Bank"],
  ["CMC 2 Coverage (101310)", "Bank"],
  ["FXCM Coverage (101125)", "Bank"],
  ["FXCM 2 Coverage (101172)", "Bank"],
  ["Noor Capital (5400231)", "Bank"],
  ["XTB Direct API (3297149)", "Bank"],
  ["Velocity (102177)", "Bank"],
  ["TopFX (102007)", "Bank"],
  ["IRESS COVERAGE acc (102037)", "Bank"],
  ["EdgeWaterMark Coverage ACC (102083)", "Bank"],
  ["Coverage XopenHub2nd Acc (101797)", "Bank"],
  ["IG Coverage (101971)", "Bank"],

  // Both (Crypto=Yes, Bank=Yes)
  ["Amana 1 (8007388)", "Both"],
  ["Amana2 (8008598)", "Both"],
  ["ATFX 2 coverage acc #186 (101691)", "Both"],
  ["Finalto Coverage 33931 REV (100915)", "Both"],
  ["Coverage Finalto 2nd acc 33758 (101860)", "Both"],
  ["Finalto 3rd account coverage 34899 (101934)", "Both"],
  ["FX Edge Coverage  (101095)", "Both"],
  ["Hantec (50120073)", "Both"],
  ["LMAX 2nd ACC TOB1 OmnibusAc (101753)", "Both"],
  ["Lmax Perpetual Coverage (102114)", "Both"],
  ["B2B Coverage account (101487)", "Both"],
  ["B2B 2Nd acc (101984)", "Both"],
];

describe("classifyLpBucket — live /Metrics/lp names vs the category sheet", () => {
  it.each(LIVE_LP_EXPECTATIONS)("%s -> %s", (lpName, expected) => {
    expect(classifyLpBucket(lpName)).toBe(expected);
  });

  it("classifies every live LP (none silently excluded from the totals)", () => {
    const unclassified = LIVE_LP_EXPECTATIONS.map(([name]) => name).filter((n) => classifyLpBucket(n) === null);
    expect(unclassified).toEqual([]);
  });
});

describe("classifyLpBucket — sheet changes", () => {
  it("ICM is Crypto only (sheet: Crypto=Yes, Bank=No)", () => {
    expect(classifyLpBucket("ICM (5101163)")).toBe("Crypto");
    expect(classifyLpBucket("ICM Capital Limited")).toBe("Crypto");
  });

  it("B2Prime is Both (sheet: Crypto=Yes, Bank=Yes)", () => {
    expect(classifyLpBucket("B2Prime")).toBe("Both");
    expect(classifyLpBucket("B2B Coverage account (101487)")).toBe("Both");
    expect(classifyLpBucket("B2B 2Nd acc (101984)")).toBe("Both");
  });

  it("Velocity is Bank (sheet: Crypto=No, Bank=Yes)", () => {
    expect(classifyLpBucket("Velocity (102177)")).toBe("Bank");
  });

  it("Multi Bank stays Crypto despite the word 'Bank' in its name", () => {
    expect(classifyLpBucket("Multi Bank (810597)")).toBe("Crypto");
  });
});

describe("classifyLpBucket — edges", () => {
  it("returns null for unknown or empty names", () => {
    expect(classifyLpBucket("Totally Unknown LP (999)")).toBeNull();
    expect(classifyLpBucket("")).toBeNull();
    expect(classifyLpBucket(null)).toBeNull();
    expect(classifyLpBucket(undefined)).toBeNull();
  });
});

describe("aggregateRealEquityByLpBucket", () => {
  it("sums real equity into the right buckets", () => {
    const totals = aggregateRealEquityByLpBucket([
      { lp: "ICM (5101163)", realEquity: 100 },
      { lp: "B2B 2Nd acc (101984)", realEquity: 200 },
      { lp: "Velocity (102177)", realEquity: 50 },
      { lp: "Totally Unknown LP (999)", realEquity: 999 },
    ]);
    expect(totals).toEqual({ Bank: 50, Both: 200, Crypto: 100 });
  });
});
