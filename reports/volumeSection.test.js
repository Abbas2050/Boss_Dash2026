// @vitest-environment node
//
// node, not the suite's default jsdom, because the orchestration tests below
// reach backendFetch(), which calls AbortSignal.timeout() -- the same reason
// backendFetch.test.js opts out.
//
// The MT5 volume section. Three things here are worth more than the rest:
//
//   1. A missing scalar must render a dash, never 0.00. Two of the ten figures
//      are not on the confirmed-under-lite=true list, so this is the case that
//      actually happens rather than the case that theoretically could.
//   2. A DealMatch/Run failure must cost the Slippage report its volume
//      section and nothing else. A new enrichment that can suppress a working
//      report is worse than no enrichment.
//   3. Neither Deal Match nor the Business Summary may gain a call. Both
//      already hold a response, and DealMatch/Run costs ~40s whatever window it
//      is asked for.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// chartjs-node-canvas needs a native canvas build and publishChartImages writes
// to disk; neither is under test here, and a report must not fail either test
// below for want of them.
vi.mock("./reportShared.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renderChartBuffer: async () => Buffer.from("not-a-real-png"),
    publishChartImages: async () => ({ token: "stub", dir: "stub", urls: {} }),
  };
});

process.env.API_TOKEN = "stub";
process.env.VITE_API_TOKEN = "stub";

const { extractVolume, renderVolumeSection, fetchVolumeReport } = await import("./volumeSection.js");

// The 20–26 Jul 2026 week recorded in docs/dealing-reporting.md §1, which is
// where the 49% / 4% / 2% figures the funnel exists to show come from.
const PAYLOAD = {
  totalMt5DealLots: 200_000.0,
  totalShiftingMt5DealLots: 3_109.22,
  totalRealizedLotsCfd: 1_400.6,
  totalRealizedLotsEquity: 98_126.0,
  totalShiftingRealizedLots: 1_554.61,
  totalInternalAccountLots: 512.4,
  totalInternalAccountRealizedLots: 250.0,
  totalBridgeLots: 8_410.15,
  totalMatchedLots: 4_300.0,
  clientRevenueSummaries: [],
};

// 2026-09-02, read off the live DealMatch/Run response. This is the day that
// exposed the original four-stage funnel: 497.10 total, 149.70 realized, 356.84
// bridge, 356.76 matched. Drawn as stages in that order the third bar was WIDER
// than the second, because Realized is not downstream of anything — it is the
// same flow counted once per round trip, a different axis from where the flow
// was routed.
//
// Realized has to be present in this fixture, not merely mentioned: the guard
// below only bites if a reinserted Realized stage has a bar to draw. Only the
// 149.70 total was recorded for this day, so the whole of it sits on the CFD
// side here purely to reproduce that total. Nothing here asserts the real split.
const LIVE_0902 = {
  totalMt5DealLots: 497.1, // all of it client flow that day; no shifting lots
  totalShiftingMt5DealLots: 0,
  totalRealizedLotsCfd: 149.7,
  totalRealizedLotsEquity: 0,
  totalBridgeLots: 356.84,
  totalMatchedLots: 356.76,
};

// 2026-09-03, read off the live DealMatch/Run response, and the day the rebuilt
// section is asserted against: 296.09 deal lots, 260.25 of them to the bridge,
// 259.95 matched. Those are 87.9% and 87.8%, which BOTH print as 88% -- which is
// why the guard reads the unrounded share and not the text.
//
// Realized was 56.76 that day, all of it CFD. Shifting was genuinely zero on
// both axes, so this fixture is also where "a real zero is 0.00" is asserted
// against figures that were actually sent rather than constructed.
const LIVE_0903 = {
  totalMt5DealLots: 296.09,
  totalShiftingMt5DealLots: 0,
  totalShiftingRealizedLots: 0,
  totalRealizedLotsCfd: 56.76,
  totalRealizedLotsEquity: 0,
  totalBridgeLots: 260.25,
  totalMatchedLots: 259.95,
};

// ── HTML readers ─────────────────────────────────────────────────

const flowOf = (html) => html.slice(0, html.indexOf("Volume Breakdown"));
const breakdownOf = (html) => html.slice(html.indexOf("Volume Breakdown"));

// One table.data row, addressed by the value of its first cell. Both tables are
// built the same way, so one reader serves both.
//
// The anchor is a `<span class="val">` specifically — the visible value of a
// cell, never a `<span class="lbl">` column label — so "X is not a flow row"
// stays a structural claim: a figure rendered in the other table is invisible to
// a reader pointed at this one no matter how its label is worded.
function row(html, key) {
  const at = html.indexOf(`<span class="val">${key}</span>`);
  if (at === -1) return null;
  const end = html.indexOf("</tr>", at);
  return html.slice(at, end === -1 ? html.length : end);
}

// One cell of a row, by its column label.
function cellOf(rowHtml, column) {
  if (rowHtml === null) return null;
  const idx = rowHtml.indexOf(`data-label="${column}"`);
  if (idx === -1) return null;
  const open = rowHtml.indexOf('<span class="val', idx);
  const gt = rowHtml.indexOf(">", open);
  return rowHtml.slice(gt + 1, rowHtml.indexOf("</span>", gt)).trim();
}

