import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("src/components/dashboard/AccountsDepartment.tsx", "utf8");
const INPUTS_MODULE = readFileSync("src/lib/excessFundsInputs.ts", "utf8");

// The excessInputs object literal, from its declaration to its closing brace.
//
// The previous version of this file scanned a fixed 400-character window after
// the word "excessInputs". The literal is longer than that, so mutating the LAST
// field to read from pspBalances sat outside the window and the tripwire passed
// on a broken file. Slice the real thing instead, and fail loudly if the shape
// ever stops being findable rather than silently scanning nothing.
function excessInputsLiteral(): string {
  const start = SOURCE.indexOf("const excessInputs");
  if (start < 0) throw new Error("excessInputs is gone from AccountsDepartment.tsx");
  const end = SOURCE.indexOf("\n  };", start);
  if (end < 0) throw new Error("could not find the end of the excessInputs literal");
  return SOURCE.slice(start, end + "\n  };".length);
}

// A source-scanning tripwire. The wiring itself needs a live component and three
// live endpoints to exercise, but the ways it can be wired WRONGLY are all
// visible in the text.
describe("the Excess Funds inputs are not taken from the coerced balances", () => {
  it("mounts the section", () => {
    expect(SOURCE).toMatch(/<ExcessFundsSection/);
  });

  it("finds the whole excessInputs literal, not a truncated window", () => {
    const literal = excessInputsLiteral();
    // Every one of the six terms must be inside the slice, or the scan below is
    // looking at less than it thinks it is.
    for (const term of [
      "netDifference",
      "netCrypto",
      "fabAndMbme",
      "goldSouq",
      "fabOperating",
      "fabHolding",
    ]) {
      expect(literal).toContain(`${term}:`);
    }
  });

  // pspBalances has already had status:'error' flattened to 0 for display.
  // Building the treasury inputs from it would silently drop a dead provider's
  // balance instead of reporting the figure as unavailable.
  it("does not build the excess inputs from pspBalances", () => {
    expect(excessInputsLiteral()).not.toMatch(/pspBalances/);
  });

  // goldSouq used to bypass addOrNull, so a non-error widget with an absent
  // balance produced NaN instead of null.
  it("routes every widget-derived term through addOrNull", () => {
    const literal = excessInputsLiteral();
    for (const term of ["netCrypto", "fabAndMbme", "goldSouq"]) {
      expect(literal).toMatch(new RegExp(`${term}:\\s*addOrNull\\(`));
    }
  });

  it("reads the raw widget status so a failed source becomes null", () => {
    expect(INPUTS_MODULE).toMatch(/status\s*===\s*["']error["']\)?\s*return null/);
  });

  // The silent-zero route this branch exists to close: pspClients.js parses a
  // cell with `parseFloat(...) || 0`, so an empty cell or a #REF! left by a
  // shifted row arrives as a balance of 0 on a widget stamped status:'ok'.
  it("nulls a widget whose underlying sheet cell could not be read", () => {
    expect(INPUTS_MODULE).toMatch(/unreadableSheetFields/);
    expect(INPUTS_MODULE).toMatch(/WIDGET_SHEET_FIELDS\[id\]/);
    expect(INPUTS_MODULE).toMatch(/\.some\(\(f\) => unreadableSheetFields\.includes\(f\)\)\)\s*return null/);
    // And the component must actually pass the list in, or the guard is inert.
    expect(SOURCE).toMatch(/readWidgetValue\(walletWidgets,\s*id,\s*unreadableSheetFields\)/);
    expect(SOURCE).toMatch(/setUnreadableSheetFields\(/);
  });

  // lpEquitySummary initialises to zeroes, so using its value without checking
  // that the fetch succeeded turns a dead equity endpoint into a confident
  // netDifference of 0.00 -- the same class of bug as the widget status one.
  it("guards netDifference on whether the equity fetch succeeded", () => {
    expect(SOURCE).toMatch(/netDifference:\s*equityLoaded\s*\?/);
  });

  // The equity call used to be gated behind an isLpMode if/else, so the
  // Accounts page (which renders with mode unset) never made it. Prove the
  // call now happens outside any isLpMode-conditional: everything in the
  // effect between the fetchLpEquitySummary definition and the first branch
  // on isLpMode runs unconditionally, so the literal call must live there.
  it("no longer gates the equity fetch to LP mode only", () => {
    const effectStart = SOURCE.indexOf("const fetchLpEquitySummary = async");
    expect(effectStart).toBeGreaterThan(-1);
    const afterDefinition = SOURCE.slice(effectStart);
    const branchIdx = afterDefinition.search(/if\s*\(\s*!?isLpMode\s*\)/);
    expect(branchIdx).toBeGreaterThan(-1);
    const unconditionalRegion = afterDefinition.slice(0, branchIdx);
    expect(unconditionalRegion).toMatch(/\bfetchLpEquitySummary\(\);/);
  });

  // The mirror image: the FAB workbook feeds a section that only renders when
  // !isLpMode, so calling it unconditionally made the home page's Dealing (LP)
  // card take a 502 on every mount and refresh for data it never shows.
  it("does gate the FAB fetch to non-LP mode", () => {
    const effectStart = SOURCE.indexOf("const fetchLpEquitySummary = async");
    const afterDefinition = SOURCE.slice(effectStart);
    const branchIdx = afterDefinition.search(/if\s*\(\s*!?isLpMode\s*\)/);
    const unconditionalRegion = afterDefinition.slice(0, branchIdx);
    expect(unconditionalRegion).not.toMatch(/\bfetchFab\(\)/);
    expect(afterDefinition.slice(branchIdx)).toMatch(/\bfetchFab\(\)/);
  });
});

// SEAM 2 (~line 402): the effect must forward the *response's*
// unreadableSheetFields into state, not a hardcoded empty array. The check at
// line 75 above (`expect(SOURCE).toMatch(/setUnreadableSheetFields\(/)`) only
// proves the identifier appears somewhere in the file -- a reviewer showed that
// mutating the real call to `setUnreadableSheetFields([])` still satisfies it,
// and every other test in this suite (and all 564 elsewhere) stays green. This
// pins the actual argument text of that one call site instead.
describe("seam 2: the unreadable-field list reaches state as reported, not hardcoded", () => {
  it("passes response.data.unreadableSheetFields into setUnreadableSheetFields, not a literal []", () => {
    const callStart = SOURCE.indexOf("setUnreadableSheetFields(");
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = SOURCE.indexOf(");", callStart);
    expect(callEnd).toBeGreaterThan(callStart);
    const call = SOURCE.slice(callStart, callEnd + 2);

    expect(call).toMatch(/response\.data\.unreadableSheetFields/);
    expect(call).not.toMatch(/setUnreadableSheetFields\(\s*\[\]\s*\)/);
  });
});

describe("the equity poll costs what it is worth", () => {
  // fetchLpEquitySummary also POSTs to /api/lp-equity-live-snapshots, so a 5s
  // interval is 12 external calls and 12 database upserts a minute per mount --
  // and this component mounts twice on the home page. It buys nothing either:
  // the wallet half refreshes every 2 minutes, so the section can never be
  // fresher than that. LP mode's own 5s cadence is deliberately left alone.
  it("polls equity once a minute on the non-LP path", () => {
    const start = SOURCE.indexOf("if (!isLpMode) {", SOURCE.indexOf("const fetchFab"));
    const elseIdx = SOURCE.indexOf("} else {", start);
    const nonLpBranch = SOURCE.slice(start, elseIdx);
    expect(nonLpBranch).toMatch(/setInterval\(fetchLpEquitySummary,\s*60 \* 1000\)/);
    expect(nonLpBranch).not.toMatch(/setInterval\(fetchLpEquitySummary,\s*5000\)/);
  });

  it("leaves the LP path on its own 5s cadence", () => {
    const elseIdx = SOURCE.indexOf("} else {", SOURCE.indexOf("const fetchFab"));
    const lpBranch = SOURCE.slice(elseIdx, SOURCE.indexOf("return () => {", elseIdx));
    expect(lpBranch).toMatch(/\}, 5000\)/);
  });

  // A response slower than the interval would otherwise land after a newer one
  // and write a stale equity back over a fresher one.
  it("holds an in-flight guard so a slow response cannot overwrite a newer one", () => {
    expect(SOURCE).toMatch(/if \(equityInFlight\) return;/);
    expect(SOURCE).toMatch(/equityInFlight = false;/);
  });

  // The component mounts twice on the home page; a leaked interval doubles
  // every cost above on each refresh.
  it("clears both intervals on unmount", () => {
    expect(SOURCE).toMatch(/if \(walletInterval\) clearInterval\(walletInterval\);/);
    expect(SOURCE).toMatch(/if \(lpInterval\) clearInterval\(lpInterval\);/);
  });
});

