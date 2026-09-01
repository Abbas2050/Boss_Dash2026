import { describe, expect, it, vi } from "vitest";

// Stubbed so readFabAccounts can be exercised without a network or credentials.
// batchGet is captured so the request itself can be asserted -- the render
// option is the whole fix for the locale problem and is invisible in the result.
const batchGet = vi.fn(async () => ({
  data: { valueRanges: [{ values: [[1234.56]] }, { values: [[-98.75]] }] },
}));

vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: class GoogleAuth {} },
    sheets: () => ({ spreadsheets: { values: { batchGet } } }),
  },
}));

import { parseSheetNumber, describeSheetError, readFabAccounts } from "./fabAccountsSheet.js";
import { DEFAULT_FAB_ACCOUNTS_MAPPING, loadFabAccountsMapping } from "./fabAccountsMappingConfig.js";

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

  // Accounting number format renders a zero balance as a lone dash instead of
  // "0.00". That is a real zero, not a missing cell -- verified against live
  // production data (match2pay/mbme in the wallet workbook), and confirmed by
  // the sheet owner.
  it("reads the accounting-format dash as zero, not as missing", () => {
    for (const dash of ["-", "  -   ", "–", "—"]) {
      expect(parseSheetNumber(dash)).toBe(0);
    }
  });

  // An empty or unreadable cell is NOT a balance of zero. Returning 0 here is
  // the exact failure this design exists to prevent.
  it("returns null for an empty or unreadable cell", () => {
    for (const bad of ["", "   ", null, undefined, "#REF!", "N/A"]) {
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

// Why the render option matters, and why parseSheetNumber alone is not enough.
describe("the sheet's own locale must never reach parseSheetNumber", () => {
  // parseSheetNumber strips everything but [0-9.-], so a comma-decimal display
  // string loses its decimal comma and keeps its thousands dot. The result is a
  // plausible WRONG number -- 1.23456 instead of 1234.56 -- which is worse than
  // a loud failure on a treasury figure. Nobody has seen this workbook's locale.
  it("mangles a European-formatted display string, so it must not receive one", () => {
    expect(parseSheetNumber("1.234,56")).toBe(1.23456);
    expect(parseSheetNumber("1.234,56")).not.toBe(1234.56);
  });

  // The fallback still has to work for the day a string arrives anyway.
  it("still reads the US-formatted display string correctly", () => {
    expect(parseSheetNumber("1,234.56")).toBe(1234.56);
  });

  // UNFORMATTED_VALUE hands back the underlying number, which has no locale at
  // all. This is the actual fix; the parser is only the safety net.
  it("reads a raw number straight through, decimals and sign intact", () => {
    expect(parseSheetNumber(1234.56)).toBe(1234.56);
    expect(parseSheetNumber(-98.75)).toBe(-98.75);
    expect(parseSheetNumber(0)).toBe(0);
  });
});

describe("readFabAccounts asks Sheets for unformatted values", () => {
  it("sends valueRenderOption UNFORMATTED_VALUE and reads the raw numbers back", async () => {
    process.env.FAB_ACCOUNTS_SHEET_ID = "sheet-abc";
    process.env.GA4_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "svc@x.iam.gserviceaccount.com" });
    batchGet.mockClear();

    const result = await readFabAccounts();

    expect(batchGet).toHaveBeenCalledTimes(1);
    expect(batchGet.mock.calls[0][0].valueRenderOption).toBe("UNFORMATTED_VALUE");
    expect(batchGet.mock.calls[0][0].spreadsheetId).toBe("sheet-abc");
    expect(result.fabOperating).toBe(1234.56);
    expect(result.fabHolding).toBe(-98.75);
    // The cells it read are reported back, so a wrong figure can be traced to
    // the cell it came from without opening the server. Compared against the
    // live mapping, not the defaults: storage/fab_accounts_mapping.json is
    // edited by hand and may legitimately differ.
    const mapping = loadFabAccountsMapping();
    expect(result.source.tab).toBe(mapping.tab);
    expect(result.source.cells).toEqual(mapping.cells);
    expect(batchGet.mock.calls[0][0].ranges).toEqual([
      `${mapping.tab}!${mapping.cells.fabOperating}`,
      `${mapping.tab}!${mapping.cells.fabHolding}`,
    ]);
  });
});
