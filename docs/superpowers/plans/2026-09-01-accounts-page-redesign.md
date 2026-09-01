# Accounts Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/departments/accounts` as a full-width page — Excess Funds first, then Balances and Treasury side by side — without changing how the same component renders on the home dashboard.

**Architecture:** `AccountsDepartment` keeps all its state and fetching and gains a `layout` prop. `layout="card"` (the default) renders exactly the markup it renders today. `layout="page"` renders a new composition built from three extracted presentational panels. The home mounts never pass the prop, so their output is provably unchanged.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, vitest.

**Approved design:** https://claude.ai/code/artifact/04c7c039-b7f8-47ce-b82a-3e673e30455d — the mockup is the visual spec. Match its structure and hierarchy; exact Tailwind classes are the implementer's choice within the constraints below.

**A deliberate departure from how plans are normally written here.** The
implementation steps below give complete test code but describe the components
rather than spelling out their JSX. That is on purpose: the mockup pins the
visuals far better than a wall of Tailwind classes would, and asserting on class
names would produce tests that break on every cosmetic change while proving
nothing. So the tests pin the **contracts** — exported functions, labels,
ordering, formatting, and the dash-versus-zero rule — and the mockup pins the
**look**. Where the two are silent, use judgement and match the surrounding
codebase.

## Global Constraints

