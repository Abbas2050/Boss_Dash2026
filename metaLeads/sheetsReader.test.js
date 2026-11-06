// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildRange, columnLetter, readHeaderAndRows } from "./sheetsReader.js";

const client = (values) => ({
  spreadsheets: { values: { get: vi.fn(async () => ({ data: { values } })) } },
});

const HEADER = ["id","created_time","ad_id","ad_name","adset_id","adset_name","campaign_id","campaign_name","form_id","form_name","is_organic","platform","email","phone_number","first_name","last_name","country","lead_status"];

describe("columnLetter", () => {
  it("names the columns the export uses", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(17)).toBe("R");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
  });
});

describe("buildRange", () => {
  it("asks for every column of the export from one row on", () => {
    expect(buildRange("Sheet1", 2)).toBe("'Sheet1'!A2:R");
  });

  // A tab called "Leads 2026" breaks an unquoted range, and a tab with an
  // apostrophe breaks a naively quoted one.
  it("quotes the tab name", () => {
    expect(buildRange("Leads 2026", 2)).toBe("'Leads 2026'!A2:R");
    expect(buildRange("Dave's tab", 2)).toBe("'Dave''s tab'!A2:R");
  });
});

describe("readHeaderAndRows", () => {
  it("reads the header and the rows after it on a full read", async () => {
    const sheets = client([HEADER, ["l:1"], ["l:2"]]);
    const result = await readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 1 },
      { getSheetsClient: () => sheets },
    );
    expect(sheets.spreadsheets.values.get).toHaveBeenCalledWith({
      spreadsheetId: "abc", range: "'Sheet1'!A1:R", majorDimension: "ROWS",
    });
    expect(result.header).toEqual(HEADER);
    expect(result.rows).toEqual([["l:1"], ["l:2"]]);
    expect(result.firstRowNumber).toBe(2);
  });

  // The windowed read: the header is fetched separately so the caller can
  // still verify it without pulling thousands of rows back every minute.
  it("fetches the header separately on a windowed read", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { values: [HEADER] } })
      .mockResolvedValueOnce({ data: { values: [["l:9"]] } });
    const result = await readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 31 },
      { getSheetsClient: () => ({ spreadsheets: { values: { get } } }) },
    );
    expect(get).toHaveBeenNthCalledWith(1, { spreadsheetId: "abc", range: "'Sheet1'!A1:R1", majorDimension: "ROWS" });
    expect(get).toHaveBeenNthCalledWith(2, { spreadsheetId: "abc", range: "'Sheet1'!A31:R", majorDimension: "ROWS" });
    expect(result.header).toEqual(HEADER);
    expect(result.rows).toEqual([["l:9"]]);
    expect(result.firstRowNumber).toBe(31);
  });

  it("answers no rows when the window is past the end of the sheet", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { values: [HEADER] } })
      .mockResolvedValueOnce({ data: {} });
    const result = await readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 999 },
      { getSheetsClient: () => ({ spreadsheets: { values: { get } } }) },
    );
    expect(result.rows).toEqual([]);
    expect(result.header).toEqual(HEADER);
  });

  it("answers an empty header for an empty sheet", async () => {
    const sheets = client([]);
    const result = await readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 1 },
      { getSheetsClient: () => sheets },
    );
    expect(result.header).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("lets a Google failure through to the caller", async () => {
    const get = vi.fn(async () => { throw new Error("The caller does not have permission"); });
    await expect(readHeaderAndRows(
      { spreadsheetId: "abc", tabName: "Sheet1", fromRow: 1 },
      { getSheetsClient: () => ({ spreadsheets: { values: { get } } }) },
    )).rejects.toThrow(/permission/);
  });
});
