import { describe, expect, it, vi, beforeEach } from "vitest";

// SEAM 1 (walletMonitor.js:163): checkAllBalances() reads
// `gs.unreadableFields` off the GoogleSheetsClient result and republishes it as
// `data.unreadableSheetFields`. Nothing upstream of that line was previously
// exercised end-to-end -- sheetCellReadability.test.js proves pspClients.js
// *produces* `unreadable`, and excessFundsInputs.test.ts proves the frontend
// *consumes* `unreadableSheetFields`, but the republish in between had no test
// of its own. A reviewer showed that hardcoding `unreadableSheetFields: []` at
// that line leaves all 564 existing tests green.
//
// walletMonitor.js does `new GoogleSheetsClient()` (and friends) directly, with
// no constructor injection point, so the narrowest seam available without
// touching production code is the `./pspClients.js` module boundary itself:
// stub every exported client class so checkAllBalances() runs for real but
// never makes a network call, then control what the Google Sheets client
// hands back.
const mockGoogleSheetsGetBalance = vi.hoisted(() => vi.fn());

vi.mock("./pspClients.js", () => {
  const inertClient = () => ({
    getBalance: async () => ({ balance: 0, currencies: {} }),
  });
  return {
    BitpaceClient: vi.fn().mockImplementation(inertClient),
    LetKnowPayClient: vi.fn().mockImplementation(inertClient),
    OwnBitClient: vi.fn().mockImplementation(inertClient),
    HeroPaymentClient: vi.fn().mockImplementation(inertClient),
    GoogleSheetsClient: vi.fn().mockImplementation(() => ({
      getBalance: mockGoogleSheetsGetBalance,
    })),
  };
});

const { checkAllBalances } = await import("./walletMonitor.js");

// A GoogleSheetsClient#getBalance() result shaped the way pspClients.js really
// returns it (see getBalance()'s return block), overridable per test.
const sheetResult = (overrides = {}) => ({
  sheetUsed: "01/09/2026",
  match2pay: 10,
  deusXpay: 20,
  openPayed: 30,
  goldSouq: 40,
  fabAed: 1,
  fabUsd: 2,
  fabTotal: 3,
  mbme: 4,
  bankReceivable: 0,
  cryptoReceivable: 0,
  toBeDepositedIntoLPsK20: 0,
  toBeDepositedIntoLPsK21: 0,
  netAllCurrentBalance: 0,
  netBalanceAfterExpectedFunds: 0,
  differenceBetweenActualAndExpected: 0,
  creditByLPs: 0,
  goldSouqDeductionJ31: 0,
  unreadableFields: [],
  customValues: {},
  ...overrides,
});

describe("checkAllBalances() carries the sheet client's unreadable field list through (seam 1)", () => {
  beforeEach(() => {
    mockGoogleSheetsGetBalance.mockReset();
  });

  it("emits data.unreadableSheetFields carrying exactly what the sheet client reported", async () => {
    mockGoogleSheetsGetBalance.mockResolvedValue(
      sheetResult({ unreadableFields: ["goldSouq", "fabAed"] }),
    );

    const report = await checkAllBalances();

    expect(report.data.unreadableSheetFields).toEqual(["goldSouq", "fabAed"]);
  });

  it("emits an empty list when the sheet client reported nothing unreadable", async () => {
    mockGoogleSheetsGetBalance.mockResolvedValue(sheetResult({ unreadableFields: [] }));

    const report = await checkAllBalances();

    expect(report.data.unreadableSheetFields).toEqual([]);
  });

  it("still returns the widgets' historical balances alongside the unreadable list", async () => {
    // The fix is additive -- proving the list rides along must not also prove it
    // replaced anything. goldSouq should still be 40 even while flagged.
    mockGoogleSheetsGetBalance.mockResolvedValue(
      sheetResult({ goldSouq: 40, unreadableFields: ["goldSouq"] }),
    );

    const report = await checkAllBalances();

    const goldSouqWidget = report.data.widgets.find((w) => w.id === "googlesheets_goldsouq");
    expect(goldSouqWidget.balance).toBe(40);
    expect(report.data.unreadableSheetFields).toEqual(["goldSouq"]);
  });
});
