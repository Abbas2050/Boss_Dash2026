// @vitest-environment node
//
// The revenue-share data layer.
//
// Verified directly against the live API on 2026-08-25: all three endpoints
// nest their rows in an object -- /History/aggregate and /History/volume
// under `items` (aggregate also carries `totals`, `fromTimestamp`,
// `toTimestamp`), /History/deals under `deals`. None of them are bare
// arrays. Unwrapping must throw on a shape it doesn't recognise rather than
// silently returning [] -- an empty table and a broken backend must not look
// the same. A genuinely empty result (the right key holding an empty array)
// is not an error and must still return [].
import { afterEach, describe, it, expect, vi } from "vitest";
import { unwrapDeals, unwrapItems, isErrorRow, hidesFromRevenueShare, fetchRevenueShare, fetchVolume, fetchDeals } from "./revenueShareApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unwrapDeals", () => {
  it("reads rows from the nested deals array", () => {
    const payload = {
      login: 101487,
      lpName: "B2B Coverage account",
      fromTimestamp: 1785528000,
      toTimestamp: 1787601599,
      totalDeals: 2,
      deals: [{ dealTicket: 1 }, { dealTicket: 2 }],
    };
    expect(unwrapDeals(payload)).toHaveLength(2);
  });

  // The live endpoint returned deals: [] on every sample taken while writing
  // this, so the empty case is the common one, not the edge case.
  it("returns an empty array when the LP had no deals", () => {
    expect(unwrapDeals({ login: 1, totalDeals: 0, deals: [] })).toEqual([]);
  });

  // An unrecognised shape must throw, not disappear as an empty table. A
  // silent [] here is indistinguishable from "this LP had no deals" -- that
  // was the actual bug being fixed.
  it("throws on an unexpected shape instead of returning an empty array", () => {
    expect(() => unwrapDeals(null)).toThrow(/deals/i);
    expect(() => unwrapDeals(undefined)).toThrow(/deals/i);
    expect(() => unwrapDeals({})).toThrow(/deals/i);
    expect(() => unwrapDeals({ deals: null })).toThrow(/deals/i);
    expect(() => unwrapDeals("nope")).toThrow(/deals/i);
  });

  it("names the endpoint and the keys actually present when it throws", () => {
    try {
      unwrapDeals({ error: "upstream timeout" });
      throw new Error("expected unwrapDeals to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("/History/deals");
      expect(message).toContain("error");
    }
  });

  // If the backend ever returns a bare array here, accept it rather than
  // showing the user nothing.
  it("accepts a bare array too", () => {
    expect(unwrapDeals([{ dealTicket: 7 }])).toHaveLength(1);
  });
});

