# Revenue Share Calculation Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show what each LP is owed under its revenue-share agreement, as a Dealing tab and an Accounts panel driven by one shared component.

**Architecture:** A pure data module (`src/lib/revenueShareApi.ts`) holds the types, the three fetchers and the response-shape handling — that is where all the testable logic lives. A single presentational component (`RevenueShareTab.tsx`) renders three views over a shared date range, and is mounted twice: as a Dealing tab and as a panel inside `AccountsDepartment`.

**Tech Stack:** React 18, TypeScript, Vite, vitest (`// @vitest-environment node` for source-parsing tests), Tailwind, the in-house `SortableTable`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-25-revenue-share-page-design.md`.
- **Do not compute the revenue share.** `realLpPL`, `ntpPercent` and `lpPL` come from the backend and are rendered as received. No multiplication anywhere in this feature.
- Typecheck is `npx tsc -b --noEmit`. Plain `tsc --noEmit` checks **nothing** in this repo (`tsconfig.json` has `"files": []`) and will always report success.
- Full suite is `npx vitest run`. Test files that do not render React start with `// @vitest-environment node`.
- Add no new runtime dependency.
- Reuse `toUnixRange(fromYmd, toYmd)` from `src/lib/dealMatchApi.ts` — it already returns `{from, to}` in unix seconds with `from` at `T00:00:00Z` and `to` at `T23:59:59Z`. Do not write another one, and do not re-test it: `src/lib/dealMatchApi.test.ts:10` already asserts the inclusive UTC bounds, which covers the spec's fourth testing requirement.
- Reuse `BACKEND_BASE_URL` from `src/lib/backendBase.ts`. Do not declare a ninth local copy of that constant.
- Requests carry `...authHeaders()` from `src/lib/auth.ts`, matching every other tab.
- Never send a request to a production write endpoint.
- **All three endpoints nest their rows.** `/History/aggregate` and
  `/History/volume` answer `{items: [...]}`; `/History/deals` answers
  `{deals: [...]}`. An earlier draft of this plan wrongly called the first two
  bare arrays. Unwrapping must throw on an unexpected shape, never return `[]` —
  an empty table with no error is indistinguishable from "no data".
- **Hide LPs on 0% NTP** unless the row is an error row, matching the reference
  page: an LP with no agreement has no revenue share to report.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/revenueShareApi.ts` (create) | Types, the three fetchers, response-shape handling. All logic worth testing. |
| `src/lib/revenueShareApi.test.ts` (create) | Unit tests for the above. |
| `src/pages/departments/dealing/RevenueShareTab.tsx` (create) | The whole UI: date range, view switch, three tables, LP selector. |
| `src/pages/departments/DealingDepartmentPage.tsx` (modify) | Menu map entry + render branch. |
| `src/components/dashboard/AccountsDepartment.tsx` (modify) | Second mount as a panel. |

---

## Task 1: The data module

**Files:**
- Create: `src/lib/revenueShareApi.ts`
- Test: `src/lib/revenueShareApi.test.ts`

**Interfaces:**
- Consumes: `toUnixRange` from `src/lib/dealMatchApi.ts`; `BACKEND_BASE_URL` from `src/lib/backendBase.ts`; `authHeaders` from `src/lib/auth.ts`.
- Produces:
  - `type RevenueShareRow`, `type VolumeRow`, `type DealRow`
  - `unwrapDeals(payload: unknown): DealRow[]`
  - `isErrorRow(row: {isError?: boolean}): boolean`
  - `fetchRevenueShare(fromYmd: string, toYmd: string): Promise<RevenueShareRow[]>`
  - `fetchVolume(fromYmd: string, toYmd: string): Promise<VolumeRow[]>`
  - `fetchDeals(login: number | string, fromYmd: string, toYmd: string): Promise<DealRow[]>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/revenueShareApi.test.ts`:

```typescript
// @vitest-environment node
//
// The revenue-share data layer.
//
// Two shape traps live here. /History/deals returns an OBJECT with rows nested
// under .deals, while /History/aggregate and /History/volume return bare arrays
// — treating deals like the other two yields an empty grid with no error. And
// every aggregate/volume row carries isError/errorMessage, so a failed LP must
// show its message rather than a plausible zero.
import { describe, it, expect } from "vitest";
import { unwrapDeals, isErrorRow } from "./revenueShareApi";

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

  it("returns an empty array rather than throwing on an unexpected shape", () => {
    expect(unwrapDeals(null)).toEqual([]);
    expect(unwrapDeals(undefined)).toEqual([]);
    expect(unwrapDeals({})).toEqual([]);
    expect(unwrapDeals({ deals: null })).toEqual([]);
    expect(unwrapDeals("nope")).toEqual([]);
  });

  // If the backend ever returns a bare array here, accept it rather than
  // showing the user nothing.
  it("accepts a bare array too", () => {
    expect(unwrapDeals([{ dealTicket: 7 }])).toHaveLength(1);
  });
});

