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
  const notionalCells = (html) =>
    [...html.matchAll(/data-label="Notional \(M USD\)"[^>]*>.*?<span class="val[^"]*">([^<]*)<\/span>/g)]
      .map((m) => m[1]);

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
    expect(html).toMatch(/kpi-label">Notional \(M USD\)<\/p>\s*<p class="kpi-value">322\.64<\/p>/);
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
  const card = (html) =>
    (html.match(/uppercase;color:#64748b">Notional \(M USD\)<\/div>\s*<div style="font:800 20px[^"]*">([^<]*)<\/div>/) || [])[1];

  // The table's TOTAL (listed clients) row. It sits at the TOP of <tbody>, so
  // the first Notional data cell in document order is the total.
  const totalRow = (html) =>
    (html.match(/data-label="Notional \(M USD\)"[^>]*>.*?<span class="val[^"]*">([^<]*)<\/span>/) || [])[1];

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

  it("uses the column's own label, and leaves the unit out of the value", () => {
    // Same label as the table column and as the dashboard's clientMillionsUsd,
    // so the card and the row are visibly the same quantity.
    expect(render()).toContain('">Notional (M USD)</div>');
    expect(card(render())).not.toMatch(/[$M]/);
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
    expect(html).toMatch(/kpi-label">Notional \(M USD\)<\/p>\s*<p class="kpi-value">322\.64<\/p>/);
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
        const rowCells = [...h.matchAll(/data-label="Notional \(M USD\)"[^>]*>.*?<span class="val[^"]*">([^<]*)<\/span>/g)]
          .map((m) => m[1]).slice(1);
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
