// ymd() must format a Date using its LOCAL calendar day, not the UTC day
// d.toISOString() reports. These users are in the UAE (UTC+4): between local
// midnight and 04:00, d.toISOString().slice(0, 10) reports the previous UTC
// day, which silently defaulted the "To" date to yesterday and could put
// monthStart a month early at a month boundary.
//
// Node reads process.env.TZ per Date construction (verified directly: set
// TZ, then build the Date -- no library needed), so the test pins the
// UTC+4 case concretely by setting TZ to "Asia/Dubai" for the duration of
// the test and restoring it afterward, rather than only asserting against
// whatever timezone the test runner happens to run in.
import { describe, it, expect, afterEach } from "vitest";
import { ymd } from "./RevenueShareTab";

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("ymd", () => {
  it("formats local midnight in a UTC+4 zone as today, not the UTC day (yesterday)", () => {
    process.env.TZ = "Asia/Dubai";
    // 2026-01-01 00:30 local (UTC+4) time -- still 2025-12-31 in UTC.
    const d = new Date(2026, 0, 1, 0, 30, 0);
    expect(d.toISOString().slice(0, 10)).toBe("2025-12-31"); // sanity check on the premise
    expect(ymd(d)).toBe("2026-01-01");
  });

  it("does not roll a month boundary back a month in a UTC+4 zone", () => {
    process.env.TZ = "Asia/Dubai";
    // 2026-03-01 00:30 local (UTC+4) time -- still 2026-02-28 in UTC, which
    // is the trap: a UTC-based "month start" built from this instant would
    // land in February instead of March.
    const d = new Date(2026, 2, 1, 0, 30, 0);
    expect(d.toISOString().slice(0, 10)).toBe("2026-02-28"); // sanity check on the premise
    expect(ymd(d)).toBe("2026-03-01");
  });

  it("still formats correctly for a date with no UTC/local day mismatch", () => {
    process.env.TZ = "Asia/Dubai";
    const d = new Date(2026, 5, 15, 12, 0, 0);
    expect(ymd(d)).toBe("2026-06-15");
  });
});
