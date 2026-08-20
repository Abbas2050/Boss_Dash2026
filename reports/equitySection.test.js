// @vitest-environment node
//
// The Equity Position section of the Weekly Business Summary.
import { describe, it, expect } from "vitest";
process.env.API_TOKEN = "stub";
const { aggregate, buildSummaryEmailHtml } = await import("./weeklyBusinessSummary.js");

const AGG = aggregate([
  { type: "deposit", psp: "bankwire", processedAmount: 1000, fromUserId: 1, processedAt: "2026-08-08 10:00:00" },
]);
for (const d of AGG.depositors) d.name = "Client 1";

// Shaped like the live payloads, with the identity that makes the notes true:
// equity minus credit equals withdrawable on both sides.
const EQUITY = {
  withdrawable: {
    lpEquity: 10_699_532.6,
    lpCredit: 5_900_500,
    lpWithdrawable: 4_799_032.6,
    clientWithdrawable: 6_339_054.85,
    difference: -1_540_022.25,
  },
  gross: {
    lpEquity: 10_706_808.27,
    lpCredit: 5_900_500,
    lpWithdrawable: 4_806_308.27,
    clientEquity: 6_846_646.06,
    clientCredit: 502_600,
    clientWithdrawable: 6_344_046.06,
    difference: 3_860_162.21,
  },
};

const render = (equity) =>
  buildSummaryEmailHtml({
    fromYmd: "2026-08-08",
    toYmd: "2026-08-14",
    agg: AGG,
    glance: { totalRevenue: 5000 },
    firstTimers: { rows: [], unverified: 0, checked: 0 },
    instruments: { rows: [], totalLots: 0, instrumentCount: 0 },
    equity,
  });

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

describe("Equity Position section", () => {
  const html = render(EQUITY);

  it("renders all six tiles", () => {
    for (const label of [
      "LP Withdrawable Equity",
      "Client Withdrawable Equity",
      "LP-Client WD Difference",
      "LP Equity (incl. credit)",
      "Client Equity (incl. credit)",
      "LP-Client Equity Difference",
    ]) {
      expect(tile(html, label), `missing tile: ${label}`).not.toBeNull();
    }
  });

  it("states the LP formula with figures that reconcile", () => {
    const t = tile(html, "LP Withdrawable Equity");
    expect(t.value).toBe("$4,799,032.60");
    expect(t.note).toBe("$10,699,532.60 equity less $5,900,500.00 credit");
    // The note is only honest if the arithmetic holds.
    expect(EQUITY.withdrawable.lpEquity - EQUITY.withdrawable.lpCredit).toBeCloseTo(
      EQUITY.withdrawable.lpWithdrawable,
      2,
    );
  });

  it("shows the credit inside each gross tile", () => {
    expect(tile(html, "LP Equity (incl. credit)")).toEqual({
      value: "$10,706,808.27",
      note: "includes $5,900,500.00 credit",
    });
    expect(tile(html, "Client Equity (incl. credit)")).toEqual({
      value: "$6,846,646.06",
      note: "includes $502,600.00 credit",
    });
  });

  it("keeps the two differences opposite in sign, as the live data is", () => {
    expect(tile(html, "LP-Client WD Difference").value).toBe("-$1,540,022.25");
    expect(tile(html, "LP-Client Equity Difference").value).toBe("$3,860,162.21");
  });

  it("marks the section as a snapshot, not a weekly figure", () => {
    expect(html).toContain("as at send time, not for the week");
  });

  it("never renders an object into the copy", () => {
    expect(html).not.toContain("[object Object]");
  });
});

describe("Equity Position degradation", () => {
  it("says which source failed instead of showing zeros", () => {
    const html = render({ withdrawable: null, gross: EQUITY.gross });
    expect(html).toContain("Withdrawable equity unavailable");
    expect(tile(html, "LP Withdrawable Equity")).toBeNull();
    // The half that worked still renders.
    expect(tile(html, "LP Equity (incl. credit)").value).toBe("$10,706,808.27");
  });

  it("degrades both rows when neither source responds", () => {
    const html = render({ withdrawable: null, gross: null });
    expect(html).toContain("Withdrawable equity unavailable");
    expect(html).toContain("Credit-inclusive equity unavailable");
    expect(html).not.toContain("$0.00 equity less");
  });

  it("still renders when the caller omits equity entirely", () => {
    const html = buildSummaryEmailHtml({
      fromYmd: "2026-08-08",
      toYmd: "2026-08-14",
      agg: AGG,
      glance: { totalRevenue: null },
      instruments: { rows: [], totalLots: 0, instrumentCount: 0 },
    });
    expect(html).toContain("Equity Position");
    expect(html).toContain("unavailable");
  });
});
