import { describe, expect, it } from "vitest";
import { toYmd, toUnixRange, num, deriveBaseRows } from "@/lib/dealMatchApi";

describe("dealMatchApi helpers", () => {
  it("toYmd formats a date as YYYY-MM-DD", () => {
    expect(toYmd(new Date(2025, 0, 5))).toBe("2025-01-05");
    expect(toYmd(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("toUnixRange converts ymd to inclusive unix-second bounds (UTC)", () => {
    const { from, to } = toUnixRange("2025-01-01", "2025-01-31");
    expect(from).toBe(Math.floor(Date.UTC(2025, 0, 1, 0, 0, 0) / 1000));
    expect(to).toBe(Math.floor(Date.UTC(2025, 0, 31, 23, 59, 59) / 1000));
  });

  it("num coerces safely, defaulting to 0", () => {
    expect(num("12.5")).toBe(12.5);
    expect(num(undefined)).toBe(0);
    expect(num("abc")).toBe(0);
  });

  it("deriveBaseRows builds rows from clientRevenueSummaries", () => {
    const rows = deriveBaseRows({
      clientRevenueSummaries: [
        { login: 101, name: "A", lots: 10, markupRevenueUsd: 100, clientCommissionUsd: 20, lpCommissionUsd: -5, totalRevenueUsd: 0 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].login).toBe("101");
    expect(rows[0].lpComm).toBe(5);
    expect(rows[0].totalRev).toBe(115); // 100 + 20 - 5
  });

  it("deriveBaseRows aggregates the matches fallback shape and sets netRevenue", () => {
    const rows = deriveBaseRows({
      matches: [
        { clientLogin: 200, clientName: "C", clientVolume: 3, spreadRevenueUsd: 30, clientCommission: 6, lpCommission: -2 },
        { clientLogin: 200, clientName: "C", clientVolume: 2, spreadRevenueUsd: 20, clientCommission: 4, lpCommission: -1 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].lots).toBe(5);
    expect(rows[0].lpComm).toBe(3); // abs(-2) + abs(-1)
    expect(rows[0].totalRev).toBe(57); // (30+20) + (6+4) - 3
    expect(rows[0].netRevenue).toBe(57);
  });
});