- **The home dashboard must not change.** `AccountsDepartment` mounts five times across `Index.tsx` (twice), `MainDashboard.tsx`, `DepartmentPages.tsx` and `MT5Examples.tsx`. Only `DepartmentPages.tsx` passes `layout="page"`. Every other mount renders byte-identical markup to today.
- **No figure's value may change.** This is presentation only. `lpPlusPspDifference`, `metrics.totalBalance`, the eight treasury tiles, `excessInputs`, `computeExcessFunds` — all untouched.
- **Panels are presentational.** They take data as props and do no fetching, no arithmetic beyond formatting. All computation stays where it is.
- **A dash is not a zero.** `—` means "could not read"; `$0.00` means the balance is zero. Every panel keeps that distinction.
- **A failed provider is visibly failed.** A wallet widget with `status: 'error'` renders with a failure dot in the ledger, not as an ordinary `$0.00` row.
- **Figures use tabular numerals** so columns of digits align: `font-variant-numeric: tabular-nums` (Tailwind `tabular-nums`) on every numeric cell.
- **Card labels for the two company balances are `Skylinks Capital LLC` and `Skylink holdings`** — not "FAB Operating Balance" / "FAB Holding Balance", which read as a third FAB figure beside `Net FAB & MBME`.
- **No cell references in the UI.** `SEP 2026!B3` and the like are removed from the cards. The `source` field stays in the API response for diagnostics.
- Run tests with `npx vitest run`. This project's `tsconfig.json` has `"files": []`, so `npx tsc --noEmit` checks **nothing** — always use `npx tsc -b --noEmit`.
- Comments explain **why**, in prose.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/components/dashboard/accounts/BalancesPanel.tsx` (create) | The PSP ledger: grouped rows, per-provider status, subtotal, total. |
| `src/components/dashboard/accounts/TreasuryPanel.tsx` (create) | The eight treasury tiles, plus the failed-provider notice. |
| `src/components/dashboard/ExcessFundsSection.tsx` (modify) | Reworked: two headline figures first, seven inputs grouped by source. |
| `src/components/dashboard/AccountsDepartment.tsx` (modify) | Gains `layout`; renders the page composition when asked. |
| `src/pages/DepartmentPages.tsx` (modify) | Passes `layout="page"`. |

`src/components/dashboard/accounts/` is a new directory. `AccountsDepartment.tsx` is already ~1,050 lines; the page layout goes into panels rather than into it.

---

## Task 1: The Excess Funds section, reworked

**Files:**
- Modify: `src/components/dashboard/ExcessFundsSection.tsx`
- Test: `src/components/dashboard/ExcessFundsSection.test.tsx` (exists — update)

**Interfaces:**
- Consumes: `computeExcessFunds`, `ExcessFundsInputs` from `src/lib/excessFunds.ts` (unchanged).
- Produces: `excessFundsCards()` is **replaced** by two exported functions, because the section now has two visually distinct parts:
  ```ts
  export interface ExcessHeadline { label: string; value: string; tone: "positive" | "negative" | "neutral"; why: string; unavailable: boolean }
  export interface ExcessSourceRow { label: string; value: string; tone: "positive" | "negative" | "neutral" }
  export interface ExcessSourceGroup { title: string; rows: ExcessSourceRow[] }
  export function excessHeadlines(props: ExcessFundsSectionProps): [ExcessHeadline, ExcessHeadline];
  export function excessSourceGroups(props: ExcessFundsSectionProps): ExcessSourceGroup[];
  ```
  `ExcessFundsSectionProps` keeps its existing fields.

**The three copy changes**, all visible in the mockup:
- `FAB Operating Balance` → `Skylinks Capital LLC`; `FAB Holding Balance` → `Skylink holdings`.
- The `SEP 2026!B3` cell-reference notes are removed entirely.
- The seven inputs group into three: **Equity** (LP, Client, and a derived `Gap` row showing `netDifference`), **Wallet and bank** (Crypto, FAB and MBME, Gold Souq), **Company accounts** (the two above).

The `Gap` row displays `inputs.netDifference` — it does **not** subtract the two equity cards. That value is the backend's own field and recomputing it here would create a second answer.

- [ ] **Step 1: Write the failing test**

Replace the contents of `src/components/dashboard/ExcessFundsSection.test.tsx`:

```typescript
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/dashboard/ExcessFundsSection.test.tsx`
Expected: FAIL — `excessHeadlines` and `excessSourceGroups` are not exported.

- [ ] **Step 3: Rewrite the component**

Rewrite `src/components/dashboard/ExcessFundsSection.tsx` so it exports the two functions above and a component that renders, in order:

1. a header row: the title `Excess funds` and, on the right, the source timestamps it already receives;
2. the two headline figures side by side — large, monospace, coloured by sign, each with its one-line explanation beneath, and its unavailable reason in place of that line when unavailable;
3. the three source groups as columns of compact label/value rows.

Keep `money()` and `tone()` as they are — including that anything rounding to `$0.00` tones neutral, and that `null` renders `—`. Reuse the existing `computeExcessFunds` result for both `unavailable` and `why`; do not re-derive which inputs are missing.

Every numeric cell gets Tailwind `font-mono tabular-nums`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/dashboard/ExcessFundsSection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prove the grouping tests can fail**

Rename the `Company accounts` group to `FAB accounts` and change one row label back to `FAB Operating Balance`. Run the test file and confirm the naming tests fail. Restore, confirm they pass. Report both outputs with real counts.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc -b --noEmit
npx vitest run
git add src/components/dashboard/ExcessFundsSection.tsx src/components/dashboard/ExcessFundsSection.test.tsx
git commit -m "Rework the Excess Funds section around its two headline figures"
```

---

## Task 2: The Balances panel

**Files:**
- Create: `src/components/dashboard/accounts/BalancesPanel.tsx`
- Test: `src/components/dashboard/accounts/BalancesPanel.test.tsx`

**Interfaces:**
- Consumes: `WalletWidgetEntry` from `src/lib/walletApi.ts` (`id`, `name`, `balance`, `status`).
- Produces:
  ```ts
  export interface BalancesRow { id: string; label: string; value: string; failed: boolean; kind: "row" | "subtotal" | "total" }
  export interface BalancesPanelProps {
    widgets: readonly WalletWidgetEntry[];
    totalBalance: number;
    reportDate: string | null;
    order: readonly { key: string; label: string; group: "crypto" | "bank" }[];
  }
  export function balancesRows(props: BalancesPanelProps): { crypto: BalancesRow[]; bank: BalancesRow[]; total: BalancesRow };
  export function BalancesPanel(props: BalancesPanelProps): JSX.Element;
  ```

`order` is `PSP_ORDER`, passed in rather than imported, so the panel stays presentational and the test can supply its own.

