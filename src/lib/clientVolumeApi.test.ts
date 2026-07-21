import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVolumeRange, formatLocalYmd, fetchClientVolume } from "./clientVolumeApi";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe("fetchClientVolume", () => {
  it("requests the documented URL with group=* by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ byDate: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchClientVolume({ from: "2026-07-01", to: "2026-07-21" });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/ClientVolume/Run?");
    expect(url).toContain("from=2026-07-01");
    expect(url).toContain("to=2026-07-21");
    expect(url).toContain("group=*");
  });

  it("coerces numeric strings and fills missing fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({
      fromDate: "2026-07-01",
      toDate: "2026-07-21",
      totalLots: "84767.16",
      totalStocksLots: "72321",
      totalCfdLots: null,
      byDate: [{ date: "2026-07-20", lots: "483.5", stocksLots: null, cfdLots: "483.5" }],
    })));

    const r = await fetchClientVolume({ from: "2026-07-01", to: "2026-07-21" });

    expect(r.totalLots).toBe(84767.16);
    expect(r.totalStocksLots).toBe(72321);
    expect(r.totalCfdLots).toBe(0);
    expect(r.byDate).toEqual([{ date: "2026-07-20", lots: 483.5, stocksLots: 0, cfdLots: 483.5 }]);
  });

  it("returns an empty byDate when the field is missing or not an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ totalLots: 0 })));
    const r = await fetchClientVolume({ from: "2026-07-01", to: "2026-07-21" });
    expect(r.byDate).toEqual([]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));
    await expect(fetchClientVolume({ from: "2026-07-01", to: "2026-07-21" })).rejects.toThrow(/502/);
  });
});