// A flow row: its lots, the percentage a reader sees, and the unrounded share
// behind that percentage. The share is read separately because the printed one
// is rounded to a whole number and would hide a one-point inversion — the same
// reason the guard used to measure bar widths rather than the printed text.
function stage(html, label) {
  const r = row(html, label);
  if (r === null) return null;
  const printed = /<span class="vs" data-share="[^"]*">([\s\S]*?)<\/span>/.exec(r);
  const exact = /data-share="([^"]*)"/.exec(r);
  return {
    value: cellOf(r, "Lots"),
    pct: printed ? printed[1].trim() : null,
    share: exact && exact[1] !== "" ? Number(exact[1]) : null,
  };
}

// One cell of a breakdown row, by bucket name and column label.
const breakdownCell = (html, bucket, column) => cellOf(row(html, bucket), column);

// Every labelled cell the section renders, as {label, value}, in document
// order. The value is the cell's visible text with inner markup stripped, so a
// share cell (which nests a <span class="vs">) reads the same way as a plain
// lots cell, and an HTML entity survives as itself.
//
// This reads CELLS, not the whole document: the explanations are prose and use
// an em dash as punctuation. A dash is only a claim about a value when it is
// the value of a labelled cell.
function cells(html) {
  return [...html.matchAll(/<td[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => ({
    label: m[1],
    value: m[2]
      .replace(/^[\s\S]*?<span class="val[^"]*">/, "")
      .replace(/<[^>]*>/g, "")
      .trim(),
  }));
}

// Every breakdown row in document order, by the bucket it names.
function bucketLabels(html) {
  return [...html.matchAll(/data-label="Bucket"[^>]*>[\s\S]*?<span class="val">([^<]*)<\/span>/g)].map((m) => m[1]);
}

// Every flow row in document order.
function stageLabels(html) {
  return [...html.matchAll(/data-label="Stage"[^>]*>[\s\S]*?<span class="val">([^<]*)<\/span>/g)].map((m) => m[1]);
}

// The shares the flow table actually renders, in document order. The
// denominator row carries 100 even though it prints no percentage, so the
// sequence starts where the reader's eye does.
function stageShares(html) {
  return [...html.matchAll(/data-share="([^"]*)"/g)].map((m) => (m[1] === "" ? null : Number(m[1])));
}

// A bar was a nested <table role="presentation"> with table-layout:fixed inside
// a vf-bar cell. Nothing in the section may build one again.
function barMarkup(html) {
  return {
    presentationTables: (html.match(/role="presentation"/g) || []).length,
    fixedLayouts: (html.match(/table-layout:fixed/g) || []).length,
    barCells: (html.match(/vf-bar/g) || []).length,
  };
}

// The tables the section renders, by class attribute.
const tableClasses = (html) => [...html.matchAll(/<table([^>]*)>/g)].map((m) => m[1].trim());

// ── 1. extraction ────────────────────────────────────────────────────────────

describe("extractVolume", () => {
  it("pulls all ten figures out of a realistic DealMatch/Run payload", () => {
    const v = extractVolume(PAYLOAD);
    expect(v).toEqual({
      totalDeals: 203_109.22,
      clientDeals: 200_000.0,
      shiftingDeals: 3_109.22,
      shiftingRealized: 1_554.61,
      internalDeals: 512.4,
      internalRealized: 250.0,
      realizedCfd: 1_400.6,
      realizedEquity: 98_126.0,
      realizedTotal: 99_526.6,
      bridgeLots: 8_410.15,
      matchedLots: 4_300.0,
    });
  });

  it("reconciles with the documented identities for that week", () => {
    const v = extractVolume(PAYLOAD);
    // sum(clientRevenueSummaries[].lots) = totalMt5DealLots + totalShiftingMt5DealLots
    expect(v.totalDeals).toBeCloseTo(203_109.22, 2);
    // totalRealizedLotsCfd + totalRealizedLotsEquity = ClientVolume/Run totalLots
    expect(v.realizedTotal).toBeCloseTo(99_526.6, 2);
  });

  it("returns null rather than an object of nulls when there is no report", () => {
    expect(extractVolume(null)).toBeNull();
    expect(extractVolume(undefined)).toBeNull();
  });
});

// ── 2. a missing scalar is null, and renders a dash ──────────────────────────

describe("a missing scalar", () => {
  // These two are the ones actually at risk: docs/dealing-reporting.md lists
  // what is confirmed present under lite=true, and neither is on it.
  const { totalShiftingRealizedLots, totalInternalAccountRealizedLots, ...LITE } = PAYLOAD;

  it("yields null for the two fields not confirmed under lite=true", () => {
    const v = extractVolume(LITE);
    expect(v.shiftingRealized).toBeNull();
    expect(v.internalRealized).toBeNull();
  });

  it("renders those two as a dash, never as 0.00", () => {
    const html = breakdownOf(renderVolumeSection(extractVolume(LITE)));
    expect(breakdownCell(html, "Shifting", "Realized")).toBe("&mdash;");
    expect(breakdownCell(html, "Internal", "Realized")).toBe("&mdash;");
    expect(breakdownCell(html, "Shifting", "Realized")).not.toBe("0.00");
    expect(breakdownCell(html, "Internal", "Realized")).not.toBe("0.00");
  });

  it("treats every kind of absence the same way, and never as a number", () => {
    expect(extractVolume({ totalBridgeLots: undefined }).bridgeLots).toBeNull();
    expect(extractVolume({ totalBridgeLots: null }).bridgeLots).toBeNull();
    expect(extractVolume({ totalBridgeLots: "" }).bridgeLots).toBeNull();
    expect(extractVolume({ totalBridgeLots: "not a number" }).bridgeLots).toBeNull();
    expect(extractVolume({}).bridgeLots).toBeNull();
  });

  it("does not let a missing part turn a sum into the half that arrived", () => {
    // Client deals alone are not "total deals": reporting them as the total
    // would understate the denominator every percentage is measured against.
    expect(extractVolume({ totalMt5DealLots: 200_000 }).totalDeals).toBeNull();
    expect(extractVolume({ totalRealizedLotsCfd: 1_400.6 }).realizedTotal).toBeNull();
  });

  it("marks the whole section unavailable, with the reason, when the call failed", () => {
    const html = renderVolumeSection(null, { unavailableReason: "DealMatch/Run HTTP 503" });
    expect(html).toMatch(/Volume data was unavailable/);
    expect(html).toMatch(/DealMatch\/Run HTTP 503/);
  });
});

// ── 3. a genuine zero is a number ────────────────────────────────────────────

describe("a genuine zero", () => {
  const ZERO = { ...PAYLOAD, totalMatchedLots: 0, totalInternalAccountRealizedLots: 0 };

  it("extracts as 0, not null", () => {
    const v = extractVolume(ZERO);
    expect(v.matchedLots).toBe(0);
    expect(v.internalRealized).toBe(0);
  });

  it("renders 0.00, not a dash", () => {
    const html = renderVolumeSection(extractVolume(ZERO));
    expect(stage(flowOf(html), "Matched Lots").value).toBe("0.00");
    expect(stage(flowOf(html), "Matched Lots").value).not.toBe("&mdash;");
    expect(breakdownCell(breakdownOf(html), "Internal", "Realized")).toBe("0.00");
  });

  // A zero and an absence must not look alike. With the bars gone, the share
  // column is what tells them apart: a genuine zero is 0% of a real total, an
  // unreadable value is a dash on both axes.
  it("stays distinguishable from an absent value", () => {
    const zero = stage(flowOf(renderVolumeSection(extractVolume(ZERO))), "Matched Lots");
    expect(zero.value).toBe("0.00");
    expect(zero.pct).toBe("0%");

    const { totalMatchedLots: _dropped, ...missing } = PAYLOAD;
    const absent = stage(flowOf(renderVolumeSection(extractVolume(missing))), "Matched Lots");
    expect(absent.value).toBe("&mdash;");
    expect(absent.pct).toBe("&mdash;");
  });

  // 2026-09-03 had no shifting activity at all: both figures were sent as zero,
  // not omitted. They must read 0.00.
  it("renders the live 2026-09-03 shifting zeros as 0.00", () => {
    const html = breakdownOf(renderVolumeSection(extractVolume(LIVE_0903)));
    expect(breakdownCell(html, "Shifting", "Deals")).toBe("0.00");
    expect(breakdownCell(html, "Shifting", "Realized")).toBe("0.00");
    expect(breakdownCell(html, "Shifting", "Deals")).not.toBe("&mdash;");
    expect(breakdownCell(html, "Shifting", "Realized")).not.toBe("&mdash;");
  });
});

// ── 4. percentages ───────────────────────────────────────────────────────────

describe("flow percentages", () => {
  const html = flowOf(renderVolumeSection(extractVolume(PAYLOAD)));

  it("are the documented 4% / 2% of deal volume", () => {
    expect(stage(html, "Bridge Lots").pct).toBe("4%");
    expect(stage(html, "Matched Lots").pct).toBe("2%");
  });

  it("states the total as 100%, because an empty labelled cell reads as missing", () => {
    // Not cosmetic: table.data stacks into a card per row on a phone, so an
    // empty Share cell shows its label with nothing under it.
    expect(stage(html, "Total MT5 Deals").pct).toBe("100%");
  });

  it("renders the figures the percentages were taken from", () => {
    expect(stage(html, "Total MT5 Deals").value).toBe("203,109.22");
    expect(stage(html, "Bridge Lots").value).toBe("8,410.15");
    expect(stage(html, "Matched Lots").value).toBe("4,300.00");
  });
});

// ── 4b. the flow table only narrows ──────────────────────────────────────────

// This is the regression test for the defect. The original section put Realized
// between Total and Bridge, and on 2026-09-02 that drew a third bar wider than
// the second — a shape that asserts a sequence which does not exist. Every row
// must be a share of the one above it, so the shares can only fall.
//
// The bars are gone, so the guard reads the rendered share column instead of
// measuring widths. It reads the unrounded data-share rather than the printed
// percentage because the printed one is a whole number: on 2026-09-03 both 87.9
// and 87.8 print as 88%, and an inversion smaller than a point would vanish.
//
// Reinstating Realized (or any other non-routing metric) as a row fails this.
describe("the flow table narrows at every row", () => {
  const shares = (payload) => stageShares(flowOf(renderVolumeSection(extractVolume(payload))));

  it("never widens on the live 2026-09-02 figures that exposed the defect", () => {
    const drawn = shares(LIVE_0902);
    expect(drawn).toEqual([100, 71.8, 71.8]); // 497.10 → 356.84 → 356.76
    for (let i = 1; i < drawn.length; i += 1) {
      expect(drawn[i]).toBeLessThanOrEqual(drawn[i - 1]);
    }
  });

  it("never widens on the live 2026-09-03 figures either", () => {
    const drawn = shares(LIVE_0903);
    expect(drawn).toEqual([100, 87.9, 87.8]); // 296.09 → 260.25 → 259.95
    for (let i = 1; i < drawn.length; i += 1) {
      expect(drawn[i]).toBeLessThanOrEqual(drawn[i - 1]);
    }
  });

  it("prints that as a column of percentages that never climbs", () => {
    const html = flowOf(renderVolumeSection(extractVolume(LIVE_0903)));
    expect(stage(html, "Total MT5 Deals").pct).toBe("100%"); // the denominator itself
    expect(stage(html, "Bridge Lots").pct).toBe("88%");
    expect(stage(html, "Matched Lots").pct).toBe("88%");
  });

  it("never widens on the reference payload either", () => {
    const drawn = shares(PAYLOAD);
    for (let i = 1; i < drawn.length; i += 1) {
      expect(drawn[i]).toBeLessThanOrEqual(drawn[i - 1]);
    }
  });

  it("lists exactly the three routing rows, in routing order", () => {
    const html = flowOf(renderVolumeSection(extractVolume(LIVE_0902)));
    expect(stageLabels(html)).toEqual(["Total MT5 Deals", "Bridge Lots", "Matched Lots"]);
  });
});

// ── 4c. Realized is a parallel measure, not a step in the flow ───────────

// Realized had a headline row of its own until 2026-09-04, and a second row for
// its CFD / Equity split. Both are gone: neither had a Deals figure, so both
// filled that cell with a dash — asserting a read failure on a column that does
// not apply — and the Realized row's value was the same number the Client row
// already carried. The claim these tests protect is unchanged: Realized lives on
// the bucket axis and never in the flow table. It is now the Client row's
// Realized value.
describe("Realized", () => {
  const flow = flowOf(renderVolumeSection(extractVolume(PAYLOAD)));
  const breakdown = breakdownOf(renderVolumeSection(extractVolume(PAYLOAD)));

  it("is still rendered, as the Client row's Realized, with its CFD / Equity split", () => {
    expect(breakdownCell(breakdown, "Client", "Realized")).toBe("99,526.60");
    expect(breakdown).toMatch(/CFD \/ Equity split: 1,400\.60 \/ 98,126\.00/);
  });

  // The live figures for 2026-09-03. Realized reconciles with ClientVolume/Run
  // and is one of the two numbers this section exists to report, so it is a
  // breakdown figure with a caption pointing at it — but it is on a different
  // axis from where the flow was routed, so it must not appear in the flow
  // table at all.
  it("is a breakdown figure on the live 2026-09-03 figures, and is absent from the flow table", () => {
    const html = renderVolumeSection(extractVolume(LIVE_0903));
    expect(breakdownCell(breakdownOf(html), "Client", "Realized")).toBe("56.76");
    expect(breakdownOf(html)).toMatch(/CFD \/ Equity split: 56\.76 \/ 0\.00/);
    expect(flowOf(html)).not.toMatch(/Realized/);
    expect(flowOf(html)).not.toMatch(/56\.76/);
  });

  // Structural, not a reading of the prose: a flow row is a row carrying a Stage
  // cell, so this stays true through any rewording of the labels.
  it("is not one of the flow rows", () => {
    expect(stage(flow, "Realized")).toBeNull();
    expect(stageLabels(flow)).not.toContain("Realized");
    expect(stageLabels(flow)).toHaveLength(3);
  });

  // Prominence, asserted rather than assumed. Removing the headline row must
  // not leave the reader hunting for the figure they quote most: the Client
  // row's explanation says what Realized is, and a caption under the table says
  // which cell it is and what it reconciles with.
  it("is still named as the headline figure, so the reader knows which cell it is", () => {
    expect(breakdown).toMatch(/reconciles with client volume/i);
    expect(breakdown).toMatch(/Client&rsquo;s Realized is the section&rsquo;s headline figure/);
  });

  it("still renders a dash, never 0.00, when the backend sent neither half", () => {
    const { totalRealizedLotsCfd, totalRealizedLotsEquity, ...noRealized } = PAYLOAD;
    const bare = breakdownOf(renderVolumeSection(extractVolume(noRealized)));
    expect(breakdownCell(bare, "Client", "Realized")).toBe("&mdash;");
    expect(bare).toMatch(/CFD \/ Equity split: &mdash;/);
  });
});

// ── 4d. the breakdown carries only rows the columns apply to ─────────────
//
// This is the regression for the 2026-09-04 reader report. Two of the five
// breakdown rows had no Deals figure — Realized is not a deals metric, and a
// CFD / Equity split has no deals equivalent — and both printed a dash there.
// Throughout this project a dash means "could not read", so those two cells
// reported a failure that never happened. The fix is the shape, not a nicer
// placeholder: only buckets with both figures get a row.

describe("the breakdown table", () => {
  it("has exactly three body rows, one per bucket", () => {
    const html = breakdownOf(renderVolumeSection(extractVolume(PAYLOAD)));
    expect(bucketLabels(html)).toEqual(["Client", "Shifting", "Internal"]);
  });

  it("keeps all three even when every scalar is absent", () => {
    expect(bucketLabels(breakdownOf(renderVolumeSection(extractVolume({}))))).toEqual([
      "Client", "Shifting", "Internal",
    ]);
  });

  // The duplication the reader saw: 99,526.60 rendered once as the "Realized"
  // row and again as Client's realized volume, two rows apart in a short table.
  it("renders the realized total exactly once", () => {
    const html = renderVolumeSection(extractVolume(PAYLOAD));
    expect((html.match(/99,526\.60/g) || []).length).toBe(1);
  });

  it("still shows what CFD and equity each contributed", () => {
    const html = breakdownOf(renderVolumeSection(extractVolume(PAYLOAD)));
    expect(html).toMatch(/CFD \/ Equity split: 1,400\.60 \/ 98,126\.00/);
    expect(html).toMatch(/data-exp="split"/);
    expect(html).toMatch(/Closed CFD and closed equity volume/);
  });
});

// ── 4e. no cell dashes a figure that is present ──────────────────────────
//
// The dash rule cuts both ways. "A missing scalar renders —" is asserted above;
// this is its converse, and it is the one that was broken: a dash on a cell
// whose figure is not missing but simply does not exist tells the reader a read
// failed. Every labelled cell either shows a real value or corresponds to a
// scalar that is genuinely null.

describe("a dash means the value could not be read, and nothing else", () => {
  it("renders no dashed cell at all on the reference week, where every scalar is present", () => {
    const html = renderVolumeSection(extractVolume(PAYLOAD));
    expect(cells(html).filter((c) => c.value === "&mdash;")).toEqual([]);
  });

  // LIVE_0903 is a partial fixture: the two internal scalars were not recorded
  // that day. Its dashes are therefore correct, and naming them exactly is a
  // stronger claim than "none" — every dash the section prints has to be one of
  // them, so a dash on any present figure fails here too.
  it("dashes only the scalars the live 2026-09-03 fixture actually omits", () => {
    const v = extractVolume(LIVE_0903);
    expect(v.internalDeals).toBeNull();
    expect(v.internalRealized).toBeNull();

    const dashed = cells(renderVolumeSection(v)).filter((c) => c.value === "&mdash;");
    expect(dashed.map((c) => c.label)).toEqual(["Deals", "Realized"]);
  });

  // The rule itself, unchanged: a scalar the backend did not send still dashes.
  // totalInternalAccountRealizedLots is the one to assert on — it is one of the
  // two fields not on the confirmed-under-lite=true list.
  it("still dashes the cell of a scalar the backend did not send", () => {
    const { totalInternalAccountRealizedLots: _dropped, ...missing } = PAYLOAD;
    const html = renderVolumeSection(extractVolume(missing));
    expect(breakdownCell(breakdownOf(html), "Internal", "Realized")).toBe("&mdash;");
    const dashed = cells(html).filter((c) => c.value === "&mdash;");
    expect(dashed).toHaveLength(1);
    expect(dashed[0].label).toBe("Realized");
  });
});

// ── 5. no denominator ────────────────────────────────────────────────────────

describe("a zero or missing Total MT5 Deals", () => {
  const cases = [
    ["zero", { ...PAYLOAD, totalMt5DealLots: 0, totalShiftingMt5DealLots: 0 }],
    ["missing", (() => { const { totalMt5DealLots, ...rest } = PAYLOAD; return rest; })()],
  ];

  for (const [name, payload] of cases) {
    it(`yields a dash for every percentage when the total is ${name}`, () => {
      const html = flowOf(renderVolumeSection(extractVolume(payload)));
      for (const label of ["Bridge Lots", "Matched Lots"]) {
        expect(stage(html, label).pct).toBe("&mdash;");
      }
    });

    it(`never renders NaN, Infinity or 0% when the total is ${name}`, () => {
      const html = renderVolumeSection(extractVolume(payload));
      expect(html).not.toMatch(/NaN/);
      expect(html).not.toMatch(/Infinity/);
      expect(flowOf(html)).not.toMatch(/>0%</);
    });
  }
});

// ── 6. there are no bars, and an unavailable row keeps its place ──────────
//
// The bars are gone. They were nested <table role="presentation"> blocks inside
// a vf-bar cell, sized by inline widths and marked with class names no shell
// stylesheet defines — and on the morning of 2026-09-04 the reader opened the
// Daily Digest on a phone in Zoho and saw the two headings with no figures under
// them. These assertions replace the ones that used to count bars.

describe("the section draws no bars", () => {
  it("builds no nested presentation table and keeps no vf-bar cell", () => {
    for (const payload of [PAYLOAD, LIVE_0903, {}]) {
      const m = barMarkup(renderVolumeSection(extractVolume(payload)));
      expect(m.presentationTables).toBe(0);
      expect(m.fixedLayouts).toBe(0);
      expect(m.barCells).toBe(0);
    }
  });

  // This is the regression. The section did not render because it was built out
  // of markup no shell styles; the one part that did render was the breakdown,
  // which was already table.data. Both tables must now be that same class.
  it("builds both tables as table.data, the class the rest of the report uses", () => {
    const classes = tableClasses(renderVolumeSection(extractVolume(PAYLOAD)));
    expect(classes).toEqual(['class="data narrow"', 'class="data narrow"']);
    expect(tableClasses(renderVolumeSection(extractVolume(PAYLOAD), { theme: "dark" }))).toEqual(classes);
  });

  // Bridge and Matched are the two rows that can go missing — Total is a sum of
  // fields the table cannot be drawn without at all.
  for (const [label, field] of [["Bridge Lots", "totalBridgeLots"], ["Matched Lots", "totalMatchedLots"]]) {
    it(`keeps ${label}'s row, dashed on both axes, when its value is unavailable`, () => {
      const { [field]: _dropped, ...missing } = PAYLOAD;
      const html = flowOf(renderVolumeSection(extractVolume(missing)));
      expect(stage(html, label).value).toBe("&mdash;");
      expect(stage(html, label).pct).toBe("&mdash;");
      expect(stage(html, label).share).toBeNull();
      expect(html).not.toMatch(/NaN/);
      expect(stageLabels(html)).toHaveLength(3); // the row stays
    });
  }
});

// ── 7. internal lots are a parallel bucket ───────────────────────────────────

describe("internal accounts", () => {
  const html = renderVolumeSection(extractVolume(PAYLOAD));

  // totalInternalAccountLots is a separate bucket, not a subset of client lots
  // (docs/dealing-reporting.md §4): internal logins do not appear in
  // clientRevenueSummaries at all. Listing it as a flow row would assert a
  // containment that does not hold. This test exists so nobody later
  // "completes" the flow table with it.
  it("appear in the breakdown", () => {
    expect(breakdownCell(breakdownOf(html), "Internal", "Deals")).toBe("512.40");
    expect(breakdownCell(breakdownOf(html), "Internal", "Realized")).toBe("250.00");
  });

  it("are not a flow row", () => {
    expect(stage(flowOf(html), "Internal Deals")).toBeNull();
    expect(stage(flowOf(html), "Internal")).toBeNull();
    expect(flowOf(html)).not.toMatch(/Internal/);
  });

  it("leaves the flow table with exactly the three rows it is supposed to have", () => {
    expect(stageLabels(flowOf(html))).toEqual(["Total MT5 Deals", "Bridge Lots", "Matched Lots"]);
  });
});

// ── 10. rendering constraints ────────────────────────────────────────────────

describe("email-safe markup", () => {
  const samples = [
    renderVolumeSection(extractVolume(PAYLOAD)),
    renderVolumeSection(extractVolume(PAYLOAD), { theme: "dark" }),
    renderVolumeSection(null, { unavailableReason: "boom" }),
  ];

  it("uses no pseudo-element, flex or grid anywhere", () => {
    for (const html of samples) {
      expect(html).not.toMatch(/::before|::after/);
      expect(html).not.toMatch(/flex/i);
      expect(html).not.toMatch(/grid/i);
    }
  });

  it("adds no table markup of its own beyond the two data tables", () => {
    for (const html of samples) {
      expect(html).not.toMatch(/role="presentation"/);
      expect(html).not.toMatch(/table-layout:fixed/);
      expect(html).not.toMatch(/<table(?! class="data narrow">)/);
    }
  });

  it("writes each HTML entity once, never double-escaped", () => {
    for (const html of samples) {
      expect(html).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|middot);/);
    }
  });

  it("says nothing about a week, so a daily email stays a daily email", () => {
    for (const html of samples) expect(html).not.toMatch(/week/i);
  });
});

