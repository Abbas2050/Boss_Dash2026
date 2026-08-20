// @vitest-environment node
//
// Some formatters in the dealing page return a coloured JSX <span> rather than
// a string. Dropped into a template literal they render as "[object Object]",
// and nothing catches it: TypeScript allows any value in a template literal,
// and the page still compiles and renders.
//
// It reached production twice -- the Bonus Equity cards showed "Bal [object
// Object]" and "Free [object Object]", and the equity tooltips showed it for
// every figure. Use formatDollarText (or another string-returning helper) when
// building a string.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const FILES = [
  "src/pages/departments/DealingDepartmentPage.tsx",
];

// A formatter is JSX-returning if its body contains a JSX tag.
function jsxFormatters(source: string): string[] {
  const found: string[] = [];
  const declaration = /const (\w+) = \([^)]*\) => \{([\s\S]*?)\n\};/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const [, name, body] = match;
    if (/<(span|div|p|strong)[\s>]/.test(body)) found.push(name);
  }
  return found;
}

describe("JSX formatters are never interpolated into strings", () => {
  for (const file of FILES) {
    it(`${file} has no "[object Object]" interpolation`, () => {
      const source = readFileSync(path.resolve(file), "utf8");
      const offenders = jsxFormatters(source).filter((name) => source.includes("${" + name + "("));
      expect(
        offenders,
        offenders.length
          ? `These return JSX but are used inside a template literal, which renders as "[object Object]": ${offenders.join(", ")}. Use a string-returning formatter such as formatDollarText instead.`
          : "",
      ).toEqual([]);
    });
  }

  it("recognises a JSX-returning formatter", () => {
    const sample = [
      "const formatThing = (value: number) => {",
      '  if (value === 0) return <span className="x">zero</span>;',
      "  return null;",
      "};",
    ].join("\n");
    expect(jsxFormatters(sample)).toContain("formatThing");
  });

  it("does not flag a plain string formatter", () => {
    const sample = ["const formatPlain = (value: number) => {", "  return String(value);", "};"].join("\n");
    expect(jsxFormatters(sample)).toEqual([]);
  });
});
