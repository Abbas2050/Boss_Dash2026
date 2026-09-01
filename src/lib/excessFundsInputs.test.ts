import { describe, expect, it } from "vitest";
import { addOrNull, widgetValue, WIDGET_SHEET_FIELDS } from "./excessFundsInputs";
import { computeExcessFunds, type ExcessFundsInputs } from "./excessFunds";
import type { WalletBalancesResponse, WalletWidgetEntry } from "./walletApi";

// A closing-balance payload as walletMonitor.js builds it when the WHOLE sheet
// read succeeded. Every Google Sheets widget is status:'ok' with a number --
// which is exactly the state a shifted row produces, because
// `parseFloat(...) || 0` turns an empty cell or a #REF! into a perfectly
// plausible 0.00 and nothing downstream can tell.
const widgets = (over: Partial<Record<string, number>> = {}): WalletWidgetEntry[] =>
  [
    { id: "bitpace", name: "Bitpace", balance: 10, status: "ok" },
    { id: "letknowpay", name: "LetKnow Pay", balance: 20, status: "ok" },
    { id: "ownbit", name: "OwnBit", balance: 30, status: "ok" },
    { id: "ownbitnew", name: "OwnBit New", balance: 40, status: "ok" },
    { id: "heropayment", name: "HeroPayment", balance: 50, status: "ok" },
    { id: "googlesheets_match2pay", name: "Match2Pay", balance: 60, status: "ok" },
    { id: "googlesheets_deusxpay", name: "DeusXpay", balance: 70, status: "ok" },
    { id: "googlesheets_openpayed", name: "OpenPayed", balance: 80, status: "ok" },
    { id: "googlesheets_goldsouq", name: "Gold Souq", balance: 100000, status: "ok" },
    { id: "googlesheets_fab", name: "FAB Bank", balance: 250000, status: "ok" },
    { id: "googlesheets_mbme", name: "MBME", balance: 0, status: "ok" },
  ].map((w) => (over[w.id] === undefined ? w : { ...w, balance: over[w.id] as number }));

const CRYPTO_IDS = [
  "bitpace",
  "letknowpay",
  "ownbit",
  "ownbitnew",
  "heropayment",
  "googlesheets_match2pay",
  "googlesheets_deusxpay",
  "googlesheets_openpayed",
];

// The same three widget-derived terms AccountsDepartment.tsx builds, kept in one
// place so the payload-level assertions below exercise the real mapping rather
// than a paraphrase of it.
function inputsFromPayload(payload: WalletBalancesResponse): ExcessFundsInputs {
  const list = payload.data?.widgets ?? [];
  const unreadable = payload.data?.unreadableSheetFields ?? [];
  const read = (id: string) => widgetValue(list, id, unreadable);
  return {
    netDifference: -1190369.63,
    netCrypto: addOrNull(...CRYPTO_IDS.map(read)),
    fabAndMbme: addOrNull(read("googlesheets_fab"), read("googlesheets_mbme")),
    goldSouq: addOrNull(read("googlesheets_goldsouq")),
    fabOperating: 300000,
    fabHolding: 200000,
  };
}

const payload = (
  list: WalletWidgetEntry[],
  unreadableSheetFields: string[] = [],
): WalletBalancesResponse => ({ ok: true, data: { widgets: list, unreadableSheetFields } });

describe("the sheet-field to widget map", () => {
  // A wrong entry here reintroduces the silent zero somewhere new, so the pairs
  // are pinned against walletMonitor.js by hand.
  it("pairs each sheet-backed widget with every field its balance is built from", () => {
    expect(WIDGET_SHEET_FIELDS).toEqual({
      googlesheets_match2pay: ["match2pay"],
      googlesheets_deusxpay: ["deusXpay"],
      googlesheets_openpayed: ["openPayed"],
      googlesheets_goldsouq: ["goldSouq", "goldSouqDeductionJ31"],
      googlesheets_fab: ["fabAed", "fabUsd"],
      googlesheets_mbme: ["mbme"],
    });
  });

  it("leaves the non-sheet PSPs unmapped, so their own status is the only gate", () => {
    for (const id of ["bitpace", "letknowpay", "ownbit", "ownbitnew", "heropayment"]) {
      expect(WIDGET_SHEET_FIELDS[id]).toBeUndefined();
    }
  });
});

