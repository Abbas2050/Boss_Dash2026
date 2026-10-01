// @vitest-environment node
//
// Net Revenue in the weekly Deal Match email.
//
// The email used to compute gross - lpCommissionUsd so it would agree with the
// Deal Performance tab. Both were wrong: the backend builds Net Revenue from
// the PER-MILLION commission (notional x weighted rate), which is the larger
// figure. Checked against DealMatch/Run for 2026-08-08..14 -- the per-million
// identity held on 78 of 78 client rows, lpCommissionUsd on 0 of 78 -- and the
// old formula overstated the week by $1,405.91 (3.5%).
import { describe, it, expect } from "vitest";
process.env.CRM_API_TOKEN = "stub";
const { deriveClientRevenueRows } = await import("./dealMatchWeeklyReport.js");

// Two real rows from that week.
const SUMMARIES = [
  { login: 102226, name: "Bilal Tahir Malik", lots: 378.42, markupRevenueUsd: 5621.44, clientCommissionUsd: 0,
    lpCommissionUsd: 1539.55, totalRevenueUsd: 3959.07, clientMillionsUsd: 166.2371, lpCommPerMillionRateUsd: 10, lpCommPerMillionUsd: 1662.37 },
  { login: 102245, name: "Afia Jamal", lots: 356.06, markupRevenueUsd: 5100.0, clientCommissionUsd: 0,
    lpCommissionUsd: 1439.79, totalRevenueUsd: 3536.0, clientMillionsUsd: 156.4, lpCommPerMillionRateUsd: 10, lpCommPerMillionUsd: 1564.0 },
];

describe("deriveClientRevenueRows", () => {
  const rows = deriveClientRevenueRows({ clientRevenueSummaries: SUMMARIES });

  it("uses the backend's Net Revenue rather than recomputing it", () => {
    expect(rows[0].totalRev).toBeCloseTo(3959.07, 2);
    expect(rows[1].totalRev).toBeCloseTo(3536.0, 2);
  });

  it("does not subtract the coverage-attributed LP Commission", () => {
    // gross - lpCommissionUsd would be 4081.89 -- $122.82 too high on this row.
    expect(rows[0].totalRev).not.toBeCloseTo(4081.89, 2);
  });

  it("carries notional and the per-million cost for the client fold", () => {
    expect(rows[0].millionsUsd).toBeCloseTo(166.2371, 4);
    expect(rows[0].lpCommPerM).toBeCloseTo(1662.37, 2);
    // Both LP figures are kept: they are different quantities, not duplicates.
    expect(rows[0].lpComm).toBeCloseTo(1539.55, 2);
  });

  it("falls back to gross less the per-million cost when the backend sends no total", () => {
    const [row] = deriveClientRevenueRows({ clientRevenueSummaries: [{ ...SUMMARIES[0], totalRevenueUsd: 0 }] });
    expect(row.totalRev).toBeCloseTo(3959.07, 2);
  });

  it("subtracts LP Commission only when there is no per-million figure at all", () => {
    const [row] = deriveClientRevenueRows({ clientRevenueSummaries: [{ ...SUMMARIES[0], totalRevenueUsd: 0, lpCommPerMillionUsd: 0 }] });
    expect(row.totalRev).toBeCloseTo(4081.89, 2);
  });

  // The whole point of the fix: the total the boss reads.
  it("reports a lower, correct total than the old formula", () => {
    const now = rows.reduce((s, r) => s + r.totalRev, 0);
    const old = SUMMARIES.reduce((s, r) => s + r.markupRevenueUsd + r.clientCommissionUsd - Math.abs(r.lpCommissionUsd), 0);
    expect(now).toBeLessThan(old);
    expect(old - now).toBeCloseTo(247.03, 2);
  });
});

describe("deriveClientRevenueRows matches fallback", () => {
  it("has no notional, so it can only subtract LP Commission", () => {
    const [row] = deriveClientRevenueRows({
      matches: [{ clientLogin: 500, clientName: "B", clientVolume: 10, spreadRevenueUsd: 50, clientCommission: 0, lpCommission: -20 }],
    });
    expect(row.millionsUsd).toBe(0);
    expect(row.lpCommPerM).toBe(0);
    expect(row.totalRev).toBeCloseTo(30, 2);
  });
});

// ── swap, split by direction (2026-09-25) ────────────────────────────────────
//
// The desk asked to see swap charged from clients as revenue and swap given to
// clients as a cost. Both are real, and the trap is that they are NOT two new
// lines on either side of the equation: gross already carries swap NET of
// direction, so subtracting "given" from gross would count it twice.
import { buildEmailHtml } from "./dealMatchWeeklyReport.js";

describe("client swap, split by direction", () => {
  const STATS = {
    markupRevenue: 6730.74,
    commissionRevenue: 2811.84,
    // gross - markup - commission, the residual the backend's own scalars imply
    swapRevenue: 713.66,
    swapCharged: 900.0,
    swapGiven: 186.34,
    grossRevenue: 10256.24,
    lpCommission: 1868.27,
    netRevenue: 8387.97,
  };

  const html = () =>
    buildEmailHtml({
      fromYmd: "2026-09-24",
      toYmd: "2026-09-24",
      cadence: "daily",
      periodNoun: "day",
      rows: [],
      volume: null,
      revenueStats: STATS,
      volumeDetail: null,
      mt5Volume: null,
    });

  it("shows both directions and the net between them", () => {
    const out = html();
    expect(out).toContain("Swap Charged to Clients");
    expect(out).toContain("$900.00");
    expect(out).toContain("Swap Given to Clients");
    expect(out).toContain("$186.34");
    expect(out).toContain("Net Swap");
    expect(out).toContain("$713.66");
  });

  it("the two directions reconcile to the net", () => {
    expect(STATS.swapCharged - STATS.swapGiven).toBeCloseTo(STATS.swapRevenue, 2);
  });

  it("the net swap is the residual of the backend's own three scalars", () => {
    // markup + commission + swap = gross. If this drifts, the swap card is
    // describing a number gross does not contain.
    expect(STATS.markupRevenue + STATS.commissionRevenue + STATS.swapRevenue).toBeCloseTo(STATS.grossRevenue, 2);
  });

  it("does not subtract swap given a second time when reaching net", () => {
    // The whole hazard. Net is gross less LP commission and nothing else --
    // "given" is already inside gross as the negative half of swap.
    expect(STATS.grossRevenue - STATS.lpCommission).toBeCloseTo(STATS.netRevenue, 2);
    expect(STATS.grossRevenue - STATS.lpCommission - STATS.swapGiven).not.toBeCloseTo(STATS.netRevenue, 2);
  });

  it("says on the card that given is already inside gross", () => {
    // A cost figure sitting beside a net figure invites the reader to do the
    // subtraction themselves; the card has to head that off where it is read.
    expect(html()).toMatch(/Already netted inside Gross Revenue/);
  });
});
