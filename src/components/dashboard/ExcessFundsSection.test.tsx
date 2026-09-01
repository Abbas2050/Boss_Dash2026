import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { excessHeadlines, excessSourceGroups } from "./ExcessFundsSection";
import type { ExcessFundsInputs } from "@/lib/excessFunds";

// The live figures from 2026-09-01 19:18, so the arithmetic is anchored to a
// real page rather than to numbers picked to make a test pass.
const INPUTS: ExcessFundsInputs = {
  netDifference: -1133202.07,
  netCrypto: 40255.84,
  fabAndMbme: 204799.11,
  goldSouq: 34130.96,
  fabOperating: 0,
  fabHolding: 0,
};

const props = (over: Partial<ExcessFundsInputs> = {}, lp: number | null = 3343713.27, cl: number | null = 4476915.34) =>
  ({ inputs: { ...INPUTS, ...over }, lpEquity: lp, clientEquity: cl });

const groupTitles = (p = props()) => excessSourceGroups(p as never).map((g) => g.title);
const rowsOf = (title: string, p = props()) =>
  excessSourceGroups(p as never).find((g) => g.title === title)?.rows ?? [];
const rowValue = (title: string, label: string, p = props()) =>
  rowsOf(title, p).find((r) => r.label === label)?.value;

describe("the two headline figures", () => {
  it("leads with gross and net, in that order", () => {
    const [gross, net] = excessHeadlines(props() as never);
    expect(gross.label).toBe("Gross excess fund");
    expect(net.label).toBe("Net excess fund");
  });

  it("computes both from the live figures", () => {
    // -1,133,202.07 + 40,255.84 + 204,799.11 + 34,130.96 = -854,016.16
    const [gross, net] = excessHeadlines(props() as never);
    expect(gross.value).toBe("-$854,016.16");
    // both company balances are a genuine zero today, so net equals gross
    expect(net.value).toBe("-$854,016.16");
  });

  it("tones a negative result as negative", () => {
    const [gross] = excessHeadlines(props() as never);
    expect(gross.tone).toBe("negative");
    expect(gross.unavailable).toBe(false);
  });

  it("marks a figure unavailable and says what was missing", () => {
    const [gross, net] = excessHeadlines(props({ netCrypto: null }) as never);
    expect(gross.unavailable).toBe(true);
    expect(gross.value).toBe("—");
    expect(gross.why).toContain("Net Crypto");
    expect(net.unavailable).toBe(true);
  });

  // Losing only the company balances must cost net alone. This is the state on
  // any morning nobody has filled the FAB sheet in.
  it("leaves gross standing when only the company balances are missing", () => {
    const [gross, net] = excessHeadlines(props({ fabOperating: null, fabHolding: null }) as never);
    expect(gross.unavailable).toBe(false);
    expect(gross.value).toBe("-$854,016.16");
    expect(net.unavailable).toBe(true);
  });

  // computeExcessFunds still emits the client-rejected "FAB Operating
  // Balance" / "FAB Holding Balance" strings into missing[] (that library is
  // out of scope and its own tests pin those strings exactly). This is the
  // single likeliest failure a reader sees -- most mornings the company sheet
  // just isn't filled in yet -- so the component must translate them before
  // they reach the "why" text.
  it("translates the rejected FAB names to the approved company names when the net figure is unavailable", () => {
    const [, net] = excessHeadlines(props({ fabOperating: null, fabHolding: null }) as never);
    expect(net.why).toContain("Skylinks Capital LLC");
    expect(net.why).toContain("Skylink holdings");
    expect(net.why).not.toContain("FAB Operating");
    expect(net.why).not.toContain("FAB Holding");
  });

  // Any missing label the library already names sensibly -- like crypto --
  // must pass through untouched rather than being swallowed by the map.
  it("leaves an already-sensible missing label alone, such as crypto on the gross figure", () => {
    const [gross] = excessHeadlines(props({ netCrypto: null }) as never);
    expect(gross.why).toContain("Net Crypto");
  });

  // Both a rejected name and a pass-through name can be missing at once (a
  // failed company sheet plus a failed crypto read); both must be named, not
  // just the first one translated.
  it("names both a translated and a pass-through label when both are missing together", () => {
    const [, net] = excessHeadlines(props({ netCrypto: null, fabOperating: null, fabHolding: null }) as never);
    expect(net.why).toContain("Net Crypto");
    expect(net.why).toContain("Skylinks Capital LLC");
    expect(net.why).toContain("Skylink holdings");
    expect(net.why).not.toContain("FAB Operating");
    expect(net.why).not.toContain("FAB Holding");
  });
});