// ── 8 & 9. orchestration ─────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const SLIP_ROWS = [
  { lpsid: "LP One", fillVolume: 12.5, lpPlImpact: -120.5, lpSlipPoints: -3.2, lpPrice: 1.1, clientPlImpact: -80.25, clientCostUsd: -60.1, clientSlipPoints: -2.1, extLogin: "10218" },
  { lpsid: "LP Two", fillVolume: 7.25, lpPlImpact: 45.75, lpSlipPoints: 1.4, lpPrice: 1.2, clientPlImpact: 30.5, clientCostUsd: 20.4, clientSlipPoints: 0.9, extLogin: "10219" },
];

// Records every outbound URL so a second DealMatch/Run cannot hide, and keeps
// the sent messages so the email itself can be asserted on.
function stubFetch({ dealMatchStatus = 200 } = {}) {
  const urls = [];
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/oauth/token")) return json({ access_token: "issued-token", expires_in: 300 });
    if (u.includes("api.brevo.com")) {
      sent.push(JSON.parse(init.body));
      return json({ messageId: "stub" });
    }
    if (u.includes("/DealMatch/Run")) {
      return dealMatchStatus === 200 ? json(PAYLOAD) : json({ error: "upstream exploded" }, dealMatchStatus);
    }
    if (u.includes("/SlippageReport/Run")) return json({ rows: SLIP_ROWS, internalRows: [], rowCount: SLIP_ROWS.length });
    if (u.includes("/ClientVolume/Run")) return json({ totalLots: 0, totalStocksLots: 0, totalCfdLots: 0, byDate: [] });
    if (u.includes("/rest/")) return json([]); // CRM: no transactions, no users
    return json({});
  };
  return { urls, sent };
}

