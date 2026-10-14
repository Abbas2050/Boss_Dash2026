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

// ── reading a Notional cell, now that it carries a per-million bracket ──────
//
// The value is `FIGURE <span class="perm">(NET net · LP LP per M)</span>`
// inside the cell's own `<span class="val">`, so a capture that stops at the
// first "<" no longer reaches the end of it. These read the whole value and
// split it the way a reader does: the figure, then the small aside.
const notionalValues = (html) =>
  [...html.matchAll(/data-label="Notional \(M USD\)"[^>]*>.*?<span class="val[^"]*">(.*?)<\/span><\/td>/g)]
    .map((m) => m[1]);
const plainText = (v) =>
  String(v).replace(/<[^>]*>/g, "").replace(/&middot;/g, "·").replace(/&mdash;/g, "—").trim();
// undefined in, undefined out: several tests assert a card is ABSENT.
const figureOf = (v) => (v == null ? undefined : plainText(v).split("(")[0].trim());
const bracketOf = (v) => {
  if (v == null) return undefined;
  const t = plainText(v);
  const at = t.indexOf("(");
  return at < 0 ? "" : t.slice(at);
};

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

// ── Notional in USD millions, in the client table (2026-10-14) ──────────────
//
// "in Daily Deal Match Analysis report lets add the volume in millions also."
//
// The figure was already on every row as millionsUsd, derived from the
// backend's clientMillionsUsd -- the notional the per-million LP commission is
// charged against, and so the basis of Net Revenue. Nothing new is fetched;
// these tests pin that it is actually surfaced, and that the TOTAL row sums it.
//
// The trap this guards: `totals` is a reduce with an explicit seed, so a cell
// rendered from `totals.millionsUsd` with no matching seed key and no matching
// accumulate line renders a confident "0.00" rather than throwing.
describe("notional (M USD) in the client revenue table", () => {
  // Built from the real summaries above, so the whole path from the backend's
  // clientMillionsUsd to the rendered cell is under test, not a hand-made row.
  const ROWS = deriveClientRevenueRows({ clientRevenueSummaries: SUMMARIES }).map((row) => ({
    ...row,
    accounts: [row.login],
    rebateWithdrawn: 0,
    netRev: row.totalRev,
  }));

  const render = (rows = ROWS, extra = {}) =>
    buildEmailHtml({
      fromYmd: "2026-08-08",
      toYmd: "2026-08-14",
      rows,
      volume: null,
      ...extra,
    });

  // Pulls the value out of each Notional cell in document order. The TOTAL row
  // sits at the TOP of <tbody> (a <tfoot> always renders last, which would put
  // the headline below every client), so index 0 is the total.
  const notionalCells = (html) => notionalValues(html).map(figureOf);
  const notionalBrackets = (html) => notionalValues(html).map(bracketOf);

  it("shows each client's own notional on its row", () => {
    // Not the total repeated: 166.24 and 156.40 are different figures, and a
    // cell rendered from `totals` instead of `row` would print 322.64 twice.
    expect(notionalCells(render()).slice(1)).toEqual(["166.24", "156.40"]);
  });

  it("totals the notional from the unrounded rows", () => {
    const cells = notionalCells(render());
    // The backend sends notional to 4 dp (166.2371), so the TOTAL has to sum
    // the unrounded values and round once -- not sum the 2 dp displays. Same
    // treatment every money column in this table already gets.
    const unrounded = SUMMARIES.reduce((acc, s) => acc + s.clientMillionsUsd, 0);
    expect(unrounded).toBeCloseTo(322.6371, 4);
    expect(cells[0]).toBe("322.64");
    // The arithmetic the reader does by eye still has to come out, to within
    // the half-cent per row that independent rounding can cost.
    const eyeSum = cells.slice(1).reduce((acc, v) => acc + Number(v), 0);
    expect(Math.abs(eyeSum - Number(cells[0]))).toBeLessThanOrEqual(0.005 * (cells.length - 1));
  });

  it("does not leave the total at zero when the rows carry a figure", () => {
    // The specific failure an unseeded or unaccumulated key produces.
    expect(notionalCells(render())[0]).not.toBe("0.00");
  });

  it("does not total lots into the notional column", () => {
    // 734.48 is the lots total. The two columns measure the same flow in
    // different units and are trivially easy to cross-wire in the reducer.
    const cells = notionalCells(render());
    expect(cells[0]).not.toBe("734.48");
    expect(cells[0]).toBe("322.64");
  });

  it("renders a small notional rather than rounding it away", () => {
    // 0.07 million is $70k of notional -- small beside a 166-million client,
    // but a real row, and 2 dp is what keeps it from reading as nothing. This
    // is why the column is fmtNum(_, 2) and not whole millions.
    const [small] = deriveClientRevenueRows({
      clientRevenueSummaries: [{ ...SUMMARIES[0], clientMillionsUsd: 0.0712 }],
    });
    const html = render([{ ...small, accounts: [small.login], rebateWithdrawn: 0, netRev: small.totalRev }]);
    expect(notionalCells(html).slice(1)).toEqual(["0.07"]);
  });

  it("carries the unit in the label and leaves the value as bare digits", () => {
    const html = render();
    // dataCell repeats the label inside every cell, so the unit reaches a
    // phone reader without being stamped on each figure.
    expect(html).toContain('<span class="lbl">Notional (M USD)</span>');
    // No "$" and no "M" on the value: among money columns a "$166.24" would
    // read as dollars rather than as 166 million dollars of notional.
    expect(notionalCells(html)).not.toContain("$166.24");
    expect(notionalCells(html)).not.toContain("166.24 M");
  });

  it("keeps the header row and the empty-state colspan at the same width", () => {
    // The column count lives in three places: the body cells, the <th> list
    // (inert, since thead is display:none, but it documents the columns) and
    // the empty-state colspan. A colspan left at 9 is invisible until a day
    // with no rows at all.
    const table = render([]).match(/<table class="data">[\s\S]*?<\/table>/)[0];
    const headers = [...table.matchAll(/<th /g)].length;
    expect(headers).toBe(10);
    expect(table).toContain(`colspan="${headers}"`);
  });

  it("puts notional on the summary tile beside lots", () => {
    // The row-derived KPI deck, which renders when whole-run revenueStats are
    // not supplied. Both volume units belong together there.
    const html = render(ROWS, { revenueStats: null });
    expect(html).toContain('<p class="kpi-label">Total Lots (deals)</p>');
    expect(html).toContain('<p class="kpi-label">Notional (M USD)</p>');
    expect(figureOf((html.match(/kpi-label">Notional \(M USD\)<\/p>\s*<p class="kpi-value">([\s\S]*?)<\/p>/) || [])[1])).toBe("322.64");
  });

  it("appears in all three cadences, since one renderer builds them all", () => {
    // The request named the daily report. This module renders daily, weekly
    // and monthly from the same builder, so the column lands in all three --
    // intended, and recorded here so it is not read later as a regression.
    for (const cadence of ["daily", "weekly", "monthly"]) {
      expect(notionalCells(render(ROWS, { cadence }))[0]).toBe("322.64");
    }
  });
});

// ── Notional (M USD) as a CARD near the top of the email (2026-10-15) ───────
//
// The column shipped yesterday and the top of the email was then checked for
// this figure, which was not there -- the column is correct, it is just far
// down the page. A card is what was wanted.
//
// The previous commit refused a card deliberately, and the refusal was right
// at the time: there is no whole-run notional scalar (docs/dealing-reporting.md
// lists the lite=true fields and none of them is one), so a card could only be
// the per-client row sum, and this email's KPIs HAD once been row sums -- they
// reported $389.74 against the tab's $10,256.24, which is why the warning is
// still in sendDealMatchReport.
//
// What overturned it, measured on the delivered 2026-10-13 report: the table
// listed 30 rows, the header badge said "30 active clients", and the Lots
// column totalled 400.07 -- the same figure as that email's whole-run TOTAL
// MT5 DEALS card, which is the backend's own scalar and NOT a row sum. A table
// listing only some clients could not have reached it, so the rows are the
// whole population and summing notional over them is sound.
//
// So these tests pin the two things that can now go wrong: the card
// disappearing, and the card disagreeing with the TOTAL row a reader will
// check it against.
describe("notional (M USD) as a card near the top of the email", () => {
  const ROWS = deriveClientRevenueRows({ clientRevenueSummaries: SUMMARIES }).map((row) => ({
    ...row,
    accounts: [row.login],
    rebateWithdrawn: 0,
    netRev: row.totalRev,
  }));

  // Whole-run figures off DealMatch/Run. Their presence is what selects the
  // hero + card decks over the row-derived KPI tiles.
  const STATS = {
    markupRevenue: 6730.74, commissionRevenue: 2811.84, swapRevenue: 713.66,
    swapCharged: 900.0, swapGiven: 186.34,
    grossRevenue: 10256.24, lpCommission: 1868.27, netRevenue: 8387.97,
  };

  const render = (extra = {}) =>
    buildEmailHtml({
      fromYmd: "2026-08-08",
      toYmd: "2026-08-14",
      rows: ROWS,
      volume: null,
      revenueStats: STATS,
      ...extra,
    });

  // The card is an rptCard: an uppercase label div, then the figure at 20px.
  // Deliberately NOT matched by class -- rptCard styles inline, and Outlook
  // rewrites class names with an x_ prefix anyway.
  const cardValue = (html) =>
    (html.match(/uppercase;color:#64748b">Notional \(M USD\)<\/div>\s*<div style="font:800 20px[^"]*">([\s\S]*?)<\/div>/) || [])[1];
  const card = (html) => figureOf(cardValue(html));
  const cardBracket = (html) => bracketOf(cardValue(html));

  // The table's TOTAL (listed clients) row. It sits at the TOP of <tbody>, so
  // the first Notional data cell in document order is the total.
  const totalRow = (html) => figureOf(notionalValues(html)[0]);
  const totalRowBracket = (html) => bracketOf(notionalValues(html)[0]);
  // The row-derived KPI tile, the branch that renders when whole-run stats are
  // absent.
  const tileValue = (html) =>
    (html.match(/kpi-label">Notional \(M USD\)<\/p>\s*<p class="kpi-value">([\s\S]*?)<\/p>/) || [])[1];

  it("renders the card when the whole-run revenue deck is present", () => {
    // The deck that is whole-run by contract is exactly the case the figure
    // used to be left out of, so it is the case worth pinning.
    expect(card(render())).toBe("322.64");
  });

  it("shows the card above the client table, not only inside it", () => {
    // The whole point of the request: visible without scrolling to the table.
    const html = render();
    expect(html.indexOf('<table class="data">')).toBeGreaterThan(
      html.indexOf('">Notional (M USD)</div>'),
    );
  });

  it("shows the same number on the card as in the TOTAL (listed clients) row", () => {
    // Both read one pre-formatted const. A reader checks one against the other,
    // so a second fmtNum() call anywhere here is a bug waiting to diverge.
    const html = render();
    expect(card(html)).toBe(totalRow(html));
    expect(card(html)).toBe("322.64");
  });

  it("cannot be computed from a different total than the TOTAL row", () => {
    // Fed a row set the reducer must follow, the card has to move with it. A
    // card built from its own sum -- unfiltered rows, the first row, a
    // hard-coded figure -- would hold still or disagree here.
    const html = render({ rows: [ROWS[0]] });
    expect(card(html)).toBe("166.24");
    expect(card(html)).toBe(totalRow(html));
    expect(card(html)).not.toBe("322.64");
  });

  it("sums notional and not lots", () => {
    // 734.48 is this fixture's lots total. The two columns measure the same
    // flow in different units and are trivially easy to cross-wire.
    expect(card(render())).not.toBe("734.48");
    expect(card(render())).toBe("322.64");
  });

  it("keeps the millions scale the label promises", () => {
    // The backend already reports millions, so there is nothing to convert.
    // A stray x1e6 or /1000 renders a figure that is still plausible on a
    // card, which is why the scale is pinned rather than just the digits.
    const value = card(render());
    expect(value).toBe("322.64");
    expect(value).not.toMatch(/322,637,100/);
    expect(value).not.toBe("0.32");
    expect(value).not.toBe("322,637.10");
  });

  it("says on the card that it is a row sum, not a whole-run figure", () => {
    // Its neighbours in this part of the email are whole-run scalars. The card
    // sits beside them and must not be read as one of them.
    const html = render();
    expect(html).toContain("summed across the 2 client rows below, not a whole-run scalar");
    expect(html).toMatch(/Summed over the 2 listed clients/);
    expect(html).toMatch(/the same figure as the TOTAL \(listed clients\) row below/);
  });

  it("uses the column's own label, and leaves the unit off the figure", () => {
    // Same label as the table column and as the dashboard's clientMillionsUsd,
    // so the card and the row are visibly the same quantity.
    expect(render()).toContain('">Notional (M USD)</div>');
    // No "$" and no "M" on the FIGURE: among money cards a "$322.64" would
    // read as dollars rather than as 322 million dollars of notional. The
    // per-million bracket beside it is money and does carry "$" -- that is
    // the point of it, and it is 10px and muted so the two do not compete.
    expect(card(render())).not.toMatch(/[$M]/);
    expect(cardBracket(render())).toMatch(/^\(\$/);
  });

  it("prints the figure once above the table, not once per deck", () => {
    // The row-derived KPI tile carries this figure too. Rendering both decks
    // would put the same number on screen twice before the table.
    const html = render();
    const above = html.slice(0, html.indexOf('<table class="data">'));
    expect([...above.matchAll(/Notional \(M USD\)/g)]).toHaveLength(1);
  });

  it("still shows it when there are no whole-run stats, on the row-derived deck", () => {
    // The other branch, unchanged by this commit except that it now reads the
    // same const. One figure, one source, either way.
    const html = render({ revenueStats: null });
    expect(card(html)).toBeUndefined();
    expect(figureOf(tileValue(html))).toBe("322.64");
    expect(totalRow(html)).toBe("322.64");
  });

  it("appears in all three cadences, since one renderer builds them all", () => {
    for (const cadence of ["daily", "weekly", "monthly"]) {
      expect(card(render({ cadence }))).toBe("322.64");
    }
  });

  // ── against the real delivered email ────────────────────────────────────
  //
  // The 30 client rows of the delivered Daily Deal Match Analysis
  // (2026-10-13), read off that email. They are its DISPLAYED 2 dp values, so
  // their sum is the eye-sum a reader gets adding the column up: 112.90.
  //
  // That email's own TOTAL row says 112.87, and both are right. The live run
  // summed the backend's UNROUNDED notional and rounded once -- the treatment
  // every money column in this table gets -- and 30 rows of independent
  // rounding can differ by up to half a cent each. Summing the rounded
  // displays instead would match the eye-sum and stop matching the TOTAL row,
  // which is the comparison a reader actually makes.
  describe("the delivered 2026-10-13 report", () => {
    const NOTIONAL = [44.4, 8.35, 8.02, 12.74, 2.8, 3.34, 1.61, 2.89, 1.08, 3.54,
      3.34, 3.34, 1.87, 2.18, 2.1, 2.01, 1.67, 1.67, 1.67, 0.75, 1.17, 0.84,
      0.7, 0.58, 0.11, 0.01, 0.05, 0.03, 0.03, 0.01];
    const LOTS = [106.9, 60, 53.6, 30.6, 25, 16, 14.79, 12.92, 8.55, 8.44, 8, 8,
      8, 5.2, 5.04, 4.8, 4, 4, 4, 3.6, 2.88, 2, 1.69, 1.4, 0.26, 0.12, 0.11,
      0.08, 0.06, 0.03];

    const REAL_ROWS = NOTIONAL.map((millionsUsd, i) => ({
      name: "Client " + (i + 1), accounts: [String(100000 + i)], login: 100000 + i,
      lots: LOTS[i], millionsUsd,
      markup: 0, clientComm: 0, swap: 0, lpComm: 0, totalRev: 0, rebateWithdrawn: 0, netRev: 0,
    }));

    const html = render({ rows: REAL_ROWS, fromYmd: "2026-10-13", toYmd: "2026-10-13", cadence: "daily", periodNoun: "day" });

    it("reproduces that email's notional from its own rows", () => {
      expect(card(html)).toBe("112.90");
      expect(card(html)).toBe(totalRow(html));
    });

    // The delivered email's own TOTAL row says 112.87, not the 112.90 above.
    // Both are correct: the live run summed the backend's UNROUNDED notional
    // and rounded once. These rows are those displays less a thousandth each,
    // so every row still renders exactly what the email renders while the true
    // total is the 112.87 the email printed -- the delivered report,
    // reproduced.
    //
    // This is the case that catches a card summing the rounded displays. Such
    // a card would print the 112.90 a reader gets adding the column up and
    // disagree with the TOTAL row right beside it, which is the one thing the
    // card must never do.
    describe("summing the unrounded rows, as the live run did", () => {
      const UNROUNDED = REAL_ROWS.map((r) => ({ ...r, millionsUsd: r.millionsUsd - 0.001 }));
      const h = render({ rows: UNROUNDED, fromYmd: "2026-10-13", toYmd: "2026-10-13", cadence: "daily", periodNoun: "day" });

      it("renders every row exactly as the delivered email did", () => {
        const rowCells = notionalValues(h).map(figureOf).slice(1);
        expect(rowCells).toEqual(NOTIONAL.map((v) => v.toFixed(2)));
      });

      it("prints the TOTAL row the delivered email printed, not the eye-sum", () => {
        expect(totalRow(h)).toBe("112.87");
        // 112.90 is what the 30 displayed rows add up to by eye. A total built
        // from those displays would land there and stop matching this row.
        expect(totalRow(h)).not.toBe("112.90");
      });

      it("keeps the card on that same total, cent for cent", () => {
        expect(card(h)).toBe("112.87");
        expect(card(h)).toBe(totalRow(h));
        expect(card(h)).not.toBe("112.90");
      });

      it("leaves the eye-sum gap inside the per-row rounding budget", () => {
        // 30 rows each rounded independently can drift half a cent apiece, so
        // 0.03 is expected arithmetic rather than a reconciliation failure --
        // worth pinning so the 3-cent gap is not "fixed" into a real bug.
        const eye = NOTIONAL.reduce((a, b) => a + b, 0);
        expect(eye - Number(totalRow(h))).toBeCloseTo(0.03, 2);
        expect(Math.abs(eye - Number(totalRow(h)))).toBeLessThanOrEqual(0.005 * NOTIONAL.length);
      });
    });

    it("is a sum over all 30 rows, which is what makes it a legitimate total", () => {
      // The evidence that overturned the refusal: 30 rows, the header badge's
      // own "30 active clients", and a lots total equal to the whole-run
      // TOTAL MT5 DEALS scalar in the same email. If this table ever gains a
      // slice or a top-N, that comparison has to be re-run before the card can
      // still be called a total -- see the comment at the card.
      expect(html).toContain("summed across the 30 client rows below");
      expect(html).toContain("30 active clients");
      expect(LOTS.reduce((a, b) => a + b, 0)).toBeCloseTo(400.07, 2);
      const lotsTotal = (html.match(/data-label="Lots"[^>]*>.*?<span class="val[^"]*">([^<]*)<\/span>/) || [])[1];
      expect(lotsTotal).toBe("400.07");
    });
  });
});

// ── per-million figures, bracketed beside the notional (2026-10-15) ─────────
//
// "where we are showing volume add over there per million value also" / "add
// in small font in brackets". Both figures the desk chose ride in one bracket:
// net revenue per million of notional, and LP commission per million.
//
// THE TRAP, and what most of these tests exist for. DealMatch/Run publishes TWO
// LP costs per client and the row carries both. The bracket divides
// `lpCommPerM` (lpCommPerMillionUsd -- notional x the weighted per-million
// rate, the cost Net Revenue is actually built from: docs/dealing-reporting.md
// §5, which reproduced totalRevenueUsd on 78 of 78 rows where lpCommissionUsd
// reproduced it on none). Dividing that by notional recovers the weighted rate
// itself, which is the number being asked for.
//
// The other one, `lpComm`, is coverage-attributed, and it is what the visible
// LP Comm COLUMN prints. So "LP Comm / Notional" does NOT reproduce the
// bracket, and the fixture below is built so the two are far apart -- $10.00
// against $9.26 on the first row -- because a mutant that swaps them has to
// fail rather than round into agreement.
describe("per-million figures in brackets beside the notional", () => {
  const ROWS = deriveClientRevenueRows({ clientRevenueSummaries: SUMMARIES }).map((row) => ({
    ...row,
    accounts: [row.login],
    rebateWithdrawn: 0,
    netRev: row.totalRev,
  }));

  const STATS = {
    markupRevenue: 6730.74, commissionRevenue: 2811.84, swapRevenue: 713.66,
    swapCharged: 900.0, swapGiven: 186.34,
    grossRevenue: 10256.24, lpCommission: 1868.27, netRevenue: 8387.97,
  };

  const render = (extra = {}) =>
    buildEmailHtml({
      fromYmd: "2026-08-08",
      toYmd: "2026-08-14",
      rows: ROWS,
      volume: null,
      revenueStats: STATS,
      ...extra,
    });

  const cardValue = (html) =>
    (html.match(/uppercase;color:#64748b">Notional \(M USD\)<\/div>\s*<div style="font:800 20px[^"]*">([\s\S]*?)<\/div>/) || [])[1];
  const tileValue = (html) =>
    (html.match(/kpi-label">Notional \(M USD\)<\/p>\s*<p class="kpi-value">([\s\S]*?)<\/p>/) || [])[1];

  const brackets = (html) => notionalValues(html).map(bracketOf);

  it("puts both figures in one bracket on every client row", () => {
    // Each client's OWN rate, not the total's repeated: a cell built from
    // `totals` instead of `row` would print the same bracket twice.
    expect(brackets(render()).slice(1)).toEqual([
      "($23.82 net · $10.00 LP per M)",
      "($22.61 net · $10.00 LP per M)",
    ]);
  });

  it("divides the LP cost Net Revenue is built from, not the coverage-attributed one", () => {
    // THE mutation that matters. lpComm / notional is $9.26 and $9.21 on these
    // two rows; lpCommPerM / notional is $10.00 on both, because the backend
    // charged a flat $10 per million that week. A swap to lpComm lands on a
    // figure that is still entirely plausible on screen, which is exactly why
    // it is pinned to the cent.
    const rows = brackets(render()).slice(1);
    expect(rows[0]).toContain("$10.00 LP per M");
    expect(rows[0]).not.toContain("$9.26");
    expect(rows[1]).not.toContain("$9.21");
    // And the figure really is the backend's per-million RATE, recovered.
    expect(SUMMARIES[0].lpCommPerMillionUsd / SUMMARIES[0].clientMillionsUsd)
      .toBeCloseTo(SUMMARIES[0].lpCommPerMillionRateUsd, 4);
  });

  it("leaves the LP Comm column showing the coverage-attributed cost", () => {
    // Not changed by this commit, and deliberately: that column has always
    // been lpCommissionUsd, and a new bracket is no reason to redefine it.
    const lpCells = [...render().matchAll(/data-label="LP Comm"[^>]*>.*?<span class="val[^"]*">([^<]*)<\/span>/g)]
      .map((m) => m[1]);
    expect(lpCells.slice(1)).toEqual(["$1,539.55", "$1,439.79"]);
    // Which is why the arithmetic a reader might try does NOT come out, and
    // why the subtitle has to say so.
    expect(1539.55 / 166.2371).toBeCloseTo(9.26, 2);
  });

  it("divides money by notional and not notional by money", () => {
    // An inverted ratio renders $0.04 / $0.10 here -- small, tidy and
    // completely wrong. Both directions are pinned, because either could be
    // flipped on its own.
    for (const b of brackets(render()).slice(1)) {
      expect(b).not.toContain("$0.04");
      expect(b).not.toContain("$0.10 LP per M");
    }
  });

  it("brackets the TOTAL row with the ratio of the unrounded totals", () => {
    // $23.23 is 7495.07 / 322.6371 and $10.00 is 3226.37 / 322.6371. The LP
    // half also pins the reducer: `lpCommPerM` has to be both seeded and
    // accumulated in `totals`, and a miss on either renders "$0.00 LP per M"
    // against rows that each carry a real rate.
    const b = bracketOf(notionalValues(render())[0]);
    expect(b).toBe("($23.23 net · $10.00 LP per M)");
    expect(b).not.toContain("$0.00");
    // Not the coverage-attributed total either, which is $9.23 per million.
    expect(b).not.toContain("$9.23");
  });

  it("divides the unrounded notional, not the 2 dp figure printed beside it", () => {
    // The sharpest case, and the reason the rule matters at all: a client with
    // 0.0712 of notional DISPLAYS 0.07, and 16.59 / 0.07 is $237.00 against a
    // true $233.01 -- four dollars a million, from one rounding. The LP half
    // moves too, $10.14 against $9.97. Small-notional rows are where a ratio
    // taken off the rendered display stops being an approximation and becomes
    // a different number, and they are exactly the rows the 2 dp column was
    // widened to keep visible in the first place.
    const small = {
      ...ROWS[0], accounts: ["109871"], name: "Rina Petrova",
      lots: 0.42, millionsUsd: 0.0712, lpComm: 0.71, lpCommPerM: 0.71,
      totalRev: 16.59, rebateWithdrawn: 0, netRev: 16.59,
    };
    const html = render({ rows: [small] });
    expect(figureOf(notionalValues(html)[1])).toBe("0.07");
    expect(brackets(html)[1]).toBe("($233.01 net · $9.97 LP per M)");
    expect(brackets(html)[1]).not.toContain("$237.00");
    expect(brackets(html)[1]).not.toContain("$10.14");
    // The total and the card divide the same unrounded figure, not the "0.07"
    // they print.
    expect(brackets(html)[0]).toBe("($233.01 net · $9.97 LP per M)");
    expect(bracketOf(cardValue(html))).toBe("($233.01 net · $9.97 LP per M)");
    expect(figureOf(cardValue(html))).toBe("0.07");
  });

  it("prints the same bracket on the card as on the TOTAL row", () => {
    // Same requirement the notional figure itself has: a reader who notices
    // the card goes down and checks it against the row, so both read one pair
    // of formatted consts instead of recomputing.
    const html = render();
    expect(bracketOf(cardValue(html))).toBe(bracketOf(notionalValues(html)[0]));
    expect(bracketOf(cardValue(html))).toBe("($23.23 net · $10.00 LP per M)");
  });

  it("moves with the rows, so the card cannot be computing its own total", () => {
    const html = render({ rows: [ROWS[0]] });
    expect(bracketOf(cardValue(html))).toBe("($23.82 net · $10.00 LP per M)");
    expect(bracketOf(cardValue(html))).toBe(bracketOf(notionalValues(html)[0]));
  });

  it("brackets the row-derived KPI tile from the same digits", () => {
    // The other branch, which renders when whole-run revenueStats are absent.
    // One figure, one rate, either way.
    const html = render({ revenueStats: null });
    expect(cardValue(html)).toBeUndefined();
    expect(bracketOf(tileValue(html))).toBe("($23.23 net · $10.00 LP per M)");
    expect(bracketOf(tileValue(html))).toBe(bracketOf(notionalValues(html)[0]));
  });

  it("is smaller and quieter than the figure it sits beside", () => {
    // The request itself: "add in small font in brackets". 10px muted grey
    // against a 12px cell value and a 20px card figure.
    const html = render();
    expect(html).toContain('<span class="perm" style="font-size:10px;font-weight:400;letter-spacing:0;color:#64748b">');
    // The figures themselves are untouched -- still bare 2 dp digits.
    expect(notionalValues(html).map(figureOf)).toEqual(["322.64", "166.24", "156.40"]);
  });

  it("styles the bracket inline, with no pseudo-element and no new media query", () => {
    // docs §6: mail clients strip CSS pseudo-elements, and Zoho strips @media
    // entirely plus everything outside a 29-property allow-list. The bracket
    // is therefore real text with an inline style, like the cards it sits on.
    const html = render();
    expect(html).not.toMatch(/\.perm[^{]*::?before/);
    expect(html).not.toMatch(/@media[^{]*\{[^}]*\.perm/);
    // Real DOM text, the same reason a row label is a real <span class="lbl">:
    // the separator is a character in the document, not generated content.
    expect(html).toContain("&middot; $10.00 LP per M)");
    expect(bracketOf(notionalValues(html)[0])).toContain(" net · ");
  });

  it("lets the bracket take its own line rather than overflow", () => {
    // Both containers are nowrap (`table.data td.num .val`, and rptCard's 20px
    // figure div), so without a white-space:normal wrapper the pair would run
    // off the side instead of taking a second line. One wrapper per bracket.
    const html = render();
    const wrappers = [...html.matchAll(/<span style="white-space:normal">/g)].length;
    const perms = [...html.matchAll(/class="perm"/g)].length;
    expect(perms).toBeGreaterThan(0);
    expect(wrappers).toBe(perms);
  });

  it("breaks between the two figures but never inside one", () => {
    // The table cell is capped at max-width:156px and the pair measures ~137px
    // at ordinary magnitudes; a client with tiny notional and real revenue can
    // print a four-figure rate that would overflow into the cell beside it.
    // So each HALF is nowrap and the bracket as a whole is not -- docs §6
    // forbids breaking a figure mid-value, not breaking between two of them.
    const html = render();
    const halves = [...html.matchAll(/<span style="white-space:nowrap">([^<]*(?:<[^>]*>[^<]*)*?)<\/span>/g)];
    expect(halves.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('<span style="white-space:nowrap">&middot; $10.00 LP per M)</span>');
    // The bracket itself must NOT be nowrap, or the halves cannot separate.
    expect(html).not.toMatch(/class="perm" style="white-space:nowrap/);
  });

  it("reads on the TOTAL row's dark background instead of vanishing into it", () => {
    // tr.total-row is #0f172a. #64748b is unreadable on it, and that row's own
    // `td .val { color:#ffffff }` would otherwise win and make the bracket as
    // loud as the figure.
    const html = render();
    expect(notionalValues(html)[0]).toContain("color:#94a3b8");
    expect(notionalValues(html)[0]).not.toContain("color:#64748b");
    expect(cardValue(html)).toContain("color:#64748b");
  });

  it("renders an em dash, not Infinity or a confident zero, when there is no notional", () => {
    // A client can hold lots with no notional at all. The ratio is then
    // UNDEFINED: "$0.00 net" would claim the client earned nothing per million,
    // and Infinity/NaN would ship as literal text in the email.
    const html = render({
      rows: [{ ...ROWS[0], millionsUsd: 0, lpCommPerM: 0, netRev: 120.5, lots: 3.4 }],
    });
    const b = brackets(html);
    expect(b[0]).toBe("(— net · — LP per M)");
    expect(b[1]).toBe("(— net · — LP per M)");
    expect(html).not.toMatch(/Infinity|NaN/);
    expect(b[1]).not.toContain("$0.00");
    // The notional figure itself is still a real 0.00 -- zero notional is a
    // fact; only its ratio is undefined.
    expect(figureOf(notionalValues(html)[1])).toBe("0.00");
  });

  it("keeps the minus sign on a negative net per million, and marks it", () => {
    // From the delivered 2026-10-13 email: one client's net per million was
    // -$11.67, the single most useful number on that row. A dropped sign turns
    // a loss into a gain of the same size.
    const html = render({
      rows: [{ ...ROWS[0], netRev: -32.67, millionsUsd: 2.8 }],
    });
    expect(brackets(html).slice(1)).toEqual(["(-$11.67 net · $593.70 LP per M)"]);
    // Red and bold, inline, so the TOTAL row's white-everything rule cannot
    // flatten it there either.
    expect(html).toContain('<span class="money-neg" style="color:#b91c1c;font-weight:700">-$11.67</span>');
    expect(html).toContain('<span class="money-neg" style="color:#fca5a5;font-weight:700">-$11.67</span>');
  });

  it("says in the section subtitle which LP figure the bracket divides", () => {
    // Without it a reader who divides the LP Comm column by Notional gets a
    // different answer and concludes the report is broken. It goes in the
    // always-rendered subtitle, not the paragraph below it, which appears only
    // when whole-run revenueStats do.
    for (const stats of [STATS, null]) {
      expect(render({ revenueStats: stats })).toContain(
        "the weighted per-million rate Net Revenue is built from, not the LP Comm column over notional",
      );
    }
  });

  it("appears in all three cadences, since one renderer builds them all", () => {
    for (const cadence of ["daily", "weekly", "monthly"]) {
      const html = render({ cadence });
      expect(bracketOf(cardValue(html))).toBe("($23.23 net · $10.00 LP per M)");
      expect(brackets(html)).toHaveLength(3);
    }
  });

  // ── against the real delivered email ────────────────────────────────────
  //
  // The 30 client rows of the delivered Daily Deal Match Analysis
  // (2026-10-13), read off that email: its displayed Notional, Net Revenue and
  // LP Comm columns. They total 112.90 notional by eye-sum, $3,348.45 net and
  // $1,033.96 LP Comm -- and the email's own TOTAL row said 112.87, because
  // the live run summed the backend's unrounded notional and rounded once.
  //
  // That 3-cent gap is what makes this the fixture that catches a ratio built
  // from the rounded display: 3348.45 / 112.87 is $29.67 and 3348.45 / 112.90
  // is $29.66. One cent, two different rules, and only one of them agrees with
  // the notional total printed right beside it.
  describe("the delivered 2026-10-13 report", () => {
    const NOTIONAL = [44.4, 8.35, 8.02, 12.74, 2.8, 3.34, 1.61, 2.89, 1.08, 3.54,
      3.34, 3.34, 1.87, 2.18, 2.1, 2.01, 1.67, 1.67, 1.67, 0.75, 1.17, 0.84,
      0.7, 0.58, 0.11, 0.01, 0.05, 0.03, 0.03, 0.01];
    const NET = [945.13, 139.33, 1016.37, 382.65, -32.67, 57.08, 41.6, 48.26,
      37.26, 45.35, 48.72, 48.04, 41.5, 25.03, 27.85, 28.7, 28.99, 23.99, 23.31,
      11.16, 97.71, 29.76, 217.46, 13.04, 4.94, 0.32, -4.26, 0.89, 0.65, 0.29];
    // The LP Comm COLUMN of that email -- the coverage-attributed cost. The
    // email does not print lpCommPerMillionUsd, so the per-million LP cost is
    // modelled at the $10/M rate the backend charged; the point of carrying
    // both here is that the bracket must follow the second one.
    const LP_COMM = [382.22, 60.67, 80.17, 127.35, 32.67, 30.92, 16.06, 27.86,
      11.59, 35.43, 31.28, 30.46, 18.74, 21.77, 20.03, 18.8, 15.01, 15.01,
      16.69, 7.34, 11.53, 7.74, 6.6, 5.76, 0.98, 0.16, 0.42, 0.33, 0.25, 0.12];

    const row = (millionsUsd, i) => ({
      name: "Client " + (i + 1), accounts: [String(100000 + i)], login: 100000 + i,
      lots: 1, millionsUsd,
      markup: 0, clientComm: 0, swap: 0,
      lpComm: LP_COMM[i],
      lpCommPerM: Number((millionsUsd * 10).toFixed(2)),
      totalRev: NET[i], rebateWithdrawn: 0, netRev: NET[i],
    });

    // Those displays less a thousandth each: every row still renders exactly
    // what the email rendered, while the true total is the 112.87 it printed.
    const html = render({
      rows: NOTIONAL.map((v, i) => row(v - 0.001, i)),
      fromYmd: "2026-10-13", toYmd: "2026-10-13", cadence: "daily", periodNoun: "day",
    });

    it("lands on the real email's overall net per million", () => {
      // $29.67 from the 112.87 that email's TOTAL row printed. The $29.66 a
      // reader gets from the 112.90 eye-sum is the same figure a cent away, and
      // the gap is the per-row rounding the notional total already carries.
      expect(bracketOf(notionalValues(html)[0])).toContain("$29.67 net");
      expect(figureOf(notionalValues(html)[0])).toBe("112.87");
      expect(NET.reduce((a, b) => a + b, 0)).toBeCloseTo(3348.45, 2);
    });

    it("does not build the ratio from the rounded notional display", () => {
      // 3348.45 / 112.90 -- the eye-sum of the printed column -- is $29.66. A
      // bracket computed from the display beside it lands there and stops
      // agreeing with the total it claims to divide.
      expect(bracketOf(notionalValues(html)[0])).not.toContain("$29.66 net");
      expect(3348.45 / 112.9).toBeCloseTo(29.6585, 3);
      expect(3348.45 / 112.87).toBeCloseTo(29.6664, 3);
    });

    it("does not divide the LP Comm column a reader can see", () => {
      // 1033.96 / 112.87 is $9.16, and that is what the visible column gives.
      // The bracket must show the per-million basis instead -- $10.00 here.
      const b = bracketOf(notionalValues(html)[0]);
      expect(b).toContain("$10.00 LP per M");
      expect(b).not.toContain("$9.16");
      expect(LP_COMM.reduce((a, c) => a + c, 0) / 112.87).toBeCloseTo(9.16, 2);
    });

    it("reproduces that email's negative clients exactly", () => {
      // -$32.67 net on 2.80 of notional. The row the desk actually reads, and
      // the figure named in the request.
      expect(brackets(html)[5]).toBe("(-$11.67 net · $10.00 LP per M)");
      // The other negative, -$4.26 on 0.05 of notional, is read off the
      // DISPLAYED notional: a thousandth is 2% of a 0.05 row, so the
      // total-reproducing fixture above moves that ratio while leaving the
      // 2.80 one alone. -$85.20 is the email's own arithmetic.
      const displayed = render({
        rows: NOTIONAL.map(row),
        fromYmd: "2026-10-13", toYmd: "2026-10-13", cadence: "daily", periodNoun: "day",
      });
      expect(brackets(displayed)[27]).toBe("(-$85.20 net · $10.00 LP per M)");
      // Both still carry the sign, in both renders.
      expect(brackets(html)[27]).toMatch(/^\(-\$/);
      expect(brackets(displayed)[5]).toMatch(/^\(-\$/);
    });

    it("carries the bracket on all 30 rows plus the total", () => {
      const b = brackets(html);
      expect(b).toHaveLength(31);
      expect(b.filter((x) => x.includes("per M"))).toHaveLength(31);
    });

    it("keeps the card, the TOTAL row and the figures they divide in agreement", () => {
      expect(bracketOf(cardValue(html))).toBe(bracketOf(notionalValues(html)[0]));
      expect(figureOf(cardValue(html))).toBe(figureOf(notionalValues(html)[0]));
    });
  });
});
