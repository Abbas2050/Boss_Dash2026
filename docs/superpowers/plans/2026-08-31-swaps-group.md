# Swaps Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Swaps Report tab showing per-client and per-LP swap totals, and an `excludeFromSwaps` flag on LP Manager and Internal Accounts.

**Architecture:** A data module (`src/lib/swapsReportApi.ts`) holds the types, the fetcher and the response-shape handling — all the logic worth testing. A presentational component renders two tables over one date range and is mounted as a Dealing tab. The flag is a fifth member of an existing family of exclude booleans and follows their handling exactly.

**Tech Stack:** React 18, TypeScript, Vite, vitest (`// @vitest-environment node` for non-rendering tests), Tailwind, the in-house `SortableTable`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-31-swaps-group-design.md`.
- **`GET /api/SwapsReport` does not exist yet and there is no staging server.** Every field name below comes from `temporay_for_reference_pages/swaps-report.html` and cannot be verified until the backend deploys. Do not weaken any assertion to make something pass — if reality differs, that is a deploy-day correction, not a reason to guess more loosely now.
- **Unwrapping must throw, never return `[]` for an unrecognised shape.** Follow `unwrapItems` in `src/lib/revenueShareApi.ts`: the thrown error names the endpoint and the keys actually present. A wrong shape assumption on the Revenue Share page produced an empty table with no error; that is the failure being designed out.
- **Totals come from the response, never from summing rows.** The backend sends `clientTotals` and `lpTotals`. A missing total renders as unavailable, not as a computed sum and not as `$0.00`.
- A missing `excludeFromSwaps` reads as `false` — an account is included in swap reporting unless someone says otherwise.
- Reuse `toUnixRange(fromYmd, toYmd)` from `src/lib/dealMatchApi.ts` and `BACKEND_BASE_URL` from `src/lib/backendBase.ts`. Do not write new ones.
- Requests carry `...authHeaders()` from `src/lib/auth.ts`.
- Typecheck with `npx tsc -b --noEmit`. Plain `tsc --noEmit` checks **nothing** in this repo (`tsconfig.json` has `"files": []`) and always reports success.
- Full suite is `npx vitest run`. No new runtime dependency.
- Never send a request to a production write endpoint.

### Two things the reference page has that we do not

`internal-accounts 1.html` puts the Swaps checkbox in a **bulk toolbar**. Our `InternalAccountsTab.tsx` has no bulk toolbar and exposes only Equity and Positions. Task 5 adds a third checkbox in our existing pattern; it does not build a bulk toolbar.

`lp-manager 5.html` uses `<select>Yes/No` for the flag. Our LP Manager already uses exactly that control for the other four flags, so Task 4 matches our file, which happens to agree.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/swapsReportApi.ts` (create) | Types, the fetcher, shape handling. All testable logic. |
| `src/lib/swapsReportApi.test.ts` (create) | Unit tests for the above. |
| `src/pages/departments/dealing/SwapsReportTab.tsx` (create) | Two tables, one date range, two totals lines. |
| `src/pages/departments/DealingDepartmentPage.tsx` (modify) | Import, menu-map slugs, render branch. |
| `src/lib/permissions.ts` (modify) | `"Swaps Report"` in `DEALING_TABS`. |
| `src/pages/settings/LPManagerPage.tsx` (modify) | Column, create-form field, edit-form field, both payloads. |
| `src/pages/departments/dealing/InternalAccountsTab.tsx` (modify) | Checkbox in the form and the inline row editor. |

---

## Task 1: The swaps data module

**Files:**
- Create: `src/lib/swapsReportApi.ts`
- Test: `src/lib/swapsReportApi.test.ts`