const dealMatchCalls = (urls) => urls.filter((u) => u.includes("/DealMatch/Run")).length;
const PERIOD = { fromDate: new Date(Date.UTC(2026, 6, 20)), toDate: new Date(Date.UTC(2026, 6, 26, 23, 59, 59)) };

beforeEach(async () => {
  const { resetBackendTokenState } = await import("../wallet/backendToken.js");
  resetBackendTokenState();
  process.env.BACKEND_API_KEY = "unit-test-key";
  process.env.BACKEND_CLIENT_ID = "4071";
  process.env.BREVO_API_KEY = "unit-test-brevo";
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
  const { resetBackendTokenState } = await import("../wallet/backendToken.js");
  resetBackendTokenState();
});

describe("the Slippage report when DealMatch/Run fails", () => {
  it("still sends, with every existing slippage figure intact", async () => {
    const { runSlippageEmailReport } = await import("./slippageWeeklyReport.js");
    const { urls, sent } = stubFetch({ dealMatchStatus: 500 });

    const result = await runSlippageEmailReport({ ...PERIOD, recipients: ["ops@example.com"] });

    expect(dealMatchCalls(urls)).toBe(1); // it tried
    expect(result.ok).toBe(true); // and sent anyway
    expect(sent).toHaveLength(1);

    const html = sent[0].htmlContent;
    // The figures that were already in this report before the funnel existed.
    expect(html).toMatch(/By-LP Summary/);
    expect(html).toMatch(/LP One/);
    expect(html).toMatch(/LP Two/);
    expect(html).toMatch(/19\.75/); // total lots, 12.5 + 7.25
    expect(html).toMatch(/-\$74\.75/); // total net LP slippage, -120.50 + 45.75
  });

  it("marks the volume section unavailable and names the reason", async () => {
    const { runSlippageEmailReport } = await import("./slippageWeeklyReport.js");
    const { sent } = stubFetch({ dealMatchStatus: 500 });

    await runSlippageEmailReport({ ...PERIOD, recipients: ["ops@example.com"] });

    const html = sent[0].htmlContent;
    expect(html).toMatch(/MT5 Volume Flow/);
    expect(html).toMatch(/Volume data was unavailable/);
    expect(html).toMatch(/DealMatch\/Run HTTP 500/);
    expect(html).not.toMatch(/203,109\.22/); // no invented figures
  });

  it("renders the flow table when the call succeeds", async () => {
    const { runSlippageEmailReport } = await import("./slippageWeeklyReport.js");
    const { urls, sent } = stubFetch();

    const result = await runSlippageEmailReport({ ...PERIOD, recipients: ["ops@example.com"] });

    expect(result.ok).toBe(true);
    expect(dealMatchCalls(urls)).toBe(1); // the one new call this report is allowed
    expect(sent[0].htmlContent).toMatch(/203,109\.22/);
    expect(sent[0].htmlContent).toMatch(/>4%</); // Bridge Lots, the first row carrying one
  });
});

