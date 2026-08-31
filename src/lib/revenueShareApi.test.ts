// @vitest-environment node
//
// The revenue-share data layer.
//
// Two shape traps live here. /History/deals returns an OBJECT with rows nested
// under .deals, while /History/aggregate and /History/volume return bare arrays
// — treating deals like the other two yields an empty grid with no error. And
// every aggregate/volume row carries isError/errorMessage, so a failed LP must
// show its message rather than a plausible zero.
import { describe, it, expect } from "vitest";
import { unwrapDeals, isErrorRow } from "./revenueShareApi";

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

  it("returns an empty array rather than throwing on an unexpected shape", () => {
    expect(unwrapDeals(null)).toEqual([]);
    expect(unwrapDeals(undefined)).toEqual([]);
    expect(unwrapDeals({})).toEqual([]);
    expect(unwrapDeals({ deals: null })).toEqual([]);
    expect(unwrapDeals("nope")).toEqual([]);
  });

  // If the backend ever returns a bare array here, accept it rather than
  // showing the user nothing.
  it("accepts a bare array too", () => {
    expect(unwrapDeals([{ dealTicket: 7 }])).toHaveLength(1);
  });
});

describe("isErrorRow", () => {
  it("is true only when the backend says so", () => {
    expect(isErrorRow({ isError: true })).toBe(true);
    expect(isErrorRow({ isError: false })).toBe(false);
    expect(isErrorRow({})).toBe(false);
  });
});
