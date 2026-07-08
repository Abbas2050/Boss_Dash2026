# Weekly Slippage Email Report Implementation Plan

> Execute via superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add a second, independent weekly email — the **Slippage Report** — that works exactly like the existing Deal Match weekly email but is fully separate (own module, own schedule, own recipients, own on/off switch).

**Architecture:** Extract the report-agnostic plumbing from `reports/dealMatchWeeklyReport.js` into `reports/reportShared.js`; refactor the Deal Match report to import it (behavior unchanged); add `reports/slippageWeeklyReport.js` that pulls `/SlippageReport/Run`, aggregates By-LP + KPIs (same math as the Slippage tab), builds an HTML email + a net-slippage-by-LP chart, and sends via Brevo; start its cron scheduler in `server.js` next to the Deal Match one.

**Tech:** Node ESM, `node-cron`, `chartjs-node-canvas`, Brevo REST.

## Global Constraints

- Two reports must be **fully independent**: separate env vars, separate cron jobs, separate try/catch — one failing/misconfigured must not affect the other.
- The Deal Match report's behavior must be **byte-for-byte unchanged** after the refactor (same email, same schedule, same data).
- Slippage email content (decided): **By-LP summary table + 5 KPIs + a net-slippage-by-LP bar chart image**. No By-Symbol/worst-client tables in the email body (KPIs already include best/worst LP + worst client).
- Delivery (decided): **own recipient list AND own schedule**. Env: `SLIPPAGE_ALERT_RECIPIENTS`, `WEEKLY_SLIPPAGE_ENABLED` (default `"true"`), `WEEKLY_SLIPPAGE_CRON` (default `"30 20 * * 5"` = Fri 20:30), `WEEKLY_SLIPPAGE_TIMEZONE` (default `"Asia/Dubai"`), `WEEKLY_SLIPPAGE_RUN_ON_START` (default `"false"`).
- No real email is sent during verification (recipients unset → the report logs "no-recipients" and skips send, mirroring Deal Match).
- Branch `feat/slippage-weekly-email` (off `10c9293`). Never push.

## Reference: `/SlippageReport/Run` (external backend)
`GET ${BACKEND_BASE_URL}/SlippageReport/Run?group=*&from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ rows, internalRows, rowCount, fromDate, toDate }`. Uses **date strings** (not unix). Per-order row fields include: `extLogin, symbol, side, fillVolume, lpsid, hasMakerMatch, lpPrice, clientPlImpact, lpPlImpact, lpSlipPoints`. (Ignore `internalRows` for the email — excluded, like the tab.)

## Aggregation (mirror the Slippage tab, verified in `src/pages/departments/dealing/SlippageReportTab.tsx`)
- **By-LP bucket** grouped by `lpsid` (blank → "Unattributed"): `lots = Σ fillVolume`; `netSlipUsd = Σ lpPlImpact`; `netPosUsd`/`netNegUsd` = Σ of positive/negative `lpPlImpact`; `avgSlipPts = Σ lpSlipPoints (rows with lpPrice>0) / count(those rows)`. Sort ascending by `netSlipUsd` (worst first).
- **KPIs**: `Total Lots` = Σ bucket lots; `Total Net LP Slippage USD` = Σ bucket netSlipUsd; `Best LP` = min `costPerLot = -netSlipUsd/lots` (exclude "Unattributed" and zero-lot); `Worst LP` = max `costPerLot`; `Worst Client` = extLogin with max `-Σ clientPlImpact` (only positive totals count).

---

## Task 1: Extract `reports/reportShared.js` and refactor the Deal Match report

**Files:** Create `reports/reportShared.js`; modify `reports/dealMatchWeeklyReport.js`.

- [ ] **Step 1:** Read `reports/dealMatchWeeklyReport.js` fully.
- [ ] **Step 2:** Create `reports/reportShared.js` exporting the report-agnostic helpers moved verbatim: `BACKEND_BASE_URL` const, `toYmdUtc`, `parseRecipients`, `fmtNum`, `money`, `escapeHtml`, `mapWithConcurrency`, `previousFullWeekUtc`, `toUnixRange`, `sendBrevoEmail`, `renderChartBuffer` (the `ChartJSNodeCanvas` factory taking a chart config + width/height → PNG buffer). Keep signatures identical.
- [ ] **Step 3:** In `dealMatchWeeklyReport.js`, delete those moved definitions and `import` them from `./reportShared.js`. Leave the Deal-Match-specific code untouched: CRM/IB helpers (`crmAuthHeaders`, `crmFetchJson`, `getCrmUserIdByMt5Login`, `isIbUser`, `getIbWalletUsdBalance`, `getIbApprovedTransfersAndWithdrawals`, `getIbCommissionForLogin`), `deriveClientRevenueRows`, `buildEmailHtml`, `buildEmailChartAttachments`, `runWeeklyDealMatchEmailReport`, `getWeeklyDealMatchDataset`, `startWeeklyDealMatchScheduler`.
- [ ] **Step 4:** Verify no behavior change: `node -e "import('./reports/dealMatchWeeklyReport.js').then(m=>console.log(Object.keys(m)))"` prints the same exports (`runWeeklyDealMatchEmailReport`, `getWeeklyDealMatchDataset`, `startWeeklyDealMatchScheduler`) with no import error. Then `npm run local:restart` and confirm `.local-backend.log` shows `[DealMatchWeekly] scheduled ...` and NO error. Backend must be UP.
- [ ] **Step 5:** Commit `refactor(reports): extract shared weekly-report helpers into reportShared.js`.