**Why `failed` exists.** `wallet/walletMonitor.js` returns `balance: 0, status: 'error'` when a provider's check fails. Today that renders as an ordinary `$0.00` row, indistinguishable from a real zero — which is how `$11,840.66` silently vanished from Total Combined when Tronscan rate-limited two wallets. The row keeps its `$0.00` (the figure is what the API said) but is marked `failed` so the panel can show it as failed.

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/accounts/BalancesPanel.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { balancesRows } from "./BalancesPanel";

const ORDER = [
  { key: "ownbit", label: "OwnBit", group: "crypto" },
  { key: "ownbitnew", label: "OwnBit New", group: "crypto" },
  { key: "googlesheets_goldsouq", label: "Gold Souq", group: "bank" },
  { key: "googlesheets_fab", label: "FAB Bank", group: "bank" },
] as const;

const w = (id: string, balance: number, status = "ok", name?: string) => ({ id, name: name ?? id, balance, status });

const props = (widgets: ReturnType<typeof w>[], totalBalance = 0) =>
  ({ widgets, totalBalance, reportDate: "2026-09-01", order: ORDER }) as never;

describe("grouping", () => {
  it("splits crypto from bank in the given order", () => {
    const { crypto, bank } = balancesRows(props([w("ownbit", 1), w("ownbitnew", 2), w("googlesheets_goldsouq", 3), w("googlesheets_fab", 4)]));
    expect(crypto.filter((r) => r.kind === "row").map((r) => r.id)).toEqual(["ownbit", "ownbitnew"]);
    expect(bank.map((r) => r.id)).toEqual(["googlesheets_goldsouq", "googlesheets_fab"]);
  });

  it("ends the crypto group with a subtotal of its own rows", () => {
    const { crypto } = balancesRows(props([w("ownbit", 1000), w("ownbitnew", 234.5)]));
    const last = crypto[crypto.length - 1];
    expect(last.kind).toBe("subtotal");
    expect(last.value).toBe("$1,234.50");
  });

  it("reports the total the API gave, not a sum of its own", () => {
    // totalBalance comes from the backend. Re-summing here would create a
    // second answer to the same question.
    const { total } = balancesRows(props([w("ownbit", 1), w("ownbitnew", 2)], 999999.99));
    expect(total.value).toBe("$999,999.99");
  });
});

describe("a failed provider is visibly failed", () => {
  // walletMonitor returns balance 0 with status 'error'. Rendering that as a
  // plain $0.00 is how $11,840.66 silently left Total Combined when Tronscan
  // rate-limited two wallets on 2026-09-01.
  it("marks a status:error row as failed while keeping its reported value", () => {
    const { crypto } = balancesRows(props([w("ownbit", 0, "error"), w("ownbitnew", 500)]));
    const failed = crypto.find((r) => r.id === "ownbit");
    expect(failed?.failed).toBe(true);
    expect(failed?.value).toBe("$0.00");
    expect(crypto.find((r) => r.id === "ownbitnew")?.failed).toBe(false);
  });

  it("does not mark a genuine zero as failed", () => {
    const { crypto } = balancesRows(props([w("ownbit", 0, "ok")]));
    expect(crypto.find((r) => r.id === "ownbit")?.failed).toBe(false);
  });
});

