// @vitest-environment node
//
// node, not the suite's default jsdom, because the orchestration tests below
// reach backendFetch(), which calls AbortSignal.timeout() -- the same reason
// backendFetch.test.js opts out.
//
// The MT5 Volume Funnel. Three things here are worth more than the rest:
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

// ── HTML readers ─────────────────────────────────────────────────────────────

const funnelOf = (html) => html.slice(0, html.indexOf("Volume Breakdown"));
const breakdownOf = (html) => html.slice(html.indexOf("Volume Breakdown"));

// A funnel stage, read by its label. The bar cell holds a nested table, so the
// cells are addressed by their vf-* marker classes rather than by counting
// </td> boundaries.
//
// The anchor is the vf-label cell specifically, not the bare label text. That
// is what makes "X is not a funnel stage" a structural claim: a figure rendered
// anywhere else in the section — Realized's headline, a breakdown row — has no
// vf-label, so it is invisible to this reader no matter how its label is worded.
function stage(html, label) {
  const at = html.search(new RegExp(`<td class="vf-label"[^>]*>${label}</td>`));
  if (at === -1) return null;
  const rest = html.slice(at);
  const cell = (cls) => {
    const m = new RegExp(`<td class="${cls}"[^>]*>([\\s\\S]*?)</td>`).exec(rest);
    return m ? m[1].trim() : null;
  };
  const barAt = rest.indexOf('class="vf-bar"');
  const valueAt = rest.indexOf('class="vf-value"');
  return {
    value: cell("vf-value"),
    pct: cell("vf-pct"),
    hasBar: barAt !== -1 && valueAt > barAt && rest.slice(barAt, valueAt).includes("<table"),
  };
}

// One cell of a breakdown row, by bucket name and column label.
function breakdownCell(html, bucket, column) {
  const at = html.indexOf(`<span class="val">${bucket}</span>`);
  if (at === -1) return null;
  const idx = html.indexOf(`data-label="${column}"`, at);
  if (idx === -1) return null;
  const open = html.indexOf('<span class="val', idx);
  const gt = html.indexOf(">", open);
  return html.slice(gt + 1, html.indexOf("</span>", gt)).trim();
}

const barCount = (html) => (html.match(/table-layout:fixed/g) || []).length;

// Every funnel stage in document order, with the share its bar actually draws.
//
// The bar width is read rather than the printed percentage because the printed
// one is rounded to a whole number and would hide a one-point inversion. The
// Total row draws a full bar, so its width is the 100% the rest are shares of.
function stageLabels(html) {
  return [...html.matchAll(/<td class="vf-label"[^>]*>([^<]*)</g)].map((m) => m[1]);
}

function stageShares(html) {
  // Bounded by the vf-value cell that always follows, because a stage with no
  // bar has an empty cell and "up to the next </table>" would run past its row.
  return [...html.matchAll(/<td class="vf-bar"[^>]*>([\s\S]*?)<td class="vf-value"/g)].map((m) => {
    const w = /<td width="(\d+\.\d)%"/.exec(m[1]);
    return w ? Number(w[1]) : null;
  });
}

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
    expect(stage(funnelOf(html), "Matched Lots").value).toBe("0.00");
    expect(stage(funnelOf(html), "Matched Lots").value).not.toBe("&mdash;");
    expect(breakdownCell(breakdownOf(html), "Internal", "Realized")).toBe("0.00");
  });

  it("still draws the stage's track, so an empty bar and an absent bar differ", () => {
    expect(stage(funnelOf(renderVolumeSection(extractVolume(ZERO))), "Matched Lots").hasBar).toBe(true);
  });
});

// ── 4. percentages ───────────────────────────────────────────────────────────

describe("funnel percentages", () => {
  const html = funnelOf(renderVolumeSection(extractVolume(PAYLOAD)));

  it("are the documented 4% / 2% of deal volume", () => {
    expect(stage(html, "Bridge Lots").pct).toBe("4%");
    expect(stage(html, "Matched Lots").pct).toBe("2%");
  });

  it("leaves the total itself without one, because it is the denominator", () => {
    expect(stage(html, "Total MT5 Deals").pct).toBe("");
  });

  it("renders the figures the percentages were taken from", () => {
    expect(stage(html, "Total MT5 Deals").value).toBe("203,109.22");
    expect(stage(html, "Bridge Lots").value).toBe("8,410.15");
    expect(stage(html, "Matched Lots").value).toBe("4,300.00");
  });
});

