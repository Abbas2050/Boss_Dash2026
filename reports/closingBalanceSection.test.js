// @vitest-environment node
//
// The Closing Balance section of the Weekly Business Summary.
import { describe, it, expect } from "vitest";
process.env.API_TOKEN = "stub";
const { aggregate, buildSummaryEmailHtml } = await import("./weeklyBusinessSummary.js");

const AGG = aggregate([
  { type: "deposit", psp: "bankwire", processedAmount: 1000, fromUserId: 1, processedAt: "2026-08-08 10:00:00" },
]);
for (const d of AGG.depositors) d.name = "Client 1";

// The live figures at the time this was written.
const CLOSING = {
  bankReceivable: 1_150_000,
  cryptoReceivable: 150_000,
  toLpsBank: 0,
  toLpsCrypto: 0,
  netAllCurrentBalance: 500_452.32,
  netAfterExpectedFunds: 1_800_452.32,
  differenceActualVsExpected: -1_300_000,
  creditByLps: 0,
};

const render = (closingBalance) =>
  buildSummaryEmailHtml({
    fromYmd: "2026-08-08",
    toYmd: "2026-08-14",
    agg: AGG,
    glance: { totalRevenue: 5000 },
    firstTimers: { rows: [], unverified: 0, checked: 0 },
    instruments: { rows: [], totalLots: 0, instrumentCount: 0 },
    equity: { withdrawable: null, gross: null },
    closingBalance,
  });

// Reads a KPI tile from the Closing Balance section by its label. Bounded to
// that section so a label reused elsewhere cannot be picked up by mistake, and
// bounded at the tile's own </td> so a tile with no note cannot borrow the next
// tile's note.
function tile(html, label, occurrence = 0) {
  const section = html.slice(
    html.indexOf('<p class="section-title">Closing Balance'),
    html.indexOf('<p class="section-title">Large Depositors'),
  );
  const marker = '<p class="kpi-label">' + label + "</p>";
  let start = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    start = section.indexOf(marker, start + 1);
    if (start === -1) return null;
  }
  const seg = section.slice(start, section.indexOf("</td>", start));
  const between = (needle) => {
    const at = seg.indexOf(needle);
    if (at === -1) return null;
    const open = seg.indexOf(">", at);
    return seg.slice(open + 1, seg.indexOf("<", open)).trim();
  };
  return { value: between("kpi-value"), note: between("kpi-note-sm") };
}
const amountFor = (html, label, occurrence = 0) => tile(html, label, occurrence)?.value ?? null;

describe("Closing Balance section", () => {
  const html = render(CLOSING);

  // Stacked on a phone, two tiles with the same label look like a bug.
  it("gives every tile a distinct label", () => {
    const section = html.slice(
      html.indexOf('<p class="section-title">Closing Balance'),
      html.indexOf('<p class="section-title">Large Depositors'),
    );
    const labels = [...section.matchAll(/kpi-label">([^<]*)</g)].map((m) => m[1]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("renders as tiles, like every other section", () => {
    const section = html.slice(
      html.indexOf('<p class="section-title">Closing Balance'),
      html.indexOf('<p class="section-title">Large Depositors'),
    );
    expect(section).toContain('class="kpis"');
    expect((section.match(/class="kpi-label"/g) || []).length).toBe(8);
  });

  it("shows every figure from the dashboard's closing balance", () => {
    expect(amountFor(html, "To be received in BANK")).toBe("$1,150,000.00");
    expect(amountFor(html, "To be received in CRYPTO")).toBe("$150,000.00");
    expect(tile(html, "To be deposited into LPs (Bank)")).toEqual({ value: "$0.00", note: "USD" });
    expect(tile(html, "To be deposited into LPs (Crypto)")).toEqual({ value: "$0.00", note: "USDT" });
    expect(amountFor(html, "Net all Current Balance")).toBe("$500,452.32");
    expect(amountFor(html, "Net Balance after expected funds")).toBe("$1,800,452.32");
    expect(amountFor(html, "Difference actual vs expected")).toBe("-$1,300,000.00");
    expect(amountFor(html, "Credit by LPs")).toBe("$0.00");
  });

  it("marks the section as a snapshot, not a weekly figure", () => {
    const heading = html.slice(html.indexOf('<p class="section-title">Closing Balance'), html.indexOf("</p>", html.indexOf('<p class="section-title">Closing Balance')));
    expect(heading).toContain("as at send time, not for the week");
  });

  it("says Net all Current Balance is not from the sheet", () => {
    expect(tile(html, "Net all Current Balance").note).toBe("summed from live PSP balances");
  });

  it("never renders an object into the copy", () => {
    expect(html).not.toContain("[object Object]");
  });

  // escapeHtml turns "&" into "&amp;", so an HTML entity written inside a
  // string that is later escaped renders literally as "&ndash;" to the reader.
  it("never double-escapes an HTML entity", () => {
    const doubled = html.match(/&amp;(nbsp|ndash|mdash|minus|rsquo|lsquo|amp|lt|gt|quot);/g);
    expect(doubled, `double-escaped entities: ${doubled?.join(", ")}`).toBeNull();
  });
});

describe("Closing Balance degradation", () => {
  it("says the source failed rather than showing zeros", () => {
    const html = render(null);
    expect(html).toContain("Closing balance unavailable");
    expect(amountFor(html, "To be received in BANK")).toBeNull();
  });

  it("still renders when the caller omits it entirely", () => {
    const html = buildSummaryEmailHtml({
      fromYmd: "2026-08-08",
      toYmd: "2026-08-14",
      agg: AGG,
      glance: { totalRevenue: null },
      instruments: { rows: [], totalLots: 0, instrumentCount: 0 },
    });
    expect(html).toContain("Closing Balance");
    expect(html).toContain("Closing balance unavailable");
  });

  it("renders a genuine zero as $0.00, not as unavailable", () => {
    const html = render({ ...CLOSING, bankReceivable: 0 });
    expect(amountFor(html, "To be received in BANK")).toBe("$0.00");
    expect(html).not.toContain("Closing balance unavailable");
  });
});