**Interfaces:**
- Consumes: `toUnixRange` from `src/lib/dealMatchApi.ts`; `BACKEND_BASE_URL` from `src/lib/backendBase.ts`; `authHeaders` from `src/lib/auth.ts`.
- Produces:
  - `type SwapAccountRow`, `type SwapTotals`, `type SwapsReport`
  - `unwrapSwapRows(payload: unknown, key: "clients" | "lps"): SwapAccountRow[]`
  - `readTotals(payload: unknown, key: "clientTotals" | "lpTotals"): SwapTotals | null`
  - `fetchSwapsReport(fromYmd: string, toYmd: string): Promise<SwapsReport>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/swapsReportApi.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/swapsReportApi.test.ts`
Expected: FAIL — `Failed to resolve import "./swapsReportApi"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/swapsReportApi.ts`:

```typescript
import { BACKEND_BASE_URL } from "@/lib/backendBase";
import { toUnixRange } from "@/lib/dealMatchApi";
import { authHeaders } from "@/lib/auth";

/**
 * One account's swap total for the period. The client and LP halves of the
 * report carry the same fields except for the name: clients have `name`, LPs
 * have `lpName`.
 *
 * These names come from temporay_for_reference_pages/swaps-report.html.
 * /api/SwapsReport is not deployed yet, so they are unverified.
 */
export type SwapAccountRow = {
  login: number;
  name?: string;
  lpName?: string;
  source: string;
  totalSwap: number;
  dealVolume: number;
  realizedVolume: number;
};

export type SwapTotals = { totalSwap: number; accountCount: number };

export type SwapsReport = {
  clients: SwapAccountRow[];
  clientTotals: SwapTotals | null;
  lps: SwapAccountRow[];
  lpTotals: SwapTotals | null;
};

function describeShape(payload: unknown): string {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return `an array of ${payload.length}`;
  if (typeof payload !== "object") return typeof payload;
  const keys = Object.keys(payload as object);
  return keys.length ? `an object with keys: ${keys.join(", ")}` : "an empty object";
}

/**
 * Rows live under `clients` or `lps`. An empty array there is a real answer --
 * a period with no swaps -- and returns []. Anything else throws, because a
 * silent [] is indistinguishable from "no swaps this period" and would hide a
 * shape change on the day the endpoint finally ships.
 */
export function unwrapSwapRows(payload: unknown, key: "clients" | "lps"): SwapAccountRow[] {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const rows = (payload as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows as SwapAccountRow[];
  }
  throw new Error(`/api/SwapsReport: expected an object with a "${key}" array, got ${describeShape(payload)}`);
}

/**
 * The backend computes the totals. Returning null when they are missing lets the
 * UI say "unavailable"; summing the rows here would create a second answer to
 * what we paid in swaps.
 */
export function readTotals(payload: unknown, key: "clientTotals" | "lpTotals"): SwapTotals | null {
  if (!payload || typeof payload !== "object") return null;
  const totals = (payload as Record<string, unknown>)[key];
  if (!totals || typeof totals !== "object") return null;
  const t = totals as Record<string, unknown>;
  if (typeof t.totalSwap !== "number" || typeof t.accountCount !== "number") return null;
  return { totalSwap: t.totalSwap, accountCount: t.accountCount };
}

export async function fetchSwapsReport(fromYmd: string, toYmd: string): Promise<SwapsReport> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const res = await fetch(`${BACKEND_BASE_URL}/api/SwapsReport?from=${from}&to=${to}`, {
    headers: { Accept: "application/json", ...authHeaders() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/api/SwapsReport returned HTTP ${res.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  const payload = await res.json();
  return {
    clients: unwrapSwapRows(payload, "clients"),
    clientTotals: readTotals(payload, "clientTotals"),
    lps: unwrapSwapRows(payload, "lps"),
    lpTotals: readTotals(payload, "lpTotals"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/swapsReportApi.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc -b --noEmit`
Expected: no output, exit 0.

```bash
git add src/lib/swapsReportApi.ts src/lib/swapsReportApi.test.ts
git commit -m "Add the swaps report data layer"
```

---

## Task 2: A test pinning the no-invented-totals rule

**Files:**
- Modify: `src/lib/swapsReportApi.test.ts`

**Interfaces:**
- Consumes: the module from Task 1.
- Produces: nothing importable.

