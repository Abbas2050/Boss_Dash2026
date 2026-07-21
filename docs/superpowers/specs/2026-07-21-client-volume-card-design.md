# Client Volume chart + values in the Dealing (LP) card

**Date:** 2026-07-21
**Status:** Approved design (pre-implementation)
**Surface:** Homepage (`/`) → **Dealing (LP)** card — `src/components/dashboard/AccountsDepartment.tsx` (LP-only branch)

## Summary

Replace the **"Live Equity Trend (date)"** chart in the Dealing (LP) card with a **stacked area chart of client Equity vs CFD trading volume**, add **two new metric values** (Equity Volume, CFD Volume), and give the block its **own range presets** (Today / Yesterday / Week / Month).

Data comes from the same feed as `/departments/dealing?tab=client-volume` — `GET /ClientVolume/Run`.

## Decisions (from brainstorming)

- **Target card:** Dealing (LP), replacing "Live Equity Trend (date)". Confirmed explicitly after flagging that the chart the user first named sits in a different card than the one first mentioned, and that client-volume data in an LP card is a slightly odd semantic fit.
- **"Equity Volume" = stocks lots** (`totalStocksLots`); **"CFD Volume" = CFD lots** (`totalCfdLots`). This is the only split the endpoint provides.
- **Chart style:** stacked area over time (chosen over stacked bars and a donut+sparkline).
- **Time range:** the block carries **its own presets**, independent of the homepage From/To filter.

## Scope boundary

Only the LP branch of `AccountsDepartment` changes. The Accounts card (`!isLpMode`) and the Dealing (Client) card (`DealingDepartment.tsx`) are untouched. The `/departments/dealing?tab=client-volume` tab is not refactored.

## Verified data contract

`GET ${BACKEND_BASE_URL}/ClientVolume/Run?from=YYYY-MM-DD&to=YYYY-MM-DD&group=*` → HTTP 200:

```
{
  fromDate, toDate, activeDays, avgLotsPerDay,
  totalLots, totalStocksLots, totalCfdLots,
  byDate: [ { date: "2026-07-20", lots, stocksLots, cfdLots }, ... ],
  byClient, byClientSymbol, byInternalAccount
}
```

Live sample (30-day window, 2026-06-21 → 2026-07-21): `totalLots 84,767.16`, `totalStocksLots 72,321`, `totalCfdLots 12,446.16`, `byDate` 27 rows. Recent days are 100% CFD (`stocksLots: 0`) — the chart must look correct when one series is entirely zero.

`BACKEND_BASE_URL` = `import.meta.env.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com"`, matching the pattern in `src/lib/dealMatchApi.ts`.

## Components

### 1. `src/lib/clientVolumeApi.ts` (new)

One responsibility: fetch and normalize client volume.

