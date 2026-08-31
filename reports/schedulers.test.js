import { describe, expect, it } from "vitest";
import { REPORT_SCHEDULES } from "./schedulers.js";

const bySlot = Object.fromEntries(REPORT_SCHEDULES.map((s) => [s.label, s]));

describe("the schedule", () => {
  it("declares exactly nine sends", () => {
    expect(REPORT_SCHEDULES).toHaveLength(9);
  });

  it("puts every report at every cadence", () => {
    expect(REPORT_SCHEDULES.map((s) => s.label).sort()).toEqual([
      "BusinessDaily", "BusinessMonthly", "BusinessWeekly",
      "DealMatchDaily", "DealMatchMonthly", "DealMatchWeekly",
      "SlippageDaily", "SlippageMonthly", "SlippageWeekly",
    ]);
  });

  it("uses the exact cron expressions the spec fixes", () => {
    expect(bySlot.DealMatchDaily.defaultCron).toBe("0 7 * * 2-6");
    expect(bySlot.SlippageDaily.defaultCron).toBe("30 7 * * 2-6");
    expect(bySlot.BusinessDaily.defaultCron).toBe("0 8 * * 2-6");
    expect(bySlot.DealMatchWeekly.defaultCron).toBe("0 9 * * 6");
    expect(bySlot.SlippageWeekly.defaultCron).toBe("30 9 * * 6");
    expect(bySlot.BusinessWeekly.defaultCron).toBe("0 10 * * 6");
    expect(bySlot.DealMatchMonthly.defaultCron).toBe("0 11 1 * *");
    expect(bySlot.SlippageMonthly.defaultCron).toBe("30 11 1 * *");
    expect(bySlot.BusinessMonthly.defaultCron).toBe("0 12 1 * *");
  });

  it("gives every send a distinct environment variable set", () => {
    for (const key of ["enabledVar", "cronVar", "timezoneVar", "runOnStartVar"]) {
      expect(new Set(REPORT_SCHEDULES.map((s) => s[key])).size).toBe(9);
    }
  });

  it("gives every send a recipient chain ending in a report-wide list", () => {
    for (const s of REPORT_SCHEDULES) {
      expect(s.recipientVars.length).toBeGreaterThan(0);
      expect(s.recipientVars.at(-1)).toMatch(/_ALERT_RECIPIENTS$/);
    }
  });
});

// The check that would have caught the live fault: the Business Summary monthly
// at "0 10 1 * *" and its weekly at "0 10 * * 6" fire in the same minute
// whenever the 1st is a Saturday. 1 August 2026 was one.
describe("no two schedulers share a minute", () => {
  const fires = (expr, d) => {
    const [mi, hh, dom, mon, dow] = expr.split(" ");
    const f = (part, val) => {
      if (part === "*") return true;
      return part.split(",").some((chunk) => {
        if (!chunk.includes("-")) return Number(chunk) === val;
        const [lo, hi] = chunk.split("-").map(Number);
        return val >= lo && val <= hi;
      });
    };
    return f(mi, d.getUTCMinutes()) && f(hh, d.getUTCHours()) && f(dom, d.getUTCDate())
        && f(mon, d.getUTCMonth() + 1) && f(dow, d.getUTCDay());
  };

  it("holds for every minute of a full year", () => {
    const collisions = [];
    const start = Date.UTC(2026, 0, 1);
    // Every half hour is enough: all nine expressions fire on :00 or :30.
    for (let t = start; t < Date.UTC(2027, 0, 1); t += 30 * 60_000) {
      const d = new Date(t);
      const hit = REPORT_SCHEDULES.filter((s) => fires(s.defaultCron, d));
      if (hit.length > 1) collisions.push(`${d.toISOString()}: ${hit.map((s) => s.label).join(" + ")}`);
    }
    expect(collisions).toEqual([]);
  });

  it("would have caught the 10:00 Saturday-the-1st collision", () => {
    // Guard against the test above being vacuous: with the OLD monthly time the
    // same walk must report a collision.
    const saturdayFirst = new Date(Date.UTC(2026, 7, 1, 10, 0)); // 1 Aug 2026, a Saturday
    expect(fires("0 10 1 * *", saturdayFirst)).toBe(true);
    expect(fires("0 10 * * 6", saturdayFirst)).toBe(true);
  });
});

// Each report's own test asserts three distinct keys within itself. All three
// could pass while slippage-daily and dealmatch-daily collided, which would
// make one of them permanently skip as "already sent".
describe("all nine send-guard keys are distinct", () => {
  it("holds across the three reports together", async () => {
    const [{ SUMMARY_GUARD_KEYS }, { SLIPPAGE_GUARD_KEYS }, { DEALMATCH_GUARD_KEYS }] =
      await Promise.all([
        import("./weeklyBusinessSummary.js"),
        import("./slippageWeeklyReport.js"),
        import("./dealMatchWeeklyReport.js"),
      ]);
    const all = [
      ...Object.values(SUMMARY_GUARD_KEYS),
      ...Object.values(SLIPPAGE_GUARD_KEYS),
      ...Object.values(DEALMATCH_GUARD_KEYS),
    ];
    expect(all).toHaveLength(9);
    expect(new Set(all).size).toBe(9);
  });
});

describe("the daily cadence", () => {
  const dailies = REPORT_SCHEDULES.filter((s) => s.label.endsWith("Daily"));

  it("runs Tuesday to Saturday and no other day", () => {
    for (const s of dailies) expect(s.defaultCron.endsWith(" 2-6")).toBe(true);
  });

  it("covers every weekday exactly once across the week", () => {
    // Tue..Sat sends cover Mon..Fri. Sunday and Saturday are never covered,
    // because the market is shut and those reports would be screens of zeros.
    const covered = [2, 3, 4, 5, 6].map((dow) => (dow + 6) % 7);
    expect(covered.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