The rule that matters most here is that the page does not sum rows to produce a
total. That is a property of the source, so the test reads the source — the same
technique as `src/lib/revenueShareApi.test.ts`.

- [ ] **Step 1: Write the test**

Append to `src/lib/swapsReportApi.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run and prove it can fail**

Run: `npx vitest run src/lib/swapsReportApi.test.ts`
Expected: PASS — 9 tests.

Temporarily append to `src/lib/swapsReportApi.ts`:

```typescript
export const BAD = (rows: SwapAccountRow[]) => rows.reduce((s, r) => s + r.totalSwap, 0);
```

Run it again. Expected: FAIL — "clientTotals and lpTotals come from the backend."
Remove the line and re-run. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/swapsReportApi.test.ts
git commit -m "Fail the suite if swap totals are ever summed in the UI"
```

---

## Task 3: The Swaps Report tab

**Files:**
- Create: `src/pages/departments/dealing/SwapsReportTab.tsx`

**Interfaces:**
- Consumes: everything Task 1 produces; `SortableTable` and `SortableTableColumn` from `@/components/ui/SortableTable`; `ymd` from `@/lib/revenueShareApi`.
- Produces: `export function SwapsReportTab({ refreshKey }: { refreshKey?: number })`.

`ymd` already exists in `src/lib/revenueShareApi.ts` and derives the date from
**local** parts, which matters: `toISOString()` would give a UAE user yesterday's
date between local midnight and 04:00. Import it; do not write another.

- [ ] **Step 1: Create the component**

