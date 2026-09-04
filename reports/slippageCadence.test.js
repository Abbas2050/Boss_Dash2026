import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SLIPPAGE_GUARD_KEYS,
  SLIPPAGE_RECIPIENT_VARS,
  buildSlippageEmailHtml,
  slippageSubject,
} from "./slippageWeeklyReport.js";

describe("slippage guard keys", () => {
  // The weekly key stays bare for backward compatibility with sends already
  // recorded in the send log. If the daily reused it, Saturday's weekly would
  // be skipped as "already sent".
  it("gives each cadence its own key, with the weekly key unchanged", () => {
    expect(SLIPPAGE_GUARD_KEYS).toEqual({
      daily: "slippage-daily",
      weekly: "slippage",
      monthly: "slippage-monthly",
    });
  });

  it("has three distinct keys", () => {
    expect(new Set(Object.values(SLIPPAGE_GUARD_KEYS)).size).toBe(3);
  });
});

describe("slippage recipient variables", () => {
  it("falls back to the existing list at every cadence", () => {
    expect(SLIPPAGE_RECIPIENT_VARS).toEqual({
      daily: ["DAILY_SLIPPAGE_RECIPIENTS", "SLIPPAGE_ALERT_RECIPIENTS"],
      weekly: ["SLIPPAGE_ALERT_RECIPIENTS"],
      monthly: ["MONTHLY_SLIPPAGE_RECIPIENTS", "SLIPPAGE_ALERT_RECIPIENTS"],
    });
  });
});

describe("slippage subject", () => {
  // The weekly subject must not change by one character: it is what the
  // recipients' inbox rules and eyes already key on.
  it("keeps the weekly subject exactly as it was", () => {
    expect(slippageSubject("weekly", "2026-08-22", "2026-08-28"))
      .toBe("Weekly Slippage Report (2026-08-22 to 2026-08-28)");
  });

  it("names a single day once, not as a range of one", () => {
    expect(slippageSubject("daily", "2026-08-31", "2026-08-31"))
      .toBe("Daily Slippage Report (2026-08-31)");
  });

  it("names a month as a range", () => {
    expect(slippageSubject("monthly", "2026-08-01", "2026-08-31"))
      .toBe("Monthly Slippage Report (2026-08-01 to 2026-08-31)");
  });
});

const BUCKETS = [
  { lp: "LP One", deals: 120, volume: 45.5, slippageUsd: -320.25, avgSlipUsd: -2.67, positive: 40, negative: 70, neutral: 10 },
];
const KPIS = { totalDeals: 120, totalSlippageUsd: -320.25, avgSlipUsd: -2.67, worstLp: "LP One" };

const html = (over = {}) =>
  buildSlippageEmailHtml({ fromYmd: "2026-08-31", toYmd: "2026-08-31", buckets: BUCKETS, kpis: KPIS, ...over });

// The empty-table fallback ("No slippage rows for this ${periodNoun}") only
// renders when bodyRows is falsy, which never happens with the one-row
// BUCKETS fixture above. A separate empty-buckets fixture is required to
// actually exercise that branch instead of asserting on text that can't render.
const emptyHtml = (over = {}) =>
  buildSlippageEmailHtml({ fromYmd: "2026-08-31", toYmd: "2026-08-31", buckets: [], kpis: KPIS, ...over });

