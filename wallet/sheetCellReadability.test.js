import { describe, expect, it } from "vitest";
import { GoogleSheetsClient } from "./pspClients.js";
import { DEFAULT_GOOGLE_SHEETS_FIELDS } from "./googleSheetsMappingConfig.js";

// The failure this exists for: one inserted row in the wallet workbook shifts
// every reference, a configured cell lands on an empty cell or a #REF!, and
// `parseFloat(...) || 0` reports it as a balance of 0.00 with status:'ok'. The
// Closing Balance Report has always shown that 0 and must go on showing it --
// so the fix is additive: the same 0, plus a list naming the fields it came from.

const client = () => new GoogleSheetsClient();

describe("_isCellReadable", () => {
  it("accepts a genuine zero, which is a real balance", () => {
    for (const good of ["0", 0, "0.00", "$0.00", "AED 0"]) {
      expect(client()._isCellReadable(good)).toBe(true);
    }
  });

  it("accepts formatted and negative numbers", () => {
    for (const good of ["1,234.56", "$1,234,567.89", "-500", 42, "42"]) {
      expect(client()._isCellReadable(good)).toBe(true);
    }
  });

  it("rejects an empty, blank, #REF! or N/A cell", () => {
    for (const bad of [null, undefined, "", "   ", "#REF!", "#N/A", "N/A", "abc", "pending", "TBC"]) {
      expect(client()._isCellReadable(bad)).toBe(false);
    }
  });

  // The wallet sheet is in accounting number format, where a zero balance
  // renders as a lone dash instead of "0.00" -- verified against live
  // production data (K9/K18 in today's tab, match2pay and mbme) and confirmed
  // by the sheet owner as meaning zero, not "unknown". Whitespace around the
  // dash, and all three dash characters a sheet might contain, must read the
  // same way.
  it("accepts the accounting-format dash as a genuine zero", () => {
    for (const dash of ["-", "  -   ", "–", "—"]) {
      expect(client()._isCellReadable(dash)).toBe(true);
    }
  });

  // The two must agree exactly, or a cell could be called unreadable while
  // _parseCell is happily returning a number from it (or the reverse, which is
  // the bug). Unreadable is precisely the set where `|| 0` invents the zero --
  // except the lone dash, which is a genuine zero that _isCellReadable now
  // recognizes on purpose, so it is asserted separately above rather than
  // through the "invented" heuristic below (which would misclassify it).
  it("is unreadable exactly where _parseCell invents a zero", () => {
    const c = client();
    for (const raw of ["", "   ", "#REF!", "N/A", "abc", null, undefined, "0", "$0.00", "12", "-3.5", "1,000"]) {
      const invented = c._parseCell(raw) === 0 && !/0/.test(String(raw ?? ""));
      if (invented) expect(c._isCellReadable(raw)).toBe(false);
      if (c._isCellReadable(raw)) expect(Number.isFinite(c._parseCell(raw))).toBe(true);
    }
  });
});

// A fake batchGet returning one valueRange per configured field, in order.
function fakeSheets(rawByKey) {
  return {
    spreadsheets: {
      values: {
        batchGet: async () => ({
          data: {
            valueRanges: DEFAULT_GOOGLE_SHEETS_FIELDS.map((f) => {
              const raw = rawByKey[f.key];
              return raw === undefined ? {} : { values: [[raw]] };
            }),
          },
        }),
      },
    },
  };
}

const allGood = Object.fromEntries(DEFAULT_GOOGLE_SHEETS_FIELDS.map((f) => [f.key, "1000"]));

describe("_readWalletCells reports which fields it could not read", () => {
  it("reports nothing unreadable when every cell parses", async () => {
    const wallet = await client()._readWalletCells(fakeSheets(allGood), "01/09/2026");
    expect(wallet.unreadable).toEqual([]);
    expect(wallet.values.goldSouq).toBe(1000);
  });

  it("names the shifted field and still returns its historical 0", async () => {
    const wallet = await client()._readWalletCells(
      fakeSheets({ ...allGood, goldSouq: "#REF!" }),
      "01/09/2026",
    );
    expect(wallet.unreadable).toEqual(["goldSouq"]);
    // Unchanged display behaviour: the report goes on showing 0.00 for it.
    expect(wallet.values.goldSouq).toBe(0);
  });

  it("names an empty cell and a missing valueRange alike", async () => {
    const wallet = await client()._readWalletCells(
      fakeSheets({ ...allGood, fabAed: "", mbme: undefined }),
      "01/09/2026",
    );
    expect(wallet.unreadable.sort()).toEqual(["fabAed", "mbme"]);
  });

  it("never calls a genuine zero unreadable", async () => {
    const wallet = await client()._readWalletCells(
      fakeSheets({ ...allGood, goldSouq: "0", mbme: "$0.00" }),
      "01/09/2026",
    );
    expect(wallet.unreadable).toEqual([]);
    expect(wallet.values.goldSouq).toBe(0);
    expect(wallet.values.mbme).toBe(0);
  });

  // Regression test: exact raw cell values pulled from today's live tab via
  // /api/wallet/google-sheets-debug. Match2Pay (K9) and MBME (K18) are
  // genuine zero balances rendered as an accounting-format dash -- before the
  // fix this test fails because both landed in `unreadable`, which is what
  // made the Closing Balance Report show $0.00 for them while the Excess
  // Funds section directly below called them unavailable and could not total.
  it("today's live accounting-format dash data is not reported unreadable", async () => {
    const wallet = await client()._readWalletCells(
      fakeSheets({
        ...allGood,
        match2pay: "  -   ",
        deusXpay: "0.00",
        openPayed: "0.00",
        goldSouq: "  64,130.96 ",
        fabAed: "  51,681.20 ",
        mbme: "  -   ",
      }),
      "01/09/2026",
    );
    expect(wallet.unreadable).toEqual([]);
    expect(wallet.values.match2pay).toBe(0);
    expect(wallet.values.mbme).toBe(0);
  });
});