- `type ClientVolumeDay = { date: string; lots: number; stocksLots: number; cfdLots: number }`
- `type ClientVolumeSummary = { fromDate: string; toDate: string; totalLots: number; totalStocksLots: number; totalCfdLots: number; byDate: ClientVolumeDay[] }`
- `fetchClientVolume({ from, to, group = "*", signal }): Promise<ClientVolumeSummary>` — throws on non-OK; coerces every numeric field with `Number(...) || 0`; guarantees `byDate` is an array.
- `type VolumeRangePreset = "today" | "yesterday" | "week" | "month"`
- `resolveVolumeRange(preset, now: Date): { from: string; to: string }` — **pure and unit-tested**:
  - `today` → today → today
  - `yesterday` → yesterday → yesterday
  - `week` → Monday of the current week → today (Monday-start; Sunday belongs to the week that began the preceding Monday)
  - `month` → 1st of the current month → today
  - Dates formatted `YYYY-MM-DD` in **local** time (the endpoint's dates are MT5 server-local, and the existing Client Volume tab also sends local dates).

### 2. Dealing (LP) card block (replaces `AccountsDepartment.tsx` lines 644–681)

Layout, top to bottom, inside the existing rounded/gradient wrapper:

1. **Header row** — label **"Client Volume"** on the left; preset pills on the right: `Today · Yest · Week · Month`. **Default preset on first render: `today`.** Because `today` is a single-day range, the card opens on the single-day fallback (§3) — a stacked bar, not an area — and on a quiet day may legitimately show only the CFD band or an empty state. This is intended.
2. **Two value tiles** (2-col grid, matching the card's existing tile idiom `p-2 rounded-lg bg-*/10 border border-*/20`):
   - **Equity Volume** — `totalStocksLots`, cyan
   - **CFD Volume** — `totalCfdLots`, violet
   - Both formatted `toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` with a `lots` suffix.
3. **Chart** (`h-32`, `ResponsiveContainer`) — stacked `AreaChart` over `byDate`:
   - `Area type="monotone" dataKey="stocksLots" stackId="vol"` — cyan `hsl(186 100% 50%)`, gradient fill
   - `Area type="monotone" dataKey="cfdLots" stackId="vol"` — violet `#a78bfa`, gradient fill
   - `CartesianGrid` horizontal-only, low opacity; `XAxis dataKey="date"` (formatted `DD MMM`, `minTickGap`); `YAxis hide`
   - Tooltip in the card's existing dark style, listing **Equity**, **CFD**, and **Total** for the hovered day
   - `isAnimationActive` so switching presets animates
4. **Legend** — two dots, `Equity` (cyan) / `CFD` (violet), matching the legend idiom already used at lines 676–680.

### 3. Single-day fallback (required)

`today` and `yesterday` yield a **one-point** series, and a one-point area renders as nothing. When `byDate.length < 2`, render a stacked **`BarChart`** instead — same two series, same colours, same tooltip and legend. The user chose the area style knowing this; the fallback keeps single-day ranges legible rather than blank.

## Data flow

Preset pill click → `resolveVolumeRange(preset, new Date())` → `fetchClientVolume({ from, to })` → state `{ summary, loading, error }` → the two tiles read `totalStocksLots` / `totalCfdLots`; the chart reads `byDate`.

Refetch triggers: preset change, and the card's existing `refreshKey` prop. Requests are abortable (`AbortController`), aborting any in-flight request when the preset changes again quickly or the component unmounts — mirroring the routing-drilldown pattern already used in `ClientVolumeTab`.

## States

- **Loading:** tiles show a muted `—`; chart area shows a subtle skeleton/"Loading…". Previous data is not wiped mid-fetch (avoids flicker on preset change).
- **Empty** (`byDate` empty or all zero): chart area shows **"No client volume in this range."**; tiles show `0.00`.
- **Error:** an inline `text-[11px]` warning line with the message; tiles fall back to `0.00`. A failure here must not break the rest of the LP card.
- **All-zero series:** normal render — a stack of height 0 is valid; recent real days are 100% CFD.

## Testing

- **Unit (vitest), pure:** `resolveVolumeRange` for all four presets against fixed `now` values, including a **Sunday** (week still starts the preceding Monday), the **1st of a month** (month range is a single day → exercises the fallback path), and a **year boundary**.
- **Unit:** `fetchClientVolume` normalization — string numbers coerced, missing `byDate` → `[]`, non-OK response throws.
- **Manual:** homepage → Dealing (LP): each preset loads; Month shows a stacked area; Today renders the single-bar fallback; tooltip lists Equity/CFD/Total; the Accounts card and the Dealing (Client) card are visually unchanged.

## New / changed files

- New: `src/lib/clientVolumeApi.ts`, `src/lib/clientVolumeApi.test.ts`
- Edit: `src/components/dashboard/AccountsDepartment.tsx` — replace lines 644–681 with the new block; add state, the fetch effect, and the preset handler; import `BarChart`/`Bar` from recharts alongside the existing chart imports.

## Out of scope

- **Refactoring `ClientVolumeTab` onto the new lib — explicitly declined.** The tab keeps its own inline fetch, so `/ClientVolume/Run` is called from two places. Accepted knowingly: the tab works today and refactoring it would require re-testing its Run/Monthly/ClientRouting calls, filters and drill-downs for no user-visible gain. If the endpoint's contract ever changes, **both** `src/lib/clientVolumeApi.ts` and `src/pages/departments/dealing/ClientVolumeTab.tsx` must be updated.
- Any change to the Dealing (Client) card or the Accounts card.
- Group filtering (always `group=*`), client/symbol drill-downs, and internal-account splits — the tab already covers those.
- Wiring the block to the homepage From/To filter (deliberately replaced by the presets).
