import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ACCOUNTS = readFileSync("src/components/dashboard/AccountsDepartment.tsx", "utf8");
const PAGES = readFileSync("src/pages/DepartmentPages.tsx", "utf8");

describe("only the department page gets the new layout", () => {
  it("defaults the layout prop to card", () => {
    expect(ACCOUNTS).toMatch(/layout\s*=\s*['"]card['"]/);
  });

  // The home dashboard was explicitly excluded from this redesign. If any of
  // its mounts started passing layout="page" the cramped column would get a
  // full-width layout and look worse than before.
  it("is requested only from DepartmentPages", () => {
    expect(PAGES).toMatch(/layout=["']page["']/);
    for (const file of ["src/pages/Index.tsx", "src/pages/MainDashboard.tsx", "src/components/dashboard/MT5Examples.tsx"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/layout=["']page["']/);
    }
  });

  it("mounts all three panels in the page branch", () => {
    expect(ACCOUNTS).toMatch(/<BalancesPanel/);
    expect(ACCOUNTS).toMatch(/<TreasuryPanel/);
    expect(ACCOUNTS).toMatch(/<ExcessFundsSection/);
  });

  // The notice exists to report that netAllCurrentBalance is understated. It
  // can only do that if it is actually given the failed providers.
  it("feeds the treasury panel the providers that failed", () => {
    expect(ACCOUNTS).toMatch(/failedProviders=\{/);
    expect(ACCOUNTS).toMatch(/status\s*===\s*['"]error['"]/);
  });
});
