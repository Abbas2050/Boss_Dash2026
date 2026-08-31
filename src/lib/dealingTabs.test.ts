// @vitest-environment node
//
// Regression guard for the "mounted but unreachable" class of bug: commit
// 5454374 added a "Revenue Share" tab to DEALING_MENU_QUERY_MAP and to the
// render branch in DealingDepartmentPage.tsx, but never added it to
// DEALING_TABS in src/lib/permissions.ts. DEALING_TABS is what drives the
// visible nav buttons AND the allowedMenuItems permission check, so the tab
// mounted for one render and then the "reset to first allowed tab" effect
// (DealingDepartmentPage.tsx ~1320-1326) immediately redirected away from it.
//
// This test parses DEALING_MENU_QUERY_MAP out of the page source (it is not
// exported, and importing the page module directly would drag in the full
// React component tree) and asserts every display label it maps to is also
// present in DEALING_TABS. That is the exact invariant that broke.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEALING_TABS } from "@/lib/permissions";

const PAGE_PATH = path.resolve(__dirname, "../pages/departments/DealingDepartmentPage.tsx");

function extractMenuQueryMapLabels(): string[] {
  const source = readFileSync(PAGE_PATH, "utf8");
  const start = source.indexOf("const DEALING_MENU_QUERY_MAP");
  if (start === -1) {
    throw new Error("DEALING_MENU_QUERY_MAP not found in DealingDepartmentPage.tsx -- has it been renamed/moved?");
  }
  const blockStart = source.indexOf("{", start);
  const blockEnd = source.indexOf("};", blockStart);
  if (blockStart === -1 || blockEnd === -1) {
    throw new Error("Could not locate DEALING_MENU_QUERY_MAP object literal body.");
  }
  const body = source.slice(blockStart + 1, blockEnd);

  // Each entry looks like:  slug: "Display Label",   or   "slug-with-dash": "Display Label",
  // We only need the right-hand side (the display label the slug resolves to).
  const labelPattern = /:\s*"([^"]+)"/g;
  const labels = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(body)) !== null) {
    labels.add(match[1]);
  }
  return Array.from(labels);
}

describe("DEALING_MENU_QUERY_MAP labels stay registered in DEALING_TABS", () => {
  it("parses at least one label out of the source (sanity check on the parser itself)", () => {
    const labels = extractMenuQueryMapLabels();
    expect(labels.length).toBeGreaterThan(5);
  });

  it("every display label DEALING_MENU_QUERY_MAP resolves to exists in DEALING_TABS", () => {
    const labels = extractMenuQueryMapLabels();
    const missing = labels.filter((label) => !(DEALING_TABS as readonly string[]).includes(label));
    expect(missing).toEqual([]);
  });

  it("includes Revenue Share specifically (the tab this regression test was written for)", () => {
    const labels = extractMenuQueryMapLabels();
    expect(labels).toContain("Revenue Share");
    expect(DEALING_TABS as readonly string[]).toContain("Revenue Share");
  });
});