## Task 2: Create `reports/slippageWeeklyReport.js`

**Files:** Create `reports/slippageWeeklyReport.js`.

- [ ] **Step 1:** Read `reports/dealMatchWeeklyReport.js` (for structure of `run…`, `get…Dataset`, `start…Scheduler`, and how `buildEmailHtml`/`buildEmailChartAttachments` embed a chart via cid) and `src/pages/departments/dealing/SlippageReportTab.tsx` (for the aggregation math).
- [ ] **Step 2:** Implement, importing shared helpers from `./reportShared.js`:
  - `aggregateByLp(rows)` → sorted By-LP buckets + `rollup` totals (per the Aggregation section above).
  - `computeKpis(buckets, rows)` → `{ totalLots, totalNetSlipUsd, bestLp, worstLp, worstClient }`.
  - `buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis })` → dark-themed HTML with a KPI tile row + a By-LP table (LP, Lots, Net Slippage USD [pos/neg color], Avg Slip pts, Net Positive USD, Net Negative USD), referencing the chart by `cid:slippage-by-lp`. Reuse `money`/`fmtNum`/`escapeHtml`.
  - `buildSlippageChartAttachments(buckets, fromYmd, toYmd)` → one horizontal/vertical **bar chart** of `netSlipUsd` per LP (top ~15 by |netSlipUsd|) via `renderChartBuffer`, returned as a Brevo attachment with `cid: "slippage-by-lp"`.
  - `runWeeklySlippageEmailReport({ fromDate, toDate } = {})` → resolve week (`previousFullWeekUtc()` or explicit), fetch `${BACKEND_BASE_URL}/SlippageReport/Run?group=*&from=${fromYmd}&to=${toYmd}` (45s timeout), aggregate, and if `parseRecipients(process.env.SLIPPAGE_ALERT_RECIPIENTS)` is empty → log `[SlippageWeekly] No recipients configured. Skipping.` and return `{ ok:false, reason:"no-recipients" }`; else `sendBrevoEmail({ subject: \`Weekly Slippage Report (${fromYmd} to ${toYmd})\`, html, recipients, attachments })` and log the send.
  - `getWeeklySlippageDataset({ fromDate, toDate } = {})` → returns `{ fromYmd, toYmd, kpis, buckets }` WITHOUT sending (for testing).
  - `startWeeklySlippageScheduler()` → mirror `startWeeklyDealMatchScheduler` but with the `WEEKLY_SLIPPAGE_*` env vars and default cron `"30 20 * * 5"`, timezone `"Asia/Dubai"`; validate cron; log `[SlippageWeekly] scheduled with expression "…" (…)`; honor `WEEKLY_SLIPPAGE_RUN_ON_START`.
- [ ] **Step 3:** Sanity-check load: `node -e "import('./reports/slippageWeeklyReport.js').then(m=>console.log(Object.keys(m)))"` → lists `runWeeklySlippageEmailReport`, `getWeeklySlippageDataset`, `startWeeklySlippageScheduler` with no error.
- [ ] **Step 4:** Commit `feat(reports): weekly Slippage email report (By-LP table + KPIs + chart)`.

## Task 3: Wire scheduler in `server.js`

**Files:** modify `server.js`.

- [ ] **Step 1:** Add `import { startWeeklySlippageScheduler } from './reports/slippageWeeklyReport.js';` next to the Deal Match import (line ~30).
- [ ] **Step 2:** Call `startWeeklySlippageScheduler();` right after `startWeeklyDealMatchScheduler();` (line ~881).
- [ ] **Step 3:** `npm run local:restart`; confirm `.local-backend.log` shows BOTH `[DealMatchWeekly] scheduled …` and `[SlippageWeekly] scheduled …`, no errors, backend UP.
- [ ] **Step 4:** Commit `feat(server): start weekly Slippage email scheduler`.

## Task 4: Verify

- [ ] **Step 1:** Temporarily set `WEEKLY_SLIPPAGE_RUN_ON_START=true` in the local env and restart (or run a one-off node script calling `getWeeklySlippageDataset({fromDate,toDate})` for a known past week) to confirm it fetches `/SlippageReport/Run`, aggregates, and (with no recipients) logs `no-recipients` rather than erroring. Do NOT configure real recipients. Revert the env change.
- [ ] **Step 2:** Confirm the Deal Match report still schedules and is unchanged (`[DealMatchWeekly] scheduled …` present, no error).
- [ ] **Step 3:** `.env` docs: if an `.env.example` exists, add the five `WEEKLY_SLIPPAGE_*`/`SLIPPAGE_ALERT_RECIPIENTS` vars with comments; otherwise note them in the report file header. Never print real secret values.