describe("period wording", () => {
  it("titles the heading with the cadence word", () => {
    expect(html({ cadence: "daily" })).toMatch(/<h1 class="title">Daily Slippage Report<\/h1>/);
    expect(html({ cadence: "weekly" })).toMatch(/<h1 class="title">Weekly Slippage Report<\/h1>/);
    expect(html({ cadence: "monthly" })).toMatch(/<h1 class="title">Monthly Slippage Report<\/h1>/);
  });

  it("says day in the empty-state fallback of a daily email, and never week", () => {
    const out = emptyHtml({ periodNoun: "day", cadence: "daily" });
    expect(out).toMatch(/No slippage rows for this day\./);
    expect(out).not.toMatch(/this week|the week/i);
  });

  it("says month in the empty-state fallback of a monthly email, and never week", () => {
    const out = emptyHtml({ periodNoun: "month", cadence: "monthly" });
    expect(out).toMatch(/No slippage rows for this month\./);
    expect(out).not.toMatch(/this week|the week/i);
  });

  it("a daily email contains no occurrence of 'week' anywhere", () => {
    expect(html({ periodNoun: "day", cadence: "daily" })).not.toMatch(/week/i);
  });

  it("a monthly email contains no occurrence of 'week' anywhere", () => {
    expect(html({ periodNoun: "month", cadence: "monthly" })).not.toMatch(/week/i);
  });

  it("the weekly email still says week", () => {
    expect(html()).toMatch(/week/i);
  });
});

describe("HTML entities are written once, not twice", () => {
  it("contains no double-escaped entities", () => {
    expect(html()).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|middot);/);
  });
});

// ── the shared shell ─────────────────────────────────────────────────────────
//
// The Slippage report used to carry its own <style> block, hard-coded to a dark
// palette, while the Business Summary family ran on emailShell's light theme.
// The reader opens all of them on a phone in Zoho and complained about exactly
// the one that had drifted. These tests hold the migration in place: the report
// is the shared shell, in light, and nothing it renders depends on a rule that
// does not ship with it.

const VOLUME = {
  totalDeals: 203109.22,
  clientDeals: 190000,
  shiftingDeals: 13109.22,
  shiftingRealized: 400.5,
  internalDeals: 88.25,
  internalRealized: 44.125,
  realizedCfd: 1200.5,
  realizedEquity: 48000.25,
  realizedTotal: 49200.75,
  bridgeLots: 4100.1,
  matchedLots: 4050.4,
};

const richHtml = (over = {}) =>
  buildSlippageEmailHtml({
    fromYmd: "2026-08-24",
    toYmd: "2026-08-30",
    buckets: [
      // Two LPs so both sign classes render, and "Unattributed" so the
      // muted-key class is exercised rather than assumed.
      { key: "LP One", count: 3, lots: 45.5, netSlipUsd: -320.25, netPosUsd: 10, netNegUsd: -330.25, avgSlipPts: -1.2, lpAvgSlipUsd: -2.67, clientAvgSlipPts: 0.4, clientAvgSlipUsd: 1.1, clientTotalSlipUsd: 3.3, clientTotalCostUsd: 4.4, sumSlipPts: -3.6, slipPtsCount: 3, clientSumUsd: 3.3, clientCostSumUsd: 4.4, clientSumPts: 1.2 },
      // Every figure zero, so slipCls returns "muted" and that class appears.
      { key: "Unattributed", count: 1, lots: 0, netSlipUsd: 0, netPosUsd: 0, netNegUsd: 0, avgSlipPts: 0, lpAvgSlipUsd: 0, clientAvgSlipPts: 0, clientAvgSlipUsd: 0, clientTotalSlipUsd: 0, clientTotalCostUsd: 0, sumSlipPts: 0, slipPtsCount: 0, clientSumUsd: 0, clientCostSumUsd: 0, clientSumPts: 0 },
    ],
    kpis: {
      totalLots: 45.5,
      totalNetSlipUsd: -320.25,
      bestLp: { key: "LP One", costPerLot: 1.1 },
      worstLp: { key: "LP Two", costPerLot: 9.9 },
      worstClient: "10218",
      worstClientCost: 12.5,
    },
    mt5Volume: VOLUME,
    ...over,
  });

// Every colour the old private shell painted the page, the card, its border and
// its zebra stripes with. One of these surviving anywhere means a piece of the
// black email came back.
const DARK_LITERALS = ["#0b1220", "#111a2c", "#1f2a44", "#101c33", "#16233f"];

