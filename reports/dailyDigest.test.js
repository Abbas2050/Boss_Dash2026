import { describe, expect, it } from "vitest";

process.env.SUMMARY_LARGE_DEPOSIT_THRESHOLD = process.env.SUMMARY_LARGE_DEPOSIT_THRESHOLD || "1000";
const { aggregate } = await import("./summaryCore.js");
const { buildDailyDigestHtml } = await import("./dailyDigest.js");

const tx = (over = {}) => ({
  id: Math.random(), status: "approved", processedAt: "2026-08-30T09:00:00Z",
  processedCurrency: "USD", psp: "Skrill", ...over,
});

const AGG = aggregate([
  tx({ id: 1, type: "deposit", processedAmount: 5000, fromUserId: 1 }),
  tx({ id: 2, type: "deposit", processedAmount: 250, fromUserId: 2, psp: "Wire" }),
  tx({ id: 3, type: "withdrawal", processedAmount: 1200, fromUserId: 1 }),
  tx({ id: 4, type: "ib withdrawal", processedAmount: 90, fromUserId: 3, psp: "" }),
]);

const CLOSING = {
  bankReceivable: 11, cryptoReceivable: 22, toLpsBank: 33, toLpsCrypto: 44,
  netAllCurrentBalance: 55, netAfterExpectedFunds: 66,
  differenceActualVsExpected: 77, creditByLps: 88,
};

const INSTRUMENTS = {
  rows: [{ symbol: "XAUUSD", lots: 812.4, share: 61.2, clients: 12, variants: 2 }],
  totalLots: 812.4, instrumentCount: 1,
};

const base = (over = {}) => buildDailyDigestHtml({
  ymd: "2026-08-30",
  agg: AGG,
  glance: { totalRevenue: 41250.5 },
  instruments: INSTRUMENTS,
  closingBalance: CLOSING,
  notices: [],
  ...over,
});

describe("the daily digest renders its five sections", () => {
  const html = base();
  for (const title of [
    "Yesterday at a Glance",
    "Closing Balance",
    "Large Deposits",
    "Top Trading Instruments",
    "Money Movement by PSP",
  ]) {
    it(`includes "${title}"`, () => expect(html).toContain(title));
  }

  it("carries the six glance tiles the spec names, and no others", () => {
    for (const label of ["Net Flow", "Deposits", "Withdrawals", "Total Revenue", "Net Revenue", "Lots"]) {
      expect(html).toContain(label);
    }
  });

  it("names the day it covers in the subject line region", () => {
    expect(html).toContain("2026-08-30");
  });

  // The weekly report carries sections the daily deliberately drops. Their
  // presence would mean someone re-added them without reading the spec.
  it("omits the weekly-only sections", () => {
    expect(html).not.toContain("First-Time Depositors");
    expect(html).not.toContain("Account Activity");
    expect(html).not.toContain("Daily Flow");
    expect(html).not.toContain("Equity Position");
  });
});

describe("the daily digest has no charts", () => {
  // Charts cost render time on every send and a single day has no trend to
  // draw. This is the assertion that keeps that decision from eroding.
  it("emits no image markup at all", () => {
    const html = base();
    expect(html).not.toContain("<img");
    expect(html).not.toContain('<div class="ch-img"');
    expect(html).not.toContain("report-charts");
  });
});

describe("net revenue", () => {
  it("is total revenue less the IB rebate", () => {
    const html = base({ glance: { totalRevenue: 1000 } });
    // IB rebate in the fixture is 90, so net revenue is 910.
    expect(AGG.ibRebate).toBe(90);
    expect(html).toContain("$910.00");
  });

  it("renders as a dash when total revenue could not be fetched", () => {
    const html = base({ glance: { totalRevenue: null } });
    expect(html).toContain("&mdash;");
    expect(html).not.toContain("$0.00</div>");
  });
});

