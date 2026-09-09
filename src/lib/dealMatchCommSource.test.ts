// Comm Source labels which branch of the LP-commission rule produced a row's
// LP Commission. The branches are quoted in dealMatchCommSource.ts from
// `temporay_for_reference_pages/deal-matching 9.html`; each test below pins one
// of them to the input that must produce it.
import { describe, expect, it } from "vitest";
import {
  classifySymbolCommSource,
  commSourceTag,
  rollUpCommSource,
  NO_COVERAGE_RATE_PER_MILLION_USD,
  type ClientLpSymbolCommission,
} from "@/lib/dealMatchCommSource";

// A CFD symbol on a resolved coverage LP, with no symbol-level actual. Each
// test below varies only the field its branch turns on.
const COVERED_CFD: ClientLpSymbolCommission = {
  login: "9001",
  symbol: "EURUSD",
  lpsid: "S1",
  lpName: "Finalto",
  clientLots: 10,
  clientMillionsUsd: 1.5,
  coverageSymbolCommissionUsd: 0,
  perMillionRateUsd: 7,
  netLpCommUsd: 10.5,
};

describe("classifySymbolCommSource", () => {
  it("returns the backend's own tag when it sends one", () => {
    expect(classifySymbolCommSource({ ...COVERED_CFD, source: "Actual" })).toBe("Actual");
    expect(classifySymbolCommSource({ ...COVERED_CFD, source: "NoCoverage" })).toBe("NoCoverage");
  });

  it("ignores a tag it does not recognise and derives the branch instead", () => {
    expect(classifySymbolCommSource({ ...COVERED_CFD, source: "SomethingNew" })).toBe("PerMillion");
  });

  it("Actual: a symbol-level actual commission exists", () => {
    expect(classifySymbolCommSource({ ...COVERED_CFD, coverageSymbolCommissionUsd: 412.75 })).toBe("Actual");
  });

  it("Actual: even a negative actual counts -- LP commission arrives signed-negative", () => {
    expect(classifySymbolCommSource({ ...COVERED_CFD, coverageSymbolCommissionUsd: -412.75 })).toBe("Actual");
  });

  it("PerMillion: coverage present but the symbol carries no actual", () => {
    expect(classifySymbolCommSource(COVERED_CFD)).toBe("PerMillion");
  });

  it("PerMillion: a calculated-commission LP, even where an actual exists", () => {
    expect(
      classifySymbolCommSource({ ...COVERED_CFD, useCalculatedCommission: true, coverageSymbolCommissionUsd: 900 }),
    ).toBe("PerMillion");
  });

  it("NoCoverage: no coverage LP resolved for a CFD -- the $10/M default path", () => {
    const noCoverage: ClientLpSymbolCommission = {
      login: "9001",
      symbol: "GBPUSD",
      lpsid: "",
      lpName: "",
      clientLots: 4,
      clientMillionsUsd: 2,
      coverageSymbolCommissionUsd: 0,
      // Priced at the default rate, which is what the backend charges when no
      // coverage LP was matched.
      perMillionRateUsd: NO_COVERAGE_RATE_PER_MILLION_USD,
      netLpCommUsd: 2 * NO_COVERAGE_RATE_PER_MILLION_USD,
    };
    expect(classifySymbolCommSource(noCoverage)).toBe("NoCoverage");
    // The figure itself stays the backend's; this only documents that the
    // fallback row is the $10/M one.
    expect(noCoverage.netLpCommUsd).toBe(20);
  });

  it("NoCoverage: an explicit hasCoverage=false outranks a populated LP name", () => {
    expect(classifySymbolCommSource({ ...COVERED_CFD, hasCoverage: false })).toBe("NoCoverage");
  });

  it("Stock: a stock symbol with no actual data is $0, not a per-million estimate", () => {
    expect(classifySymbolCommSource({ ...COVERED_CFD, symbol: "AAPL", isStock: true, netLpCommUsd: 0 })).toBe("Stock");
    expect(classifySymbolCommSource({ ...COVERED_CFD, symbol: "AAPL", assetClass: "Equity" })).toBe("Stock");
  });

  it("Stock with an actual is Actual -- per-lot actuals are valid for stocks too", () => {
    expect(classifySymbolCommSource({ ...COVERED_CFD, isStock: true, coverageSymbolCommissionUsd: 33 })).toBe("Actual");
  });

  it("returns '' for a missing row rather than inventing a label", () => {
    expect(classifySymbolCommSource(null)).toBe("");
    expect(classifySymbolCommSource(undefined)).toBe("");
  });
});

describe("rollUpCommSource", () => {
  it("one distinct branch reports that branch", () => {
    expect(rollUpCommSource(["Actual", "Actual"])).toBe("Actual");
  });

  it("Mixed: the symbols under one (client, LP) row hit more than one branch", () => {
    expect(rollUpCommSource(["Actual", "PerMillion"])).toBe("Mixed");
    expect(rollUpCommSource(["Stock", "NoCoverage", "Actual"])).toBe("Mixed");
  });

  it("ignores unlabelled symbols and reports '' when nothing is labelled", () => {
    expect(rollUpCommSource(["", "Actual", ""])).toBe("Actual");
    expect(rollUpCommSource(["", ""])).toBe("");
    expect(rollUpCommSource([])).toBe("");
  });
});

describe("commSourceTag", () => {
  it("accepts only the five known branch names", () => {
    expect(commSourceTag("Mixed")).toBe("Mixed");
    expect(commSourceTag("Stock")).toBe("Stock");
    expect(commSourceTag("perMillion")).toBe("");
    expect(commSourceTag(undefined)).toBe("");
  });
});
