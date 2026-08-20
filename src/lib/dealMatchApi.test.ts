import { describe, expect, it } from "vitest";
import { toYmd, toUnixRange, num, deriveBaseRows, lpCommPerMillion } from "@/lib/dealMatchApi";

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

describe("lpCommPerMillion", () => {
  it("divides commission by notional", () => {
    expect(lpCommPerMillion(18316.26, 1884.5)).toBeCloseTo(9.72, 2);
  });

  // A TOTAL with no notional is not a TOTAL charged $0.00 per million.
  it("returns null when notional is unknown, so the caller can say so", () => {
    expect(lpCommPerMillion(100, 0)).toBeNull();
    expect(lpCommPerMillion(100, NaN)).toBeNull();
    expect(lpCommPerMillion(100, -5)).toBeNull();
  });

  it("reports a genuine zero rate as 0, not as unknown", () => {
    expect(lpCommPerMillion(0, 47.6)).toBe(0);
  });
});

// The bug this file exists to pin down: Net Revenue is Gross less the
// PER-MILLION commission, not less the coverage-attributed lpCommissionUsd.
// Checked against DealMatch/Run for 2026-08-08..14 -- the per-million identity
// held on 78 of 78 rows and the lpCommissionUsd one on 0 of 78. Subtracting
// lpCommissionUsd overstated the weekly email's Total Revenue by 0.2-3.5%.
describe("deriveBaseRows revenue", () => {
  // A real row from that week: login 102226, Bilal Tahir Malik.
  const LIVE = {
    login: 102226,
    name: "Bilal Tahir Malik",
    lots: 378.42,
    markupRevenueUsd: 5621.44,
    clientCommissionUsd: 0,
    lpCommissionUsd: 1539.55,
    totalRevenueUsd: 3959.07,
    clientMillionsUsd: 166.2371,
    lpCommPerMillionRateUsd: 10,
    lpCommPerMillionUsd: 1662.37,
  };

  it("carries notional and the per-million cost", () => {
    const [row] = deriveBaseRows({ clientRevenueSummaries: [LIVE] });
    expect(row.millionsUsd).toBeCloseTo(166.2371, 4);
    expect(row.lpCommPerM).toBeCloseTo(1662.37, 2);
    expect(row.lpComm).toBeCloseTo(1539.55, 2);
  });

  it("prefers the backend's own Net Revenue", () => {
    const [row] = deriveBaseRows({ clientRevenueSummaries: [LIVE] });
    expect(row.totalRev).toBeCloseTo(3959.07, 2);
  });

  it("falls back to gross less the per-million cost, not less LP Commission", () => {
    const [row] = deriveBaseRows({ clientRevenueSummaries: [{ ...LIVE, totalRevenueUsd: 0 }] });
    // gross 5621.44 - perM 1662.37 = 3959.07, which is what the backend reports.
    expect(row.totalRev).toBeCloseTo(3959.07, 2);
    // The old behaviour subtracted lpCommissionUsd and read 4081.89 -- $122.82
    // high on this client alone.
    expect(row.totalRev).not.toBeCloseTo(4081.89, 2);
  });

  it("subtracts LP Commission only when no per-million figure exists", () => {
    const [row] = deriveBaseRows({
      clientRevenueSummaries: [{ ...LIVE, totalRevenueUsd: 0, lpCommPerMillionUsd: 0 }],
    });
    expect(row.totalRev).toBeCloseTo(4081.89, 2);
  });

  // The matches fallback carries no notional and no per-million commission.
  it("leaves notional and per-million cost at zero on the matches fallback", () => {
    const [row] = deriveBaseRows({
      matches: [{ clientLogin: 500, clientName: "B", clientVolume: 10, spreadRevenueUsd: 50, clientCommission: 0, lpCommission: -20 }],
    });
    expect(row.millionsUsd).toBe(0);
    expect(row.lpCommPerM).toBe(0);
    expect(row.totalRev).toBeCloseTo(30, 2);
  });
});