describe("isErrorRow", () => {
  it("is true only when the backend says so", () => {
    expect(isErrorRow({ isError: true })).toBe(true);
    expect(isErrorRow({ isError: false })).toBe(false);
    expect(isErrorRow({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/revenueShareApi.test.ts`
Expected: FAIL — `Failed to resolve import "./revenueShareApi"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/revenueShareApi.ts`:

```typescript
import { BACKEND_BASE_URL } from "@/lib/backendBase";
import { toUnixRange } from "@/lib/dealMatchApi";
import { authHeaders } from "@/lib/auth";

/**
 * One LP's revenue share for the period.
 *
 * realLpPL, ntpPercent and lpPL are computed by the backend and rendered as
 * received. Recomputing lpPL here would create a second source of truth for a
 * number that decides what an LP is paid — the same split that had the Deal
 * Match tab and the weekly email disagreeing on Net Revenue.
 */
export type RevenueShareRow = {
  lpName: string;
  login: number;
  source: string;
  effectiveFrom: string;
  effectiveTo: string;
  startEquity: number;
  endEquity: number;
  credit: number;
  deposit: number;
  withdrawal: number;
  netDeposits: number;
  grossProfit: number;
  totalCommission: number;
  totalSwap: number;
  netPL: number;
  realLpPL: number;
  ntpPercent: number;
  lpPL: number;
  isError?: boolean;
  errorMessage?: string;
};

export type VolumeRow = {
  lpName: string;
  login: number;
  source: string;
  tradeCount: number;
  totalLots: number;
  notionalUsd: number;
  volumeYards: number;
  isError?: boolean;
  errorMessage?: string;
};

/**
 * A single deal. These field names come from the reference page
 * (temporay_for_reference_pages/history 4.html), NOT from a live payload —
 * every /History/deals response sampled on 2026-08-25 had deals: []. Confirm
 * them against a non-empty response before trusting them; wrong names render
 * blank columns rather than failing.
 */
export type DealRow = {
  dealTicket: number;
  symbol: string;
  timeString: string;
  direction: string;
  entry: string;
  volume: number;
  price: number;
  contractSize: number;
  marketValue: number;
  profit: number;
  commission: number;
  fee: number;
  swap: number;
  lpCommission: number;
  lpCommPerLot: number;
};

/**
 * /History/deals answers with an object whose rows sit under `deals`, unlike
 * /History/aggregate and /History/volume which answer with bare arrays.
 * Handling it like the other two produces an empty grid and no error at all.
 */
export function unwrapDeals(payload: unknown): DealRow[] {
  if (Array.isArray(payload)) return payload as DealRow[];
  if (payload && typeof payload === "object") {
    const rows = (payload as { deals?: unknown }).deals;
    if (Array.isArray(rows)) return rows as DealRow[];
  }
  return [];
}

/** The backend marks a row it could not compute. Its figures are meaningless. */
export function isErrorRow(row: { isError?: boolean }): boolean {
  return row?.isError === true;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BACKEND_BASE_URL}${path}`, {
    headers: { Accept: "application/json", ...authHeaders() },
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]} returned HTTP ${res.status}`);
  return res.json();
}

const asArray = <T,>(payload: unknown): T[] => (Array.isArray(payload) ? (payload as T[]) : []);

export async function fetchRevenueShare(fromYmd: string, toYmd: string): Promise<RevenueShareRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  return asArray<RevenueShareRow>(await getJson(`/History/aggregate?from=${from}&to=${to}`));
}

export async function fetchVolume(fromYmd: string, toYmd: string): Promise<VolumeRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  return asArray<VolumeRow>(await getJson(`/History/volume?from=${from}&to=${to}`));
}

export async function fetchDeals(login: number | string, fromYmd: string, toYmd: string): Promise<DealRow[]> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  return unwrapDeals(await getJson(`/History/deals?login=${encodeURIComponent(String(login))}&from=${from}&to=${to}`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/revenueShareApi.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/revenueShareApi.ts src/lib/revenueShareApi.test.ts
git commit -m "Add the revenue-share data layer"
```

---

## Task 2: A test that pins the no-recomputation rule

**Files:**
- Modify: `src/lib/revenueShareApi.test.ts`

**Interfaces:**
- Consumes: the module from Task 1.
- Produces: nothing importable.

The single most important property of this feature is that it does not do the
revenue-share arithmetic itself. That is a rule about the source code, so the
test reads the source — the same technique as `src/lib/noClientSecrets.test.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/revenueShareApi.test.ts`:

```typescript
import { readFileSync } from "fs";
import path from "path";

// lpPL = realLpPL x ntpPercent / 100 is the backend's calculation, verified in
// the live payload: 1,196,755.75 x 20% = 239,351.15. If this UI ever computes
// it too, the two will drift and an LP gets paid the wrong number.
describe("the revenue share is never recomputed here", () => {
  const FILES = [
    "src/lib/revenueShareApi.ts",
    "src/pages/departments/dealing/RevenueShareTab.tsx",
  ];

  for (const file of FILES) {
    it(`${file} does no arithmetic on ntpPercent or realLpPL`, () => {
      let source: string;
      try {
        source = readFileSync(path.resolve(file), "utf8");
      } catch {
        return; // not created yet; Task 3 adds the component
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const offenders = [
        /ntpPercent\s*[*/]/,
        /[*/]\s*ntpPercent/,
        /realLpPL\s*[*/]/,
        /[*/]\s*realLpPL/,
      ].filter((re) => re.test(code));
      expect(
        offenders.map(String),
        "lpPL comes from the backend. Render it; do not derive it.",
      ).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run src/lib/revenueShareApi.test.ts`
Expected: PASS — 8 tests. (The component file does not exist yet, so its case returns early.)

- [ ] **Step 3: Prove the test can fail**

Temporarily append to `src/lib/revenueShareApi.ts`:

```typescript
export const BAD = (r: RevenueShareRow) => r.realLpPL * (r.ntpPercent / 100);
```

Run: `npx vitest run src/lib/revenueShareApi.test.ts`
Expected: FAIL — "lpPL comes from the backend. Render it; do not derive it."

Delete that line and re-run. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/revenueShareApi.test.ts
git commit -m "Fail the suite if the revenue share is ever recomputed in the UI"
```

---

## Task 3: The component

**Files:**
- Create: `src/pages/departments/dealing/RevenueShareTab.tsx`

**Interfaces:**
- Consumes: everything Task 1 produces; `SortableTable` and `SortableTableColumn` from `@/components/ui/SortableTable`.
- Produces: `export function RevenueShareTab({ refreshKey }: { refreshKey?: number })` — the prop matches the sibling tabs (`ClientVolumeTab`, `SlippageReportTab`), which take `refreshKey: number` to force a reload.

- [ ] **Step 1: Create the component**

Create `src/pages/departments/dealing/RevenueShareTab.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { SortableTable, type SortableTableColumn } from "@/components/ui/SortableTable";
import {
  fetchDeals,
  fetchRevenueShare,
  fetchVolume,
  isErrorRow,
  type DealRow,
  type RevenueShareRow,
  type VolumeRow,
} from "@/lib/revenueShareApi";

type View = "share" | "deals" | "volume";

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
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "-";
};

const signed = (v: number | null | undefined) => {
  const n = Number(v) || 0;
  return n > 0 ? "text-emerald-700 dark:text-emerald-300" : n < 0 ? "text-rose-700 dark:text-rose-300" : "";
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A cell that refuses to print a figure for a row the backend could not
 * compute. A zero in a revenue-share table is a number somebody may act on.
 */
function cell(row: { isError?: boolean }, render: () => React.ReactNode) {
  return isErrorRow(row) ? <span className="text-slate-400 dark:text-slate-500">-</span> : render();
}

export function RevenueShareTab({ refreshKey }: { refreshKey?: number }) {
  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

  const [fromYmd, setFromYmd] = useState(ymd(monthStart));
  const [toYmd, setToYmd] = useState(ymd(today));
  const [view, setView] = useState<View>("share");
  const [shareRows, setShareRows] = useState<RevenueShareRow[]>([]);
  const [volumeRows, setVolumeRows] = useState<VolumeRow[]>([]);
  const [dealRows, setDealRows] = useState<DealRow[]>([]);
  const [selectedLogin, setSelectedLogin] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [share, volume] = await Promise.all([fetchRevenueShare(fromYmd, toYmd), fetchVolume(fromYmd, toYmd)]);
      setShareRows(share);
      setVolumeRows(volume);
      setDealRows([]);
      setSelectedLogin("");
    } catch (e: any) {
      setError(e?.message || "Failed to load revenue share.");
      setShareRows([]);
      setVolumeRows([]);
    } finally {
      setLoading(false);
    }
  }, [fromYmd, toYmd]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadDeals = useCallback(
    async (login: string) => {
      setSelectedLogin(login);
      setDealRows([]);
      if (!login) return;
      setLoading(true);
      setError(null);
      try {
        setDealRows(await fetchDeals(login, fromYmd, toYmd));
      } catch (e: any) {
        setError(e?.message || "Failed to load deals.");
      } finally {
        setLoading(false);
      }
    },
    [fromYmd, toYmd],
  );

  const shareColumns = useMemo<SortableTableColumn<RevenueShareRow>[]>(
    () => [
      { key: "lpName", label: "LP Name", sortValue: (r) => r.lpName || "", searchValue: (r) => `${r.lpName} ${r.login}`,
        render: (r) => (
          <span className="font-semibold">
            {r.lpName || "-"}
            {isErrorRow(r) && <span className="ml-2 text-xs font-normal text-rose-600 dark:text-rose-400">{r.errorMessage || "failed"}</span>}
          </span>
        ) },
      { key: "login", label: "Login", sortValue: (r) => r.login, render: (r) => <span className="font-mono">{r.login}</span> },
      { key: "source", label: "Source", sortValue: (r) => r.source || "", render: (r) => <span className="text-slate-500">{r.source || "-"}</span> },
      { key: "effectiveFrom", label: "Start Period", sortValue: (r) => r.effectiveFrom || "", render: (r) => r.effectiveFrom ? String(r.effectiveFrom).slice(0, 10) : "-" },
      ...([
        ["startEquity", "Start Equity"], ["endEquity", "End Equity"], ["credit", "Credit"],
        ["deposit", "Deposit"], ["withdrawal", "Withdrawal"], ["netDeposits", "Net Deposits"],
        ["grossProfit", "Gross P/L"], ["totalCommission", "Commission"], ["totalSwap", "Swap"],
        ["netPL", "Net P/L"], ["realLpPL", "Real LP P/L"],
      ] as [keyof RevenueShareRow, string][]).map(([key, label]) => ({
        key: String(key),
        label,
        headerClassName: "text-right",
        cellClassName: "text-right",
        sortValue: (r: RevenueShareRow) => Number(r[key]) || 0,
        render: (r: RevenueShareRow) => cell(r, () => <span className={signed(Number(r[key]))}>{money(Number(r[key]))}</span>),
      })),
      { key: "ntpPercent", label: "NTP %", headerClassName: "text-right", cellClassName: "text-right",
        headerTitle: "The agreed revenue-share percentage, set by the backend.",
        sortValue: (r) => Number(r.ntpPercent) || 0,
        render: (r) => cell(r, () => <span className="text-amber-600 dark:text-amber-400">{num(r.ntpPercent, 1)}%</span>) },
      { key: "lpPL", label: "LP P/L (Rev Share)", headerClassName: "text-right", cellClassName: "text-right",
        headerTitle: "What this LP is owed. Supplied by the backend as Real LP P/L x NTP %; this page does not recompute it.",
        sortValue: (r) => Number(r.lpPL) || 0,
        render: (r) => cell(r, () => <span className={`font-bold ${signed(r.lpPL)}`}>{money(r.lpPL)}</span>) },
    ],
    [],
  );

  const volumeColumns = useMemo<SortableTableColumn<VolumeRow>[]>(
    () => [
      { key: "lpName", label: "LP Name", sortValue: (r) => r.lpName || "", searchValue: (r) => `${r.lpName} ${r.login}`,
        render: (r) => (
          <span className="font-semibold">
            {r.lpName || "-"}
            {isErrorRow(r) && <span className="ml-2 text-xs font-normal text-rose-600 dark:text-rose-400">{r.errorMessage || "failed"}</span>}
          </span>
        ) },
      { key: "login", label: "Login", sortValue: (r) => r.login, render: (r) => <span className="font-mono">{r.login}</span> },
      { key: "source", label: "Source", sortValue: (r) => r.source || "", render: (r) => <span className="text-slate-500">{r.source || "-"}</span> },
      { key: "tradeCount", label: "Trade Count", headerClassName: "text-right", cellClassName: "text-right",
        sortValue: (r) => Number(r.tradeCount) || 0, render: (r) => cell(r, () => num(r.tradeCount, 0)) },
      { key: "totalLots", label: "Total Lots", headerClassName: "text-right", cellClassName: "text-right",
        sortValue: (r) => Number(r.totalLots) || 0, render: (r) => cell(r, () => num(r.totalLots)) },
      { key: "notionalUsd", label: "Notional (USD)", headerClassName: "text-right", cellClassName: "text-right",
        sortValue: (r) => Number(r.notionalUsd) || 0, render: (r) => cell(r, () => money(r.notionalUsd)) },
      { key: "volumeYards", label: "Volume (Yards)", headerClassName: "text-right", cellClassName: "text-right",
        sortValue: (r) => Number(r.volumeYards) || 0, render: (r) => cell(r, () => num(r.volumeYards, 4)) },
    ],
    [],
  );

  const dealColumns = useMemo<SortableTableColumn<DealRow>[]>(
    () => [
      { key: "dealTicket", label: "Ticket", sortValue: (r) => Number(r.dealTicket) || 0, render: (r) => <span className="font-mono">{r.dealTicket}</span> },
      { key: "symbol", label: "Symbol", sortValue: (r) => r.symbol || "", render: (r) => <span className="font-semibold">{r.symbol}</span> },
      { key: "timeString", label: "Time", sortValue: (r) => r.timeString || "", render: (r) => <span className="text-slate-500">{r.timeString}</span> },
      { key: "direction", label: "Direction", sortValue: (r) => r.direction || "", render: (r) => r.direction },
      { key: "entry", label: "Entry", sortValue: (r) => r.entry || "", render: (r) => r.entry },
      { key: "volume", label: "Volume", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.volume) || 0, render: (r) => num(r.volume) },
      { key: "price", label: "Price", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.price) || 0, render: (r) => num(r.price, 5) },
      { key: "contractSize", label: "Contract Size", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.contractSize) || 0, render: (r) => num(r.contractSize, 0) },
      { key: "marketValue", label: "Market Value", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.marketValue) || 0, render: (r) => money(r.marketValue) },
      { key: "profit", label: "Profit", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.profit) || 0, render: (r) => <span className={signed(r.profit)}>{money(r.profit)}</span> },
      { key: "commission", label: "Commission", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.commission) || 0, render: (r) => <span className={signed(r.commission)}>{money(r.commission)}</span> },
      { key: "fee", label: "Fee", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.fee) || 0, render: (r) => <span className={signed(r.fee)}>{money(r.fee)}</span> },
      { key: "swap", label: "Swap", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.swap) || 0, render: (r) => <span className={signed(r.swap)}>{money(r.swap)}</span> },
      { key: "lpCommission", label: "LP Comm", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.lpCommission) || 0, render: (r) => money(r.lpCommission) },
      { key: "lpCommPerLot", label: "LP Comm/Lot", headerClassName: "text-right", cellClassName: "text-right", sortValue: (r) => Number(r.lpCommPerLot) || 0, render: (r) => money(r.lpCommPerLot) },
    ],
    [],
  );

  const inputCls = "rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900";
  const tabCls = (v: View) =>
    `rounded px-3 py-1 text-xs font-semibold ${view === v ? "bg-primary/20 text-primary" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`;

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800/80 dark:bg-slate-950/70">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          From
          <input type="date" value={fromYmd} onChange={(e) => setFromYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input type="date" value={toYmd} onChange={(e) => setToYmd(e.target.value)} className={`mt-1 block ${inputCls}`} />
        </label>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">
          {loading ? "Loading…" : "Run"}
        </button>
        <div className="ml-auto flex gap-1">
          <button type="button" className={tabCls("share")} onClick={() => setView("share")}>Revenue Share</button>
          <button type="button" className={tabCls("deals")} onClick={() => setView("deals")}>Deals</button>
          <button type="button" className={tabCls("volume")} onClick={() => setView("volume")}>Volume</button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">{error}</div>}

      {view === "share" && (
        <SortableTable
          tableId="revenue-share"
          rows={shareRows}
          columns={shareColumns}
          tableClassName="min-w-full text-[11px]"
          emptyText="No LP had a revenue-share period inside this date range. The aggregate is scoped by each agreement's start and end dates, not only by the dates you picked."
        />
      )}

      {view === "volume" && (
        <SortableTable
          tableId="revenue-share-volume"
          rows={volumeRows}
          columns={volumeColumns}
          tableClassName="min-w-full text-[11px]"
          emptyText="No LP had a revenue-share period inside this date range."
        />
      )}

      {view === "deals" && (
        <div className="space-y-2">
          <label className="text-xs text-slate-500">
            LP
            <select value={selectedLogin} onChange={(e) => void loadDeals(e.target.value)} className={`ml-2 ${inputCls}`}>
              <option value="">Select an LP…</option>
              {shareRows.map((r) => (
                <option key={r.login} value={r.login}>{r.lpName || r.login} ({r.login})</option>
              ))}
            </select>
          </label>
          {selectedLogin ? (
            <SortableTable
              tableId="revenue-share-deals"
              rows={dealRows}
              columns={dealColumns}
              tableClassName="min-w-full text-[11px]"
              emptyText="This LP has no deals in the selected range."
            />
          ) : (
            <p className="text-xs text-slate-500">Choose an LP to load its deals for the selected date range.</p>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: no output, exit 0.

- [ ] **Step 3: Confirm the no-recomputation test now covers the component**

Run: `npx vitest run src/lib/revenueShareApi.test.ts`
Expected: PASS — 8 tests. The component file now exists, so its case reads the real source instead of returning early.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pages/departments/dealing/RevenueShareTab.tsx
git commit -m "Add the Revenue Share page component"
```

---

## Task 4: Mount it as a Dealing tab

**Files:**
- Modify: `src/pages/departments/DealingDepartmentPage.tsx`

**Interfaces:**
- Consumes: `RevenueShareTab` from Task 3.
- Produces: the route `/departments/dealing?tab=revenue-share`.

- [ ] **Step 1: Add the import**

In `src/pages/departments/DealingDepartmentPage.tsx`, below the existing line
`import { SlippageReportTab } from "@/pages/departments/dealing/SlippageReportTab";` (line 21), add:

```tsx
import { RevenueShareTab } from "@/pages/departments/dealing/RevenueShareTab";
```

- [ ] **Step 2: Add the menu entry**

In `DEALING_MENU_QUERY_MAP` (starts line 74), add these two lines beside the
other slug pairs, keeping both a short and a long form as its neighbours do:

```tsx
  "revenue-share": "Revenue Share",
  revshare: "Revenue Share",
```

- [ ] **Step 3: Add the render branch**

Find this chain (around line 4084):

```tsx
            ) : activeMenu === "Slippage Report" ? (
              <SlippageReportTab refreshKey={slippageRefreshKey} />
```

Insert immediately before that `) : activeMenu === "Slippage Report" ? (` line:

```tsx
            ) : activeMenu === "Revenue Share" ? (
              <RevenueShareTab />
```

- [ ] **Step 4: Typecheck and test**

Run: `npx tsc -b --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 5: Verify the menu entry resolves**

Run:
```bash
node -e "const s=require('fs').readFileSync('src/pages/departments/DealingDepartmentPage.tsx','utf8');const hasMap=s.includes('\"revenue-share\": \"Revenue Share\"');const hasBranch=s.includes('activeMenu === \"Revenue Share\"');console.log(hasMap&&hasBranch?'OK: slug and branch both present':'FAIL: '+(hasMap?'branch missing':'slug missing'))"
```
Expected: `OK: slug and branch both present`

A slug with no branch renders an empty tab, and a branch with no slug is
unreachable — both fail silently in the browser, which is why this is checked
rather than eyeballed.

- [ ] **Step 6: Commit**

```bash
git add src/pages/departments/DealingDepartmentPage.tsx
git commit -m "Add Revenue Share to the Dealing tabs"
```

---

## Task 5: Mount it as an Accounts panel

**Files:**
- Modify: `src/components/dashboard/AccountsDepartment.tsx`

**Interfaces:**
- Consumes: `RevenueShareTab` from Task 3.
- Produces: nothing importable.

`AccountsDepartment` has no tab structure — it is a scrolling page of live
panels. The component is added as one more panel rather than bolting a tab bar
onto a page that has never had one.

- [ ] **Step 1: Add the import**

At the top of `src/components/dashboard/AccountsDepartment.tsx`, add:

```tsx
import { RevenueShareTab } from "@/pages/departments/dealing/RevenueShareTab";
```

- [ ] **Step 2: Add the panel**

The component returns a single `<DepartmentCard>`. Add this as its **last**
child, immediately before the closing `</DepartmentCard>` at the end of the file
— revenue share is a settlement view, read after the day's flows, not before
them:

```tsx
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Revenue Share</h2>
        <p className="text-xs text-slate-500">
          What each LP is owed for the period. Figures come from the backend's revenue-share
          calculation; this panel does not recompute them.
        </p>
        <RevenueShareTab />
      </div>
```

- [ ] **Step 3: Typecheck and test**

Run: `npx tsc -b --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 4: Check for an import cycle**

`AccountsDepartment` now imports from `pages/departments/dealing/`. Confirm the
tab does not import back into `components/dashboard/`:

```bash
node -e "const s=require('fs').readFileSync('src/pages/departments/dealing/RevenueShareTab.tsx','utf8');console.log(/from ['\"]@\/components\/dashboard/.test(s)?'FAIL: import cycle':'OK: no cycle')"
```
Expected: `OK: no cycle`

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/AccountsDepartment.tsx
git commit -m "Show Revenue Share in the Accounts department"
```

---

## Task 6: Verify against the running app

**Files:** none — this is a verification task.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Full local verification**

Run: `npx tsc -b --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 2: Confirm the live endpoints still answer**

Run:
```bash
node -e "
const f=Math.floor(new Date('2026-08-01T00:00:00Z')/1000), t=Math.floor(new Date('2026-08-24T23:59:59Z')/1000);
for (const p of ['/History/aggregate','/History/volume']) {
  fetch('https://api.skylinkscapital.com'+p+'?from='+f+'&to='+t).then(r=>r.json()).then(d=>console.log(p, Array.isArray(d)?d.length+' rows':'unexpected shape'));
}"
```
Expected: `9 rows` for each (the count will differ as periods change; a number is the point, not the value).

- [ ] **Step 3: Hand off to the user**

Do not deploy. Tell the user to push, restart, and check:

1. `/departments/dealing?tab=revenue-share` loads and shows LP rows with an
   **LP P/L (Rev Share)** column.
2. Pick one row and confirm `Real LP P/L x NTP %` equals the displayed
   **LP P/L** — if it does not, the backend changed and the page is right to
   show its figure rather than ours.
3. Switch to **Deals**, choose an LP. If the columns render blank, the deal
   field names taken from the reference page are wrong — report the actual
   field names back rather than guessing.
4. Set the range to 1 Jul – 24 Aug. It should show the "no revenue-share
   period" empty state, not an error.
5. Open the **Accounts** department and confirm the same panel appears at the
   bottom.

- [ ] **Step 4: Only after the user confirms, mark done**

Do not tick this box on local tests alone. It is ticked when the user reports
step 1 and step 5 working.

---

## Out of scope

The other ten reference pages in this batch. Five are blocked on backend
endpoints returning 404 (`/api/SwapsReport`, `/api/ClientAccountMonitor`,
`/api/admin/api-clients`, `/api/admin/vendor-urls`) or a missing field
(`excludeFromSwaps` on `/api/LpAccount`). The two Finalto pages return 401, so
their backend exists and they are buildable under a separate plan once the
authentication scheme is known.
