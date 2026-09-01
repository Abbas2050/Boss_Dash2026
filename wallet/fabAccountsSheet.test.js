import { describe, expect, it } from "vitest";
import { parseSheetNumber, describeSheetError } from "./fabAccountsSheet.js";
import { DEFAULT_FAB_ACCOUNTS_MAPPING } from "./fabAccountsMappingConfig.js";

describe("parseSheetNumber", () => {
  it("reads a plain number", () => expect(parseSheetNumber("1234.56")).toBe(1234.56));

  // Sheets hand back display strings, not numbers.
  it("strips currency formatting", () => {
    expect(parseSheetNumber("$1,234,567.89")).toBe(1234567.89);
    expect(parseSheetNumber("AED 12,000")).toBe(12000);
  });

  it("reads a negative in accounting parentheses", () => {
    expect(parseSheetNumber("(1,234.56)")).toBe(-1234.56);
  });

  it("reads a genuine zero as zero, not as missing", () => {
    expect(parseSheetNumber("0")).toBe(0);
    expect(parseSheetNumber("$0.00")).toBe(0);
  });

  // An empty or unreadable cell is NOT a balance of zero. Returning 0 here is
  // the exact failure this design exists to prevent.
  it("returns null for an empty or unreadable cell", () => {
    for (const bad of ["", "   ", null, undefined, "#REF!", "N/A", "-"]) {
      expect(parseSheetNumber(bad)).toBeNull();
    }
  });
});

describe("describeSheetError", () => {
  // A permission failure is the likeliest first error: the sheet exists but was
  // never shared with the service account. The message must say so and name the
  // account, or whoever reads the log has to go and find it.
  it("names the service account when access is denied", () => {
    const msg = describeSheetError(
      { code: 403, message: "The caller does not have permission" },
      { spreadsheetId: "abc123", tab: "Sheet1", account: "svc@project.iam.gserviceaccount.com" },
    );
    expect(msg).toContain("abc123");
    expect(msg).toContain("svc@project.iam.gserviceaccount.com");
    expect(msg).toMatch(/share/i);
  });

  it("names the tab when the tab is missing", () => {
    const msg = describeSheetError(
      { code: 400, message: "Unable to parse range: NoSuchTab!B4" },
      { spreadsheetId: "abc123", tab: "NoSuchTab", account: "svc@x.com" },
    );
    expect(msg).toContain("NoSuchTab");
  });

  it("never returns an empty message", () => {
    expect(describeSheetError({}, { spreadsheetId: "x", tab: "y", account: "z" })).toBeTruthy();
  });
});

describe("the default mapping", () => {
  it("declares both cells so config, not code, locates them", () => {
    expect(Object.keys(DEFAULT_FAB_ACCOUNTS_MAPPING.cells).sort())
      .toEqual(["fabHolding", "fabOperating"]);
    expect(DEFAULT_FAB_ACCOUNTS_MAPPING.tab).toBeTruthy();
  });
});