describe("an unreadable sheet cell is not a balance", () => {
  it("nulls Gold Souq and both figures when goldSouq could not be read", () => {
    const inputs = inputsFromPayload(payload(widgets(), ["goldSouq"]));
    expect(inputs.goldSouq).toBeNull();

    const { gross, net } = computeExcessFunds(inputs);
    expect(gross.value).toBeNull();
    expect(net.value).toBeNull();
    expect(gross.missing).toContain("Gold Souq");
    expect(net.missing).toContain("Gold Souq");
  });

  // The Gold Souq widget's balance is goldSouq MINUS the J-column deduction, so
  // an unreadable deduction corrupts the figure just as completely.
  it("nulls Gold Souq when only its deduction cell could not be read", () => {
    expect(inputsFromPayload(payload(widgets(), ["goldSouqDeductionJ31"])).goldSouq).toBeNull();
  });

  // googlesheets_fab is fabAed + fabUsd. Half of a sum is not a sum.
  it("nulls FAB & MBME when either half of the FAB pair is unreadable", () => {
    expect(inputsFromPayload(payload(widgets(), ["fabAed"])).fabAndMbme).toBeNull();
    expect(inputsFromPayload(payload(widgets(), ["fabUsd"])).fabAndMbme).toBeNull();
    expect(inputsFromPayload(payload(widgets(), ["mbme"])).fabAndMbme).toBeNull();
  });

  it("nulls the crypto subtotal when one sheet-backed crypto PSP is unreadable", () => {
    expect(inputsFromPayload(payload(widgets(), ["deusXpay"])).netCrypto).toBeNull();
  });

  // An unreadable field that no Excess Funds term reads must not take a figure
  // down with it -- the rule is "name what was missing", not "fail on anything".
  it("leaves the figures standing when the unreadable field feeds no term", () => {
    const inputs = inputsFromPayload(payload(widgets(), ["netAllCurrentBalance"]));
    expect(computeExcessFunds(inputs).gross.value).not.toBeNull();
  });
});

describe("a genuine zero is still a zero", () => {
  it("keeps a 0 balance as 0 when the unreadable list is empty", () => {
    const inputs = inputsFromPayload(payload(widgets({ googlesheets_goldsouq: 0 }), []));
    expect(inputs.goldSouq).toBe(0);
    // MBME is 0 in the fixture too, so the pair sums to the FAB figure alone.
    expect(inputs.fabAndMbme).toBe(250000);
    expect(computeExcessFunds(inputs).gross.value).not.toBeNull();
  });

  it("keeps a 0 as 0 when some OTHER field is unreadable", () => {
    const inputs = inputsFromPayload(payload(widgets({ googlesheets_goldsouq: 0 }), ["mbme"]));
    expect(inputs.goldSouq).toBe(0);
  });

  // An older backend build sends no list at all; that must not be read as "every
  // field unreadable" nor as a licence to trust a zero it never vetted.
  it("treats an absent list as nothing known to be unreadable", () => {
    const inputs = inputsFromPayload({ ok: true, data: { widgets: widgets() } });
    expect(inputs.goldSouq).toBe(100000);
  });
});

describe("the existing guards still hold", () => {
  it("nulls a widget whose whole source failed", () => {
    const list = widgets().map((w) =>
      w.id === "googlesheets_goldsouq" ? { ...w, status: "error", balance: 0 } : w,
    );
    expect(widgetValue(list, "googlesheets_goldsouq", [])).toBeNull();
  });

  it("nulls a widget that is absent altogether", () => {
    expect(widgetValue([], "googlesheets_fab", [])).toBeNull();
  });

  it("nulls a present widget carrying no balance at all, rather than yielding NaN", () => {
    const list = [{ id: "googlesheets_goldsouq", name: "Gold Souq", status: "ok" } as WalletWidgetEntry];
    expect(addOrNull(widgetValue(list, "googlesheets_goldsouq", []))).toBeNull();
  });
});
