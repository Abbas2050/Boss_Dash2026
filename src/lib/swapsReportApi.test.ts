// @vitest-environment node
//
// The swaps data layer.
//
// /api/SwapsReport does not exist yet and there is no staging server, so this
// shape comes from temporay_for_reference_pages/swaps-report.html and is
// unverified. That is exactly why unwrapping throws instead of returning []:
// when the Revenue Share page guessed a shape wrongly, the table rendered
// empty with no error and nobody could tell why.
import { describe, it, expect, vi, afterEach } from "vitest";
import { unwrapSwapRows, readTotals, fetchSwapsReport } from "./swapsReportApi";

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

  // The envelope check (object with a "clients"/"lps" array) says nothing
  // about what's inside each row. Before this guard existed, a row shaped
  // like { swapTotal, clientName } instead of { totalSwap, login } passed
  // straight through: money(undefined) renders "-", the name falls back to
  // "-", and the table looks like a legitimate zero-swap period instead of a
  // broken response. These tests are the row-shape half of the same
  // loud-failure guarantee the envelope checks above already provide.
  it("passes through a well-formed row unchanged", () => {
    const row = { login: 101, name: "A", source: "Live", totalSwap: -12.5, dealVolume: 3, realizedVolume: 2 };
    expect(unwrapSwapRows({ clients: [row] }, "clients")).toEqual([row]);
  });

  it("throws naming the field the backend actually sent, when totalSwap is renamed", () => {
    const row = { login: 101, swapTotal: -12.5 };
    expect(() => unwrapSwapRows({ clients: [row] }, "clients")).toThrow(/totalSwap/);
    // The message should describe what IS on the row, not just what's missing.
    expect(() => unwrapSwapRows({ clients: [row] }, "clients")).toThrow(/swapTotal/);
  });

  it("throws naming login when it is missing", () => {
    const row = { totalSwap: 4 };
    expect(() => unwrapSwapRows({ clients: [row] }, "clients")).toThrow(/login/);
  });

  it("still returns [] for a legitimately empty array without inspecting row shape", () => {
    expect(unwrapSwapRows({ clients: [] }, "clients")).toEqual([]);
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

// If IIS answers a 200 with an HTML body (an SPA fallback, say) instead of
// JSON, the res.ok check passes and res.json() is what actually fails. Left
// unguarded, that throws a bare "Unexpected token '<'" that never names
// /api/SwapsReport -- the same "which fetch broke" problem the row-shape
// guard above exists to prevent, one step earlier in the pipeline.
describe("fetchSwapsReport JSON parse guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the endpoint when the response body isn't valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token '<', \"<!doctype \"... is not valid JSON");
        },
        text: async () => "<!doctype html>...",
      }),
    );

    await expect(fetchSwapsReport("2026-08-01", "2026-08-07")).rejects.toThrow(/\/api\/SwapsReport/);
  });
});

import { readFileSync, globSync, existsSync, readdirSync } from "fs";
import path from "path";

