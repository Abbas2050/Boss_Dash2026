// Gross and Net Excess Fund, and every rule about what happens when a figure is
// missing. Pure: no fetching, no React, no formatting. Three independent sources
// feed this section and each can fail on its own, so the degradation rules are
// the substance here -- the addition is the easy part.
//
// Design: docs/superpowers/specs/2026-09-01-excess-funds-cards-design.md

export type ExcessInput = number | null;

export interface ExcessFundsInputs {
  // The BACKEND's netDifference, not a subtraction we performed. It already
  // equals lps.netWithdrawableEquity - clients.netWithdrawableEquity; computing
  // it again here would create a second answer to a question already answered.
  netDifference: ExcessInput;
  netCrypto: ExcessInput;
  fabAndMbme: ExcessInput;
  goldSouq: ExcessInput;
  fabOperating: ExcessInput;
  fabHolding: ExcessInput;
}

export interface ExcessFigure {
  value: number | null;
  // The labels of the inputs that were missing. A card shows these so the reader
  // knows which source failed rather than just that something did.
  missing: string[];
}

export interface ExcessFundsResult {
  gross: ExcessFigure;
  net: ExcessFigure;
}

export const EXCESS_LABELS: Record<keyof ExcessFundsInputs, string> = {
  netDifference: "Net LP Equity − Net Client Equity",
  netCrypto: "Net Crypto",
  fabAndMbme: "Net FAB & MBME",
  goldSouq: "Gold Souq",
  fabOperating: "FAB Operating Balance",
  fabHolding: "FAB Holding Balance",
};

export const GROSS_TERMS = [
  "netDifference",
  "netCrypto",
  "fabAndMbme",
  "goldSouq",
] as const satisfies readonly (keyof ExcessFundsInputs)[];

export const NET_EXTRA_TERMS = [
  "fabOperating",
  "fabHolding",
] as const satisfies readonly (keyof ExcessFundsInputs)[];

// A value only counts if it is a real finite number. Number("") is 0 and
// Number(undefined) is NaN, so an absent figure can otherwise arrive looking
// like a balance of zero -- which is a real balance and must stay meaningful.
function usable(value: ExcessInput): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sum(
  inputs: ExcessFundsInputs,
  terms: readonly (keyof ExcessFundsInputs)[],
): ExcessFigure {
  const missing = terms.filter((t) => !usable(inputs[t])).map((t) => EXCESS_LABELS[t]);
  if (missing.length) return { value: null, missing };
  const value = terms.reduce((total, t) => total + (inputs[t] as number), 0);
  return { value, missing: [] };
}

export function computeExcessFunds(inputs: ExcessFundsInputs): ExcessFundsResult {
  const gross = sum(inputs, GROSS_TERMS);
  // Net is gross plus the two FAB accounts, so it inherits everything gross was
  // missing. Losing only the FAB workbook costs net and leaves gross standing --
  // the expected state whenever that sheet is unreachable.
  const net = sum(inputs, [...GROSS_TERMS, ...NET_EXTRA_TERMS]);
  return { gross, net };
}
