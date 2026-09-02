import type { WalletWidgetEntry } from "@/lib/walletApi";

// Turning wallet widgets into Excess Funds inputs, and the one thing that makes
// it hard: a Google Sheets widget can arrive with status:'ok' and a balance of 0
// that was never a balance.
//
// pspClients.js reads each configured cell with `parseFloat(...) || 0`, so an
// empty cell, a `#REF!` left behind by a deleted row and a genuine zero are all
// the same 0, and walletMonitor.js then stamps the widget 'ok'. Whole-sheet
// failure is caught (every sheet widget goes status:'error'); per-cell failure
// was not -- and per-cell drift is the documented historical failure on this
// workbook: googleSheetsMappingConfig.js carries three generations of cell
// addresses because rows kept shifting under it.
//
// The backend now also reports which field keys it could not parse, on
// data.unreadableSheetFields. This module is where that list turns into a null.
//
// Design: docs/superpowers/specs/2026-09-01-excess-funds-cards-design.md

// Which sheet field keys each widget's balance is built from, mirroring
// walletMonitor.js. A widget is unusable if ANY of its fields is unreadable:
// googlesheets_fab is fabAed + fabUsd, and googlesheets_goldsouq is
// goldSouq minus its J-column deduction, so losing either half of a pair is
// losing the whole figure. Getting this map wrong reintroduces the silent zero
// in a new place, so it is kept next to the test that pins it.
//
// goldSouqDeductionJ31 stays in the pair deliberately, even though a BLANK
// deduction no longer reaches this list. The backend decides that question now:
// the deduction cell is configured `required: false`, so an empty cell is
// reported as the real zero it is, while a cell holding a #REF! is still named
// unreadable -- and when it is named, Gold Souq must still go unavailable,
// because a corrupted deduction corrupts the adjusted balance just as
// completely as a corrupted K13 does.
export const WIDGET_SHEET_FIELDS: Record<string, readonly string[]> = {
  googlesheets_match2pay: ["match2pay"],
  googlesheets_deusxpay: ["deusXpay"],
  googlesheets_openpayed: ["openPayed"],
  googlesheets_goldsouq: ["goldSouq", "goldSouqDeductionJ31"],
  googlesheets_fab: ["fabAed", "fabUsd"],
  googlesheets_mbme: ["mbme"],
};

// Built from the RAW widgets, not from the display array: that one has already
// had status:'error' flattened to a balance of 0 so the row can still render,
// and a treasury figure must never treat a failed read as a zero balance.
export function widgetValue(
  widgets: readonly WalletWidgetEntry[],
  id: string,
  unreadableSheetFields: readonly string[] = [],
): number | null {
  const entry = widgets.find((w) => w.id === id);
  if (!entry) return null;
  if (entry.status === "error") return null;
  const fields = WIDGET_SHEET_FIELDS[id];
  if (fields && fields.some((f) => unreadableSheetFields.includes(f))) return null;
  return Number(entry.balance ?? Number.NaN);
}

// One missing term makes the whole sum unavailable. Also used on a single value,
// so a lone widget cannot slip past as NaN.
export function addOrNull(...values: (number | null)[]): number | null {
  return values.some((v) => v === null || !Number.isFinite(v as number))
    ? null
    : values.reduce((total: number, v) => total + (v as number), 0);
}
