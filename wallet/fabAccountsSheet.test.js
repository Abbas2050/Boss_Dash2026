import { beforeEach, describe, expect, it, vi } from "vitest";

// Stubbed so readFabAccounts can be exercised without a network or credentials.
// Both calls are captured so the requests themselves can be asserted -- the
// render option is the whole fix for the locale AND the date-order problem, and
// it is invisible in the result.
const spreadsheetsGet = vi.fn();
const valuesGet = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: class GoogleAuth {} },
    sheets: () => ({ spreadsheets: { get: spreadsheetsGet, values: { get: valuesGet } } }),
  },
}));

import {
  columnIndexToLetter,
  columnLetterToIndex,
  describeSheetError,
  dubaiCalendarDate,
  parseSheetNumber,
  readFabAccounts,
  tabNameForDate,
  toSheetsSerial,
} from "./fabAccountsSheet.js";
import { DEFAULT_FAB_ACCOUNTS_MAPPING, loadFabAccountsMapping } from "./fabAccountsMappingConfig.js";

// The serial the tests build their fixtures from. Derived here independently of
// the module under test, and anchored below against two serials that can be
// checked against a real Google Sheet, so a bug in the module's own epoch
// arithmetic cannot hide behind a matching bug in the fixtures.
const SHEETS_EPOCH_UTC = Date.UTC(1899, 11, 30);
function serialFor(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - SHEETS_EPOCH_UTC) / 86400000);
}

// A Date whose Dubai (UTC+4) calendar day is the one named. 08:00 UTC is noon in
// Dubai, comfortably inside the day from either direction.
function dubaiNoon(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 8, 0, 0));
}

// One row of the real sheet: date in A, operating in B, holding in C.
function row(year, month, day, operating, holding) {
  const cells = [serialFor(year, month, day)];
  if (operating !== undefined) cells[1] = operating;
  if (holding !== undefined) cells[2] = holding;
  return cells;
}

function stubSheet({ titles, rows }) {
  spreadsheetsGet.mockReset();
  valuesGet.mockReset();
  spreadsheetsGet.mockResolvedValue({
    data: { sheets: titles.map((title) => ({ properties: { title } })) },
  });
  valuesGet.mockResolvedValue({ data: { values: rows } });
}

beforeEach(() => {
  process.env.FAB_ACCOUNTS_SHEET_ID = "sheet-abc";
  process.env.GA4_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "svc@x.iam.gserviceaccount.com" });
});

describe("the mapping this suite's fixtures assume", () => {
  // Every fixture below puts the date in A, operating in B and holding in C.
  // If storage/fab_accounts_mapping.json ever moves them, the failures would be
  // baffling; fail here instead, saying exactly what changed.
  it("still describes the sheet as date=A, operating=B, holding=C from row 3", () => {
    expect(loadFabAccountsMapping().columns).toEqual({ date: "A", fabOperating: "B", fabHolding: "C" });
    expect(loadFabAccountsMapping().firstDataRow).toBe(3);
  });

  it("configures a shape, not fixed cells -- the cell moves every day", () => {
    expect(DEFAULT_FAB_ACCOUNTS_MAPPING).not.toHaveProperty("cells");
    expect(DEFAULT_FAB_ACCOUNTS_MAPPING.tabNamePattern).toContain("{MON}");
    expect(DEFAULT_FAB_ACCOUNTS_MAPPING.tabNamePattern).toContain("{YYYY}");
  });
});

