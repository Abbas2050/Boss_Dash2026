import { describe, expect, it } from "vitest";
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
