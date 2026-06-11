# Deal Performance — Month-wise PDF Report

**Date:** 2026-06-10
**Status:** Approved design (pre-implementation)
**Area:** `/departments/dealing?tab=performance`

## Summary

Add a reusable **"Download PDF Report"** button to the Deal Performance tab. It takes the
tab's currently selected date range, breaks it into calendar months, and produces a
**landscape PDF** whose centerpiece is three month-by-month bar charts (Net Revenue, IB
Commission, LP Commission) so the user can compare strong vs weak months at a glance.

The user's immediate goal: set the range to **Jan 1, 2025 → today** and export. The feature
is range-agnostic and reusable for any future range.

## Decisions (from brainstorming)

- **Delivery:** reusable in-app button (not a one-off file).
- **Charts:** three separate single-series monthly bar charts — Revenue, IB Commission,
  LP Commission. Best month highlighted green, weakest red, others neutral; value labels on bars.
- **Revenue bar metric:** **Net Revenue** (Total Revenue − IB Commission). Total Revenue
  still appears in the monthly table.
- **Monthly IB commission basis:** IB **transactions only** (`ib transfer to account`,
  `ib withdrawal`) dated within each month. Current IB wallet balance is excluded (it is a
  live snapshot and cannot be attributed to a past month).
- **Orientation:** Landscape.
- **Approach:** Client-side (chart.js → canvas + jsPDF), reusing the tab's existing data access.

## Definitions

Per the existing tab logic ([DealPerformanceTab.tsx](../../../src/pages/departments/dealing/DealPerformanceTab.tsx)):

- **Total Revenue** = Markup + Client Commission − LP Commission
- **IB Commission (month)** = sum of the IB's `ib transfer to account` + `ib withdrawal`
  transactions dated within that month, across all IB clients
- **Net Revenue (month)** = Total Revenue (month) − IB Commission (month)
- **LP Commission (month)** = sum of `lpCommissionUsd` (absolute) across clients in the month

## Architecture

Three new units plus a UI edit. Heavy lifting stays in the browser, reusing the same
`DealMatch/Run` endpoint and CRM REST proxy the tab already calls (so existing
auth/tokens apply — no backend wiring needed).

### 1. `src/lib/dealMatchApi.ts` (extracted shared helpers)

Move the reusable, network-facing helpers currently inline in `DealPerformanceTab.tsx`
into a shared module so both the tab and the report use one copy:

- `toYmd`, `toUnixRange`, `num`, `money`, `mapWithConcurrency`
- `fetchDealMatch(baseUrl, fromYmd, toYmd): DealMatchResponse`
- `deriveBaseRows(report): DealMatchRevenueRow[]`
- `fetchCrmUserIdByLogin(login)`, `isIb(crmId)`
- `fetchIbTransactionsWithDates(crmId, fromYmd, toYmd): { processedAtMs, amount }[]`
  — a new variant of the current `fetchIbPeriodTransactions` that returns dated rows
  (so amounts can be bucketed by month) instead of a pre-summed total.

The tab is refactored to import these (behavior unchanged).

### 2. `src/pages/departments/dealing/dealPerformanceReport.ts` (data builder)

Pure logic + orchestration:

- `enumerateMonths(from: Date, to: Date): MonthBucket[]`
  — calendar months clamped to the range; last month may be partial (e.g. Jun 1–10).
  Pure & unit-tested. `MonthBucket = { key, label, startYmd, endYmd }`.
- `aggregateMonth(report: DealMatchResponse): MonthTotals`
  — reduces a month's DealMatch response to `{ lots, markup, clientComm, lpComm, totalRev }`
  and per-client rows. Pure & unit-tested.
- `bucketIbByMonth(rows, months): Record<monthKey, number>`
  — buckets dated IB transaction amounts into months. Pure & unit-tested.
