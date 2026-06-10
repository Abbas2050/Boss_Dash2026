import { describe, expect, it } from "vitest";
import { enumerateMonths, aggregateMonth } from "./dealPerformanceReport";

describe("enumerateMonths", () => {
  it("returns one bucket for a single full month", () => {
    const months = enumerateMonths(new Date(2025, 0, 1), new Date(2025, 0, 31));
    expect(months).toEqual([
      { key: "2025-01", label: "Jan 2025", startYmd: "2025-01-01", endYmd: "2025-01-31" },
    ]);
  });

  it("clamps first and last buckets to the range (partial months)", () => {
    const months = enumerateMonths(new Date(2025, 0, 15), new Date(2025, 2, 10));
    expect(months.map((m) => m.key)).toEqual(["2025-01", "2025-02", "2025-03"]);
    expect(months[0].startYmd).toBe("2025-01-15");
    expect(months[2].endYmd).toBe("2025-03-10");
  });

  it("crosses year boundaries", () => {
    const months = enumerateMonths(new Date(2025, 11, 1), new Date(2026, 1, 28));
    expect(months.map((m) => m.label)).toEqual(["Dec 2025", "Jan 2026", "Feb 2026"]);
  });

  it("returns empty when from is after to", () => {
    expect(enumerateMonths(new Date(2025, 5, 1), new Date(2025, 0, 1))).toEqual([]);
  });
});

describe("aggregateMonth", () => {
  it("sums client rows and computes total revenue", () => {
    const agg = aggregateMonth({
      clientRevenueSummaries: [
        { login: 1, name: "A", lots: 10, markupRevenueUsd: 100, clientCommissionUsd: 20, lpCommissionUsd: -5, totalRevenueUsd: 0 },
        { login: 2, name: "B", lots: 4, markupRevenueUsd: 40, clientCommissionUsd: 10, lpCommissionUsd: -2, totalRevenueUsd: 0 },
        { login: 3, name: "Zero", lots: 0, markupRevenueUsd: 999, clientCommissionUsd: 0, lpCommissionUsd: 0, totalRevenueUsd: 0 },
      ],
    });
    expect(agg.lots).toBe(14);
    expect(agg.lpComm).toBe(7);
    expect(agg.totalRev).toBe(163); // (100+20-5) + (40+10-2)
    expect(agg.clients).toHaveLength(2); // zero-lot row filtered out
  });
});