describe("no report gains an extra DealMatch/Run call", () => {
  it("Deal Match makes exactly the one it always made", async () => {
    const { runDealMatchEmailReport } = await import("./dealMatchWeeklyReport.js");
    const { urls, sent } = stubFetch();

    const result = await runDealMatchEmailReport({ ...PERIOD, recipients: ["ops@example.com"] });

    expect(result.ok).toBe(true);
    expect(dealMatchCalls(urls)).toBe(1);
    // ...and it is the same response that fed the section, not a second one.
    expect(sent[0].htmlContent).toMatch(/MT5 Volume Flow/);
    expect(sent[0].htmlContent).toMatch(/203,109\.22/);
  });

  it("the Business Summary makes exactly the one it always made", async () => {
    const { runWeeklyBusinessSummary } = await import("./weeklyBusinessSummary.js");
    const { urls, sent } = stubFetch();

    const result = await runWeeklyBusinessSummary({ ...PERIOD, recipients: ["ops@example.com"] });

    expect(result.ok).toBe(true);
    expect(dealMatchCalls(urls)).toBe(1);
    expect(sent[0].htmlContent).toMatch(/MT5 Volume Flow/);
    expect(sent[0].htmlContent).toMatch(/203,109\.22/);
  });
});

// ── the fetch itself ─────────────────────────────────────────────────────────

