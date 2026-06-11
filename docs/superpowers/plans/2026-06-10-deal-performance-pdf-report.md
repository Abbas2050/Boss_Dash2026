# Deal Performance Month-wise PDF Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Download PDF Report" button to the Deal Performance tab that exports a landscape PDF with three month-by-month bar charts (Net Revenue, IB Commission, LP Commission) plus KPIs and tables, for the tab's selected date range.

**Architecture:** Client-side. Shared fetch helpers are extracted into `src/lib/dealMatchApi.ts`. A data builder (`dealPerformanceReport.ts`) splits the range into calendar months, fetches per-month revenue/LP via `DealMatch/Run` and per-month IB commission via CRM transactions, and returns a `ReportData` object. A renderer (`performancePdf.ts`) draws charts with chart.js and composes the PDF with jsPDF + jsPDF-autotable. The tab gets a button that runs the pipeline.

**Tech Stack:** React + TypeScript, Vite, Vitest, chart.js (already installed), jsPDF + jsPDF-autotable (added in Task 1).

**Spec:** `docs/superpowers/specs/2026-06-10-deal-performance-pdf-report-design.md`

---

## File structure

- Create: `src/lib/dealMatchApi.ts` — shared types + fetch/util helpers (extracted from the tab + one new fetcher).
- Create: `src/lib/dealMatchApi.test.ts` — unit tests for pure helpers.
- Create: `src/pages/departments/dealing/dealPerformanceReport.ts` — month enumeration, aggregation, `buildReport` orchestration, report types.
- Create: `src/pages/departments/dealing/dealPerformanceReport.test.ts` — unit tests for pure functions.
- Create: `src/pages/departments/dealing/performancePdf.ts` — chart rendering + PDF composition.
- Modify: `src/pages/departments/dealing/DealPerformanceTab.tsx` — import shared helpers; add the button + progress.

---

## Task 0: Feature branch

**Files:** none

- [ ] **Step 1: Create and switch to a feature branch** (repo default branch is `main`; do not commit to it directly)

Run:
```bash
git checkout -b feat/deal-performance-pdf-report
```
Expected: `Switched to a new branch 'feat/deal-performance-pdf-report'`

---

## Task 1: Add PDF dependencies

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install jsPDF + autotable**

Run:
```bash
npm install jspdf jspdf-autotable
```
Expected: both added to `dependencies`, no errors.

- [ ] **Step 2: Verify typecheck still passes**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add jspdf and jspdf-autotable for performance report export"
```

---

## Task 2: Shared DealMatch/CRM helpers (`dealMatchApi.ts`)

**Files:**
- Create: `src/lib/dealMatchApi.ts`
- Test: `src/lib/dealMatchApi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/dealMatchApi.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { toYmd, toUnixRange, num, deriveBaseRows } from "@/lib/dealMatchApi";