describe("degradation is reported, never rendered as a plausible zero", () => {
  it("says the wallet monitor did not respond rather than showing zeros", () => {
    const html = base({ closingBalance: null });
    expect(html).toMatch(/Closing balance unavailable/i);
    expect(html).not.toContain("To be received in BANK");
  });

  it("says top instruments are unavailable rather than showing an empty table as fact", () => {
    const html = base({
      instruments: { rows: [], totalLots: 0, instrumentCount: 0 },
      notices: ["Top Trading Instruments unavailable: HTTP 500"],
    });
    expect(html).toContain("Top Trading Instruments unavailable: HTTP 500");
  });

  it("surfaces every notice it is handed", () => {
    const html = base({ notices: ["first notice", "second notice"] });
    expect(html).toContain("first notice");
    expect(html).toContain("second notice");
  });
});

describe("HTML entities are written once, not twice", () => {
  // The weekly report shipped with a literal "&ndash;" in a reader's inbox
  // because an entity was passed through escapeHtml. Same guard here.
  it("contains no double-escaped entities", () => {
    const html = base({ notices: ["a & b"] });
    expect(html).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|middot);/);
  });

  it("still escapes a genuine ampersand from the data", () => {
    const html = base({ notices: ["Smith & Sons failed"] });
    expect(html).toContain("Smith &amp; Sons failed");
  });
});

describe("large deposits", () => {
  it("names the threshold and says the period is yesterday, not this week", () => {
    const html = base();
    expect(html).toContain("$1,000.00");
    expect(html).toMatch(/yesterday/i);
    expect(html).not.toMatch(/more than \$1,000\.00 this week/);
  });
});

describe("the footer states the real cadence", () => {
  // The digest now sends Tuesday-Saturday only. The footer used to claim it
  // sent every morning including weekends — a reader who got nothing on a
  // Monday would read the silence as a dead scheduler, exactly the confusion
  // that sentence exists to prevent. Guard against that claim coming back.
  it("makes no promise of weekend or every-day sending", () => {
    const html = base();
    expect(html).not.toMatch(/every morning, including weekends/i);
    expect(html).not.toMatch(/sent every morning/i);
  });
});

// ── credit given to clients ──────────────────────────────────────────────────
//
// Credit is a bonus, not cash. aggregate() has always bucketed it apart from
// deposits/withdrawals; before 2026-09-25 the digest never showed it, so the one
// number saying what the business gave away yesterday existed only in the
// footer's excluded line of a DIFFERENT report.
describe("credit given to clients", () => {
  const WITH_CREDIT = aggregate([
    tx({ id: 1, type: "deposit", processedAmount: 5000, fromUserId: 1 }),
    tx({ id: 2, type: "withdrawal", processedAmount: 1200, fromUserId: 1 }),
    tx({ id: 3, type: "credit", processedAmount: 300, fromUserId: 2 }),
    tx({ id: 4, type: "credit", processedAmount: 150, fromUserId: 3 }),
  ]);

  it("shows the credit total and how many credits made it", () => {
    const out = base({ agg: WITH_CREDIT });
    expect(out).toContain("Credit Given");
    expect(out).toContain("$450.00");
    expect(out).toMatch(/across 2 credits/);
  });

  it("keeps credit out of deposits, withdrawals and net flow", () => {
    // The tile must not change the money chain. Deposits - Withdrawals - IB
    // Rebate = Net Flow still holds, and none of the three moved by the $450.
    expect(WITH_CREDIT.deposits).toBe(5000);
    expect(WITH_CREDIT.withdrawals).toBe(1200);
    expect(WITH_CREDIT.netFlow).toBe(5000 - 1200 - 0);
    expect(WITH_CREDIT.excluded.find((e) => e.kind === "credit")).toEqual({
      kind: "credit",
      amount: 450,
      count: 2,
    });
  });

  it("never tints credit as cash", () => {
    // pos/cost are the classes the deposit and withdrawal tiles carry. Credit
    // wearing one would read as money in or out, which is the whole confusion
    // the note guards against.
    const out = base({ agg: WITH_CREDIT });
    const tile = out.slice(out.indexOf("Credit Given"), out.indexOf("Credit Given") + 400);
    expect(tile).not.toMatch(/kpi-value[^"]*\b(pos|cost)\b/);
    expect(tile).toMatch(/bonus\/credit, not cash/);
  });

  it("says so plainly on a day with no credit, rather than omitting the tile", () => {
    // A missing tile reads as "not measured"; $0.00 with a note reads as
    // "measured, and it was none".
    const out = base();
    expect(out).toContain("Credit Given");
    expect(out).toMatch(/none yesterday/);
  });
});
