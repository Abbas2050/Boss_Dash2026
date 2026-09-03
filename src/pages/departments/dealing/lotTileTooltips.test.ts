// @vitest-environment node
//
// Every lot tile explains itself.
//
// The ten tiles in the MT5 Client Volume and Bridge / Matched groups are the
// only place the dashboard states these figures, and their meanings are not
// guessable from the labels: "deals" counts each leg of a round trip while
// "realized" counts the closed position once, shifting lots are balance and
// credit movements rather than trading, and internal lots are a parallel bucket
// that is not part of client flow at all. A reader who does not already know
// that will misread the numbers rather than notice they are confused.
//
// Three tiles shipped without a `title` for months -- Shifting Deals, Shifting
// Realized and Internal Realized -- and nothing caught it, because a missing
// tooltip is invisible in a diff and invisible on screen. That is exactly the
// kind of gap a source scan is for.
//
// The same wording now also appears beneath each figure in the report emails
// (reports/volumeSection.js), because a tooltip cannot travel in an email --
// mail clients drop `title`. The two must say the same thing; this test only
// enforces that a tooltip EXISTS, since asserting the prose would break on any
// copy edit and pin the email and the tab together in a way neither deserves.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = path.join(process.cwd(), "src/pages/departments/dealing/DealMatchingTab.tsx");

/**
 * Each `<LotTile ... />` element as one flat string, attributes included.
 *
 * Tiles are written across two lines when they carry a title, so this cannot
 * scan line by line -- doing so was how the gap survived review in the first
 * place. Matching to the closing `/>` keeps a multi-line tile intact.
 */
function lotTiles(source: string): string[] {
  return source.match(/<LotTile[\s\S]*?\/>/g) ?? [];
}

function labelOf(tile: string): string {
  return tile.match(/label="([^"]*)"/)?.[1] ?? "(unlabelled)";
}

describe("LotTile tooltips", () => {
  const source = readFileSync(SOURCE, "utf8");
  const tiles = lotTiles(source);

  it("finds every tile in the file", () => {
    // Ten figures: eight MT5 client volume, two bridge/matched. If this number
    // changes, a tile was added or removed and the expectation below should be
    // updated deliberately rather than the test loosened.
    expect(tiles.length).toBe(10);
  });

  it("gives every tile a title", () => {
    const untitled = tiles.filter((t) => !/\btitle="/.test(t)).map(labelOf);
    expect(untitled).toEqual([]);
  });

  it("gives every title real prose, not a placeholder", () => {
    // A one-word title satisfies the check above while explaining nothing.
    const thin = tiles
      .map((t) => ({ label: labelOf(t), title: t.match(/\btitle="([^"]*)"/)?.[1] ?? "" }))
      .filter((t) => t.title.trim().length < 25)
      .map((t) => t.label);
    expect(thin).toEqual([]);
  });

  it("covers the three tiles that were missing one", () => {
    // Named explicitly: these are the regression, and a future refactor that
    // drops their titles should fail here saying so, not just in the count.
    for (const label of ["Shifting Deals", "Shifting Realized", "Internal Realized"]) {
      const tile = tiles.find((t) => labelOf(t) === label);
      expect(tile, `no tile labelled ${label}`).toBeDefined();
      expect(tile, `${label} has no title`).toMatch(/\btitle="/);
    }
  });
});