describe("the inputs are grouped by where they came from", () => {
  it("uses three groups, named for their source", () => {
    expect(groupTitles()).toEqual(["Equity", "Wallet and bank", "Company accounts"]);
  });

  it("puts the equity pair and their gap together", () => {
    expect(rowsOf("Equity").map((r) => r.label)).toEqual(["LP", "Client", "Gap"]);
    expect(rowValue("Equity", "LP")).toBe("$3,343,713.27");
    expect(rowValue("Equity", "Gap")).toBe("-$1,133,202.07");
  });

  // The gap is the backend's netDifference, not a subtraction performed here.
  // Feeding mismatched equity cards must not change it.
  it("shows the backend's gap rather than subtracting the two cards", () => {
    const p = props({}, 999, 1);
    expect(rowValue("Equity", "Gap", p)).toBe("-$1,133,202.07");
  });

  it("keeps the wallet figures together", () => {
    expect(rowsOf("Wallet and bank").map((r) => r.label)).toEqual(["Crypto", "FAB and MBME", "Gold Souq"]);
  });

  // "FAB Operating Balance" beside "FAB and MBME" read as the same account
  // twice. These are separate companies, from a different sheet.
  it("names the company accounts by their entity, never as FAB", () => {
    expect(rowsOf("Company accounts").map((r) => r.label)).toEqual(["Skylinks Capital LLC", "Skylink holdings"]);
    const all = JSON.stringify(excessSourceGroups(props() as never));
    expect(all).not.toContain("FAB Operating");
    expect(all).not.toContain("FAB Holding");
  });
});

describe("a dash is not a zero", () => {
  it("renders a genuine zero as money", () => {
    expect(rowValue("Company accounts", "Skylinks Capital LLC")).toBe("$0.00");
  });

  it("renders an unreadable input as a dash", () => {
    expect(rowValue("Wallet and bank", "Gold Souq", props({ goldSouq: null }))).toBe("—");
  });

  it("renders a failed equity fetch as dashes on both cards", () => {
    const p = props({}, null, null);
    expect(rowValue("Equity", "LP", p)).toBe("—");
    expect(rowValue("Equity", "Client", p)).toBe("—");
  });
});

describe("no cell references reach the UI", () => {
  // "SEP 2026!B3" under a card is diagnostic output, not something a reader
  // asked for. It stays in the API response; it does not belong on screen.
  it("carries no sheet or cell address anywhere", () => {
    const rendered = JSON.stringify([excessHeadlines(props() as never), excessSourceGroups(props() as never)]);
    expect(rendered).not.toMatch(/SEP\s*20\d\d/);
    expect(rendered).not.toMatch(/![A-Z]\d/);
  });

  // The section used to accept a fabSource prop wiring the FAB workbook's cell
  // addresses straight in from both call sites. Nothing read it -- not the
  // exported functions, not the component body -- but a live wire from cell
  // addresses into a component whose governing rule is that no cell reference
  // reaches the UI is how one comes back.
  it("is not handed the cell addresses in the first place", () => {
    expect(readFileSync("src/components/dashboard/ExcessFundsSection.tsx", "utf8")).not.toMatch(/\bcells\b/);
  });
});

// This section renders at two very different widths from a single set of
// classes: full width on /departments/accounts, and inside the home
// dashboard's lg:col-span-4 third-width column, because AccountsDepartment's
// card branch mounts the very same component. The card branch was excluded
// from the redesign but did not escape it. These assertions read the source
// because the property is the class list itself -- jsdom has no layout engine
// and would report every width as 0.
describe("the section fits the narrow column it also renders in", () => {
  // Comments stripped first: the classes these assertions forbid are named in
  // the prose explaining why they were wrong, and a tripwire that fires on its
  // own explanation is worthless.
  const SECTION = readFileSync("src/components/dashboard/ExcessFundsSection.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("never pairs the two headlines unconditionally", () => {
    // A bare grid-cols-2 gives each headline ~150px in the third-width column,
    // which -$854,016.16 does not fit in at headline size.
    expect(SECTION).not.toMatch(/grid-cols-2(?![\w-])/);
  });

  it("floors each headline cell at a width its figure fits in", () => {
    expect(SECTION).toMatch(/grid-cols-\[repeat\(auto-fit,minmax\(\d+px,1fr\)\)\]/);
  });

  it("truncates a headline figure rather than letting it spill past its border", () => {
    expect(SECTION).toMatch(/font-mono tabular-nums font-semibold [^`"]*\btruncate\b/);
  });

  // sm:/md:/lg: are viewport breakpoints. They are already satisfied on a wide
  // screen, which is precisely when the home dashboard's column is narrowest.
  it("uses no viewport breakpoint to decide its column count", () => {
    expect(SECTION).not.toMatch(/\b(sm|md|lg|xl):grid-cols-/);
  });

  it("lets a long entity name ellipse instead of pushing its figure out of the row", () => {
    expect(SECTION).toMatch(/<span className="min-w-0 truncate text-muted-foreground"/);
    expect(SECTION).toMatch(/flex-none font-mono tabular-nums/);
  });
});
