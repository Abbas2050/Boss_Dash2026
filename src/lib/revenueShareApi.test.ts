// @vitest-environment node
//
// The revenue-share data layer.
//
// Verified directly against the live API on 2026-08-25: all three endpoints
// nest their rows in an object -- /History/aggregate and /History/volume
// under `items` (aggregate also carries `totals`, `fromTimestamp`,
// `toTimestamp`), /History/deals under `deals`. None of them are bare
// arrays. Unwrapping must throw on a shape it doesn't recognise rather than
// silently returning [] -- an empty table and a broken backend must not look
// the same. A genuinely empty result (the right key holding an empty array)
// is not an error and must still return [].
import { afterEach, describe, it, expect, vi } from "vitest";
import { unwrapDeals, unwrapItems, isErrorRow, fetchRevenueShare, fetchVolume, fetchDeals } from "./revenueShareApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unwrapDeals", () => {
  it("reads rows from the nested deals array", () => {
    const payload = {
      login: 101487,
      lpName: "B2B Coverage account",
      fromTimestamp: 1785528000,
      toTimestamp: 1787601599,
      totalDeals: 2,
      deals: [{ dealTicket: 1 }, { dealTicket: 2 }],
    };
    expect(unwrapDeals(payload)).toHaveLength(2);
  });

  // The live endpoint returned deals: [] on every sample taken while writing
  // this, so the empty case is the common one, not the edge case.
  it("returns an empty array when the LP had no deals", () => {
    expect(unwrapDeals({ login: 1, totalDeals: 0, deals: [] })).toEqual([]);
  });

  // An unrecognised shape must throw, not disappear as an empty table. A
  // silent [] here is indistinguishable from "this LP had no deals" -- that
  // was the actual bug being fixed.
  it("throws on an unexpected shape instead of returning an empty array", () => {
    expect(() => unwrapDeals(null)).toThrow(/deals/i);
    expect(() => unwrapDeals(undefined)).toThrow(/deals/i);
    expect(() => unwrapDeals({})).toThrow(/deals/i);
    expect(() => unwrapDeals({ deals: null })).toThrow(/deals/i);
    expect(() => unwrapDeals("nope")).toThrow(/deals/i);
  });

  it("names the endpoint and the keys actually present when it throws", () => {
    try {
      unwrapDeals({ error: "upstream timeout" });
      throw new Error("expected unwrapDeals to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("/History/deals");
      expect(message).toContain("error");
    }
  });

  // If the backend ever returns a bare array here, accept it rather than
  // showing the user nothing.
  it("accepts a bare array too", () => {
    expect(unwrapDeals([{ dealTicket: 7 }])).toHaveLength(1);
  });
});

