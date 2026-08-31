import { describe, expect, it } from "vitest";

const { aggregate } = await import("./summaryCore.js");
const { buildMonthlyReviewHtml, pctChange, fmtPct, weekBuckets } = await import("./monthlyReview.js");

// ─── month-over-month arithmetic ─────────────────────────────────────────────
// The naive formula (current - prior) / prior reports an improvement as a
// decline the moment prior is negative: net flow going from -100 to +50 comes
// out as -150%. Dividing by the MAGNITUDE of prior gets the direction right.

describe("pctChange", () => {
  it("reports a plain increase", () => expect(pctChange(150, 100)).toBeCloseTo(50));
  it("reports a plain decrease", () => expect(pctChange(50, 100)).toBeCloseTo(-50));
  it("reports no change as zero", () => expect(pctChange(100, 100)).toBe(0));

  it("reads a negative-to-positive swing as an improvement, not a collapse", () => {
    // -100 -> +50 is unambiguously better. (current - prior) / prior would say
    // -150%; dividing by |prior| says +150%.
    expect(pctChange(50, -100)).toBeCloseTo(150);
  });

  it("reads a positive-to-negative swing as a decline", () => {
    expect(pctChange(-50, 100)).toBeCloseTo(-150);
  });

  it("returns null when the prior month was zero", () => {
    // Any percentage against a zero base is either infinite or invented. The
    // renderer shows a dash and the figure itself still appears in its column.
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
    expect(pctChange(-100, 0)).toBeNull();
  });

  it("returns null when either side is missing or not a number", () => {
    expect(pctChange(100, null)).toBeNull();
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, undefined)).toBeNull();
    expect(pctChange(Number.NaN, 100)).toBeNull();
    expect(pctChange(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("fmtPct", () => {
  it("signs an increase", () => expect(fmtPct(50)).toBe("+50.0%"));
  it("signs a decrease", () => expect(fmtPct(-50)).toBe("-50.0%"));
  it("renders no change without a sign", () => expect(fmtPct(0)).toBe("0.0%"));
  it("renders an unavailable comparison as a dash, never as 0.0%", () => {
    expect(fmtPct(null)).toBe("&mdash;");
  });
});

// ─── week-by-week breakdown ──────────────────────────────────────────────────

const day = (d, deposits, withdrawals, ibRebate = 0) => ({ day: d, deposits, withdrawals, ibRebate });

describe("weekBuckets", () => {
  // August 2026: the 1st is a Saturday, so the month starts on a week boundary.
  const august = [
    day("2026-08-01", 100, 10),
    day("2026-08-05", 200, 20),
    day("2026-08-07", 300, 30), // Friday - still week 1
    day("2026-08-08", 400, 40), // Saturday - week 2
    day("2026-08-14", 500, 50),
    day("2026-08-31", 600, 60, 5), // Monday - a partial final week
  ];

  it("groups days into Saturday-to-Friday weeks, matching the weekly report", () => {
    const rows = weekBuckets(august);
    expect(rows.map((r) => r.start)).toEqual(["2026-08-01", "2026-08-08", "2026-08-29"]);
  });

  it("sums each week from its own days", () => {
    const [first] = weekBuckets(august);
    expect(first.deposits).toBe(600);
    expect(first.withdrawals).toBe(60);
  });

  // The breakdown must never disagree with the headline it sits under.
  it("sums to the month total on every column", () => {
    const rows = weekBuckets(august);
    const total = (key) => rows.reduce((s, r) => s + r[key], 0);
    expect(total("deposits")).toBe(2100);
    expect(total("withdrawals")).toBe(210);
    expect(total("ibRebate")).toBe(5);
    expect(total("net")).toBe(2100 - 210 - 5);
  });

  it("orders weeks chronologically", () => {
    const rows = weekBuckets([...august].reverse());
    expect(rows.map((r) => r.start)).toEqual(["2026-08-01", "2026-08-08", "2026-08-29"]);
  });

  it("returns nothing for a month with no movement", () => {
    expect(weekBuckets([])).toEqual([]);
  });

  it("handles a month that does not start on a Saturday", () => {
    // September 2026 starts on a Tuesday, so the first bucket opens on the
    // preceding Saturday (29 Aug) and holds only the September days present.
    const rows = weekBuckets([day("2026-09-01", 10, 1), day("2026-09-05", 20, 2), day("2026-09-06", 30, 3)]);
    expect(rows.map((r) => r.start)).toEqual(["2026-08-29", "2026-09-05"]);
    // 1 Sep is a Tuesday, so it lands in the week opening Sat 29 Aug on its
    // own; 5 Sep is the next Saturday and opens the second week with 6 Sep.
    expect(rows[0].deposits).toBe(10);
    expect(rows[1].deposits).toBe(50);
  });
});

// ─── the rendered email ──────────────────────────────────────────────────────

const tx = (o) => ({ status: "approved", processedAt: "2026-08-10T09:00:00Z", processedCurrency: "USD", psp: "Skrill", ...o });
const AGG = aggregate([
  tx({ id: 1, type: "deposit", processedAmount: 5000, fromUserId: 1 }),
  tx({ id: 2, type: "withdrawal", processedAmount: 1200, fromUserId: 1, processedAt: "2026-08-18T09:00:00Z" }),
  tx({ id: 3, type: "ib withdrawal", processedAmount: 90, fromUserId: 3, psp: "", processedAt: "2026-08-25T09:00:00Z" }),
]);

const base = (over = {}) => buildMonthlyReviewHtml({
  fromYmd: "2026-08-01",
  toYmd: "2026-08-31",
  monthLabel: "August 2026",
  agg: AGG,
  glance: { totalRevenue: 40000 },
  firstTimers: { rows: [], unverified: 0, checked: 0 },
  instruments: { rows: [], totalLots: 500, instrumentCount: 0 },
  equity: { withdrawable: null, gross: null },
  closingBalance: null,
  chartUrl: null,
  prior: { monthLabel: "July 2026", deposits: 4000, withdrawals: 1000, netFlow: 2900, totalRevenue: 20000, netRevenue: 19910, lots: 250 },
  notices: [],
  ...over,
});

describe("the monthly review", () => {
  const html = base();

  it("names the month it covers", () => {
    expect(html).toContain("August 2026");
  });

  it("carries the weekly report's sections", () => {
    for (const title of [
      "Equity Position",
      "Closing Balance",
      "Large Depositors",
      "First-Time Depositors",
      "Top Trading Instruments",
      "Account Activity",
      "Money Movement by PSP",
    ]) {
      expect(html).toContain(title);
    }
  });

  it("says month, not week, in the copy it inherits", () => {
    expect(html).toContain("during the month");
    expect(html).not.toContain("during the week");
    expect(html).not.toContain("this week");
  });

  it("adds the two sections only a month can show", () => {
    expect(html).toContain("Month over Month");
    expect(html).toContain("Week by Week");
    expect(html).toContain("July 2026");
  });

  it("shows each headline figure against the prior month", () => {
    // Deposits 5,000 against 4,000 is +25.0%.
    expect(html).toContain("+25.0%");
    // Total revenue 40,000 against 20,000 is +100.0%.
    expect(html).toContain("+100.0%");
  });

  it("keeps its charts", () => {
    const withChart = base({ chartUrl: "https://example.test/c.png" });
    expect(withChart).toContain("https://example.test/c.png");
  });
});

describe("the monthly review degrades honestly", () => {
  it("renders dashes, not zeros, when the prior month could not be fetched", () => {
    const html = base({ prior: null });
    expect(html).toMatch(/prior month unavailable/i);
    expect(html).not.toContain("+0.0%");
  });

  it("surfaces every notice it is handed", () => {
    const html = base({ notices: ["DealMatch unavailable: HTTP 500"] });
    expect(html).toContain("DealMatch unavailable: HTTP 500");
  });

  it("contains no double-escaped entities", () => {
    const html = base({ notices: ["a & b"] });
    expect(html).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|middot);/);
  });
});
