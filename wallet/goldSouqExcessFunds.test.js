import { describe, expect, it, vi, beforeEach } from "vitest";
import { DEFAULT_GOOGLE_SHEETS_FIELDS } from "./googleSheetsMappingConfig.js";
import { addOrNull, widgetValue } from "../src/lib/excessFundsInputs";

// The bug this file exists for, seen on one page at one moment: the Closing
// Balance Report card said "Gold Souq $50,694.96" and the Excess Funds section
// directly below it said "Unavailable -- could not read Gold Souq". Both were
// reading the same sheet through the same request. K13 had parsed perfectly;
// the only thing missing was J32, the deduction, which was empty because
// nothing had been deducted.
//
// Every other test here runs one half of that chain. This one runs the whole
// of it -- real cell strings, real GoogleSheetsClient, real checkAllBalances(),
// real widgetValue() -- because the defect was never inside either half. It
// was the disagreement between them, and only a test that holds both at once
// can fail when it comes back.
//
// So the clients are stubbed at the module boundary (walletMonitor.js does
// `new GoogleSheetsClient()` with no injection point) but the sheet client is
// the REAL one, subclassed only to hand it a fake spreadsheets API. Everything
// between the raw cell text and the number on the card is production code.

// Raw cell text by cell address, as the sheet would return it. A cell absent
// from this map comes back with no valueRange at all, which is exactly how a
// genuinely empty cell arrives from Google.
const sheet = vi.hoisted(() => ({ cells: {} }));
// Which cell the deduction field is configured to read. Held here so a test can
// move it and prove the widget label follows the mapping rather than a row
// number someone typed into a template string.
const mapping = vi.hoisted(() => ({ deductionCell: "J32" }));

vi.mock("./googleSheetsMappingConfig.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Pinned to the defaults rather than to storage/google_sheets_wallet_mapping.json,
    // so the fixture below means the same thing on a machine where someone has
    // saved a custom mapping.
    loadGoogleSheetsMappingConfig: () => ({
      fields: actual.DEFAULT_GOOGLE_SHEETS_FIELDS.map((f) =>
        f.key === "goldSouqDeductionJ31" ? { ...f, cell: mapping.deductionCell } : { ...f },
      ),
      updatedAt: null,
      source: "default",
    }),
  };
});

vi.mock("./pspClients.js", async (importOriginal) => {
  const actual = await importOriginal();
  const inert = { balance: 0, currencies: {}, unvalued: [] };
  const inertClient = () => ({ getBalance: async () => inert });

  // A spreadsheets API answering from `sheet.cells`. batchGet is keyed by the
  // CELL in each requested range, not by field order, so a test seeds "K13" and
  // "J32" the way the workbook is actually addressed -- and moving a field to a
  // different cell really does change what it reads.
  const fakeSpreadsheets = () => ({
    spreadsheets: {
      values: {
        get: async () => ({ data: {} }),
        batchGet: async ({ ranges }) => ({
          data: {
            valueRanges: ranges.map((range) => {
              const cell = String(range).split("!").pop().toUpperCase();
              const raw = sheet.cells[cell];
              return raw === undefined ? {} : { values: [[raw]] };
            }),
          },
        }),
      },
    },
  });

  class FakeSheetsClient extends actual.GoogleSheetsClient {
    constructor() {
      super();
      this.spreadsheetId = "test-spreadsheet";
    }

    _getService() {
      return fakeSpreadsheets();
    }
  }

  return {
    ...actual,
    BitpaceClient: vi.fn().mockImplementation(inertClient),
    LetKnowPayClient: vi.fn().mockImplementation(inertClient),
    OwnBitClient: vi.fn().mockImplementation(inertClient),
    HeroPaymentClient: vi.fn().mockImplementation(inertClient),
    GoogleSheetsClient: FakeSheetsClient,
  };
});

const { checkAllBalances } = await import("./walletMonitor.js");

const DEDUCTION_KEY = "goldSouqDeductionJ31";
const CONFIGURED_DEDUCTION_CELL = DEFAULT_GOOGLE_SHEETS_FIELDS.find(
  (f) => f.key === DEDUCTION_KEY,
).cell;

// Every configured cell holding a plausible number, so nothing but the override
// under test can put a field into the unreadable list.
function seed(overrides = {}) {
  const cells = Object.fromEntries(DEFAULT_GOOGLE_SHEETS_FIELDS.map((f) => [f.cell, "1000"]));
  for (const [cell, raw] of Object.entries(overrides)) {
    if (raw === undefined) delete cells[cell];
    else cells[cell] = raw;
  }
  return cells;
}

// The exact raw values read off production via /api/wallet/google-sheets-debug
// on the day the two halves of the Accounts page disagreed. K13 carries the
// sheet's leading/trailing spaces; J32 has no valueRange at all.
const LIVE = {
  K13: "  50,694.96 ",
  J31: "0.00",
  J32: undefined,
};