describe("fetchVolumeReport", () => {
  it("asks for lite=true, because lite=false is ~45 MB of match rows", async () => {
    const { urls } = stubFetch();
    await fetchVolumeReport(PERIOD.fromDate, PERIOD.toDate);
    const call = urls.find((u) => u.includes("/DealMatch/Run"));
    expect(call).toMatch(/lite=true/);
    expect(call).not.toMatch(/lite=false/);
  });

  it("throws rather than returning an empty payload, so the caller can say why", async () => {
    stubFetch({ dealMatchStatus: 503 });
    await expect(fetchVolumeReport(PERIOD.fromDate, PERIOD.toDate)).rejects.toThrow(/HTTP 503/);
  });
});

// ── 11. every figure carries its explanation ─────────────────────────────────
//
// The dealing tab explains these numbers with `title` tooltips, which render
// nowhere in a mail client. The email therefore carries the same sentences as
// visible text — and this is the test that keeps them attached to the figures.
//
// It is deliberately blind to the wording. A figure cell (or breakdown row)
// carries data-fig="<key>"; its explanation carries data-exp="<key>". Comparing
// the two SETS means a copy edit is invisible here, while a figure that arrives
// without a line, or a line orphaned from its figure, is not.

const attrs = (html, name) => [...html.matchAll(new RegExp(`data-${name}="([^"]+)"`, "g"))].map((m) => m[1]);
const figKeys = (html) => [...new Set(attrs(html, "fig"))].sort();
const expKeys = (html) => [...new Set(attrs(html, "exp"))].sort();