describe("the section can tell the reader its inputs are stale", () => {
  // A failed wallet refresh leaves walletWidgets at the last good read and a
  // failed equity fetch leaves netDifference frozen, in both cases producing an
  // arithmetically complete figure from arbitrarily old data. The only error
  // text used to live in a different block entirely.
  it("passes the wallet and equity failures and the read time to the section", () => {
    const mount = SOURCE.slice(SOURCE.indexOf("<ExcessFundsSection"));
    expect(mount).toMatch(/walletError=\{walletError\}/);
    expect(mount).toMatch(/equityError=\{equityError\}/);
    expect(mount).toMatch(/walletUpdated=\{reportUpdated\}/);
  });

  it("records an equity failure rather than swallowing it", () => {
    expect(SOURCE).toMatch(/setEquityError\(/);
  });
});

describe("the existing figure keeps its own scope note", () => {
  // Both lpPlusPspDifference and Gross Excess Fund read as "spare cash" and give
  // different answers. Both stay, so both must say what they count.
  it("labels what lpPlusPspDifference includes", () => {
    const idx = SOURCE.indexOf("lpPlusPspDifference");
    expect(idx).toBeGreaterThan(-1);
    expect(SOURCE.slice(idx)).toMatch(/all PSPs|every PSP/i);
  });
});