// The backend sends clientTotals and lpTotals. If this UI also reduces over
// totalSwap it becomes a second answer to what we paid in swaps, and the two
// will disagree the first time a row is filtered or hidden.
//
// Prose that needs to mention the idea should write "sum of totalSwap" without
// an arithmetic operator next to the field name, or this test will fire.
//
// This is a tripwire, not a proof: it scans source text with regexes, so it
// can be stepped around by anyone determined to. Known, accepted gaps --
// not oversights:
//   - field access split across statements, e.g.
//     `const t = r.totalSwap; sum += t;` -- the alias `t` carries no textual
//     link back to `totalSwap` at the point it's added.
//   - destructuring in a callback, e.g.
//     `rows.forEach(({ totalSwap }) => { sum += totalSwap; });` -- same
//     aliasing problem, one syntax over.
//   - bracket notation, e.g. `row["totalSwap"]`, which none of the patterns
//     below match (they all require a literal `.totalSwap`).
//   - a summing helper defined in a file outside both globs below, then
//     imported and called from a file the globs do cover -- the arithmetic
//     itself never appears in a scanned file.
//   - arithmetic performed via `Math.*` or a lodash function (`_.sumBy`,
//     `Math.hypot`, etc.) rather than a literal `+`/`+=`/`.reduce(`.
// Only comments are stripped before matching -- block comments, and `//`
// comments on a line of their own (see stripComments below). A TRAILING `//`
// comment -- code, then `// comment` on the same line -- is deliberately
// LEFT IN PLACE and is NOT stripped: the revenue-share version of this same
// tripwire tried stripping trailing comments (and strings) and a reviewer
// showed it erased real violations, because reliably telling "`//` starts a
// comment" from "`//` sits inside a string" needs a character-by-character
// scan, and an apostrophe in an unstripped trailing comment was enough to
// start a phantom string that swallowed genuine arithmetic on a later line.
// A tripwire that can erase the bug it exists to catch is worse than one
// that occasionally cries wolf on prose, so this version accepts the false
// positive instead: prose that needs to mention totalSwap arithmetic,
// including inside a trailing `//` comment, should avoid a bare `+`/`+=`
// next to the field name.
describe("swap totals are never summed in the UI", () => {
  const LIB_GLOB = "src/lib/swapsReport*.ts";
  const COMPONENT_GLOB = "src/pages/departments/dealing/SwapsReport*.tsx";

  // Strips comments only -- block comments and full-line `//` comments. See
  // the header comment above for why trailing `//` comments and strings are
  // deliberately left untouched.
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  // Pattern 3 uses `\+=?` rather than `\+` so it matches both `+` and `+=`
  // immediately before `ident.totalSwap`. Without the `=?` the most natural
  // accumulator loop -- `total += r.totalSwap` -- slipped through every
  // pattern here: pattern 2 needs a `+` AFTER `totalSwap`, and the old
  // pattern 3 needed a `+` directly before `ident.totalSwap` with no `=` in
  // between, but `+=` puts an `=` right after the `+`, so neither matched.
  const OFFENDER_PATTERNS = [
    /\.reduce\([^)]*totalSwap/,
    /totalSwap\s*\+/,
    /\+=?\s*[a-zA-Z_$][\w$]*\.totalSwap/,
  ];

  function offenders(source: string): string[] {
    const stripped = stripComments(source);
    return OFFENDER_PATTERNS.filter((re) => re.test(stripped)).map(String);
  }

  const libFiles = globSync(LIB_GLOB).filter((f) => !f.endsWith(".test.ts"));
  const componentFiles = globSync(COMPONENT_GLOB).filter((f) => !f.endsWith(".test.tsx"));
  const files = [...libFiles, ...componentFiles];

  // Asserted on the lib glob alone. Previously this was a union of both
  // globs, asserting only that the total was non-zero -- and because
  // swapsReportApi.ts always exists, that union was permanently non-zero
  // regardless of what the component glob matched. That made the assertion
  // incapable of ever catching the component glob returning zero, which is
  // exactly the state that exists until a later task creates the component.
  it("finds the swaps data module", () => {
    expect(libFiles.length, `${LIB_GLOB} matched nothing, so the assertions below are vacuous`).toBeGreaterThan(0);
  });

  // SwapsReportTab.tsx (or similar) does not exist yet -- a later task adds
  // it -- so asserting componentFiles.length > 0 right now would fail
  // permanently until that task lands, which would be a lie about what's
  // broken today. What CAN be checked honestly, without asserting something
  // false about the present, is that the glob would actually catch such a
  // component if one existed: scan the dealing pages directory for any
  // .tsx file whose name loosely looks like a swaps-report component (case-
  // insensitively contains "swap") and assert every one of those is also
  // matched by the strict SwapsReport*.tsx glob used above. Today the
  // directory holds no such file, so both sides are empty and this passes
  // vacuously. The day a component lands under a name the strict glob
  // misses -- e.g. SwapReportTab.tsx (singular), DealingSwapsPanel.tsx, or
  // swapsReportTab.tsx (lowercase) -- this starts failing, which is the
  // honest way to say "the component glob is stale" without asserting a
  // false positive about a component that doesn't exist yet.
  it("the component glob would catch a swaps-report component if one existed", () => {
    const dealingDir = path.dirname(COMPONENT_GLOB);
    const present = existsSync(dealingDir) ? readdirSync(dealingDir) : [];
    const looksLikeSwapsComponent = present.filter(
      (f) => /swap/i.test(f) && f.endsWith(".tsx") && !f.endsWith(".test.tsx"),
    );
    const matchedBasenames = new Set(componentFiles.map((f) => path.basename(f)));
    const missed = looksLikeSwapsComponent.filter((f) => !matchedBasenames.has(f));
    expect(
      missed,
      `a .tsx file in ${dealingDir} looks like a swaps-report component (name contains "swap") but isn't matched by ${COMPONENT_GLOB} -- widen the glob or rename the file so the checks below actually run against it`,
    ).toEqual([]);
  });

  for (const file of files) {
    it(`${file} does not reduce over totalSwap`, () => {
      const source = readFileSync(path.resolve(file), "utf8");
      expect(
        offenders(source),
        "clientTotals and lpTotals come from the backend. Render them; do not derive them.",
      ).toEqual([]);
    });
  }

  // Regression coverage for the detector logic itself, independent of what
  // currently exists on disk -- so a future edit to OFFENDER_PATTERNS that
  // reopens one of these bypasses fails here even before a real file trips
  // it.
  describe("the detector itself", () => {
    it("catches a += accumulator (the bypass every pattern used to miss)", () => {
      const code = "let total = 0; for (const r of rows) { total += r.totalSwap; }";
      expect(offenders(code)).not.toEqual([]);
    });

    it("still catches the literal + form", () => {
      expect(offenders("const sum = a.totalSwap + b.totalSwap;")).not.toEqual([]);
    });

    it("still catches .reduce", () => {
      expect(offenders("rows.reduce((s, r) => s + r.totalSwap, 0)")).not.toEqual([]);
    });

    it("does not fire on prose naming the idea without an arithmetic operator", () => {
      const code = 'const helpText = "this is the sum of totalSwap for the period";';
      expect(offenders(code)).toEqual([]);
    });
  });
});