describe("every figure is explained inline", () => {
  const html = renderVolumeSection(extractVolume(PAYLOAD));

  it("pairs every rendered figure with an explanation, and every explanation with a figure", () => {
    expect(figKeys(html)).toEqual(expKeys(html));
    // The three flow rows, the three breakdown buckets, and the CFD / Equity
    // split, which carries its figures inside the Client row rather than in a
    // row of its own. Named so that adding a figure without a line fails here
    // rather than shipping an unexplained number.
    expect(figKeys(html)).toEqual([
      "bridge", "client", "internal", "matched", "shifting", "split", "totalDeals",
    ]);
  });

  it("explains each flow row next to the figure itself", () => {
    for (const key of ["totalDeals", "bridge", "matched"]) {
      const fig = html.indexOf(`data-fig="${key}"`);
      const exp = html.indexOf(`data-exp="${key}"`);
      expect(fig).toBeGreaterThan(-1);
      expect(exp).toBeGreaterThan(fig); // the line follows the number it explains
    }
  });

  it("carries no explanation at all when the whole section is unavailable", () => {
    const bare = renderVolumeSection(null, { unavailableReason: "boom" });
    expect(figKeys(bare)).toEqual([]);
    expect(expKeys(bare)).toEqual([]);
  });
});

// A dash tells the reader a number is missing; only the line beside it tells
// them WHAT is missing. So the explanations must not be attached to the value.
describe("an unavailable figure keeps its explanation", () => {
  const EMPTY = {};

  it("explains all seven even when every scalar is absent", () => {
    const html = renderVolumeSection(extractVolume(EMPTY));
    expect(expKeys(html)).toEqual(expKeys(renderVolumeSection(extractVolume(PAYLOAD))));
    expect(figKeys(html)).toEqual(expKeys(html));
  });

  it("still explains the two rows that render a dash", () => {
    const { totalBridgeLots, totalMatchedLots, ...missing } = PAYLOAD;
    const html = flowOf(renderVolumeSection(extractVolume(missing)));
    expect(stage(html, "Bridge Lots").value).toBe("&mdash;");
    expect(html).toMatch(/data-exp="bridge"/);
    expect(html).toMatch(/data-exp="matched"/);
  });

  it("still explains a breakdown cell that could not be read", () => {
    const { totalShiftingRealizedLots, ...lite } = PAYLOAD;
    const html = breakdownOf(renderVolumeSection(extractVolume(lite)));
    expect(breakdownCell(html, "Shifting", "Realized")).toBe("&mdash;");
    expect(html).toMatch(/data-exp="shifting"/);
  });
});

