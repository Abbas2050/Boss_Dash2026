import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

// SEAM 2 (walletMonitor.js:215): the `timestamp` field on the report.
//
// This reproduces the reported bug end-to-end: checkAllBalances() builds
// `timestamp` from `generatedAt`, the frontend parses it back with
// `new Date(str.replace(' ', 'T'))` (AccountsDepartment.tsx /
// BackOfficeDepartment.tsx before the fix -- both did exactly this), and the
// three "freshness" stamps are rendered in Dubai time. The old
// `.toISOString().replace('T', ' ').slice(0, 19)` dropped the trailing "Z",
// so `new Date(...)` on the frontend parsed the string as LOCAL time instead
// of UTC. On a machine whose local zone IS Dubai (UTC+4) -- e.g. the server,
// or a phone set to Dubai -- a UTC instant of 21:22:35 got re-interpreted as
// 21:22:35 *Dubai* time, four hours (and, near midnight, a whole calendar
// day) off from the correct 01:22:35 the next day. That is precisely what
// was seen in production: "Wallet Sep 01, 21:22:35" instead of "Sep 02,
// 01:22:35".
//
// Pinning process.env.TZ here is deliberate: on a UTC CI box, the old buggy
// code and the fixed code produce the SAME output (parsing a zone-less string
// as UTC-local is a no-op when local IS UTC), so a test that never leaves the
// default UTC timezone would pass whether the bug is present or not. Setting
// TZ to Asia/Dubai reproduces the real failure.
describe("checkAllBalances() timestamp survives frontend parsing across the date line (seam 2)", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    mockGoogleSheetsGetBalance.mockReset();
    mockGoogleSheetsGetBalance.mockResolvedValue(sheetResult());
    vi.useFakeTimers();
    // Machine/server local timezone at the time of the reported bug.
    process.env.TZ = "Asia/Dubai";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // Mirrors AccountsDepartment.tsx / BackOfficeDepartment.tsx's parsing of
  // `response.timestamp` prior to the fix (still harmless afterwards, since
  // the fixed timestamp has no space to replace).
  function parseAsFrontendDid(timestamp) {
    return new Date(String(timestamp).replace(" ", "T"));
  }

  it("renders as 2 September, 01:22:35 Dubai for a UTC instant of 2026-09-01T21:22:35Z, not 1 September 21:22:35", async () => {
    vi.setSystemTime(new Date("2026-09-01T21:22:35.000Z"));

    const report = await checkAllBalances();
    const parsed = parseAsFrontendDid(report.timestamp);

    expect(Number.isNaN(parsed.getTime())).toBe(false);
    const rendered = parsed.toLocaleString("en-US", {
      timeZone: "Asia/Dubai",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    expect(rendered).toBe("Sep 02, 01:22:35");
    expect(rendered).not.toBe("Sep 01, 21:22:35");
  });

  it("derives a Dubai report date of 2026-09-02 for that instant, not 2026-09-01", async () => {
    vi.setSystemTime(new Date("2026-09-01T21:22:35.000Z"));

    const report = await checkAllBalances();
    const parsed = parseAsFrontendDid(report.timestamp);

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Dubai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed);
    const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const dubaiDate = `${byType.year}-${byType.month}-${byType.day}`;

    expect(dubaiDate).toBe("2026-09-02");
    expect(dubaiDate).not.toBe("2026-09-01");
  });

  it("still renders correctly for an instant that does not cross the date line", async () => {
    vi.setSystemTime(new Date("2026-09-01T06:00:00.000Z"));

    const report = await checkAllBalances();
    const parsed = parseAsFrontendDid(report.timestamp);

    const rendered = parsed.toLocaleString("en-US", {
      timeZone: "Asia/Dubai",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    expect(rendered).toBe("Sep 01, 10:00:00");
  });

  it("emits a full ISO-8601 instant with its zone designator, not a bare 19-character date-time", async () => {
    vi.setSystemTime(new Date("2026-09-01T21:22:35.000Z"));

    const report = await checkAllBalances();

    expect(report.timestamp).toMatch(/Z$/);
    expect(report.timestamp).toBe("2026-09-01T21:22:35.000Z");
  });
});
