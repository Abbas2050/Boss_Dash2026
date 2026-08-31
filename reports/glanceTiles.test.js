// @vitest-environment node
//
// The Last Week at a Glance tiles that count deposits and first-time depositors.
import { describe, it, expect } from "vitest";
process.env.API_TOKEN = "stub";
const { aggregate } = await import("./summaryCore.js");
const { buildSummaryEmailHtml } = await import("./weeklyBusinessSummary.js");

// Client 1 deposits three times, client 2 once. Withdrawals, IB movements,
// internal transfers and credits must NOT be counted as deposits.
const TX = [
  { type: "deposit", psp: "bankwire", processedAmount: 1000, fromUserId: 1, processedAt: "2026-08-08 10:00:00" },
  { type: "deposit", psp: "bankwire", processedAmount: 2000, fromUserId: 1, processedAt: "2026-08-09 10:00:00" },
  { type: "deposit", psp: "crypto", processedAmount: 500, fromUserId: 1, processedAt: "2026-08-10 10:00:00" },
  { type: "deposit", psp: "crypto", processedAmount: 800, fromUserId: 2, processedAt: "2026-08-11 10:00:00" },
  { type: "withdrawal", psp: "bankwire", processedAmount: -400, fromUserId: 1, processedAt: "2026-08-12 10:00:00" },
  { type: "ib withdrawal", psp: "", processedAmount: 300, fromUserId: 3, processedAt: "2026-08-12 11:00:00" },
  { type: "transfer in", psp: "", processedAmount: 900, fromUserId: 4, processedAt: "2026-08-13 10:00:00" },
  { type: "credit", psp: "", processedAmount: 50, fromUserId: 5, processedAt: "2026-08-13 11:00:00" },
];

// Reads one KPI tile by its label. Bounded at the tile's own </td> so a tile
// with no note can never pick up the next tile's note.
function tile(html, label) {
  const start = html.indexOf('<p class="kpi-label">' + label + "</p>");
  if (start === -1) return null;
  const seg = html.slice(start, html.indexOf("</td>", start));
  const between = (marker) => {
    const at = seg.indexOf(marker);
    if (at === -1) return null;
    const open = seg.indexOf(">", at);
    return seg.slice(open + 1, seg.indexOf("<", open)).trim();
  };
  return { value: between("kpi-value"), note: between("kpi-note-sm") };
}

describe("deposit count", () => {
  it("counts deposit transactions, not depositing clients", () => {
    const agg = aggregate(TX);
    expect(agg.depositCount).toBe(4); // four deposits from two clients
    expect(agg.depositors.length).toBe(3); // two depositors plus one IB-only
  });

  it("excludes withdrawals, IB, internal transfers and credits", () => {
    expect(aggregate([{ type: "withdrawal", processedAmount: -100, fromUserId: 1 }]).depositCount).toBe(0);
    expect(aggregate([{ type: "ib withdrawal", processedAmount: 100, fromUserId: 1 }]).depositCount).toBe(0);
    expect(aggregate([{ type: "transfer in", processedAmount: 100, fromUserId: 1 }]).depositCount).toBe(0);
    expect(aggregate([{ type: "credit", processedAmount: 100, fromUserId: 1 }]).depositCount).toBe(0);
  });
});

describe("glance tiles", () => {
  const agg = aggregate(TX);
  for (const d of agg.depositors) d.name = "Client " + d.userId;
  const firstTimers = {
    rows: [
      { userId: 2, name: "Client 2", deposits: 800, depositCount: 1 },
      { userId: 1, name: "Client 1", deposits: 3500, depositCount: 3 },
    ],
    unverified: 0,
    conflicts: 0,
    noCrmDate: 0,
    checked: 2,
  };
  const html = buildSummaryEmailHtml({
    fromYmd: "2026-08-08",
    toYmd: "2026-08-14",
    agg,
    glance: { totalRevenue: 5000 },
    firstTimers,
    instruments: { rows: [], totalLots: 0, instrumentCount: 0 },
  });

  it("Deposits shows the amount and how many deposits made it up", () => {
    expect(tile(html, "Deposits")).toEqual({ value: "$4,300.00", note: "across 4 deposits" });
  });

  it("First-Time Depositors leads with the amount, not the count", () => {
    expect(tile(html, "First-Time Depositors")).toEqual({
      value: "$4,300.00",
      note: "2 clients over 4 deposits",
    });
  });

  it("leaves the other tiles alone", () => {
    expect(tile(html, "Withdrawals").value).toBe("$400.00");
    expect(tile(html, "IB Rebate").value).toBe("$300.00");
    expect(tile(html, "Net Flow").value).toBe("$3,600.00");
  });

  it("says deposit, singular, when there is only one", () => {
    const one = aggregate([
      { type: "deposit", processedAmount: 250, fromUserId: 9, processedAt: "2026-08-08 10:00:00" },
    ]);
    for (const d of one.depositors) d.name = "Solo";
    const h = buildSummaryEmailHtml({
      fromYmd: "2026-08-08",
      toYmd: "2026-08-14",
      agg: one,
      glance: { totalRevenue: null },
      firstTimers: { rows: [{ userId: 9, name: "Solo", deposits: 250, depositCount: 1 }], unverified: 0, checked: 1 },
      instruments: { rows: [], totalLots: 0, instrumentCount: 0 },
    });
    expect(tile(h, "Deposits").note).toBe("across 1 deposit");
    expect(tile(h, "First-Time Depositors")).toEqual({ value: "$250.00", note: "1 client over 1 deposit" });
  });

  it("renders zero first-time depositors without breaking", () => {
    const h = buildSummaryEmailHtml({
      fromYmd: "2026-08-08",
      toYmd: "2026-08-14",
      agg,
      glance: { totalRevenue: null },
      instruments: { rows: [], totalLots: 0, instrumentCount: 0 },
    });
    expect(tile(h, "First-Time Depositors")).toEqual({ value: "$0.00", note: "0 clients over 0 deposits" });
  });
});