Create `src/pages/departments/dealing/SwapsReportTab.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import { ymd } from "@/lib/revenueShareApi";
import {
  fetchSwapsReport,
  type SwapAccountRow,
  type SwapTotals,
  type SwapsReport,
} from "@/lib/swapsReportApi";

const money = (v: number | null | undefined) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const num = (v: number | null | undefined, digits = 2) => {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "-";
};

const signed = (v: number | null | undefined) => {
  const n = Number(v) || 0;
  return n > 0 ? "text-emerald-700 dark:text-emerald-300" : n < 0 ? "text-rose-700 dark:text-rose-300" : "";
};

/**
 * The two halves of the report differ only in which field carries the name, so
 * one factory builds both rather than two near-identical column lists drifting
 * apart.
 */
function swapColumns(nameLabel: string, nameOf: (row: SwapAccountRow) => string): SortableTableColumn<SwapAccountRow>[] {
  return [
    {
      key: "name",
      label: nameLabel,
      sortValue: (r) => nameOf(r) || "",
      searchValue: (r) => `${nameOf(r)} ${r.login}`,
      render: (r) => <span className="font-semibold">{nameOf(r) || "-"}</span>,
    },
    { key: "login", label: "Login", sortValue: (r) => r.login, render: (r) => <span className="font-mono">{r.login}</span> },
    {
      key: "source",
      label: "Source",
      sortValue: (r) => r.source || "",
      render: (r) => <span className="text-slate-500">{r.source || "-"}</span>,
    },
    {
      key: "totalSwap",
      label: "Total Swap",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => Number(r.totalSwap) || 0,
      render: (r) => <span className={`font-semibold ${signed(r.totalSwap)}`}>{money(r.totalSwap)}</span>,
    },
    {
      key: "dealVolume",
      label: "Deal Volume",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => Number(r.dealVolume) || 0,
      render: (r) => num(r.dealVolume),
    },
    {
      key: "realizedVolume",
      label: "Realized Volume",
      headerClassName: "text-right",
      cellClassName: "text-right",
      sortValue: (r) => Number(r.realizedVolume) || 0,
      render: (r) => num(r.realizedVolume),
    },
  ];
}

/** Totals arrive from the backend. Absent, we say so rather than showing a figure. */
function TotalsLine({ totals }: { totals: SwapTotals | null }) {
  if (!totals) {
    return (
      <p className="text-xs text-slate-500">
        Totals unavailable &mdash; the report did not include them for this section.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-4 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900/50">
      <span className="text-slate-500">
        Accounts <span className="font-semibold text-slate-700 dark:text-slate-200">{totals.accountCount}</span>
      </span>
      <span className="text-slate-500">
        Total Swap <span className={`font-semibold ${signed(totals.totalSwap)}`}>{money(totals.totalSwap)}</span>
      </span>
    </div>
  );
}

export function SwapsReportTab({ refreshKey }: { refreshKey?: number }) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [fromYmd, setFromYmd] = useState(ymd(monthStart));
  const [toYmd, setToYmd] = useState(ymd(today));
  const [report, setReport] = useState<SwapsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchSwapsReport(fromYmd, toYmd));
    } catch (e: any) {
      setError(e?.message || "Failed to load the swaps report.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [fromYmd, toYmd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const clientColumns = useMemo(() => swapColumns("Client", (r) => r.name || ""), []);
  const lpColumns = useMemo(() => swapColumns("LP Name", (r) => r.lpName || ""), []);

  const inputCls = "rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900";

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          From
          <input type="date" value={fromYmd} onChange={(e) => setFromYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input type="date" value={toYmd} onChange={(e) => setToYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
        </label>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {loading ? "Loading…" : "Run"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {!error && (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">By Client</h3>
            <TotalsLine totals={report?.clientTotals ?? null} />
            <SortableTable
              tableId="swaps-report-clients"
              rows={report?.clients || []}
              columns={clientColumns}
              tableClassName="min-w-full text-[11px]"
              emptyText="No client swap activity in this date range."
            />
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">By LP</h3>
            <TotalsLine totals={report?.lpTotals ?? null} />
            <SortableTable
              tableId="swaps-report-lps"
              rows={report?.lps || []}
              columns={lpColumns}
              tableClassName="min-w-full text-[11px]"
              emptyText="No LP swap activity in this date range."
            />
          </div>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: no output, exit 0.

If `ymd` is not exported from `src/lib/revenueShareApi.ts`, stop and report it
rather than writing a local copy — the local-parts behaviour is deliberate and
must not be duplicated.

- [ ] **Step 3: Confirm the no-summing test now covers the component**

Run: `npx vitest run src/lib/swapsReportApi.test.ts`
Expected: PASS — 10 tests (the glob now matches the new `.tsx` too).

- [ ] **Step 4: Full suite and commit**

Run: `npx vitest run`
Expected: all pass.

```bash
git add src/pages/departments/dealing/SwapsReportTab.tsx
git commit -m "Add the Swaps Report tab"
```

---

## Task 4: Mount it as a Dealing tab

**Files:**
- Modify: `src/lib/permissions.ts`
- Modify: `src/pages/departments/DealingDepartmentPage.tsx`

**Interfaces:**
- Consumes: `SwapsReportTab` from Task 3.
- Produces: the route `/departments/dealing?tab=swaps-report`.

Three edits in two files. Missing the `DEALING_TABS` one produces a tab that
mounts and then redirects away — that failure has already happened once on this
project, because the nav list and the permission list both derive from that
array.

- [ ] **Step 1: Register the tab**

In `src/lib/permissions.ts`, in the `DEALING_TABS` array, add `"Swaps Report"`
immediately after `"Swap Tracker"`:

```typescript
  "Swap Tracker",
  "Swaps Report",
```

- [ ] **Step 2: Add the import**

In `src/pages/departments/DealingDepartmentPage.tsx`, below the existing line
`import { RevenueShareTab } from "@/pages/departments/dealing/RevenueShareTab";`, add:

```tsx
import { SwapsReportTab } from "@/pages/departments/dealing/SwapsReportTab";
```

- [ ] **Step 3: Add the menu slugs**

In `DEALING_MENU_QUERY_MAP`, beside the other pairs, add:

```tsx
  "swaps-report": "Swaps Report",
  swaps: "Swaps Report",