// ── 4b. the funnel only narrows ──────────────────────────────────────────────

// This is the regression test for the defect. The original funnel put Realized
// between Total and Bridge, and on 2026-09-02 that drew a third bar wider than
// the second — a shape that asserts a sequence which does not exist. Every stage
// must be a share of the one above it, so the shares can only fall.
//
// Reinstating Realized (or any other non-routing metric) as a stage fails this.
describe("the funnel narrows at every stage", () => {
  const shares = (payload) => stageShares(funnelOf(renderVolumeSection(extractVolume(payload))));

  it("never widens on the live 2026-09-02 figures that exposed the defect", () => {
    const drawn = shares(LIVE_0902);
    expect(drawn).toEqual([100, 71.8, 71.8]); // 497.10 → 356.84 → 356.76
    for (let i = 1; i < drawn.length; i += 1) {
      expect(drawn[i]).toBeLessThanOrEqual(drawn[i - 1]);
    }
  });

  it("never widens on the reference payload either", () => {
    const drawn = shares(PAYLOAD);
    for (let i = 1; i < drawn.length; i += 1) {
      expect(drawn[i]).toBeLessThanOrEqual(drawn[i - 1]);
    }
  });

  it("draws exactly the three routing stages, in routing order", () => {
    const html = funnelOf(renderVolumeSection(extractVolume(LIVE_0902)));
    expect(stageLabels(html)).toEqual(["Total MT5 Deals", "Bridge Lots", "Matched Lots"]);
  });
});

// ── 4c. Realized is a parallel measure, not a stage ──────────────────────────

describe("Realized", () => {
  const html = funnelOf(renderVolumeSection(extractVolume(PAYLOAD)));

  it("is still rendered, with its total and its CFD / Equity split", () => {
    expect(html).toMatch(/<td class="vr-value"[^>]*>99,526\.60<\/td>/);
    expect(html).toMatch(/<td class="vr-split"[^>]*>1,400\.60 \/ 98,126\.00<\/td>/);
  });

  // Structural, not a reading of the prose: a stage is a row carrying a
  // vf-label cell, so this stays true through any rewording of the captions.
  it("is not one of the funnel stages", () => {
    expect(stage(html, "Realized")).toBeNull();
    expect(stageLabels(html)).not.toContain("Realized");
    expect(stageLabels(html)).toHaveLength(3);
  });

  it("still renders a dash, never 0.00, when the backend sent neither half", () => {
    const { totalRealizedLotsCfd, totalRealizedLotsEquity, ...noRealized } = PAYLOAD;
    const bare = funnelOf(renderVolumeSection(extractVolume(noRealized)));
    expect(/<td class="vr-value"[^>]*>([\s\S]*?)<\/td>/.exec(bare)[1]).toBe("&mdash;");
    expect(/<td class="vr-split"[^>]*>([\s\S]*?)<\/td>/.exec(bare)[1]).toBe("&mdash;");
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
      const html = funnelOf(renderVolumeSection(extractVolume(payload)));
      for (const label of ["Bridge Lots", "Matched Lots"]) {
        expect(stage(html, label).pct).toBe("&mdash;");
      }
    });

    it(`never renders NaN, Infinity or 0% when the total is ${name}`, () => {
      const html = renderVolumeSection(extractVolume(payload));
      expect(html).not.toMatch(/NaN/);
      expect(html).not.toMatch(/Infinity/);
      expect(funnelOf(html)).not.toMatch(/>0%</);
    });
  }
});

// ── 6. an unavailable stage draws no bar ─────────────────────────────────────

