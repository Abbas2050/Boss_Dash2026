import { describe, expect, it } from "vitest";
import { SUMMARY_GUARD_KEYS, SUMMARY_RECIPIENT_VARS } from "./weeklyBusinessSummary.js";

describe("business summary guard keys", () => {
  // These three are deliberately inconsistent with slippage-* and dealmatch-*.
  // They were recorded against real sends on 1 September 2026; renaming them
  // would let those sends repeat on the next app-pool restart.
  it("keeps the keys already written to the send log", () => {
    expect(SUMMARY_GUARD_KEYS).toEqual({
      daily: "daily",
      weekly: "summary",
      monthly: "monthly",
    });
  });

  it("has three distinct keys", () => {
    expect(new Set(Object.values(SUMMARY_GUARD_KEYS)).size).toBe(3);
  });
});

describe("business summary recipient variables", () => {
  it("falls back to the existing list at every cadence", () => {
    expect(SUMMARY_RECIPIENT_VARS).toEqual({
      daily: ["DAILY_DIGEST_RECIPIENTS", "SUMMARY_ALERT_RECIPIENTS"],
      weekly: ["SUMMARY_ALERT_RECIPIENTS"],
      monthly: ["MONTHLY_REVIEW_RECIPIENTS", "SUMMARY_ALERT_RECIPIENTS"],
    });
  });
});