describe("Sheets date serials", () => {
  // Anchors that can be verified against a live sheet: typing 2021-01-01 into a
  // cell and formatting it as a plain number shows 44197, and the epoch itself
  // puts 1900-01-01 at 2 (the Lotus leap-year bug is baked into the format).
  it("matches serials a real spreadsheet would show", () => {
    expect(toSheetsSerial({ year: 2021, month: 1, day: 1 })).toBe(44197);
    expect(toSheetsSerial({ year: 1900, month: 1, day: 1 })).toBe(2);
  });

  it("agrees with the fixtures' own arithmetic", () => {
    expect(toSheetsSerial({ year: 2026, month: 9, day: 1 })).toBe(serialFor(2026, 9, 1));
  });

  // "Today" is the Dubai calendar day, matching every scheduler in this project.
  // On a UTC host, 21:00 UTC is already tomorrow in Dubai; reading the host's
  // own day there would fetch yesterday's row for the first four hours of every
  // Dubai morning.
  it("takes today from Dubai, not from the host clock", () => {
    expect(dubaiCalendarDate(new Date("2026-09-01T21:00:00Z"))).toEqual({ year: 2026, month: 9, day: 2 });
    expect(dubaiCalendarDate(new Date("2026-09-01T19:59:00Z"))).toEqual({ year: 2026, month: 9, day: 1 });
  });
});

describe("the monthly tab name", () => {
  const pattern = DEFAULT_FAB_ACCOUNTS_MAPPING.tabNamePattern;

  it("derives the uppercase three-letter month for every month of the year", () => {
    const names = Array.from({ length: 12 }, (_, i) => tabNameForDate({ year: 2026, month: i + 1 }, pattern));
    expect(names).toEqual([
      "JAN 2026", "FEB 2026", "MAR 2026", "APR 2026", "MAY 2026", "JUN 2026",
      "JUL 2026", "AUG 2026", "SEP 2026", "OCT 2026", "NOV 2026", "DEC 2026",
    ]);
  });

  // September is the trap. Some ICU builds render its short form as "Sept", so
  // an implementation built on toLocaleString({ month: "short" }) would look for
  // a "SEPT 2026" tab that does not exist -- and would do it only on the hosts
  // with that ICU build, which is the worst way to find out.
  it("names September SEP, never SEPT", () => {
    expect(tabNameForDate({ year: 2026, month: 9 }, pattern)).toBe("SEP 2026");
    for (const name of Array.from({ length: 12 }, (_, i) => tabNameForDate({ year: 2026, month: i + 1 }, pattern))) {
      expect(name.split(" ")[0]).toHaveLength(3);
    }
  });

  it("rolls the year over with the tab", () => {
    expect(tabNameForDate({ year: 2027, month: 1 }, pattern)).toBe("JAN 2027");
  });
});

describe("A1 column letters", () => {
  it("round-trips single and double letters", () => {
    expect(columnLetterToIndex("A")).toBe(1);
    expect(columnLetterToIndex("C")).toBe(3);
    expect(columnLetterToIndex("AA")).toBe(27);
    expect(columnIndexToLetter(1)).toBe("A");
    expect(columnIndexToLetter(3)).toBe("C");
    expect(columnIndexToLetter(27)).toBe("AA");
  });
});