describe("bars", () => {
  it("draws one per stage when every stage has a value", () => {
    expect(barCount(funnelOf(renderVolumeSection(extractVolume(PAYLOAD))))).toBe(3);
  });

  // Bridge and Matched are the two stages that can go missing — Total is a sum
  // of fields the funnel cannot be drawn without at all.
  for (const [label, field] of [["Bridge Lots", "totalBridgeLots"], ["Matched Lots", "totalMatchedLots"]]) {
    it(`draws none for ${label} when its value is unavailable`, () => {
      const { [field]: _dropped, ...missing } = PAYLOAD;
      const html = funnelOf(renderVolumeSection(extractVolume(missing)));
      expect(stage(html, label).value).toBe("&mdash;");
      expect(stage(html, label).pct).toBe("&mdash;");
      expect(stage(html, label).hasBar).toBe(false);
      expect(barCount(html)).toBe(2);
      expect(html).not.toMatch(/NaN/);
      expect(stageLabels(html)).toHaveLength(3); // the row stays, only the bar goes
    });
  }
});

// ── 7. internal lots are a parallel bucket ───────────────────────────────────

describe("internal accounts", () => {
  const html = renderVolumeSection(extractVolume(PAYLOAD));

  // totalInternalAccountLots is a separate bucket, not a subset of client lots
  // (docs/dealing-reporting.md §4): internal logins do not appear in
  // clientRevenueSummaries at all. Drawing it as a funnel stage would assert a
  // containment that does not hold. This test exists so nobody later
  // "completes" the funnel with it.
  it("appear in the breakdown", () => {
    expect(breakdownCell(breakdownOf(html), "Internal", "Deals")).toBe("512.40");
    expect(breakdownCell(breakdownOf(html), "Internal", "Realized")).toBe("250.00");
  });

  it("are not a funnel stage", () => {
    expect(stage(funnelOf(html), "Internal Deals")).toBeNull();
    expect(stage(funnelOf(html), "Internal")).toBeNull();
    expect(funnelOf(html)).not.toMatch(/Internal/);
  });

  it("leaves the funnel with exactly the three stages it is supposed to have", () => {
    expect(stageLabels(funnelOf(html))).toEqual(["Total MT5 Deals", "Bridge Lots", "Matched Lots"]);
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

  it("builds its bars as nested tables with percentage widths and a background", () => {
    const html = renderVolumeSection(extractVolume(PAYLOAD));
    expect(html).toMatch(/<table role="presentation"[^>]*table-layout:fixed;"><tr><td width="\d+\.\d%"/);
    expect(html).toMatch(/background:#b45309/); // the Bridge Lots bar's fill
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
    expect(html).toMatch(/MT5 Volume Funnel/);
    expect(html).toMatch(/Volume data was unavailable/);
    expect(html).toMatch(/DealMatch\/Run HTTP 500/);
    expect(html).not.toMatch(/203,109\.22/); // no invented figures
  });

  it("renders the funnel when the call succeeds", async () => {
    const { runSlippageEmailReport } = await import("./slippageWeeklyReport.js");
    const { urls, sent } = stubFetch();

    const result = await runSlippageEmailReport({ ...PERIOD, recipients: ["ops@example.com"] });

    expect(result.ok).toBe(true);
    expect(dealMatchCalls(urls)).toBe(1); // the one new call this report is allowed
    expect(sent[0].htmlContent).toMatch(/203,109\.22/);
    expect(sent[0].htmlContent).toMatch(/>4%</); // Bridge Lots, the first stage carrying one
  });
});

describe("no report gains an extra DealMatch/Run call", () => {
  it("Deal Match makes exactly the one it always made", async () => {
    const { runDealMatchEmailReport } = await import("./dealMatchWeeklyReport.js");
    const { urls, sent } = stubFetch();

    const result = await runDealMatchEmailReport({ ...PERIOD, recipients: ["ops@example.com"] });

    expect(result.ok).toBe(true);
    expect(dealMatchCalls(urls)).toBe(1);
    // ...and it is the same response that fed the funnel, not a second one.
    expect(sent[0].htmlContent).toMatch(/MT5 Volume Funnel/);
    expect(sent[0].htmlContent).toMatch(/203,109\.22/);
  });

  it("the Business Summary makes exactly the one it always made", async () => {
    const { runWeeklyBusinessSummary } = await import("./weeklyBusinessSummary.js");
    const { urls, sent } = stubFetch();

    const result = await runWeeklyBusinessSummary({ ...PERIOD, recipients: ["ops@example.com"] });

    expect(result.ok).toBe(true);
    expect(dealMatchCalls(urls)).toBe(1);
    expect(sent[0].htmlContent).toMatch(/MT5 Volume Funnel/);
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