const goldSouqOf = (report) => report.data.widgets.find((w) => w.id === "googlesheets_goldsouq");

// What the Excess Funds section computes for its Gold Souq term, built the way
// AccountsDepartment.tsx builds it.
const excessFundsGoldSouq = (report) =>
  addOrNull(
    widgetValue(report.data.widgets, "googlesheets_goldsouq", report.data.unreadableSheetFields),
  );

beforeEach(() => {
  mapping.deductionCell = "J32";
  sheet.cells = seed(LIVE);
});

describe("the card and the Excess Funds term agree about Gold Souq", () => {
  // The regression test proper. It fails if either side moves alone: each is
  // pinned to the live figure, and then to each other.
  it("gives today's live cells one answer, not two", async () => {
    const report = await checkAllBalances();

    const card = goldSouqOf(report).balance;
    const excessFunds = excessFundsGoldSouq(report);

    expect(card).toBe(50694.96);
    expect(excessFunds).toBe(50694.96);
    expect(excessFunds).toBe(card);
    expect(excessFunds).not.toBeNull();
  });

  it("does not name the empty deduction cell as unreadable", async () => {
    const report = await checkAllBalances();
    expect(report.data.unreadableSheetFields).toEqual([]);
    expect(report.data.unreadableSheetFields).not.toContain(DEDUCTION_KEY);
  });

  it("still subtracts a deduction that is actually there", async () => {
    sheet.cells = seed({ ...LIVE, J32: "1,000.00" });
    const report = await checkAllBalances();

    expect(goldSouqOf(report).balance).toBeCloseTo(49694.96, 2);
    expect(excessFundsGoldSouq(report)).toBeCloseTo(49694.96, 2);
    expect(report.data.unreadableSheetFields).toEqual([]);
  });
});

describe("the guard on the balance cell survives", () => {
  // The whole point of the unreadable list, and it must not have been traded
  // away for the fix above: K13 gone means the figure is gone, and Excess Funds
  // has to say so even though the card will happily print the invented 0.
  it("still makes Gold Souq unavailable when K13 cannot be read", async () => {
    sheet.cells = seed({ ...LIVE, K13: "#REF!" });
    const report = await checkAllBalances();

    expect(report.data.unreadableSheetFields).toEqual(["goldSouq"]);
    expect(excessFundsGoldSouq(report)).toBeNull();
    // Unchanged, and the reason the guard is needed: the card cannot tell.
    expect(goldSouqOf(report).balance).toBe(0);
  });

  it("still makes Gold Souq unavailable when the deduction cell holds a #REF!", async () => {
    sheet.cells = seed({ ...LIVE, J32: "#REF!" });
    const report = await checkAllBalances();

    expect(report.data.unreadableSheetFields).toEqual([DEDUCTION_KEY]);
    expect(excessFundsGoldSouq(report)).toBeNull();
  });

  // A blank REQUIRED cell is still a lost number, and vetoes its own widget
  // without touching Gold Souq's.
  it("still vetoes Match2Pay on a blank K9, and only Match2Pay", async () => {
    sheet.cells = seed({ ...LIVE, K9: "" });
    const report = await checkAllBalances();

    expect(report.data.unreadableSheetFields).toEqual(["match2pay"]);
    expect(
      widgetValue(report.data.widgets, "googlesheets_match2pay", report.data.unreadableSheetFields),
    ).toBeNull();
    expect(excessFundsGoldSouq(report)).toBe(50694.96);
  });

  it("keeps reading the accounting dash in the deduction as a real zero", async () => {
    sheet.cells = seed({ ...LIVE, J32: "  -   " });
    const report = await checkAllBalances();

    expect(report.data.unreadableSheetFields).toEqual([]);
    expect(goldSouqOf(report).balance).toBe(50694.96);
  });
});

describe("the deduction label names the cell it read", () => {
  it("names the configured cell, which is no longer J31", async () => {
    const report = await checkAllBalances();

    expect(CONFIGURED_DEDUCTION_CELL).toBe("J32");
    expect(goldSouqOf(report).name).toBe(
      `Gold Souq (-$0.00 deducted, ${CONFIGURED_DEDUCTION_CELL})`,
    );
    // The stale row the key still spells, and the one the label used to print.
    expect(goldSouqOf(report).name).not.toContain("J31");
  });

  // Derivation, not a coincidence: move the mapping and the label moves with
  // it. Rows have shifted under this field twice already (J30, J31, now J32).
  it("follows the mapping when the deduction cell moves again", async () => {
    mapping.deductionCell = "J77";
    sheet.cells = seed({ ...LIVE, J77: "250.00" });
    const report = await checkAllBalances();

    expect(goldSouqOf(report).name).toBe("Gold Souq (-$250.00 deducted, J77)");
    expect(goldSouqOf(report).balance).toBeCloseTo(50444.96, 2);
  });
});