describe("readFabAccounts finds today's row", () => {
  it("matches the date serial rather than counting rows, so an inserted row cannot shift it", async () => {
    // Day-of-month + 2 says today (the 4th) is on row 6. Someone has inserted a
    // note row above the data, so the 4th is actually on row 7. Arithmetic gets
    // the 3rd's balances here; a search gets the right ones.
    stubSheet({
      titles: ["SEP 2026"],
      rows: [
        ["Inserted note row"],
        row(2026, 9, 1, 11, 21),
        row(2026, 9, 2, 12, 22),
        row(2026, 9, 3, 13, 23),
        row(2026, 9, 4, 14, 24),
        row(2026, 9, 5, 15, 25),
      ],
    });

    const result = await readFabAccounts({ now: dubaiNoon(2026, 9, 4) });

    expect(result.fabOperating).toBe(14);
    expect(result.fabHolding).toBe(24);
    // Row 3 + offset 4 = row 7, not the 6 that day-of-month + 2 would give.
    expect(result.source.cells).toEqual({ fabOperating: "B7", fabHolding: "C7" });
  });

  // The whole reason column A is read as a serial. "09/13/2026" and "13/09/2026"
  // are the same day written two ways, and a string comparison picks whichever
  // one the sheet happens to render -- silently right until the 13th, silently
  // wrong after it.
  it("resolves a date after the 12th, where MM/DD and DD/MM diverge", async () => {
    stubSheet({
      titles: ["SEP 2026"],
      rows: [
        row(2026, 9, 9, 109, 209),
        row(2026, 9, 13, 113, 213),
        row(2026, 9, 20, 120, 220),
      ],
    });

    const thirteenth = await readFabAccounts({ now: dubaiNoon(2026, 9, 13) });
    expect(thirteenth.fabOperating).toBe(113);
    expect(thirteenth.fabHolding).toBe(213);
    expect(thirteenth.source.cells.fabOperating).toBe("B4");

    // The 20th cannot be read as a month at all, so a swapped-order bug lands
    // somewhere else entirely rather than on a neighbouring day.
    stubSheet({
      titles: ["SEP 2026"],
      rows: [
        row(2026, 9, 9, 109, 209),
        row(2026, 9, 13, 113, 213),
        row(2026, 9, 20, 120, 220),
      ],
    });
    const twentieth = await readFabAccounts({ now: dubaiNoon(2026, 9, 20) });
    expect(twentieth.fabOperating).toBe(120);
    expect(twentieth.source.cells.fabHolding).toBe("C5");
  });

  it("asks Sheets for unformatted values over the quoted monthly tab", async () => {
    stubSheet({ titles: ["SEP 2026"], rows: [row(2026, 9, 1, 0, 0)] });

    await readFabAccounts({ now: dubaiNoon(2026, 9, 1) });

    expect(valuesGet).toHaveBeenCalledTimes(1);
    const request = valuesGet.mock.calls[0][0];
    expect(request.valueRenderOption).toBe("UNFORMATTED_VALUE");
    expect(request.spreadsheetId).toBe("sheet-abc");
    // Quoted, because "SEP 2026" has a space in it and an unquoted space in A1
    // notation is a parse error rather than a miss.
    expect(request.range).toBe("'SEP 2026'!A3:C");
  });
});

describe("readFabAccounts tells a zero from a blank", () => {
  // Both cells hold a real 0 in the live sheet today. Reporting that as
  // "unavailable" would hide a balance that has genuinely been counted.
  it("returns a genuine zero as 0, not as null", async () => {
    stubSheet({ titles: ["SEP 2026"], rows: [row(2026, 9, 1, 0, 0)] });

    const result = await readFabAccounts({ now: dubaiNoon(2026, 9, 1) });

    expect(result.fabOperating).toBe(0);
    expect(result.fabHolding).toBe(0);
    expect(result.fabOperating).not.toBeNull();
    expect(result.fabHolding).not.toBeNull();
  });

  // Today's row exists from the moment the month tab is made; the balances get
  // typed in later in the day. "Not filled in yet" is null and shows as
  // unavailable -- and it must not take the other, already-filled balance with
  // it.
  it("returns null for a blank cell while the filled one still reads", async () => {
    stubSheet({
      titles: ["SEP 2026"],
      rows: [
        row(2026, 9, 1, 5, 6),
        // Sheets drops trailing blanks, so a row with only C filled arrives with
        // an empty slot in the middle, and one with only B filled arrives short.
        [serialFor(2026, 9, 2), "", 4321],
      ],
    });

    const result = await readFabAccounts({ now: dubaiNoon(2026, 9, 2) });

    expect(result.fabOperating).toBeNull();
    expect(result.fabHolding).toBe(4321);
  });

  it("returns null for a balance the row does not reach at all", async () => {
    stubSheet({
      titles: ["SEP 2026"],
      rows: [[serialFor(2026, 9, 1), 777]],
    });

    const result = await readFabAccounts({ now: dubaiNoon(2026, 9, 1) });

    expect(result.fabOperating).toBe(777);
    expect(result.fabHolding).toBeNull();
  });
});