describe("the Slippage email is light, not dark", () => {
  it("contains none of the old dark-palette colours anywhere", () => {
    for (const variant of [richHtml(), richHtml({ mt5Volume: null }), emptyHtml()]) {
      const found = DARK_LITERALS.filter((hex) => variant.includes(hex));
      expect(found).toEqual([]);
    }
  });

  it("paints the page and the card with the light theme's own colours", () => {
    const out = richHtml();
    expect(out).toMatch(/background:#f3f7fb/); // page
    expect(out).toMatch(/background:#ffffff/); // card
  });
});

describe("the Slippage email is built through the shared shell", () => {
  const source = readFileSync(path.resolve("reports/slippageWeeklyReport.js"), "utf8");

  it("defines no shell of its own — no stylesheet, no document, no <body>", () => {
    expect(source).not.toMatch(/<style>/);
    expect(source).not.toMatch(/<!doctype/i);
    expect(source).not.toMatch(/<body>/);
  });

  it("imports the shell and the cell helpers instead of hand-copying them", () => {
    expect(source).toMatch(/^\s+emailShell,$/m);
    // The two helpers this file used to keep private copies of.
    expect(source).not.toMatch(/^function (dataCell|spanCell)\(/m);
  });

  it("still emits the shell's document and the tscroll wrapper that keeps a phone from scrolling sideways", () => {
    const out = richHtml();
    expect(out).toMatch(/^<!doctype html>/);
    expect(out).toMatch(/<div class="tscroll">/);
  });
});

// ── class coverage ───────────────────────────────────────────────────────────
//
// The regression this exists for: on 2026-09-04 the volume section reached the
// reader's phone as two headings and no figures, because its markup used class
// names no shell stylesheet defined. A body class with no rule behind it is
// invisible until someone opens the email.
//
// vx and vs are the two documented exceptions, and they are exceptions by
// construction rather than by oversight (volumeSection.js): vx carries every
// declaration it needs inline on the element, and vs is a bare marker that
// pairs a data-share attribute with a value the monotonicity guard reads. They
// are named here individually so a third undefined class cannot join them.
const MARKER_CLASSES = ["vs", "vx"];

function classesUsed(html) {
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].trim().split(/\s+/)) if (c) used.add(c);
  }
  return used;
}

function classesDefined(html) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  expect(style).not.toBeNull();
  return new Set([...style[1].matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
}

describe("every class in the Slippage body has a rule in the stylesheet that ships with it", () => {
  it.each([
    ["with volume", () => richHtml()],
    ["with volume unavailable", () => richHtml({ mt5Volume: null, volumeError: "boom" })],
    ["with no slippage rows", () => emptyHtml()],
  ])("%s", (_label, build) => {
    const out = build();
    const defined = classesDefined(out);
    const undefinedClasses = [...classesUsed(out)]
      .filter((c) => !defined.has(c) && !MARKER_CLASSES.includes(c))
      .sort();
    expect(undefinedClasses).toEqual([]);
  });

  it("allows exactly the two documented marker classes and no others", () => {
    expect(MARKER_CLASSES).toEqual(["vs", "vx"]);
  });
});

describe("the volume section inside the Slippage email renders light", () => {
  it("uses the light muted colour and never the dark one", () => {
    const out = richHtml();
    expect(out).toMatch(/MT5 Volume Flow/);
    expect(out).toMatch(/color:#64748b/); // volumeSection THEMES.light.muted
    expect(out).not.toMatch(/#8ea4c6/); // THEMES.dark.muted
  });

  it("says so when volume is unavailable, still in the light colour", () => {
    const out = richHtml({ mt5Volume: null, volumeError: "boom" });
    expect(out).toMatch(/Volume data was unavailable[\s\S]*?boom/);
    expect(out).not.toMatch(/#8ea4c6/);
  });
});
