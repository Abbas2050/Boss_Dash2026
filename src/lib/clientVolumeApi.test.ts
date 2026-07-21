import { describe, expect, it } from "vitest";
import { resolveVolumeRange, formatLocalYmd } from "./clientVolumeApi";

// 2026-07-21 is a Tuesday. Constructed via local-time args on purpose.
const tue = new Date(2026, 6, 21, 15, 30, 0);

describe("formatLocalYmd", () => {
  it("formats local date parts, not UTC", () => {
    expect(formatLocalYmd(new Date(2026, 6, 21, 23, 59, 0))).toBe("2026-07-21");
    expect(formatLocalYmd(new Date(2026, 0, 5, 0, 30, 0))).toBe("2026-01-05");
  });
});

describe("resolveVolumeRange", () => {
  it("today = same day both ends", () => {
    expect(resolveVolumeRange("today", tue)).toEqual({ from: "2026-07-21", to: "2026-07-21" });
  });

  it("yesterday = previous day both ends", () => {
    expect(resolveVolumeRange("yesterday", tue)).toEqual({ from: "2026-07-20", to: "2026-07-20" });
  });

  it("week = Monday of the current week through today", () => {
    expect(resolveVolumeRange("week", tue)).toEqual({ from: "2026-07-20", to: "2026-07-21" });
  });

  it("week on a Sunday uses the Monday that began that week", () => {
    const sun = new Date(2026, 6, 26, 9, 0, 0); // Sunday 26 Jul 2026
    expect(resolveVolumeRange("week", sun)).toEqual({ from: "2026-07-20", to: "2026-07-26" });
  });

  it("week on a Monday starts that same day", () => {
    const mon = new Date(2026, 6, 20, 9, 0, 0);
    expect(resolveVolumeRange("week", mon)).toEqual({ from: "2026-07-20", to: "2026-07-20" });
  });

  it("month = 1st through today", () => {
    expect(resolveVolumeRange("month", tue)).toEqual({ from: "2026-07-01", to: "2026-07-21" });
  });

  it("month on the 1st is a single day", () => {
    const first = new Date(2026, 6, 1, 8, 0, 0);
    expect(resolveVolumeRange("month", first)).toEqual({ from: "2026-07-01", to: "2026-07-01" });
  });

  it("yesterday crosses a month boundary", () => {
    const firstOfAug = new Date(2026, 7, 1, 8, 0, 0);
    expect(resolveVolumeRange("yesterday", firstOfAug)).toEqual({ from: "2026-07-31", to: "2026-07-31" });
  });

  it("yesterday crosses a year boundary", () => {
    const newYear = new Date(2027, 0, 1, 8, 0, 0);
    expect(resolveVolumeRange("yesterday", newYear)).toEqual({ from: "2026-12-31", to: "2026-12-31" });
  });

  it("week crosses a month boundary", () => {
    const thu = new Date(2026, 7, 6, 9, 0, 0); // Thu 6 Aug 2026; that week's Monday is 3 Aug
    expect(resolveVolumeRange("week", thu)).toEqual({ from: "2026-08-03", to: "2026-08-06" });
  });
});