describe("readFabAccounts distinguishes its failures", () => {
  // It is the 1st of October and nobody has made the new tab. That is a person's
  // job, not a code fault, and the message has to say which tab to create and
  // show what is actually there so a typo in an existing name is visible.
  it("throws naming the expected tab and the tabs that exist when the month is missing", async () => {
    stubSheet({ titles: ["JUL 2026", "AUG 2026", "SEP 2026"], rows: [] });

    await expect(readFabAccounts({ now: dubaiNoon(2026, 10, 1) })).rejects.toThrow(/OCT 2026/);

    stubSheet({ titles: ["JUL 2026", "AUG 2026", "SEP 2026"], rows: [] });
    const error = await readFabAccounts({ now: dubaiNoon(2026, 10, 1) }).catch((e) => e);
    expect(error.message).toContain("SEP 2026");
    expect(error.message).toContain("AUG 2026");
    // Never a silent fall back to a month that does exist.
    expect(valuesGet).not.toHaveBeenCalled();
  });

  // The tab is there but today's row is not -- a month tab built short, or a row
  // deleted. Naming the date as well as the tab is what makes it findable.
  it("throws naming the tab and the date when today has no row", async () => {
    stubSheet({
      titles: ["SEP 2026"],
      rows: [row(2026, 9, 1, 1, 2), row(2026, 9, 2, 3, 4)],
    });

    const error = await readFabAccounts({ now: dubaiNoon(2026, 9, 15) }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("SEP 2026");
    expect(error.message).toContain("2026-09-15");
  });

  // A column of text that only looks like dates can never match a serial. Saying
  // so points at the actual fix instead of sending someone to look for a row
  // that is sitting right there.
  it("says so when column A holds text rather than real dates", async () => {
    stubSheet({ titles: ["SEP 2026"], rows: [["09/01/2026", 1, 2]] });

    const error = await readFabAccounts({ now: dubaiNoon(2026, 9, 1) }).catch((e) => e);

    expect(error.message).toMatch(/text, not real dates/i);
  });

  it("surfaces a permission failure naming the service account", async () => {
    spreadsheetsGet.mockReset();
    valuesGet.mockReset();
    spreadsheetsGet.mockRejectedValue(Object.assign(new Error("The caller does not have permission"), { code: 403 }));

    const error = await readFabAccounts({ now: dubaiNoon(2026, 9, 1) }).catch((e) => e);

    expect(error.message).toContain("svc@x.iam.gserviceaccount.com");
    expect(error.message).toMatch(/share/i);
  });
});

describe("readFabAccounts reports where each figure came from", () => {
  // A disputed figure has to be traceable to a cell without opening the server.
  // The page renders these as "SEP 2026!B7" under each card.
  it("returns the resolved tab and the real A1 addresses it read", async () => {
    stubSheet({
      titles: ["SEP 2026"],
      rows: [
        ["Inserted note row"],
        row(2026, 9, 1, 11, 21),
        row(2026, 9, 2, 12, 22),
      ],
    });

    const result = await readFabAccounts({ now: dubaiNoon(2026, 9, 2) });

    expect(result.source.tab).toBe("SEP 2026");
    expect(result.source.cells).toEqual({ fabOperating: "B5", fabHolding: "C5" });
    expect(result.source.spreadsheetId).toBe("sheet-abc");
    expect(typeof result.fetchedAt).toBe("string");
  });

  // The workbook's own spelling wins, so a hand-typed "Sep 2026" still reads and
  // the card note shows what is actually on the tab rather than what was wanted.
  it("uses the workbook's spelling of the tab when the case differs", async () => {
    stubSheet({ titles: ["Sep 2026"], rows: [row(2026, 9, 1, 8, 9)] });

    const result = await readFabAccounts({ now: dubaiNoon(2026, 9, 1) });

    expect(result.source.tab).toBe("Sep 2026");
    expect(valuesGet.mock.calls[0][0].range).toBe("'Sep 2026'!A3:C");
  });
});

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
      { spreadsheetId: "abc123", tab: "SEP 2026", account: "svc@project.iam.gserviceaccount.com" },
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

describe("the mapping config", () => {
  it("keeps the column letters and first data row configurable", () => {
    const mapping = loadFabAccountsMapping();
    expect(Object.keys(mapping.columns).sort()).toEqual(["date", "fabHolding", "fabOperating"]);
    expect(Number.isInteger(mapping.firstDataRow)).toBe(true);
    expect(mapping.tabNamePattern).toBeTruthy();
  });
});
