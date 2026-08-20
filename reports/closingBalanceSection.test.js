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

// Pulls the Amount cell for a labelled row inside the Closing Balance table.
function amountFor(html, label) {
  const section = html.slice(
    html.indexOf('<p class="section-title">Closing Balance'),
    html.indexOf('<p class="section-title">Large Depositors'),
  );
  const at = section.indexOf(label);
  if (at === -1) return null;
  const row = section.slice(at, section.indexOf("</tr>", at));
  const amountCell = row.indexOf('data-label="Amount"');
  if (amountCell === -1) return null;
  const valueStart = row.indexOf('class="val', amountCell);
  const open = row.indexOf(">", valueStart);
  return row.slice(open + 1, row.indexOf("<", open)).trim();
}

describe("Closing Balance section", () => {
  const html = render(CLOSING);

  it("shows every figure from the dashboard's closing balance", () => {
    expect(amountFor(html, "To be received in BANK")).toBe("$1,150,000.00");
    expect(amountFor(html, "To be received in CRYPTO")).toBe("$150,000.00");
    expect(amountFor(html, "To be deposited into LPs (Bank – USD)")).toBe("$0.00");
    expect(amountFor(html, "To be deposited into LPs (Crypto USDT)")).toBe("$0.00");
    expect(amountFor(html, "Net all Current Balance")).toBe("$500,452.32");
    expect(amountFor(html, "Net Balance after expected funds")).toBe("$1,800,452.32");
    expect(amountFor(html, "Difference between actual and expected")).toBe("-$1,300,000.00");
    expect(amountFor(html, "Credit by LPs")).toBe("$0.00");
  });

  it("marks the section as a snapshot, not a weekly figure", () => {
    const heading = html.slice(html.indexOf('<p class="section-title">Closing Balance'), html.indexOf("</p>", html.indexOf('<p class="section-title">Closing Balance')));
    expect(heading).toContain("as at send time, not for the week");
  });

  it("says Net all Current Balance is not from the sheet", () => {
    expect(html).toContain("live PSP balances, not the sheet");
  });

  it("points at where the figures are maintained", () => {
    expect(html).toContain("Google Sheet Mapping");
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
