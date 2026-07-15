import { describe, expect, it } from "vitest";
import { normalizeApplicationId } from "./appId.js";

describe("normalizeApplicationId", () => {
  it("passes through a plain numeric id", () => {
    expect(normalizeApplicationId("3892")).toBe("3892");
  });
  it("extracts the id from an FXBO HTML anchor", () => {
    expect(
      normalizeApplicationId('<a href="https://portal.skylinkscapital.com/crm/applications/3892/view/">3892</a>')
    ).toBe("3892");
  });
  it("returns empty for the spreadsheet header row", () => {
    expect(normalizeApplicationId("Application ID + Link")).toBe("");
  });
  it("returns empty for null/undefined/blank", () => {
    expect(normalizeApplicationId(null)).toBe("");
    expect(normalizeApplicationId(undefined)).toBe("");
    expect(normalizeApplicationId("   ")).toBe("");
  });
  it("trims whitespace around a numeric id", () => {
    expect(normalizeApplicationId("  3525\n")).toBe("3525");
  });
  it("accepts a number input", () => {
    expect(normalizeApplicationId(3525)).toBe("3525");
  });
  it("leaves an opaque non-numeric id unchanged", () => {
    expect(normalizeApplicationId("APP-TEST-001")).toBe("APP-TEST-001");
  });
});
