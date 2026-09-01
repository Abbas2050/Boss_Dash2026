import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("src/components/dashboard/AccountsDepartment.tsx", "utf8");

// A source-scanning tripwire. The wiring itself needs a live component and three
// live endpoints to exercise, but the two ways it can be wired WRONGLY are both
// visible in the text.
describe("the Excess Funds inputs are not taken from the coerced balances", () => {
  it("mounts the section", () => {
    expect(SOURCE).toMatch(/<ExcessFundsSection/);
  });

  // pspBalances has already had status:'error' flattened to 0 at line ~374.
  // Building the treasury inputs from it would silently drop a dead provider's
  // balance instead of reporting the figure as unavailable.
  it("does not build the excess inputs from pspBalances", () => {
    const wiring = SOURCE.slice(SOURCE.indexOf("excessInputs"));
    expect(wiring).not.toMatch(/excessInputs[\s\S]{0,400}pspBalances/);
  });

  it("reads the raw widget status so a failed source becomes null", () => {
    expect(SOURCE).toMatch(/status\s*===\s*['"]error['"]\s*\?\s*null/);
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