describe("unwrapItems", () => {
  it("reads rows from the nested items array", () => {
    const payload = {
      items: [{ login: 1 }, { login: 2 }, { login: 3 }],
      totals: { grossProfit: 100 },
      fromTimestamp: 1785528000,
      toTimestamp: 1787601599,
    };
    expect(unwrapItems(payload, "/History/aggregate")).toHaveLength(3);
  });

  it("returns an empty array when the period genuinely had no rows", () => {
    expect(unwrapItems({ items: [] }, "/History/aggregate")).toEqual([]);
  });

  // Same trap as unwrapDeals: a shape we don't recognise must throw, naming
  // which endpoint broke and what keys the payload actually had, so this
  // doesn't read as "no data for the period".
  it("throws on an unexpected shape instead of returning an empty array", () => {
    expect(() => unwrapItems(null, "/History/aggregate")).toThrow(/aggregate/);
    expect(() => unwrapItems(undefined, "/History/aggregate")).toThrow(/aggregate/);
    expect(() => unwrapItems({}, "/History/aggregate")).toThrow(/aggregate/);
    expect(() => unwrapItems({ items: null }, "/History/volume")).toThrow(/volume/);
    expect(() => unwrapItems("nope", "/History/volume")).toThrow(/volume/);
  });

  it("names the endpoint and the keys actually present when it throws", () => {
    try {
      unwrapItems({ error: "upstream timeout", code: 502 }, "/History/aggregate");
      throw new Error("expected unwrapItems to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("/History/aggregate");
      expect(message).toContain("error");
      expect(message).toContain("code");
    }
  });

  // If the backend ever returns a bare array here, accept it rather than
  // showing the user nothing.
  it("accepts a bare array too", () => {
    expect(unwrapItems([{ login: 1 }], "/History/aggregate")).toHaveLength(1);
  });
});

describe("isErrorRow", () => {
  it("is true only when the backend says so", () => {
    expect(isErrorRow({ isError: true })).toBe(true);
    expect(isErrorRow({ isError: false })).toBe(false);
    expect(isErrorRow({})).toBe(false);
  });
});

// An LP with ntpPercent === 0 (the number) has no revenue-share agreement
// and should be hidden. Anything else -- including a null/undefined/string
// "0" that merely LOOKS like zero after coercion -- is missing data, not a
// zero agreement, and must stay visible. An error row is always visible
// regardless of its (meaningless) ntpPercent.
describe("hidesFromRevenueShare", () => {
  it("hides a row whose ntpPercent is strictly the number 0", () => {
    expect(hidesFromRevenueShare({ ntpPercent: 0 })).toBe(true);
  });

  it("shows a row with a nonzero ntpPercent", () => {
    expect(hidesFromRevenueShare({ ntpPercent: 20 })).toBe(false);
  });

  it("shows a row whose ntpPercent is null (missing data, not a zero agreement)", () => {
    expect(hidesFromRevenueShare({ ntpPercent: null })).toBe(false);
  });

  it("shows a row whose ntpPercent is undefined", () => {
    expect(hidesFromRevenueShare({ ntpPercent: undefined })).toBe(false);
  });

  it('shows a row whose ntpPercent is the string "0" (coerces to 0 but is not the number 0)', () => {
    expect(hidesFromRevenueShare({ ntpPercent: "0" as unknown as number })).toBe(false);
  });

  it("shows a row with a negative ntpPercent", () => {
    expect(hidesFromRevenueShare({ ntpPercent: -5 })).toBe(false);
  });

  it("shows an error row even when its ntpPercent is 0 -- an error must always be visible", () => {
    expect(hidesFromRevenueShare({ ntpPercent: 0, isError: true })).toBe(false);
  });
});

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const errorResponse = (status: number, body: string) => ({
  ok: false,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
});

describe("fetchRevenueShare / fetchVolume unwrap items", () => {
  it("fetchRevenueShare returns the nested items array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ items: [{ login: 1 }], totals: {}, fromTimestamp: 0, toTimestamp: 0 })),
    );
    const rows = await fetchRevenueShare("2026-08-01", "2026-08-25");
    expect(rows).toEqual([{ login: 1 }]);
  });

  it("fetchVolume returns the nested items array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ items: [{ login: 2 }] })));
    const rows = await fetchVolume("2026-08-01", "2026-08-25");
    expect(rows).toEqual([{ login: 2 }]);
  });

  it("fetchRevenueShare throws rather than silently rendering an empty table on a broken payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ error: "db unavailable" })));
    await expect(fetchRevenueShare("2026-08-01", "2026-08-25")).rejects.toThrow(/aggregate/);
  });

  it("fetchDeals throws rather than silently rendering an empty table on a broken payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse({ error: "db unavailable" })));
    await expect(fetchDeals(101487, "2026-08-01", "2026-08-25")).rejects.toThrow(/deals/i);
  });
});

describe("getJson error body (via the fetch* wrappers)", () => {
  it("includes the response body in the thrown error on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(500, '{"message":"upstream LP feed timed out"}')));
    await expect(fetchRevenueShare("2026-08-01", "2026-08-25")).rejects.toThrow(/upstream LP feed timed out/);
  });

  it("truncates a very long response body rather than dumping it whole", async () => {
    const longBody = "x".repeat(5000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(502, longBody)));
    try {
      await fetchRevenueShare("2026-08-01", "2026-08-25");
      throw new Error("expected fetchRevenueShare to reject");
    } catch (err) {
      const message = (err as Error).message;
      expect(message.length).toBeLessThan(longBody.length);
      expect(message).toContain("502");
    }
  });
});

