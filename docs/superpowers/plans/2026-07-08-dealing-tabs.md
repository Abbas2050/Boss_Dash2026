# Dealing Tabs — Update 2 + Add 2 (Jul 8) Implementation Plan

> **For agentic workers:** Execute task-by-task via superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Bring 4 reference pages into the Dealing department: update **Client Volume** and **Deal Matching** to their new reference pages, and add two new tabs **LP Risk Alerts** and **Slippage Report**.

**Architecture:** React + TS tabs under `src/pages/departments/dealing/`, registered in `DealingDepartmentPage.tsx`. Data is fetched **directly from the external backend** `BACKEND_BASE_URL` (`import.meta.env.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com"`), same as existing tabs. Tables use `SortableTable` (NOT ag-grid); charts use **recharts** (NOT ag-charts/chart.js). LP Risk Alerts additionally opens a self-contained SignalR subscription via `SignalRConnectionManager`.

**Reference pages (source of truth for exact columns/logic):** `D:\Boss_Dash2026\temporay_for_reference_pages\` → `client-volume 1.html`, `deal-matching 6.html`, `lp-risk-alerts.html`, `slippage-report.html`.

## Global Constraints

- Fetch pattern: `` fetch(`${BACKEND_BASE_URL}/<Path>?${params}`) `` — copy `BACKEND_BASE_URL` const from `src/lib/dealMatchApi.ts:14`. Do NOT proxy through the node server.
- Replace ag-grid → `SortableTable` (`@/components/ui/SortableTable`, `SortableTableColumn`); replace ag-charts/chart.js → recharts (already a dep). No new chart/grid libs. No Excel-export requirement (drop the xlsx buttons; SortableTable has its own export if present — otherwise omit).
- Tabs must match the existing tabs' visual conventions (dark cards, KPI tiles, `formatDollar`/number formatting helpers already in the codebase).
- Money/number formatting: 2 decimals for money/lots, integers for counts, `%` where the reference shows it. Preserve the reference's pos/neg color coding (green positive, red negative).
- New tabs auto-gain a `Dealing:<Tab>` permission by being added to `DEALING_TABS` — no extra permission code needed.
- `npx tsc --noEmit -p tsconfig.json` must stay clean after every task.
- Do not commit to main; branch `feat/dealing-tabs-jul08` (already created off `327ce08`). Never push.

## Registration mechanics (exact — for the two NEW tabs)

In `src/lib/permissions.ts` `DEALING_TABS` array: insert **"LP Risk Alerts"** right after `"Client Risk Scenario"`; insert **"Slippage Report"** right after `"Deal Performance"`.

In `src/pages/departments/DealingDepartmentPage.tsx`:
1. **Import** the tab component near the other tab imports (lines 12–18).
2. **`DEALING_MENU_QUERY_MAP`** (line ~71): add aliases → tab name, e.g. `"lp-risk": "LP Risk Alerts"`, `"lp-risk-alerts": "LP Risk Alerts"`; `"slippage": "Slippage Report"`, `"slippage-report": "Slippage Report"`.
3. **Refresh-key state** near line ~1023: `const [lpRiskAlertsRefreshKey, setLpRiskAlertsRefreshKey] = useState(0);` and `const [slippageRefreshKey, setSlippageRefreshKey] = useState(0);`.
4. **Refresh handler** near line ~1256 (the `if (activeMenu === "...") { set...RefreshKey(k=>k+1); return; }` chain): add branches for both tab names.
5. **Columns memo** (near line ~2988, the `if (activeMenu === "X") return [];` block for self-rendering tabs): add `if (activeMenu === "LP Risk Alerts") return [];` and `if (activeMenu === "Slippage Report") return [];`.
6. **Render branch** in the ternary chain (near line ~3913–3919): add `: activeMenu === "LP Risk Alerts" ? (<LpRiskAlertsTab refreshKey={lpRiskAlertsRefreshKey} />)` and `: activeMenu === "Slippage Report" ? (<SlippageReportTab refreshKey={slippageRefreshKey} />)`.

Existing tabs for reference: `ClientVolumeTab` takes `refreshKey`; `RiskScenarioTab` takes `refreshKey`; `DealMatchingTab` takes `baseUrl={BACKEND_BASE_URL}`.

---

## Task 1: Update Client Volume tab

**Files:** Modify `src/pages/departments/dealing/ClientVolumeTab.tsx`. Reference: `client-volume 1.html`.

The tab already calls `/ClientVolume/Run`, `/ClientVolume/Monthly`, `/ClientVolume/ClientRouting`. Bring it to parity with the new reference:

- [ ] **Step 1:** Read `client-volume 1.html` and the current `ClientVolumeTab.tsx`.
- [ ] **Step 2:** Add **Stocks vs CFD lots split** everywhere: `stocksLots`/`cfdLots` columns on Daily totals, Per-client, Per-symbol grids; 3 extra KPI tiles (Stocks Lots, CFD Lots — Total Lots + Avg/Day already exist). Blue (#60a5fa) for stocks, purple (#c084fc) for CFD.
- [ ] **Step 3:** Monthly chart → **stacked bar** (recharts `BarChart` with two `Bar`s sharing `stackId`): CFD (bottom, purple) + Stocks (top, blue); X=month ("Mon YY"), Y=lots. Empty state "No closed deals in the selected window." when total ≤ 0.
- [ ] **Step 4:** Add **Internal Accounts** grid from `byInternalAccount` (same columns as Per-client); show only if non-empty; excluded from totals/KPIs/chart.
- [ ] **Step 5:** Per-client row click → filter Per-symbol grid to that login (in-memory) AND fetch `/ClientVolume/ClientRouting` (abortable) → routing grid with `%` color coding (green ≥50, amber ≥20, else gray) and "Unattributed" dim styling. (Keep existing behavior if already present.)
- [ ] **Step 6:** `npx tsc --noEmit -p tsconfig.json` clean; commit `feat(dealing): Client Volume — stocks/CFD split, stacked monthly chart, internal accounts`.

## Task 2: Update Deal Matching tab (large rebuild)

**Files:** Modify `src/pages/departments/dealing/DealMatchingTab.tsx` (and `src/lib/dealMatchApi.ts` as needed). Reference: `deal-matching 6.html`.

Rebuild to the new "Deal Match Analysis" reference. This is the biggest task; keep the existing `baseUrl` prop signature.

- [ ] **Step 1:** Read `deal-matching 6.html`, current `DealMatchingTab.tsx`, and `dealMatchApi.ts`.
- [ ] **Step 2:** Implement **two-phase load**: "Run Match" calls `/DealMatch/Run?...&lite=true` (KPIs + revenue-by-client + commission-by-LP + client systems); a "Load Match Details" button then calls `lite=false` for the heavy arrays (matches/unmatched/partial) and caches them. Filters: group (default `*`), from/to (date→unix seconds, from=00:00:00Z to=23:59:59Z), symbol, login (digits-only validation).
- [ ] **Step 3:** Build the grids (SortableTable) per the reference spec: Revenue by Client (+ pinned TOTAL, row-click → `/DealMatch/ClientRevenueDetail?login=` detail grid), Commission by LP (+ LP detail key-value panel), Client Systems (+ synthetic "LP Charged"/"Net" rows), Overall Summary, Matched Trades, Unmatched MT5 (client-aggregated via `aggregateUnmatchedMt5`), Unmatched Centroid, Partial Fills (filter of matches; row-click → MT5 details + Centroid legs). Computed columns exactly as reference (`netRevenueUsd = gross - lpComm`, `_totalRevenue = spreadRev + clientComm - |lpComm|`, `_volDiff`, `_volPct`). Collapsible sections; detail grids revealed on click.
- [ ] **Step 4:** 5 KPI tiles: Markup Revenue, Commission Revenue, Gross Revenue, LP Commission (negative), Total Net Revenue (gross − lpComm).
- [ ] **Step 5:** `npx tsc --noEmit` clean; commit `feat(dealing): Deal Matching — two-phase load, revenue drill-downs, partial fills`.

## Task 3: Add Slippage Report tab (new)

**Files:** Create `src/pages/departments/dealing/SlippageReportTab.tsx`; register per "Registration mechanics" (Slippage Report after Deal Performance). Reference: `slippage-report.html`.

- [ ] **Step 1:** Read `slippage-report.html`.
- [ ] **Step 2:** Build the component: filters group(`*`)/from/to(default today)/symbol/login; `GET ${BACKEND_BASE_URL}/SlippageReport/Run?from&to&group[&symbol][&login]`. Response `{ rows, internalRows, rowCount, fromDate, toDate }`.
- [ ] **Step 3:** Grids (SortableTable): **By-LP** rollup (aggregate rows by `lpsid`, sorted worst netSlipUsd first, pinned TOTAL, row-click → drill) → **By-Symbol** drill (same agg by `symbol`, filtered to clicked LP); **Detailed** per-order grid (default columns per spec, plus show/hide for the extra columns incl. computed markup cols; pinned TOTAL from visible rows); **Internal Accounts** grid (from `internalRows`, amber, excluded from totals) shown only if non-empty. Computed logic per spec (markup savings, `hasMakerMatch===false` → muted "—", weighted avg slip pts).
- [ ] **Step 4:** 5 KPIs: Total Lots, Total Net LP Slippage USD, Best LP (lowest USD/lot), Worst LP (highest USD/lot), Worst Client (highest total USD slippage).
- [ ] **Step 5:** Register the tab (permissions.ts + DealingDepartmentPage.tsx). `npx tsc --noEmit` clean; commit `feat(dealing): add Slippage Report tab`.

## Task 4: Add LP Risk Alerts tab (new, SignalR)

**Files:** Create `src/pages/departments/dealing/LpRiskAlertsTab.tsx`; register per mechanics (LP Risk Alerts after Client Risk Scenario). Reference: `lp-risk-alerts.html`.

- [ ] **Step 1:** Read `lp-risk-alerts.html` and `src/lib/signalRConnectionManager.ts` + how `AlertsHubProvider.tsx` builds a `SignalRConnectionManager` (hubUrl `${BACKEND_BASE_URL}/ws/dashboard` or the app's `/ws/dashboard`, `accessTokenFactory` via `/api/signalr/token`).
- [ ] **Step 2:** CRUD grid (SortableTable) of alert configs: `GET/POST ${BACKEND_BASE_URL}/api/LpRiskAlert`, `PUT/DELETE /api/LpRiskAlert/{id}`, `POST /api/LpRiskAlert/{id}/enable|disable`. Columns: Name, Symbols (join), Move (pts), ML After ≤ (%), Target ML (%), Enabled (badge), Actions (Edit/Enable-Disable/Delete). Modal for create/edit with a symbol chip-picker sourced from `GET ${BACKEND_BASE_URL}/RiskScenario/symbols` (1–4 symbols; validation: name required, move>0, targetMl & mlAfterThreshold in (0,10000]). Defaults on New: Move 50, Target ML 150, ML-after 150, Enabled true.
- [ ] **Step 3:** Live "In Danger Now" cards via a self-contained `SignalRConnectionManager` tracking event **`LpRiskAlerts`** (payload = array of firing events); render one card per `${alertId}|${lpName}` with fields per spec (direction arrow/color, triggers ML/FUND badges, mlNow, mlAfter [red if < threshold], deltaPl [red if <0], equityNow/After, freeMarginAfter, fundingToTarget [red if >0], per-symbol lots pills). WS status pill + last-tick heartbeat (STALE at 30s). Empty state "No alerts currently firing." Disconnect the manager on unmount. No audio.
- [ ] **Step 4:** Register the tab (permissions.ts + DealingDepartmentPage.tsx). `npx tsc --noEmit` clean; commit `feat(dealing): add LP Risk Alerts tab (CRUD + live SignalR cards)`.

## Task 5: Verify

- [ ] `npx tsc --noEmit -p tsconfig.json` clean; `npx vitest run` (existing suites still green); `npm run build` succeeds.
- [ ] `npm run local:restart`; open `/departments/dealing` and click through all 4 tabs; confirm data loads (backend up), the two new tabs appear near their related tabs, and query aliases (`?tab=slippage`, `?tab=lp-risk-alerts`) resolve.