describe("unwrapItems", () => {
  it("reads rows from the nested items array", () => {
    const payload = {
      items: [{ login: 1 }, { login: 2 }, { login: 3 }],
      totals: { grossProfit: 100 },
      fromTimestamp: 1785528000,
      toTimestamp: 1787601599,
    };
    expect(unwrapItems(payload, "/History/aggregate")).toHaveLength(3);
  });

  it("returns an empty array when the period genuinely had no rows", () => {
    expect(unwrapItems({ items: [] }, "/History/aggregate")).toEqual([]);
  });

  // Same trap as unwrapDeals: a shape we don't recognise must throw, naming
  // which endpoint broke and what keys the payload actually had, so this
  // doesn't read as "no data for the period".
  it("throws on an unexpected shape instead of returning an empty array", () => {
    expect(() => unwrapItems(null, "/History/aggregate")).toThrow(/aggregate/);
    expect(() => unwrapItems(undefined, "/History/aggregate")).toThrow(/aggregate/);
    expect(() => unwrapItems({}, "/History/aggregate")).toThrow(/aggregate/);
    expect(() => unwrapItems({ items: null }, "/History/volume")).toThrow(/volume/);
    expect(() => unwrapItems("nope", "/History/volume")).toThrow(/volume/);
  });

  it("names the endpoint and the keys actually present when it throws", () => {
    try {
      unwrapItems({ error: "upstream timeout", code: 502 }, "/History/aggregate");
      throw new Error("expected unwrapItems to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("/History/aggregate");
      expect(message).toContain("error");
      expect(message).toContain("code");
    }
  });

  // If the backend ever returns a bare array here, accept it rather than
  // showing the user nothing.
  it("accepts a bare array too", () => {
    expect(unwrapItems([{ login: 1 }], "/History/aggregate")).toHaveLength(1);
  });
});

describe("isErrorRow", () => {
  it("is true only when the backend says so", () => {
    expect(isErrorRow({ isError: true })).toBe(true);
    expect(isErrorRow({ isError: false })).toBe(false);
    expect(isErrorRow({})).toBe(false);
  });
});

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const errorResponse = (status: number, body: string) => ({
  ok: false,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
});

describe("fetchRevenueShare / fetchVolume unwrap items", () => {
  it("fetchRevenueShare returns the nested items array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ items: [{ login: 1 }], totals: {}, fromTimestamp: 0, toTimestamp: 0 })),
    );
    const rows = await fetchRevenueShare("2026-08-01", "2026-08-25");
    expect(rows).toEqual([{ login: 1 }]);
  });

  it("fetchVolume returns the nested items array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ items: [{ login: 2 }] })));
    const rows = await fetchVolume("2026-08-01", "2026-08-25");
    expect(rows).toEqual([{ login: 2 }]);
  });

  it("fetchRevenueShare throws rather than silently rendering an empty table on a broken payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ error: "db unavailable" })));
    await expect(fetchRevenueShare("2026-08-01", "2026-08-25")).rejects.toThrow(/aggregate/);
  });

  it("fetchDeals throws rather than silently rendering an empty table on a broken payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ error: "db unavailable" })));
    await expect(fetchDeals(101487, "2026-08-01", "2026-08-25")).rejects.toThrow(/deals/i);
  });
});

describe("getJson error body (via the fetch* wrappers)", () => {
  it("includes the response body in the thrown error on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, '{"message":"upstream LP feed timed out"}')));
    await expect(fetchRevenueShare("2026-08-01", "2026-08-25")).rejects.toThrow(/upstream LP feed timed out/);
  });

  it("truncates a very long response body rather than dumping it whole", async () => {
    const longBody = "x".repeat(5000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(502, longBody)));
    try {
      await fetchRevenueShare("2026-08-01", "2026-08-25");
      throw new Error("expected fetchRevenueShare to reject");
    } catch (err) {
      const message = (err as Error).message;
      expect(message.length).toBeLessThan(longBody.length);
      expect(message).toContain("502");
    }
  });
});

import { readFileSync } from "fs";
import path from "path";

// lpPL = realLpPL x ntpPercent / 100 is the backend's calculation, verified in
// the live payload: 1,196,755.75 x 20% = 239,351.15. If this UI ever computes
// it too, the two will drift and an LP gets paid the wrong number.
describe("the revenue share is never recomputed here", () => {
  const FILES = [
    "src/lib/revenueShareApi.ts",
    "src/pages/departments/dealing/RevenueShareTab.tsx",
  ];

  for (const file of FILES) {
    it(`${file} does no arithmetic on ntpPercent or realLpPL`, () => {
      let source: string;
      try {
        source = readFileSync(path.resolve(file), "utf8");
      } catch {
        return; // not created yet; Task 3 adds the component
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const offenders = [
        /ntpPercent\s*[*/]/,
        /[*/]\s*ntpPercent/,
        /realLpPL\s*[*/]/,
        /[*/]\s*realLpPL/,
      ].filter((re) => re.test(code));
      expect(
        offenders.map(String),
        "lpPL comes from the backend. Render it; do not derive it.",
      ).toEqual([]);
    });
  }
});
