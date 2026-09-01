import { afterEach, describe, expect, it } from "vitest";
import { dubaiCalendarDate, formatDubaiClock, formatDubaiInstant } from "./dubaiTime";

// These cover the render-time half of the timestamp fix: wallet/walletMonitor.js
// now emits a proper ISO-8601 instant (with its "Z"), and these helpers turn
// that instant into Dubai wall-clock text -- via Intl's `timeZone` option,
// not the viewer's machine timezone. A helper that quietly used the machine
// zone would pass on a CI box that happens to run UTC and still be wrong for
// a phone anywhere else, so every test here pins process.env.TZ to something
// that is neither UTC nor Dubai before asserting.

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("formatDubaiInstant / dubaiCalendarDate", () => {
  it("renders a UTC instant that crosses the date line into the next Dubai day", () => {
    process.env.TZ = "America/New_York"; // arbitrary non-UTC, non-Dubai zone
    // 21:22:35 UTC is 01:22:35 the next day in Dubai (UTC+4).
    const instant = "2026-09-01T21:22:35Z";

    expect(formatDubaiInstant(instant)).toBe("Sep 02, 01:22:35");
    expect(formatDubaiInstant(instant)).not.toBe("Sep 01, 21:22:35");
  });

  it("derives the Dubai calendar date, not the UTC calendar date", () => {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14, as far from Dubai as a zone gets
    const instant = "2026-09-01T21:22:35Z";

    expect(dubaiCalendarDate(instant)).toBe("2026-09-02");
    expect(dubaiCalendarDate(instant)).not.toBe("2026-09-01");
  });

  it("renders an instant that does not cross the date line correctly", () => {
    process.env.TZ = "Asia/Tokyo";
    // 06:00:00 UTC is 10:00:00 the same day in Dubai.
    const instant = "2026-09-01T06:00:00Z";

    expect(formatDubaiInstant(instant)).toBe("Sep 01, 10:00:00");
    expect(dubaiCalendarDate(instant)).toBe("2026-09-01");
  });

  it("formatDubaiClock renders HH:MM in Dubai time", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(formatDubaiClock("2026-09-01T21:22:35Z")).toBe("01:22");
  });

  it("output is identical across machine timezones -- the point of the fix", () => {
    const instant = "2026-09-01T21:22:35Z";
    const zones = ["UTC", "America/New_York", "Asia/Tokyo", "Pacific/Kiritimati", "Asia/Dubai"];

    const instants = zones.map((tz) => {
      process.env.TZ = tz;
      return formatDubaiInstant(instant);
    });
    const dates = zones.map((tz) => {
      process.env.TZ = tz;
      return dubaiCalendarDate(instant);
    });

    expect(new Set(instants).size).toBe(1);
    expect(instants[0]).toBe("Sep 02, 01:22:35");
    expect(new Set(dates).size).toBe(1);
    expect(dates[0]).toBe("2026-09-02");
  });

  it("returns the placeholder for missing or unparseable input", () => {
    expect(formatDubaiInstant(undefined)).toBe("—");
    expect(formatDubaiInstant(null)).toBe("—");
    expect(formatDubaiInstant("not-a-date")).toBe("—");
    expect(dubaiCalendarDate(undefined)).toBeNull();
    expect(dubaiCalendarDate("not-a-date")).toBeNull();
  });
});
