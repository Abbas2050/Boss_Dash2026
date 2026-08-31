import { describe, expect, it } from "vitest";
import {
  DEALMATCH_GUARD_KEYS,
  DEALMATCH_RECIPIENT_VARS,
  DEALMATCH_RUN_TIMEOUT_MS,
  dealMatchSubject,
} from "./dealMatchWeeklyReport.js";

describe("deal match guard keys", () => {
  it("gives each cadence its own key, with the weekly key unchanged", () => {
    expect(DEALMATCH_GUARD_KEYS).toEqual({
      daily: "dealmatch-daily",
      weekly: "dealmatch",
      monthly: "dealmatch-monthly",
    });
  });

  it("has three distinct keys", () => {
    expect(new Set(Object.values(DEALMATCH_GUARD_KEYS)).size).toBe(3);
  });
});

describe("deal match recipient variables", () => {
  it("falls back to the existing list at every cadence", () => {
    expect(DEALMATCH_RECIPIENT_VARS).toEqual({
      daily: ["DAILY_DEALMATCH_RECIPIENTS", "DEALMATCH_ALERT_RECIPIENTS"],
      weekly: ["DEALMATCH_ALERT_RECIPIENTS"],
      monthly: ["MONTHLY_DEALMATCH_RECIPIENTS", "DEALMATCH_ALERT_RECIPIENTS"],
    });
  });
});

describe("deal match subject", () => {
  it("keeps the weekly subject exactly as it was", () => {
    expect(dealMatchSubject("weekly", "2026-08-22", "2026-08-28"))
      .toBe("Weekly Deal Match Analysis (2026-08-22 to 2026-08-28)");
  });

  it("names a single day once", () => {
    expect(dealMatchSubject("daily", "2026-08-31", "2026-08-31"))
      .toBe("Daily Deal Match Analysis (2026-08-31)");
  });

  it("names a month as a range", () => {
    expect(dealMatchSubject("monthly", "2026-08-01", "2026-08-31"))
      .toBe("Monthly Deal Match Analysis (2026-08-01 to 2026-08-31)");
  });
});

describe("HTML entities are written once, not twice", () => {
  // The weekly Business Summary once shipped a literal "&ndash;" to a reader's
  // inbox because an entity was passed through escapeHtml. Same guard here,
  // because this task adds a periodNoun interpolation to several strings.
  it("contains no double-escaped entities in a weekly email", async () => {
    const { buildEmailHtml } = await import("./dealMatchWeeklyReport.js");
    const out = buildEmailHtml({
      fromYmd: "2026-08-22", toYmd: "2026-08-28",
      rows: [], volume: null, volumeStats: null, charts: null, chartError: null, ibNotice: null,
    });
    expect(out).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|middot);/);
  });
});

describe("the DealMatch/Run timeout", () => {
  // Measured 2026-08-31 against the live endpoint: 41.8s for one day, 40.4s for
  // a month. The old 45s left under four seconds of headroom on a call whose
  // cost does not shrink with the window. The Business Summary's own call to
  // the same endpoint already uses 180s.
  it("leaves real headroom over the measured ~40s response", () => {
    expect(DEALMATCH_RUN_TIMEOUT_MS).toBe(180_000);
  });
});

describe("cadence heading", () => {
  // The sibling report's <h1> hardcoded "Weekly" at every cadence -- the grep
  // pattern the brief suggested for finding user-visible "week" text missed it
  // entirely. Same risk here, so this is asserted directly rather than by grep.
  it("drives the h1 from the cadence, not a hardcoded 'Weekly'", async () => {
    const { buildEmailHtml } = await import("./dealMatchWeeklyReport.js");
    const daily = buildEmailHtml({
      fromYmd: "2026-08-31", toYmd: "2026-08-31",
      rows: [], volume: null, volumeStats: null, charts: null, chartError: null, ibNotice: null,
      periodNoun: "day", cadence: "daily",
    });
    expect(daily).toMatch(/<h1 class="title">Daily Deal Performance Summary<\/h1>/);
    expect(daily).not.toMatch(/<h1 class="title">Weekly Deal Performance Summary<\/h1>/);
  });
});

describe("DealMatch/Run timeout consistency", () => {
  // All DealMatch/Run calls must use DEALMATCH_RUN_TIMEOUT_MS (~40s measured cost).
  // ClientVolume/Run at line 230 legitimately uses 45s (responds in <1s); this test
  // must not flag that. Reading the source ensures any future hardcoded 45s on a
  // DealMatch/Run call is caught at test time.
  it("uses DEALMATCH_RUN_TIMEOUT_MS for all DealMatch/Run call sites, never bare 45_000", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const filePath = resolve("reports/dealMatchWeeklyReport.js");
    const source = readFileSync(filePath, "utf-8");

    // Find all lines with DealMatch/Run
    const lines = source.split("\n");
    const issues = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("DealMatch/Run")) {
        // Check if this line or the next few lines (in case of formatting) has a bare 45_000 timeout
        const context = lines.slice(i, Math.min(i + 3)).join("\n");
        if (/AbortSignal\.timeout\(\s*45_000\s*\)/.test(context)) {
          issues.push(`Line ${i + 1}: DealMatch/Run uses bare 45_000 timeout`);
        }
      }
    }

    expect(issues).toEqual([]);
  });
});