```

- [ ] **Step 4: Add the render branch**

Find the line `) : activeMenu === "Revenue Share" ? (` and insert immediately before it:

```tsx
            ) : activeMenu === "Swaps Report" ? (
              <SwapsReportTab />
```

- [ ] **Step 5: Verify the registration invariant**

Run: `npx vitest run src/lib/dealingTabs.test.ts`
Expected: PASS. This test asserts every label in `DEALING_MENU_QUERY_MAP` exists
in `DEALING_TABS`; it fails if only one of Steps 1 and 3 was done.

Then run:
```bash
node -e "const s=require('fs').readFileSync('src/pages/departments/DealingDepartmentPage.tsx','utf8');console.log(s.includes('activeMenu === \"Swaps Report\"')?'OK: render branch present':'FAIL: render branch missing')"
```
Expected: `OK: render branch present`

- [ ] **Step 6: Typecheck, test and commit**

Run: `npx tsc -b --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

```bash
git add src/lib/permissions.ts src/pages/departments/DealingDepartmentPage.tsx
git commit -m "Add Swaps Report to the Dealing tabs"
```

---

## Task 5: The exclude-from-swaps flag

**Files:**
- Modify: `src/pages/settings/LPManagerPage.tsx`
- Modify: `src/pages/departments/dealing/InternalAccountsTab.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing importable.

`excludeFromSwaps` is a fifth member of an existing family —
`excludeFromEquity`, `excludeFromPositions`, `excludeFromHistory`,
`excludeFromDealMatching`. Follow how `excludeFromDealMatching` is handled in
each file exactly; do not invent a different control or placement.

The field does not exist upstream yet, so a missing value must read as `false`.
Use `!!row.excludeFromSwaps` when reading, exactly as the siblings do.

**On the spec's fourth testing requirement.** It asks for a test that a missing
flag reads as `false` and a present `true` round trips. That behaviour lives
inline in two components, and none of the four sibling flags has such a test —
covering only this one would mean extracting it alone, leaving the family
inconsistent for no benefit. The `!!` coercion is the same one-token idiom used
four times beside it. If you disagree while implementing, say so rather than
adding a lone test: the right fix would be extracting all five together, which is
a separate change.

- [ ] **Step 1: LP Manager — the type**

In `src/pages/settings/LPManagerPage.tsx`, in the account type that already lists
`excludeFromDealMatching?: boolean;`, add beneath it:

```typescript
  excludeFromSwaps?: boolean;
```

- [ ] **Step 2: LP Manager — the two form states**

Find `const [excludeFromDealMatching, setExcludeFromDealMatching] = useState(false);`
and add beneath it:

```typescript
  const [excludeFromSwaps, setExcludeFromSwaps] = useState(false);
```

Find the matching edit-form state (the one named `editExcludeFromDealMatching`)
and add its sibling `editExcludeFromSwaps` the same way.

- [ ] **Step 3: LP Manager — populate, and both payloads**

Find `setEditExcludeFromDealMatching(!!a.excludeFromDealMatching);` and add beneath:

```typescript
    setEditExcludeFromSwaps(!!a.excludeFromSwaps);
```

Find the edit payload line `excludeFromDealMatching: editExcludeFromDealMatching,` and add beneath:

```typescript
      excludeFromSwaps: editExcludeFromSwaps,
```

Find the create payload line `excludeFromDealMatching,` and add beneath:

```typescript
      excludeFromSwaps,
```

- [ ] **Step 4: LP Manager — the column**

Find the column object whose `key` is `"dealMatching"` and add this immediately
after it, matching its shape exactly:

```tsx
      {
        key: "swaps",
        label: "Swaps",
        sortValue: (row) => (row.excludeFromSwaps ? 0 : 1),
        searchValue: (row) => (row.excludeFromSwaps ? "Excluded" : "Included"),
        render: (row) =>
          row.excludeFromSwaps ? (
            <span className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-700 dark:text-rose-300">Excluded</span>
          ) : (
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">Included</span>
          ),
      },
```

- [ ] **Step 5: LP Manager — the two form controls**

Find the create-form block labelled `Exclude From Deal Matching` and add this
immediately after that closing `</div>`:

```tsx
                  <div className="flex items-center gap-2 rounded border border-border bg-background/70 p-2 text-sm md:col-span-2">
                    <label className="text-muted-foreground">Exclude From Swaps</label>
                    <select
                      value={String(excludeFromSwaps)}
                      onChange={(e) => setExcludeFromSwaps(e.target.value === "true")}
                      className="ml-auto rounded border border-border bg-card px-2 py-1 text-xs"
                    >
                      <option value="false">No</option>
                      <option value="true">Yes</option>
                    </select>
                  </div>
```

Do the same in the edit form, using `editExcludeFromSwaps` and
`setEditExcludeFromSwaps`.

- [ ] **Step 6: Internal Accounts — type, default, payload, read**

In `src/pages/departments/dealing/InternalAccountsTab.tsx`, everywhere
`excludeFromPositions` appears, add an `excludeFromSwaps` sibling: in both type
declarations, in the defaults object (default `true`, matching its siblings there
— an internal account is excluded by default), in the save payload, and in the
row read where `excludeFromPositions: !!row.excludeFromPositions` appears.

- [ ] **Step 7: Internal Accounts — the two checkboxes**

After the `Positions` checkbox in the form, add:

```tsx
          <label className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900/70"><input type="checkbox" checked={form.excludeFromSwaps} onChange={(e) => setField("excludeFromSwaps", e.target.checked)} />Swaps</label>
```

And after the `excludeFromPositions` inline row-editor cell, add the same shape
for swaps:

```tsx
                  {editingId === row.id ? <input type="checkbox" checked={row.excludeFromSwaps} onChange={(e) => updateRow(row.id, { excludeFromSwaps: e.target.checked })} /> : row.excludeFromSwaps ? "Excluded" : "Included"}
```

Add its header cell beside the Positions header so the column count matches — a
body cell with no header silently shifts every column after it.

- [ ] **Step 8: Typecheck, test and commit**

Run: `npx tsc -b --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

```bash
git add src/pages/settings/LPManagerPage.tsx src/pages/departments/dealing/InternalAccountsTab.tsx
git commit -m "Add the exclude-from-swaps flag to LP Manager and Internal Accounts"
```

---

## Task 6: Hand off for deploy-day verification

**Files:** none.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Full local verification**

Run: `npx tsc -b --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 2: Confirm the endpoint is still absent**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://api.skylinkscapital.com/api/SwapsReport?from=1&to=2"
```
Expected: `404` — still not deployed. If it returns 200, fetch it and compare the
real shape against `SwapsReport` in `src/lib/swapsReportApi.ts` before handing
over.

- [ ] **Step 3: Tell the user what to check once the backend ships**

Do not deploy. Report that the work is ready and give this checklist:

1. `/departments/dealing?tab=swaps-report` loads. Before the backend ships it
   will show an error naming `/api/SwapsReport` — that is correct behaviour, not
   a bug.
2. Once deployed, both tables populate and each totals line shows an account
   count and a total. If a totals line says "Totals unavailable", the response
   omitted `clientTotals`/`lpTotals` and the backend needs telling.
3. If the page shows an error mentioning "expected an object with a clients
   array", the deployed response shape differs from the reference page. Send the
   error text — it names the keys that actually arrived.
4. LP Manager and Internal Accounts show a **Swaps** column reading `Included`
   for every row until the backend adds `excludeFromSwaps`.
5. Setting Exclude From Swaps and saving only sticks once the backend accepts the
   field.

- [ ] **Step 4: Only tick this once the user confirms after deploy**

Local tests do not prove the contract. This is done when the user reports the
tables populating with real figures.

---

## Out of scope

Client Account Monitor, the API admin pages, and Finalto — separate specs in this
batch. The bulk toolbar from `internal-accounts 1.html`, which our tab does not
have. Any change to how swaps are calculated.