// The reason the text is visible in the first place. `title` does not render in
// Outlook, Zoho or Gmail, and the primary reader is on a phone where there is
// no hover to begin with.
describe("nothing in the section depends on hover", () => {
  it("uses no title attribute anywhere", () => {
    for (const html of [
      renderVolumeSection(extractVolume(PAYLOAD)),
      renderVolumeSection(extractVolume(PAYLOAD), { theme: "dark" }),
      renderVolumeSection(extractVolume({})),
      renderVolumeSection(null, { unavailableReason: "boom" }),
    ]) {
      expect(html).not.toMatch(/\stitle\s*=/i);
    }
  });
});

// ── 12. every report family mounts the section ───────────────────────────────
//
// The section is worth nothing in the reports that forget it. Four families
// send it across nine scheduled sends, and the Business Summary alone covers
// three cadences through one shared builder — so a cadence added later inherits
// the mount, and a family added later fails here instead of shipping without it.

describe("every report family renders the volume section", () => {
  const families = [
    ["Daily Digest", async () => (await import("./dailyDigest.js")).runDailyDigest],
    ["Weekly Business Summary", async () => (await import("./weeklyBusinessSummary.js")).runWeeklyBusinessSummary],
    ["Monthly Review", async () => (await import("./monthlyReview.js")).runMonthlyReview],
    ["Deal Match", async () => (await import("./dealMatchWeeklyReport.js")).runDealMatchEmailReport],
    ["Slippage", async () => (await import("./slippageWeeklyReport.js")).runSlippageEmailReport],
  ];

  for (const [name, load] of families) {
    it(`${name} sends the section, its figures and its explanations`, async () => {
      const run = await load();
      const { sent } = stubFetch();

      const result = await run({ ...PERIOD, recipients: ["ops@example.com"] });

      expect(result.ok).toBe(true);
      expect(sent).toHaveLength(1);
      const html = sent[0].htmlContent;
      expect(html).toMatch(/MT5 Volume Flow/);
      expect(html).toMatch(/203,109\.22/); // the figures, not just the heading
      expect(figKeys(html)).toEqual(expKeys(html)); // and the lines beside them
      expect(expKeys(html)).toHaveLength(7);
    });
  }
});
