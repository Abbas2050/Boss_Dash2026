// @vitest-environment node
//
// The swaps data layer.
//
// /api/SwapsReport does not exist yet and there is no staging server, so this
// shape comes from temporay_for_reference_pages/swaps-report.html and is
// unverified. That is exactly why unwrapping throws instead of returning []:
// when the Revenue Share page guessed a shape wrongly, the table rendered
// empty with no error and nobody could tell why.
import { describe, it, expect } from "vitest";
import { unwrapSwapRows, readTotals } from "./swapsReportApi";

const GOOD = {
  clients: [{ login: 101, name: "A", source: "Live", totalSwap: -12.5, dealVolume: 3, realizedVolume: 2 }],
  clientTotals: { totalSwap: -12.5, accountCount: 1 },
  lps: [{ login: 900, lpName: "LMAX", source: "Live", totalSwap: 4, dealVolume: 1, realizedVolume: 1 }],
  lpTotals: { totalSwap: 4, accountCount: 1 },
};

describe("unwrapSwapRows", () => {
  it("reads the rows under the requested key", () => {
    expect(unwrapSwapRows(GOOD, "clients")).toHaveLength(1);
    expect(unwrapSwapRows(GOOD, "lps")).toHaveLength(1);
  });

  // A period with no swaps is a real answer, not a broken response.
  it("returns an empty array for a legitimately empty section", () => {
    expect(unwrapSwapRows({ clients: [], lps: [] }, "clients")).toEqual([]);
  });

  it("throws, naming the endpoint and the keys present, on an unrecognised shape", () => {
    expect(() => unwrapSwapRows(null, "clients")).toThrow(/SwapsReport/);
    expect(() => unwrapSwapRows({ items: [] }, "clients")).toThrow(/items/);
    expect(() => unwrapSwapRows({ clients: "nope" }, "clients")).toThrow(/SwapsReport/);
    expect(() => unwrapSwapRows("nope", "clients")).toThrow(/SwapsReport/);
  });

  it("names the key it was looking for, so the message says which half failed", () => {
    expect(() => unwrapSwapRows({ clients: [] }, "lps")).toThrow(/lps/);
  });
});

describe("readTotals", () => {
  it("returns the totals the backend sent", () => {
    expect(readTotals(GOOD, "clientTotals")).toEqual({ totalSwap: -12.5, accountCount: 1 });
  });

  // Rendering "unavailable" is honest; summing the rows would invent a second
  // answer to "what did we pay in swaps".
  it("returns null when the totals are absent or malformed, rather than inventing them", () => {
    expect(readTotals({ clients: [] }, "clientTotals")).toBeNull();
    expect(readTotals({ clientTotals: null }, "clientTotals")).toBeNull();
    expect(readTotals({ clientTotals: "x" }, "clientTotals")).toBeNull();
    expect(readTotals(null, "clientTotals")).toBeNull();
  });

  it("accepts a zero total, which is a real figure", () => {
    expect(readTotals({ clientTotals: { totalSwap: 0, accountCount: 0 } }, "clientTotals"))
      .toEqual({ totalSwap: 0, accountCount: 0 });
  });

  // NaN and Infinity are numbers in typeof terms, but not valid totals. The
  // guard must reject them so the UI renders "unavailable" instead of silently
  // claiming the figure is real and showing "-" or "NaN".
  it("rejects NaN in totalSwap", () => {
    expect(readTotals({ clientTotals: { totalSwap: NaN, accountCount: 1 } }, "clientTotals"))
      .toBeNull();
  });

  it("rejects NaN in accountCount", () => {
    expect(readTotals({ clientTotals: { totalSwap: 1, accountCount: NaN } }, "clientTotals"))
      .toBeNull();
  });

  it("rejects Infinity in totalSwap", () => {
    expect(readTotals({ clientTotals: { totalSwap: Infinity, accountCount: 1 } }, "clientTotals"))
      .toBeNull();
  });
});

import { readFileSync } from "fs";
import { globSync } from "fs";
import path from "path";

// The backend sends clientTotals and lpTotals. If this UI also reduces over
// totalSwap it becomes a second answer to what we paid in swaps, and the two
// will disagree the first time a row is filtered or hidden.
//
// Prose that needs to mention the idea should write "sum of totalSwap" without
// an arithmetic operator next to the field name, or this test will fire.
describe("swap totals are never summed in the UI", () => {
  const files = [
    ...globSync("src/lib/swapsReport*.ts").filter((f) => !f.endsWith(".test.ts")),
    ...globSync("src/pages/departments/dealing/SwapsReport*.tsx").filter((f) => !f.endsWith(".test.tsx")),
  ];

  it("finds the files it is meant to be checking", () => {
    expect(files.length, "glob matched nothing, so the assertions below are vacuous").toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} does not reduce over totalSwap`, () => {
      const source = readFileSync(path.resolve(file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const offenders = [/\.reduce\([^)]*totalSwap/, /totalSwap\s*\+/, /\+\s*[a-zA-Z_$][\w$]*\.totalSwap/]
        .filter((re) => re.test(source));
      expect(
        offenders.map(String),
        "clientTotals and lpTotals come from the backend. Render them; do not derive them.",
      ).toEqual([]);
    });
  }
});