describe("missing widgets", () => {
  it("omits a widget the response did not carry rather than inventing a zero", () => {
    const { bank } = balancesRows(props([w("googlesheets_fab", 10)]));
    expect(bank.map((r) => r.id)).toEqual(["googlesheets_fab"]);
  });

  it("prefers the widget's own name over the configured label", () => {
    const { bank } = balancesRows(props([w("googlesheets_goldsouq", 5, "ok", "Gold Souq (-$30,000.00 deducted, J31)")]));
    expect(bank[0].label).toBe("Gold Souq (-$30,000.00 deducted, J31)");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/dashboard/accounts/BalancesPanel.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the panel**

Create `src/components/dashboard/accounts/BalancesPanel.tsx` exporting `balancesRows` and `BalancesPanel`, rendering the ledger from the mockup: a group heading per group, one row per provider with a small status dot, a subtotal row closing the crypto group, and a bolder total row at the bottom. Numeric cells get `font-mono tabular-nums`. A `failed` row shows its dot in the failure colour and carries `title="Balance could not be read"` for hover.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/dashboard/accounts/BalancesPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc -b --noEmit
git add src/components/dashboard/accounts/BalancesPanel.tsx src/components/dashboard/accounts/BalancesPanel.test.tsx
git commit -m "Add the Balances panel, with failed providers marked"
```

---

## Task 3: The Treasury panel

**Files:**
- Create: `src/components/dashboard/accounts/TreasuryPanel.tsx`
- Test: `src/components/dashboard/accounts/TreasuryPanel.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface TreasuryTile { label: string; value: string; tone: "positive" | "negative" | "neutral" }
  export interface TreasuryPanelProps {
    bankReceivable: number; cryptoReceivable: number;
    toLpsBank: number; toLpsCrypto: number;
    netAllCurrentBalance: number; netAfterExpectedFunds: number;
    differenceActualVsExpected: number; creditByLps: number;
    failedProviders: readonly string[];
  }
  export function treasuryTiles(props: TreasuryPanelProps): TreasuryTile[];
  export function treasuryNotice(props: TreasuryPanelProps): string | null;
  export function TreasuryPanel(props: TreasuryPanelProps): JSX.Element;
  ```

`failedProviders` is the display names of any wallet widgets with `status: 'error'`. When non-empty the panel shows a notice, because `netAllCurrentBalance` counts those providers as zero and is therefore understated. The tile values themselves do not change — this reports the caveat, it does not correct the figure.

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/accounts/TreasuryPanel.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { treasuryTiles, treasuryNotice } from "./TreasuryPanel";

const LIVE = {
  bankReceivable: 0,
  cryptoReceivable: 0,
  toLpsBank: 250000,
  toLpsCrypto: 0,
  netAllCurrentBalance: 279185.91,
  netAfterExpectedFunds: 559079.62,
  differenceActualVsExpected: -250000,
  creditByLps: 0,
  failedProviders: [] as string[],
};

describe("the eight tiles", () => {
  it("renders all eight, in the order the sheet lists them", () => {
    expect(treasuryTiles(LIVE).map((t) => t.label)).toEqual([
      "To be received in bank",
      "To be received in crypto",
      "To deposit into LPs, bank",
      "To deposit into LPs, crypto",
      "Net all current balance",
      "Net after expected funds",
      "Actual versus expected",
      "Credit by LPs",
    ]);
  });

  it("formats the live figures", () => {
    const tiles = treasuryTiles(LIVE);
    expect(tiles.find((t) => t.label === "Net all current balance")?.value).toBe("$279,185.91");
    expect(tiles.find((t) => t.label === "Actual versus expected")?.value).toBe("-$250,000.00");
  });

  it("tones a negative tile as negative and a zero as neutral", () => {
    const tiles = treasuryTiles(LIVE);
    expect(tiles.find((t) => t.label === "Actual versus expected")?.tone).toBe("negative");
    expect(tiles.find((t) => t.label === "Credit by LPs")?.tone).toBe("neutral");
  });
});

describe("the understatement notice", () => {
  // netAllCurrentBalance counts a failed provider as zero. Saying so is the
  // whole point: on 2026-09-01 two rate-limited wallets took $11,840.66 out of
  // it with nothing on screen to indicate it.
  it("says nothing when every provider reported", () => {
    expect(treasuryNotice(LIVE)).toBeNull();
  });

  it("names the failed providers when any did not", () => {
    const notice = treasuryNotice({ ...LIVE, failedProviders: ["OwnBit", "OwnBit New"] });
    expect(notice).toContain("OwnBit");
    expect(notice).toContain("OwnBit New");
    expect(notice).toMatch(/understat/i);
  });

  it("does not change any tile's value when a provider failed", () => {
    const before = treasuryTiles(LIVE);
    const after = treasuryTiles({ ...LIVE, failedProviders: ["OwnBit"] });
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/dashboard/accounts/TreasuryPanel.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the panel**

Create the module exporting `treasuryTiles`, `treasuryNotice` and `TreasuryPanel`. Two-column tile grid as in the mockup, `font-mono tabular-nums` on values, the notice rendered beneath the grid in the warning colour when `treasuryNotice` returns a string.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/dashboard/accounts/TreasuryPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc -b --noEmit
git add src/components/dashboard/accounts/TreasuryPanel.tsx src/components/dashboard/accounts/TreasuryPanel.test.tsx
git commit -m "Add the Treasury panel, which says when its total is understated"
```

---

## Task 4: Compose the page, without touching the card

**Files:**
- Modify: `src/components/dashboard/AccountsDepartment.tsx`, `src/pages/DepartmentPages.tsx`
- Test: `src/components/dashboard/accountsLayout.test.ts` (create)

**Interfaces:**
- Consumes: `BalancesPanel`, `TreasuryPanel` (Tasks 2–3), `ExcessFundsSection` (Task 1).
- Produces: `AccountsDepartment` accepts `layout?: 'card' | 'page'`, defaulting to `'card'`.

**The constraint that governs this task.** `AccountsDepartment` mounts five times. Only `DepartmentPages.tsx` passes `layout="page"`. Every other mount must render exactly what it renders today — so the existing JSX stays in place as the `card` branch, unedited, and the page composition is new JSX beside it.

That duplicates markup between the two branches. It is deliberate and scoped: the home card was explicitly excluded from this redesign. Note it in a comment naming the follow-up — unifying the two is a later change that needs its own approval, because it alters figures on the home dashboard.

The page composition, per the mockup, in order:
1. A page header: the title, and the three source timestamps on the right.
2. The day's flow strip: Deposits, Withdrawals, Net Flow — the values already in `metrics`.
3. `ExcessFundsSection`, full width.
4. A two-column row: `BalancesPanel` on the left (wider), `TreasuryPanel` on the right. Single column below `lg`.

`failedProviders` for `TreasuryPanel` is derived from the same `walletWidgets` the Excess Funds inputs use — the widgets whose `status` is `'error'`, by display name.

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/accountsLayout.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/dashboard/accountsLayout.test.ts`
Expected: FAIL — no `layout` prop exists.

- [ ] **Step 3: Record what the card renders today**

Before editing, capture the card-mode markup so Step 6 can prove it did not move:

```bash
git show HEAD:src/components/dashboard/AccountsDepartment.tsx > .superpowers/accounts-before.tsx
```

`.superpowers/` is gitignored scratch. Delete the file once Step 6 is done.

- [ ] **Step 4: Add the prop and the page branch**

Add `layout` to the props type and destructuring, defaulting to `'card'`. Wrap the existing returned JSX as the card branch. Add the page branch as described above. In `DepartmentPages.tsx`, change the accounts mount to `<AccountsDepartment {...commonProps} layout="page" />`.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run
npx tsc -b --noEmit
```

Expected: all pass.

- [ ] **Step 6: Prove the card branch is unchanged**

Diff the card branch against the recorded copy and confirm the only differences are the new prop, the new branch, and the wrapping — no edit to any existing element, class or value:

```bash
git diff HEAD -- src/components/dashboard/AccountsDepartment.tsx
```

Read the diff and report, explicitly, every line removed from the existing JSX. The expected answer is none. If any existing element changed, restore it — the home dashboard is out of scope.

- [ ] **Step 7: Prove the layout tripwire can fail**

Add `layout="page"` to one of the `Index.tsx` mounts, run
`npx vitest run src/components/dashboard/accountsLayout.test.ts`, confirm it fails,
then remove it and confirm it passes. Report both outputs.

- [ ] **Step 8: Commit**

```bash
git add src/components/dashboard/AccountsDepartment.tsx src/pages/DepartmentPages.tsx src/components/dashboard/accountsLayout.test.ts
git commit -m "Give the Accounts department page its own layout"
```

---

## Verification before merge

- [ ] `npx vitest run` — all green
- [ ] `npx tsc -b --noEmit` — clean
- [ ] `git diff main -- src/components/dashboard/AccountsDepartment.tsx` removes no existing JSX line
- [ ] No `SEP 20` or `!B3`-style cell reference appears in any component under `src/components/dashboard/`
- [ ] Nothing under `src/lib/` changed: `git diff main --stat -- src/lib/` is empty

**Deploy note:** this is presentation only. No figure's value changes, and the home dashboard renders exactly as it does today.