import { readFileSync, globSync } from "fs";
import path from "path";

// lpPL = realLpPL x ntpPercent / 100 is the backend's calculation, verified in
// the live payload: 1,196,755.75 x 20% = 239,351.15. If this UI ever computes
// it too, the two will drift and an LP gets paid the wrong number.
//
// This is a tripwire, not a proof: it scans source text with regexes, so it
// can be stepped around by anyone determined to. What it catches, beyond the
// literal `realLpPL * x`:
//   - destructuring renames:  const { realLpPL: pl, ntpPercent: pct } = row
//   - a value copied out under a new name in an earlier statement, then used
//     later:  const x = row.realLpPL; ... x * y
//   - every file matching src/lib/revenueShare*.ts or
//     src/pages/departments/dealing/RevenueShare*.tsx, not a fixed two-entry
//     list -- so a helper such as revenueShareMath.ts, imported by the
//     component, is scanned too, and a rename of RevenueShareTab.tsx doesn't
//     silently drop it from coverage.
//
// Only comments are stripped before matching -- block comments, and `//`
// comments on a line of their own. A TRAILING `//` comment is deliberately
// left in place: stripping it safely needs to know whether the `//` sits
// inside a string, and getting that wrong is how the previous version came to
// erase real code. Strings and template literals are
// matched AS WRITTEN. An earlier version also stripped string and
// template-literal contents to avoid failing on prose that names the
// formula (a tooltip, an aria-label). A reviewer showed that stripping
// erases real violations, not just prose: the single-quote regex has no
// line anchor, so an apostrophe anywhere (even inside a trailing comment
// left un-stripped) pairs with the next apostrophe anywhere later in the
// file and deletes everything between, including genuine arithmetic on an
// intervening line; and `` `${...}` `` stripping deleted real arithmetic
// written as a JSX label, e.g. `` `${row.realLpPL * (row.ntpPercent / 100)}` ``.
// A tripwire that can erase the bug it exists to catch is worse than one
// that occasionally cries wolf on prose, so this version accepts the false
// positive: if a comment or string needs to name the formula, write it with
// an `x`, not a literal `*`/`/` token -- `realLpPL x ntpPercent`, the way
// the spec and this file's own comments already do. That is the documented
// way to avoid tripping this suite; weakening the detector is not.
//
// What it deliberately does NOT catch -- known gaps, not oversights:
//   - a second hop of aliasing (an alias of an alias)
//   - the two values crossing a function boundary under generic parameter
//     names, e.g. a utility `combine(a, b)` called as
//     `combine(realLpPL, ntpPercent)` -- the multiplication itself has no
//     textual link back to the field names at the call site
//   - a helper file whose name doesn't start with "revenueShare" /
//     "RevenueShare" -- the glob below is a naming convention, not a
//     call-graph walk
//   - arithmetic expressed without a literal `*`/`/` token, e.g. Math.pow,
//     .reduce, or a backend round-trip that recomputes the value elsewhere
// Treat a pass here as "no cheap recomputation found," not as a guarantee
// that none exists.
describe("the revenue share is never recomputed here", () => {
  const FIELDS = ["realLpPL", "ntpPercent"] as const;

  // Strips comments only -- block comments (/* ... */) and full-line `//`
  // comments. Strings and template literals are deliberately left alone: an
  // earlier version also stripped them (plus trailing `//` comments) so
  // prose naming the formula (a tooltip, an aria-label) wouldn't fail the
  // suite, but a reviewer showed that combination erases real violations,
  // not just prose -- see the header comment above and the two regression
  // tests below. A trailing `//` comment (code, then `// comment` on the
  // same line) is NOT stripped by this version: reliably telling "`//`
  // starts a comment" from "`//` sits inside a string, e.g. a URL" needs a
  // character-by-character scan, and a scan is exactly the kind of clever
  // machinery that produced this bug in the first place. Leaving trailing
  // comments unstripped is a known, accepted limitation, not an oversight:
  // it can occasionally false-positive on a trailing comment that names the
  // formula with a literal `*`/`/` (fix such comments to use `x` instead,
  // per the header above), but it can never silently erase real code, which
  // is the only failure mode that matters for a tripwire.
  function stripNonCode(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  // Names a value may have been copied out under: either a destructuring
  // rename -- `const { realLpPL: pl } = row` -- or a plain declaration whose
  // right-hand side mentions the field -- `const x = row.realLpPL`.
  // Deliberately loose: it doesn't check that the alias is later used
  // arithmetically, only that it could be the field under a new name. The
  // arithmetic check below is what actually decides pass/fail, so an
  // over-eager alias here costs a false positive, not a missed bypass.
  function aliasesOf(code: string, field: string): string[] {
    const aliases = new Set<string>();
    // Requires the `field: name` pair to sit inside a `{ ... } =` pattern
    // (destructuring), not just any object literal -- `return { realLpPL: x }`
    // (constructing an object, not extracting from one) is not a rename.
    const destructureRe = new RegExp(`\\{[^{}]*\\b${field}\\s*:\\s*([A-Za-z_$][\\w$]*)[^{}]*\\}\\s*=`, "g");
    for (const m of code.matchAll(destructureRe)) aliases.add(m[1]);
    const assignRe = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*\\b${field}\\b(?!\\w)`, "g");
    for (const m of code.matchAll(assignRe)) aliases.add(m[1]);
    aliases.delete(field);
    return [...aliases];
  }

  function usedInArithmetic(code: string, name: string): boolean {
    return new RegExp(`\\b${name}\\s*[*/]`).test(code) || new RegExp(`[*/]\\s*\\b${name}\\b`).test(code);
  }

  function offenders(code: string): string[] {
    const hits = new Set<string>();
    for (const field of FIELDS) {
      if (usedInArithmetic(code, field)) hits.add(field);
      for (const alias of aliasesOf(code, field)) {
        if (usedInArithmetic(code, alias)) hits.add(`${field} (aliased as "${alias}")`);
      }
    }
    return [...hits];
  }

  // Everything matching these two naming patterns, not a fixed file list.
  function scanTargets(): string[] {
    const libFiles = globSync("src/lib/revenueShare*.ts", { cwd: process.cwd() }).filter((f) => !f.endsWith(".test.ts"));
    const pageFiles = globSync("src/pages/departments/dealing/RevenueShare*.tsx", { cwd: process.cwd() }).filter(
      (f) => !f.endsWith(".test.tsx"),
    );
    return [...libFiles, ...pageFiles].map((f) => path.resolve(f));
  }

  // An empty scan must fail loudly, not pass silently. RevenueShareTab.tsx
  // doesn't exist yet (a later task adds it), so the page glob legitimately
  // matches nothing today -- but the data module always exists, so pin it as
  // a floor the glob must clear. If this ever fails, the glob pattern or cwd
  // broke, not the revenue-share logic.
  it("the glob actually finds the revenue-share data module", () => {
    const files = scanTargets();
    expect(files.some((f) => f.endsWith(path.join("src", "lib", "revenueShareApi.ts")))).toBe(true);
  });

  for (const file of scanTargets()) {
    const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
    it(`${relative} does no arithmetic on ntpPercent or realLpPL, directly or under an alias`, () => {
      const code = stripNonCode(readFileSync(file, "utf8"));
      expect(offenders(code), "lpPL comes from the backend. Render it; do not derive it.").toEqual([]);
    });
  }

  // Regression coverage for the detector logic itself, independent of what
  // currently exists on disk -- so a future edit to these helpers that
  // reopens one of the bypasses above fails here even before a real file
  // trips it.
  describe("the detector itself", () => {
    it("catches a destructuring rename", () => {
      const code = stripNonCode("const { realLpPL: pl, ntpPercent: pct } = row; const lpPL = pl * pct;");
      expect(offenders(code)).not.toEqual([]);
    });

    it("catches a value copied out under a new name and used later", () => {
      const code = stripNonCode("const x = row.realLpPL; const y = row.ntpPercent; const lpPL = (x * y) / 100;");
      expect(offenders(code)).not.toEqual([]);
    });

    it("still catches the literal form", () => {
      const code = stripNonCode("const lpPL = row.realLpPL * (row.ntpPercent / 100);");
      expect(offenders(code)).not.toEqual([]);
    });

    // Strings are no longer stripped (see stripNonCode above), so prose
    // naming the formula must spell it with an `x`, not a literal `*`/`/`,
    // to avoid tripping the suite -- documented in the header comment and
    // exercised here. Note this only covers the multiplication: a phrase
    // like "ntpPercent / 100" still trips the detector even with the `x`
    // rule followed, because `ntpPercent` sits directly against a literal
    // `/`. Prose describing the percent-to-fraction division has to avoid
    // that adjacency too (e.g. "divided by 100"), which is why these
    // fixtures don't mention the `/ 100` step.
    it("does not fire on prose naming the fields with 'x', inside a string literal", () => {
      const code = stripNonCode('const helpText = "lpPL is computed as realLpPL x ntpPercent by the backend";');
      expect(offenders(code)).toEqual([]);
    });

    it("does not fire on prose naming the fields with 'x', inside a template literal", () => {
      const code = stripNonCode("const helpText = `realLpPL x ntpPercent = lpPL for ${lpName}`;");
      expect(offenders(code)).toEqual([]);
    });

    // The flip side of the two tests above: this is the accepted false
    // positive from no longer stripping strings. Prose that spells the
    // formula with a literal `*`/`/` now fails the suite -- worse than
    // silently missing a real violation, per the header comment.
    it("fires on prose naming the fields with a literal '*', inside a string literal (accepted false positive)", () => {
      const code = stripNonCode('const helpText = "lpPL is computed as realLpPL * ntpPercent / 100 by the backend";');
      expect(offenders(code)).not.toEqual([]);
    });

    it("does not fire on an object literal that merely names a field realLpPL", () => {
      // `{ realLpPL: x }` here constructs a return value from some unrelated
      // `x` -- it is not a destructuring extraction, so `x` must not become
      // a tracked alias.
      const code = stripNonCode("function build(x) { return { realLpPL: x, other: x * 2 }; }");
      expect(offenders(code)).toEqual([]);
    });

    // Regression for a real bug a reviewer found in string-stripping: a
    // trailing `//` comment (not a full-line one) is never removed, so an
    // apostrophe inside it -- "don't" -- is mistaken for the start of a
    // string literal. The single-quote regex has no line anchor, so it
    // pairs with the *next* apostrophe anywhere later in the file and wipes
    // out everything in between, including genuine arithmetic on an
    // intervening line. A tripwire that can erase the violation it exists
    // to catch is worse than one that occasionally cries wolf on prose.
    it("does not erase real arithmetic sitting between two apostrophes in trailing comments", () => {
      const code = stripNonCode(
        [
          "const label = row.realLpPL; // don't touch this",
          "const lpPL = row.realLpPL * (row.ntpPercent / 100);",
          "const other = 1; // won't matter",
        ].join("\n"),
      );
      expect(offenders(code)).not.toEqual([]);
    });

    // Regression for the second half of the same bug: template-literal
    // stripping deleted `${...}` wholesale, so real arithmetic written as a
    // JSX label -- `` `${row.realLpPL * (row.ntpPercent / 100)}` `` --
    // vanished before the offender check ever saw it.
    it("does not erase real arithmetic written inside a template-literal interpolation", () => {
      const code = stripNonCode("const label = `${row.realLpPL * (row.ntpPercent / 100)}`;");
      expect(offenders(code)).not.toEqual([]);
    });
  });
});
