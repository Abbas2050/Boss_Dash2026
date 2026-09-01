import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { failedProviderNames } from "./AccountsDepartment";

const ACCOUNTS = readFileSync("src/components/dashboard/AccountsDepartment.tsx", "utf8");
const PAGES = readFileSync("src/pages/DepartmentPages.tsx", "utf8");

// Only the JSX the page layout returns. Scanning the whole file would find
// every one of these strings in the card branch below and pass whether the
// page branch carries them or not -- the exact failure that let a regex
// "protecting" the understatement notice match three unrelated places.
const PAGE_BRANCH = ACCOUNTS.slice(
  ACCOUNTS.indexOf("if (layout === 'page')"),
  ACCOUNTS.indexOf("// --- Card layout (default) ---"),
);

// The tail of the data-fetching useEffect, where fetchFab() and
// fetchLpEquitySummary() are called and their intervals set up. Sliced out
// the same way as PAGE_BRANCH above, and for the same reason: scanning the
// whole file would find these calls regardless of which branch guards them.
const EFFECT_TAIL = ACCOUNTS.slice(
  ACCOUNTS.indexOf("let walletInterval"),
  ACCOUNTS.indexOf("}, [refreshKey"),
);

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

  it("mounts both new panels in the page branch", () => {
    expect(ACCOUNTS).toMatch(/<BalancesPanel/);
    expect(ACCOUNTS).toMatch(/<TreasuryPanel/);
  });

  // The notice exists to report that netAllCurrentBalance is understated. It
  // can only do that if it is actually given the failed providers.
  it("feeds the treasury panel the providers that failed", () => {
    expect(ACCOUNTS).toMatch(/failedProviders=\{failedProviders\}/);
    expect(ACCOUNTS).toMatch(/const failedProviders = failedProviderNames\(walletWidgets\)/);
  });

  // Both panels on this page are built from one wallet fetch. Without these
  // two signals a failed or still-pending first fetch renders a Crypto
  // heading with no rows, $0.00 total combined and eight Treasury tiles all
  // reading $0.00 -- a page of confident zeroes where the card branch said
  // why. PAGE_BRANCH, not ACCOUNTS: the card branch already contains both.
  it("says why the page is empty instead of showing a page of zeroes", () => {
    expect(PAGE_BRANCH).toMatch(/\{walletError && \(/);
    expect(PAGE_BRANCH).toMatch(/pspBalances\.length === 0 && !isLoading/);
    expect(PAGE_BRANCH).toContain("No wallet data available.");
  });
});

// The client's instruction was explicit: "u dont need to change anythng on
// the home page / dont touch home page / just work on accounts page only".
// Excess Funds used to mount in both the page branch and the card branch
// (the card branch mount fed the home dashboard's Accounts card and the
// Dealing (LP) card). It must now render only on the accounts page.
describe("Excess Funds is scoped to the accounts page only", () => {
  it("mounts ExcessFundsSection exactly once, inside the page branch", () => {
    // Scanning the whole file, not PAGE_BRANCH: a second mount surviving in
    // the card branch would still pass a "PAGE_BRANCH contains it" check.
    const mounts = ACCOUNTS.match(/<ExcessFundsSection/g) || [];
    expect(mounts.length).toBe(1);
    expect(PAGE_BRANCH).toMatch(/<ExcessFundsSection/);
  });

  // fetchFab() feeds fabAccounts, which only excessInputs (and therefore only
  // ExcessFundsSection) reads. The plain home Accounts card -- layout 'card',
  // mode not 'lp' -- must not call /api/fab-accounts for a section it no
  // longer shows.
  it("does not fetch /api/fab-accounts when layout is card and mode is not lp", () => {
    const nonLpBranch = EFFECT_TAIL.slice(
      EFFECT_TAIL.indexOf("if (!isLpMode) {"),
      EFFECT_TAIL.indexOf("} else {"),
    );
    const pageGuardIndex = nonLpBranch.indexOf("if (layout === 'page')");
    const fetchFabIndex = nonLpBranch.indexOf("void fetchFab();");
    // fetchFab must exist only nested inside a layout==='page' guard within
    // the non-LP branch -- not called unconditionally for every non-LP mount
    // (which would include the plain home Accounts card).
    expect(pageGuardIndex).toBeGreaterThan(-1);
    expect(fetchFabIndex).toBeGreaterThan(pageGuardIndex);
  });
});

// TreasuryPanel's "understated" notice is the only thing on the page that
// says netAllCurrentBalance is missing money, and it says nothing at all when
// this list comes back empty. It used to be an inline .filter().map() guarded
// only by /status === 'error'/ over this file's source -- a pattern that
// matched three other places, matched before the derivation was even written,
// and went on passing when the derivation was replaced with
// `.filter(() => false)`. These exercise the function itself, so silencing it
// costs a red test.
describe("naming the providers whose balance could not be read", () => {
  const w = (id: string, name: string, status?: string) => ({ id, name, balance: 0, status });

  it("names a provider that failed its balance check", () => {
    expect(failedProviderNames([w("tron1", "TRON Wallet 1", "error")])).toEqual(["TRON Wallet 1"]);
  });

  it("does not name a provider that reported ok", () => {
    expect(failedProviderNames([w("ownbit", "OwnBit", "ok")])).toEqual([]);
  });

  // walletMonitor.js omits `status` entirely on some providers. An absent
  // status is not a failure -- treating it as one would put every one of them
  // in a notice claiming the total is understated.
  it("does not name a provider that reported no status at all", () => {
    expect(failedProviderNames([w("mbme", "MBME")])).toEqual([]);
  });

  it("gives an empty list for an empty widget list", () => {
    expect(failedProviderNames([])).toEqual([]);
  });

  // The 2026-09-01 Tronscan incident: two wallets failed at once and $11,840.66
  // silently left Total Combined. Both must be named, in order, alongside the
  // providers that were fine.
  it("names every failure and only the failures, in widget order", () => {
    const names = failedProviderNames([
      w("tron1", "TRON Wallet 1", "error"),
      w("ownbit", "OwnBit", "ok"),
      w("tron2", "TRON Wallet 2", "error"),
    ]);
    expect(names).toEqual(["TRON Wallet 1", "TRON Wallet 2"]);
  });
});