describe("dealMatchApi helpers", () => {
  it("toYmd formats a date as YYYY-MM-DD", () => {
    expect(toYmd(new Date(2025, 0, 5))).toBe("2025-01-05");
    expect(toYmd(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("toUnixRange converts ymd to inclusive unix-second bounds (UTC)", () => {
    const { from, to } = toUnixRange("2025-01-01", "2025-01-31");
    expect(from).toBe(Math.floor(Date.UTC(2025, 0, 1, 0, 0, 0) / 1000));
    expect(to).toBe(Math.floor(Date.UTC(2025, 0, 31, 23, 59, 59) / 1000));
  });

  it("num coerces safely, defaulting to 0", () => {
    expect(num("12.5")).toBe(12.5);
    expect(num(undefined)).toBe(0);
    expect(num("abc")).toBe(0);
  });

  it("deriveBaseRows builds rows from clientRevenueSummaries", () => {
    const rows = deriveBaseRows({
      clientRevenueSummaries: [
        { login: 101, name: "A", lots: 10, markupRevenueUsd: 100, clientCommissionUsd: 20, lpCommissionUsd: -5, totalRevenueUsd: 0 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].login).toBe("101");
    expect(rows[0].lpComm).toBe(5);
    expect(rows[0].totalRev).toBe(115); // 100 + 20 - 5
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/lib/dealMatchApi.test.ts
```
Expected: FAIL — cannot import from `@/lib/dealMatchApi` (module does not exist).

- [ ] **Step 3: Create the module**

Create `src/lib/dealMatchApi.ts`:
```ts
export const CRM_API_VERSION = (import.meta as any).env?.VITE_API_VERSION || "1.0.0";
export const CRM_API_TOKEN = (import.meta as any).env?.VITE_API_TOKEN || "";

export type DealMatchRevenueRow = {
  login: string;
  name: string;
  lots: number;
  markup: number;
  clientComm: number;
  lpComm: number;
  totalRev: number;
  ibCommission: number;
  netRevenue: number;
};

export type DealMatchResponse = {
  clientRevenueSummaries?: Array<{
    login?: string | number;
    name?: string;
    lots?: number;
    markupRevenueUsd?: number;
    clientCommissionUsd?: number;
    lpCommissionUsd?: number;
    totalRevenueUsd?: number;
  }>;
  matches?: Array<{
    clientLogin?: string | number;
    clientName?: string;
    clientVolume?: number;
    spreadRevenueUsd?: number;
    clientCommission?: number;
    lpCommission?: number;
  }>;
};

export function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function toUnixRange(fromDate: string, toDate: string) {
  return {
    from: Math.floor(new Date(`${fromDate}T00:00:00Z`).getTime() / 1000),
    to: Math.floor(new Date(`${toDate}T23:59:59Z`).getTime() / 1000),
  };
}

export const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const money = (value: number) =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function mapWithConcurrency<T, R>(items: T[], worker: (item: T, idx: number) => Promise<R>, limit = 8): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, limit) }).map(async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function fetchDealMatch(baseUrl: string, fromYmd: string, toYmd: string): Promise<DealMatchResponse> {
  const { from, to } = toUnixRange(fromYmd, toYmd);
  const params = new URLSearchParams({ group: "*", from: String(from), to: String(to), symbol: "", lite: "false" });
  const resp = await fetch(`${baseUrl}/DealMatch/Run?${params.toString()}`);
  if (!resp.ok) throw new Error(`DealMatch API ${resp.status}`);
  return (await resp.json()) as DealMatchResponse;
}

export function deriveBaseRows(report: DealMatchResponse): DealMatchRevenueRow[] {
  if (Array.isArray(report.clientRevenueSummaries) && report.clientRevenueSummaries.length) {
    return report.clientRevenueSummaries.map((row) => {
      const markup = num(row.markupRevenueUsd);
      const clientComm = num(row.clientCommissionUsd);
      const lpComm = Math.abs(num(row.lpCommissionUsd));
      const totalRev = Number.isFinite(num(row.totalRevenueUsd)) && num(row.totalRevenueUsd) !== 0 ? num(row.totalRevenueUsd) : markup + clientComm - lpComm;
      return {
        login: String(row.login ?? ""),
        name: String(row.name ?? "-"),
        lots: num(row.lots),
        markup,
        clientComm,
        lpComm,
        totalRev,
        ibCommission: 0,
        netRevenue: totalRev,
      };
    });
  }

  const byLogin = new Map<string, DealMatchRevenueRow>();
  (report.matches || []).forEach((m) => {
    const login = String(m.clientLogin ?? "").trim();
    if (!login) return;
    const current = byLogin.get(login) || {
      login,
      name: String(m.clientName || "-"),
      lots: 0,
      markup: 0,
      clientComm: 0,
      lpComm: 0,
      totalRev: 0,
      ibCommission: 0,
      netRevenue: 0,
    };
    current.lots += num(m.clientVolume);
    current.markup += num(m.spreadRevenueUsd);
    current.clientComm += num(m.clientCommission);
    current.lpComm += Math.abs(num(m.lpCommission));
    current.totalRev = current.markup + current.clientComm - current.lpComm;
    byLogin.set(login, current);
  });

  return Array.from(byLogin.values());
}

export async function fetchCrmUserIdByLogin(login: string): Promise<number | null> {
  const resp = await fetch(`/rest/accounts?version=${encodeURIComponent(CRM_API_VERSION)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({ login, segment: { limit: 1, offset: 0 } }),
  });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as Array<{ userId?: number }>;
  const id = num(rows?.[0]?.userId);
  return id > 0 ? id : null;
}

export async function isIb(crmId: number): Promise<boolean> {
  const resp = await fetch(`/rest/ib/tree?version=${encodeURIComponent(CRM_API_VERSION)}&ibId=${encodeURIComponent(String(crmId))}`, {
    headers: {
      Accept: "application/json",
      ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
    },
  });
  if (!resp.ok) return false;
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0;
}

export async function fetchIbPeriodTransactions(crmId: number, fromDate: string, toDate: string): Promise<number> {
  const resp = await fetch(`/rest/transactions?version=${encodeURIComponent(CRM_API_VERSION)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(CRM_API_TOKEN ? { Authorization: `Bearer ${CRM_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      fromUserId: crmId,
      statuses: ["approved"],
      transactionTypes: ["ib transfer to account", "ib withdrawal"],
      processedAt: {
        begin: `${fromDate} 00:00:00`,
        end: `${toDate} 23:59:59`,
      },
      segment: { limit: 5000, offset: 0 },
    }),
  });
  if (!resp.ok) return 0;
  const rows = (await resp.json()) as Array<{ processedAmount?: number; requestedAmount?: number }>;
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum, r) => sum + (Number.isFinite(num(r.processedAmount)) ? num(r.processedAmount) : num(r.requestedAmount)),
    0,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/lib/dealMatchApi.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dealMatchApi.ts src/lib/dealMatchApi.test.ts
git commit -m "feat: add shared dealMatchApi helpers for revenue/CRM fetching"
```

---

## Task 3: Refactor the tab to use `dealMatchApi`

**Files:**
- Modify: `src/pages/departments/dealing/DealPerformanceTab.tsx`

This removes the now-duplicated helpers from the tab and imports them from the shared module. Behavior is unchanged. `colors`, `SnapshotInput`, `takeTableSnapshot`, and `fetchIbWalletBalance` stay in the tab (tab-only). `fetchIbWalletBalance` will use the imported CRM constants.

- [ ] **Step 1: Replace the top imports**

In `DealPerformanceTab.tsx`, the file currently begins with the recharts/SortableTable imports. Add the shared-module import directly after the existing `import { SortableTable, ... }` line:
```ts
import {
  CRM_API_TOKEN,
  CRM_API_VERSION,
  deriveBaseRows,
  fetchCrmUserIdByLogin,
  fetchDealMatch,
  fetchIbPeriodTransactions,
  isIb,
  mapWithConcurrency,
  money,
  num,
  toYmd,
  toUnixRange,
  type DealMatchResponse,
  type DealMatchRevenueRow,
} from "@/lib/dealMatchApi";
```

- [ ] **Step 2: Delete the duplicated definitions from the tab**

Delete these definitions from `DealPerformanceTab.tsx` (they now live in `dealMatchApi.ts`). Keep everything else (the `colors` object, `SnapshotInput` type, `takeTableSnapshot`, `fetchIbWalletBalance`, the component):
- the `type DealMatchRevenueRow = { ... }` block
- the `type DealMatchResponse = { ... }` block
- the `const CRM_API_VERSION = ...` and `const CRM_API_TOKEN = ...` lines
- `function toYmd(...) { ... }`
- `function toUnixRange(...) { ... }`
- `const num = ...`
- `const money = ...`
- `async function mapWithConcurrency(...) { ... }`
- `async function fetchCrmUserIdByLogin(...) { ... }`
- `async function isIb(...) { ... }`
- `async function fetchIbPeriodTransactions(...) { ... }`
- `function deriveBaseRows(...) { ... }`

Do NOT delete: `const colors = { ... }`, `type SnapshotInput`, `const takeTableSnapshot = ...`, `async function fetchIbWalletBalance(...)`.

- [ ] **Step 3: Update the DealMatch fetch in `run()` to use `fetchDealMatch`**

In the component's `run()` function, replace the inline fetch block:
```ts
      const { from, to } = toUnixRange(fromDateYmd, toDateYmd);
      const params = new URLSearchParams({ group: "*", from: String(from), to: String(to), symbol: "", lite: "false" });
      const resp = await fetch(`${baseUrl}/DealMatch/Run?${params.toString()}`);
      if (!resp.ok) throw new Error(`DealMatch API ${resp.status}`);
      const report = (await resp.json()) as DealMatchResponse;
      const baseRows = deriveBaseRows(report).filter((r) => r.lots > 0);
```
with:
```ts
      const report = await fetchDealMatch(baseUrl, fromDateYmd, toDateYmd);
      const baseRows = deriveBaseRows(report).filter((r) => r.lots > 0);
```

- [ ] **Step 4: Verify typecheck + existing tests pass**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
```
Expected: typecheck clean (no unused-import or missing-symbol errors); all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/pages/departments/dealing/DealPerformanceTab.tsx
git commit -m "refactor: use shared dealMatchApi helpers in DealPerformanceTab"
```

---

## Task 4: Month enumeration + aggregation (pure functions)

**Files:**
- Create: `src/pages/departments/dealing/dealPerformanceReport.ts`
- Test: `src/pages/departments/dealing/dealPerformanceReport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/pages/departments/dealing/dealPerformanceReport.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { enumerateMonths, aggregateMonth } from "./dealPerformanceReport";

describe("enumerateMonths", () => {
  it("returns one bucket for a single full month", () => {
    const months = enumerateMonths(new Date(2025, 0, 1), new Date(2025, 0, 31));
    expect(months).toEqual([
      { key: "2025-01", label: "Jan 2025", startYmd: "2025-01-01", endYmd: "2025-01-31" },
    ]);
  });

  it("clamps first and last buckets to the range (partial months)", () => {
    const months = enumerateMonths(new Date(2025, 0, 15), new Date(2025, 2, 10));
    expect(months.map((m) => m.key)).toEqual(["2025-01", "2025-02", "2025-03"]);
    expect(months[0].startYmd).toBe("2025-01-15");
    expect(months[2].endYmd).toBe("2025-03-10");
  });

  it("crosses year boundaries", () => {
    const months = enumerateMonths(new Date(2025, 11, 1), new Date(2026, 1, 28));
    expect(months.map((m) => m.label)).toEqual(["Dec 2025", "Jan 2026", "Feb 2026"]);
  });

  it("returns empty when from is after to", () => {
    expect(enumerateMonths(new Date(2025, 5, 1), new Date(2025, 0, 1))).toEqual([]);
  });
});

describe("aggregateMonth", () => {
  it("sums client rows and computes total revenue", () => {
    const agg = aggregateMonth({
      clientRevenueSummaries: [
        { login: 1, name: "A", lots: 10, markupRevenueUsd: 100, clientCommissionUsd: 20, lpCommissionUsd: -5, totalRevenueUsd: 0 },
        { login: 2, name: "B", lots: 4, markupRevenueUsd: 40, clientCommissionUsd: 10, lpCommissionUsd: -2, totalRevenueUsd: 0 },
        { login: 3, name: "Zero", lots: 0, markupRevenueUsd: 999, clientCommissionUsd: 0, lpCommissionUsd: 0, totalRevenueUsd: 0 },
      ],
    });
    expect(agg.lots).toBe(14);
    expect(agg.lpComm).toBe(7);
    expect(agg.totalRev).toBe(163); // (100+20-5) + (40+10-2)
    expect(agg.clients).toHaveLength(2); // zero-lot row filtered out
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/pages/departments/dealing/dealPerformanceReport.test.ts
```
Expected: FAIL — module/exports do not exist.

- [ ] **Step 3: Create the module with the pure functions**

Create `src/pages/departments/dealing/dealPerformanceReport.ts`:
```ts
import {
  deriveBaseRows,
  fetchCrmUserIdByLogin,
  fetchDealMatch,
  fetchIbPeriodTransactions,
  isIb,
  mapWithConcurrency,
  toYmd,
  type DealMatchResponse,
  type DealMatchRevenueRow,
} from "@/lib/dealMatchApi";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const ymdLocal = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export type MonthBucket = { key: string; label: string; startYmd: string; endYmd: string };

export type MonthAggregate = {
  lots: number;
  markup: number;
  clientComm: number;
  lpComm: number;
  totalRev: number;
  clients: DealMatchRevenueRow[];
};

export type MonthRow = {
  key: string;
  label: string;
  lots: number;
  totalRev: number;
  ibComm: number;
  lpComm: number;
  netRevenue: number;
};

export type TopClient = {
  login: string;
  name: string;
  lots: number;
  totalRev: number;
  ibComm: number;
  netRevenue: number;
};

export type ReportData = {
  meta: { fromYmd: string; toYmd: string; generatedAt: string };
  months: MonthRow[];
  totals: { lots: number; totalRev: number; netRevenue: number; ibComm: number; lpComm: number; clients: number };
  topClients: TopClient[];
  warnings: string[];
};

export function enumerateMonths(from: Date, to: Date): MonthBucket[] {
  const months: MonthBucket[] = [];
  if (from > to) return months;
  let y = from.getFullYear();
  let m = from.getMonth();
  const endY = to.getFullYear();
  const endM = to.getMonth();
  while (y < endY || (y === endY && m <= endM)) {
    const firstOfMonth = new Date(y, m, 1);
    const lastOfMonth = new Date(y, m + 1, 0);
    const start = firstOfMonth < from ? from : firstOfMonth;
    const end = lastOfMonth > to ? to : lastOfMonth;
    months.push({
      key: `${y}-${pad2(m + 1)}`,
      label: `${MONTH_NAMES[m]} ${y}`,
      startYmd: ymdLocal(start),
      endYmd: ymdLocal(end),
    });
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return months;
}

export function aggregateMonth(report: DealMatchResponse): MonthAggregate {
  const clients = deriveBaseRows(report).filter((r) => r.lots > 0);
  const base = clients.reduce(
    (acc, r) => {
      acc.lots += r.lots;
      acc.markup += r.markup;
      acc.clientComm += r.clientComm;
      acc.lpComm += r.lpComm;
      return acc;
    },
    { lots: 0, markup: 0, clientComm: 0, lpComm: 0 },
  );
  const totalRev = base.markup + base.clientComm - base.lpComm;
  return { ...base, totalRev, clients };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/pages/departments/dealing/dealPerformanceReport.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pages/departments/dealing/dealPerformanceReport.ts src/pages/departments/dealing/dealPerformanceReport.test.ts
git commit -m "feat: add month enumeration and aggregation for performance report"
```

---

## Task 5: `buildReport` orchestration

**Files:**
- Modify: `src/pages/departments/dealing/dealPerformanceReport.ts`

- [ ] **Step 1: Append `buildReport` to the module**

Add to the end of `src/pages/departments/dealing/dealPerformanceReport.ts`:
```ts
export async function buildReport(
  baseUrl: string,
  from: Date,
  to: Date,
  onProgress?: (msg: string) => void,
): Promise<ReportData> {
  const months = enumerateMonths(from, to);
  const warnings: string[] = [];
  const clientAcc = new Map<string, { login: string; name: string; lots: number; totalRev: number }>();
  const monthAggregates: (MonthAggregate | null)[] = [];

  // 1) Monthly revenue / LP / lots + per-client accumulation
  for (let i = 0; i < months.length; i++) {
    const mb = months[i];
    onProgress?.(`Fetching month ${i + 1}/${months.length} (${mb.label})…`);
    try {
      const report = await fetchDealMatch(baseUrl, mb.startYmd, mb.endYmd);
      const agg = aggregateMonth(report);
      monthAggregates.push(agg);
      agg.clients.forEach((c) => {
        const cur = clientAcc.get(c.login) || { login: c.login, name: c.name, lots: 0, totalRev: 0 };
        cur.lots += c.lots;
        cur.totalRev += c.totalRev;
        if ((!cur.name || cur.name === "-") && c.name) cur.name = c.name;
        clientAcc.set(c.login, cur);
      });
    } catch (e: any) {
      warnings.push(`Month ${mb.label} failed to load (${e?.message || "error"})`);
      monthAggregates.push(null);
    }
  }

  // 2) Identify IB clients (crmId + isIb cached; range-independent)
  onProgress?.("Identifying IB clients…");
  const logins = Array.from(clientAcc.keys());
  const ibInfo = new Map<string, number>();
  await mapWithConcurrency(
    logins,
    async (login) => {
      try {
        const crmId = await fetchCrmUserIdByLogin(login);
        if (!crmId) return;
        if (await isIb(crmId)) ibInfo.set(login, crmId);
      } catch {
        /* ignore individual lookup errors */
      }
    },
    6,
  );

  // 3) Monthly IB commission per IB client × month
  const ibByMonth = new Map<string, number>();
  const ibByClient = new Map<string, number>();
  const ibEntries = Array.from(ibInfo.entries());
  let processed = 0;
  await mapWithConcurrency(
    ibEntries,
    async ([login, crmId]) => {
      for (const mb of months) {
        try {
          const amt = await fetchIbPeriodTransactions(crmId, mb.startYmd, mb.endYmd);
          ibByMonth.set(mb.key, (ibByMonth.get(mb.key) || 0) + amt);
          ibByClient.set(login, (ibByClient.get(login) || 0) + amt);
        } catch {
          /* ignore individual month errors */
        }
      }
      processed++;
      onProgress?.(`IB commissions ${processed}/${ibEntries.length}…`);
    },
    6,
  );

  // 4) Month rows
  const monthRows: MonthRow[] = months.map((mb, idx) => {
    const agg = monthAggregates[idx];
    const totalRev = agg ? agg.totalRev : 0;
    const lpComm = agg ? agg.lpComm : 0;
    const lots = agg ? agg.lots : 0;
    const ibComm = ibByMonth.get(mb.key) || 0;
    return { key: mb.key, label: mb.label, lots, totalRev, ibComm, lpComm, netRevenue: totalRev - ibComm };
  });

  // 5) Top clients (by net revenue)
  const topClients: TopClient[] = Array.from(clientAcc.values())
    .map((c) => {
      const ibComm = ibByClient.get(c.login) || 0;
      return { login: c.login, name: c.name, lots: c.lots, totalRev: c.totalRev, ibComm, netRevenue: c.totalRev - ibComm };
    })
    .sort((a, b) => b.netRevenue - a.netRevenue)
    .slice(0, 20);

  // 6) Totals
  const totals = monthRows.reduce(
    (acc, r) => {
      acc.lots += r.lots;
      acc.totalRev += r.totalRev;
      acc.netRevenue += r.netRevenue;
      acc.ibComm += r.ibComm;
      acc.lpComm += r.lpComm;
      return acc;
    },
    { lots: 0, totalRev: 0, netRevenue: 0, ibComm: 0, lpComm: 0, clients: clientAcc.size },
  );

  return {
    meta: { fromYmd: toYmd(from), toYmd: toYmd(to), generatedAt: new Date().toLocaleString() },
    months: monthRows,
    totals,
    topClients,
    warnings,
  };
}
```

- [ ] **Step 2: Verify typecheck + existing tests pass**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run src/pages/departments/dealing/dealPerformanceReport.test.ts
```
Expected: clean typecheck; the 5 existing pure-function tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/pages/departments/dealing/dealPerformanceReport.ts
git commit -m "feat: add buildReport orchestration for monthly performance data"
```

---

## Task 6: PDF rendering (`performancePdf.ts`)

**Files:**
- Create: `src/pages/departments/dealing/performancePdf.ts`

- [ ] **Step 1: Create the renderer module**

Create `src/pages/departments/dealing/performancePdf.ts`:
```ts
import { Chart, registerables } from "chart.js";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { ReportData } from "./dealPerformanceReport";

Chart.register(...registerables);

const COLORS = { blue: "#1d4ed8", green: "#15803d", red: "#be123c", gold: "#b45309" };

const fmtMoney = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(Math.round(v)).toLocaleString()}`;

export async function renderMonthlyBarChart(opts: {
  title: string;
  labels: string[];
  values: number[];
  baseColor: string;
}): Promise<string> {
  const { title, labels, values, baseColor } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = 1100;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const maxV = Math.max(...values, 0);
  const minV = Math.min(...values, 0);
  const barColors = values.map((v) =>
    maxV !== minV && v === maxV ? COLORS.green : maxV !== minV && v === minV ? COLORS.red : baseColor,
  );

  const valueLabelPlugin = {
    id: "valueLabels",
    afterDatasetsDraw(chart: any) {
      const c = chart.ctx as CanvasRenderingContext2D;
      c.save();
      c.font = "11px Arial";
      c.fillStyle = "#0f172a";
      c.textAlign = "center";
      chart.getDatasetMeta(0).data.forEach((bar: any, i: number) => {
        c.fillText(fmtMoney(values[i]), bar.x, bar.y - 4);
      });
      c.restore();
    },
  };

  const chart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: values, backgroundColor: barColors, borderRadius: 4, maxBarThickness: 48 }] },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: title, color: "#0f172a", font: { size: 16, weight: "bold" } },
      },
      scales: {
        x: { ticks: { color: "#475569", font: { size: 11 } }, grid: { display: false } },
        y: {
          ticks: { color: "#475569", font: { size: 11 }, callback: (v: any) => fmtMoney(Number(v)) },
          grid: { color: "#e2e8f0" },
        },
      },
    },
    plugins: [valueLabelPlugin],
  });
  chart.update();
  const url = canvas.toDataURL("image/png");
  chart.destroy();
  return url;
}

export async function generatePerformancePdf(data: ReportData): Promise<void> {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 32;
  let y = margin + 6;

  // Header
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text("Deal Performance Report", margin, y);
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(`Sky Links Capital   ·   ${data.meta.fromYmd} to ${data.meta.toYmd}`, margin, y + 16);
  doc.text(`Generated ${data.meta.generatedAt}`, pageW - margin, y + 16, { align: "right" });
  y += 30;
  doc.setDrawColor(29, 78, 216);
  doc.setLineWidth(1.5);
  doc.line(margin, y, pageW - margin, y);
  y += 18;

  // KPI row
  const kpis: Array<[string, string]> = [
    ["Total Revenue", fmtMoney(data.totals.totalRev)],
    ["Net Revenue", fmtMoney(data.totals.netRevenue)],
    ["IB Commission", fmtMoney(data.totals.ibComm)],
    ["LP Commission", fmtMoney(data.totals.lpComm)],
    ["Total Lots", Math.round(data.totals.lots).toLocaleString()],
  ];
  const gap = 8;
  const kpiW = (pageW - margin * 2 - gap * 4) / 5;
  kpis.forEach((kpi, i) => {
    const x = margin + i * (kpiW + gap);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.8);
    doc.roundedRect(x, y, kpiW, 40, 4, 4);
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(kpi[0].toUpperCase(), x + 8, y + 14);
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text(kpi[1], x + 8, y + 31);
  });
  y += 54;

  // Charts
  const labels = data.months.map((m) => m.label);
  const netUrl = await renderMonthlyBarChart({ title: "Net Revenue by Month", labels, values: data.months.map((m) => m.netRevenue), baseColor: COLORS.blue });
  const ibUrl = await renderMonthlyBarChart({ title: "IB Commission by Month", labels, values: data.months.map((m) => m.ibComm), baseColor: COLORS.red });
  const lpUrl = await renderMonthlyBarChart({ title: "LP Commission by Month", labels, values: data.months.map((m) => m.lpComm), baseColor: COLORS.gold });

  const chartW = pageW - margin * 2;
  const chartH = chartW * (360 / 1100);
  const addChart = (url: string) => {
    if (!url) return;
    if (y + chartH > pageH - margin) {
      doc.addPage();
      y = margin;
    }
    doc.addImage(url, "PNG", margin, y, chartW, chartH);
    y += chartH + 12;
  };
  addChart(netUrl);
  addChart(ibUrl);
  addChart(lpUrl);

  // Monthly breakdown table
  autoTable(doc, {
    startY: y + 4,
    head: [["Month", "Lots", "Total Rev", "Net Rev", "IB Comm", "LP Comm"]],
    body: data.months.map((m) => [
      m.label,
      Math.round(m.lots).toLocaleString(),
      fmtMoney(m.totalRev),
      fmtMoney(m.netRevenue),
      fmtMoney(m.ibComm),
      fmtMoney(m.lpComm),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42] },
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    margin: { left: margin, right: margin },
  });

  // Top clients table
  autoTable(doc, {
    head: [["Login", "Name", "Lots", "Total Rev", "IB Comm", "Net Rev"]],
    body: data.topClients.map((c) => [
      c.login,
      c.name || "-",
      Math.round(c.lots).toLocaleString(),
      fmtMoney(c.totalRev),
      fmtMoney(c.ibComm),
      fmtMoney(c.netRevenue),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42] },
    columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" } },
    margin: { left: margin, right: margin },
  });

  // Warnings (if any)
  if (data.warnings.length) {
    const yW = (doc as any).lastAutoTable.finalY + 14;
    doc.setFontSize(8);
    doc.setTextColor(190, 18, 60);
    doc.text(`Warnings: ${data.warnings.join("; ")}`, margin, yW);
  }

  doc.save(`deal-performance-report-${data.meta.fromYmd}_${data.meta.toYmd}.pdf`);
}
```

- [ ] **Step 2: Verify typecheck passes**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: clean. (If TS complains about `font: { weight: "bold" }`, change to `weight: 700`.)

- [ ] **Step 3: Commit**

```bash
git add src/pages/departments/dealing/performancePdf.ts
git commit -m "feat: add chart rendering and PDF composition for performance report"
```

---

## Task 7: Wire the "Download PDF Report" button into the tab

**Files:**
- Modify: `src/pages/departments/dealing/DealPerformanceTab.tsx`

- [ ] **Step 1: Add imports**

Add to the imports at the top of `DealPerformanceTab.tsx`:
```ts
import { buildReport } from "./dealPerformanceReport";
import { generatePerformancePdf } from "./performancePdf";
```

- [ ] **Step 2: Add export state**

Inside the component, next to the existing `const [snapshotting, setSnapshotting] = useState(false);`, add:
```ts
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
```

- [ ] **Step 3: Add the export handler**

Inside the component, directly above the existing `const handleSnapshot = () => {`, add:
```ts
  const handleExportPdf = async () => {
    setExporting(true);
    setExportStatus("Starting…");
    setError(null);
    try {
      const data = await buildReport(baseUrl, fromDate, toDate, (msg) => setExportStatus(msg));
      setExportStatus("Building PDF…");
      await generatePerformancePdf(data);
      setExportStatus("");
    } catch (e: any) {
      setError(e?.message || "Failed to generate PDF report.");
    } finally {
      setExporting(false);
      setExportStatus("");
    }
  };
```

- [ ] **Step 4: Add the button next to Snapshot**

In the JSX, find the snapshot button wrapper:
```tsx
        <div className="mb-2 flex items-center justify-end">
          <button
            type="button"
            onClick={handleSnapshot}
            disabled={snapshotting || !rows.length}
```
Replace the opening `<div className="mb-2 flex items-center justify-end">` and add the export button just before the snapshot `<button>`:
```tsx
        <div className="mb-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleExportPdf}
            disabled={exporting}
            className="rounded-md border border-cyan-600 bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? (exportStatus || "Generating…") : "Download PDF Report"}
          </button>
```
(The existing snapshot `<button>` remains immediately after this one, inside the same `<div>`.)

- [ ] **Step 5: Verify typecheck + build**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
```
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/pages/departments/dealing/DealPerformanceTab.tsx
git commit -m "feat: add Download PDF Report button to Deal Performance tab"
```

---

## Task 8: Manual verification

**Files:** none (runtime check)

- [ ] **Step 1: Start the app**

Run:
```bash
npm run local:start
```
Expected: Frontend UP on :8080, backend UP on :3001.

- [ ] **Step 2: Exercise the feature**

1. Open `http://localhost:8080`, log in as a user with Dealing access.
2. Go to `/departments/dealing?tab=performance`.
3. Set the date filter to **From = 2025-01-01, To = today**, apply.
4. Click **Download PDF Report**. Watch the button show progress ("Fetching month X/…", "Building PDF…").
5. Confirm a PDF downloads named `deal-performance-report-2025-01-01_<today>.pdf`.

- [ ] **Step 3: Verify PDF contents**

Open the PDF and confirm:
- Landscape orientation, header with range + generated time.
- KPI row (Total Rev, Net Rev, IB Comm, LP Comm, Total Lots).
- Three month-wise bar charts (Net Revenue, IB Commission, LP Commission) with value labels and best=green/worst=red bars.
- Monthly breakdown table and Top-clients table.
- If any month failed, a red "Warnings:" line appears.

- [ ] **Step 4: Stop the app**

Run:
```bash
npm run local:stop
```

---

## Self-review notes (already applied)

- **Spec coverage:** button (Task 7) ✓; monthly revenue/LP/lots (Tasks 4–5) ✓; IB-transactions-per-month (Task 5) ✓; Net = Total − IB (Tasks 5–6) ✓; 3 charts + KPIs + 2 tables landscape (Task 6) ✓; deps (Task 1) ✓; shared-helper extraction (Tasks 2–3) ✓; tests for pure functions (Tasks 2, 4) ✓; error/warnings handling (Tasks 5–6) ✓.
- **Type consistency:** `ReportData`/`MonthRow`/`TopClient` defined in Task 4 and consumed unchanged in Tasks 5–6; `buildReport`/`generatePerformancePdf`/`renderMonthlyBarChart` signatures match their call sites in Task 7.
- **Deviation from spec (intentional, for reliability):** IB monthly commission is fetched per-IB-per-month using the existing proven `fetchIbPeriodTransactions` request shape, rather than fetching full-range dated transactions and bucketing client-side. This avoids depending on an unverified transaction date field in the CRM response. Trade-off: more API calls (mitigated by concurrency).
```
