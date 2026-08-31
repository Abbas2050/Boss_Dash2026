import { describe, expect, it } from "vitest";
import { previousFullDayUtc, previousFullMonthUtc, previousFullWeekUtc } from "./reportShared.js";

// Every boundary function returns {start, end} covering a period that has
// FINISHED. The period in progress is always excluded -- a report that
// included today would change every time it ran.

const ymd = (d) => d.toISOString().slice(0, 10);
const hms = (d) => d.toISOString().slice(11, 19);

describe("previousFullDayUtc", () => {
  it("covers yesterday, from midnight to the last second", () => {
    const { start, end } = previousFullDayUtc(new Date("2026-09-01T08:00:00Z"));
    expect(ymd(start)).toBe("2026-08-31");
    expect(hms(start)).toBe("00:00:00");
    expect(ymd(end)).toBe("2026-08-31");
    expect(hms(end)).toBe("23:59:59");
  });

  it("excludes today no matter how late in the day it runs", () => {
    const lateStart = previousFullDayUtc(new Date("2026-09-01T23:59:59Z")).start;
    expect(ymd(lateStart)).toBe("2026-08-31");
  });

  it("steps back across a month boundary", () => {
    const { start, end } = previousFullDayUtc(new Date("2026-09-01T08:00:00Z"));
    expect(ymd(start)).toBe("2026-08-31");
    expect(ymd(end)).toBe("2026-08-31");
  });

  it("steps back across a year boundary", () => {
    const { start } = previousFullDayUtc(new Date("2027-01-01T08:00:00Z"));
    expect(ymd(start)).toBe("2026-12-31");
  });

  it("steps back onto a leap day", () => {
    const { start } = previousFullDayUtc(new Date("2028-03-01T08:00:00Z"));
    expect(ymd(start)).toBe("2028-02-29");
  });
});

describe("previousFullMonthUtc", () => {
  it("covers the whole of last month", () => {
    const { start, end } = previousFullMonthUtc(new Date("2026-09-01T10:00:00Z"));
    expect(ymd(start)).toBe("2026-08-01");
    expect(hms(start)).toBe("00:00:00");
    expect(ymd(end)).toBe("2026-08-31");
    expect(hms(end)).toBe("23:59:59");
  });

  it("excludes the month in progress when run mid-month", () => {
    const { start, end } = previousFullMonthUtc(new Date("2026-09-17T10:00:00Z"));
    expect(ymd(start)).toBe("2026-08-01");
    expect(ymd(end)).toBe("2026-08-31");
  });

  it("ends a 30-day month on the 30th", () => {
    const { end } = previousFullMonthUtc(new Date("2026-05-03T10:00:00Z"));
    expect(ymd(end)).toBe("2026-04-30");
  });

  it("ends a 28-day February on the 28th", () => {
    const { end } = previousFullMonthUtc(new Date("2026-03-01T10:00:00Z"));
    expect(ymd(end)).toBe("2026-02-28");
  });

  it("ends a leap February on the 29th", () => {
    const { end } = previousFullMonthUtc(new Date("2028-03-01T10:00:00Z"));
    expect(ymd(end)).toBe("2028-02-29");
  });

  it("returns December of the prior year when run in January", () => {
    const { start, end } = previousFullMonthUtc(new Date("2027-01-01T10:00:00Z"));
    expect(ymd(start)).toBe("2026-12-01");
    expect(ymd(end)).toBe("2026-12-31");
  });
});

// The three functions are used interchangeably by the schedulers, so they must
// agree on their shape. A monthly that returned {from, to} would fail only at
// send time.
describe("all three boundary functions agree on shape", () => {
  const now = new Date("2026-09-01T10:00:00Z");
  for (const [name, fn] of [
    ["previousFullDayUtc", previousFullDayUtc],
    ["previousFullWeekUtc", previousFullWeekUtc],
    ["previousFullMonthUtc", previousFullMonthUtc],
  ]) {
    it(`${name} returns Date start and end, with start before end`, () => {
      const { start, end } = fn(now);
      expect(start).toBeInstanceOf(Date);
      expect(end).toBeInstanceOf(Date);
      expect(start.getTime()).toBeLessThan(end.getTime());
      expect(end.getTime()).toBeLessThan(now.getTime());
    });
  }
});