- `buildReport(baseUrl, from, to, onProgress?): Promise<ReportData>`
  — orchestration:
  1. `enumerateMonths`.
  2. For each month (concurrency-limited): `fetchDealMatch` → `aggregateMonth`; accumulate
     per-client totals across months for the top-clients table.
  3. Union of client logins → resolve CRM id + `isIb` (cached once, range-independent).
  4. For each IB client: `fetchIbTransactionsWithDates` over the full range once →
     `bucketIbByMonth`; also accumulate per-client IB total.
  5. Compose `ReportData`.

`ReportData`:
```
{
  meta: { fromYmd, toYmd, generatedAt, group: "*" },
  months: Array<{ key, label, lots, totalRev, ibComm, lpComm, netRevenue }>,
  totals: { lots, totalRev, netRevenue, ibComm, lpComm, clients },
  topClients: Array<{ login, name, lots, totalRev, ibComm, netRevenue }>, // sorted by netRevenue
  warnings: string[], // e.g. "Month 2025-03 failed to load"
}
```

### 3. `src/pages/departments/dealing/performancePdf.ts` (rendering)

- `renderMonthlyBarChart(canvas, { title, labels, values, baseColor }): string`
  — chart.js bar chart, single dataset; per-bar colors computed (max→green `#15803d`,
  min→red `#be123c`, else `baseColor`); an inline `afterDraw` plugin writes value labels
  above bars. Returns `canvas.toDataURL("image/png")`. No extra chart plugin dependency.
- `generatePerformancePdf(data: ReportData): void`
  — jsPDF (landscape, A4) + jspdf-autotable:
  - Header: "Deal Performance Report", "Sky Links Capital", range, generated timestamp.
  - KPI row: Total Rev, Net Rev, IB Comm, LP Comm, Total Lots.
  - Three chart images: Net Revenue, IB Commission, LP Commission by month.
  - Monthly table: Month, Lots, Total Rev, Net Rev, IB Comm, LP Comm.
  - Top-clients table: Login, Name, Lots, Total Rev, IB Comm, Net Rev.
  - Saves `deal-performance-report-<fromYmd>_<toYmd>.pdf`.

### 4. `DealPerformanceTab.tsx` (UI)

- Add "Download PDF Report" button beside the existing Snapshot button.
- On click: disable + show progress ("Fetching month 3/18…", "Building PDF…"), call
  `buildReport` with the tab's current `fromDate`/`toDate`, render charts offscreen,
  `generatePerformancePdf`, then re-enable. Show warnings/errors inline.
- Button disabled when range yields no data or while generating.

## Data flow

```
[Download PDF] → buildReport(baseUrl, from, to, onProgress)
   → months × fetchDealMatch → aggregateMonth         (revenue, LP, lots, per-client)
   → IB clients × fetchIbTransactionsWithDates → bucketIbByMonth   (IB per month)
   → ReportData
→ renderMonthlyBarChart ×3 (offscreen canvas → PNG)
→ generatePerformancePdf → browser download
```

## Error handling

- Per-month and per-IB fetches are isolated in try/catch; a failure records a `warning`
  and contributes 0 rather than aborting the whole report.
- Concurrency limited (~6) via `mapWithConcurrency` to avoid hammering the APIs.
- Empty result → button disabled with "No data for range".
- Any top-level failure → inline error message; button re-enabled.

## Testing

Vitest unit tests for the pure functions (no network):

- `enumerateMonths` — full months, partial last month, single-month range, year boundary.
- `aggregateMonth` — mock DealMatch responses (both `clientRevenueSummaries` and `matches`
  shapes) → correct month totals; Net = Total − IB.
- `bucketIbByMonth` — dated transaction rows → correct per-month sums; out-of-range dropped.

Network/chart/PDF layers are thin I/O wrappers, verified manually by running the app and
exporting a PDF for Jan 2025 → today.

## Dependencies

Add: `jspdf`, `jspdf-autotable`. (`chart.js` already present.)

## Out of scope

- Server-side / scheduled / emailed reports.
- Including the live IB wallet balance in monthly figures.
- Changes to the on-screen Performance tab charts (only the export is added).

## Performance note

A wide range means ~N month calls plus one transactions call per IB client. CRM id/isIb
lookups are cached once (range-independent). Expect a noticeable but bounded run for an
18-month export; the progress indicator communicates status.
