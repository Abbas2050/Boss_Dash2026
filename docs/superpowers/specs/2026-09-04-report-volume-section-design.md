# Volume section for the three reports

**Date:** 2026-09-04
**Status:** approved, not yet implemented

## Problem

The ten lot metrics on `departments/dealing?tab=deal` exist nowhere in the
emails. Anyone reading a report sees revenue with no sense of the volume behind
it, and the single most useful fact about that volume is invisible: for 20–26
Jul, **~4,300 matched lots out of ~203,000 deal lots — roughly 2%** reached an
LP. Without that, "we traded 203k lots and made $40k" reads as a bad week rather
than a normal one.

## Scope

One **MT5 Volume Funnel** section added to all three reports — Business Summary,
Slippage, and Deal Match — across all three cadences (daily, weekly, monthly),
so nine sends in total.

Not in scope: changing any existing figure, tile or table in any report; changing
the dealing tab; adding volume to the wallet alert.

## The ten figures and where they come from

Every one is a `total*` scalar on the `DealMatch/Run` response, the same source
the dashboard tab reads (`src/pages/departments/dealing/DealMatchingTab.tsx:1316`).

| Figure | Field |
| --- | --- |
| Total MT5 Deals | `totalMt5DealLots + totalShiftingMt5DealLots` |
| Client Deals | `totalMt5DealLots` |
| MT5 Realized (CFD) | `totalRealizedLotsCfd` |
| MT5 Realized (Equity) | `totalRealizedLotsEquity` |
| Shifting Deals | `totalShiftingMt5DealLots` |
| Shifting Realized | `totalShiftingRealizedLots` |
| Internal Deals | `totalInternalAccountLots` |
| Internal Realized | `totalInternalAccountRealizedLots` |
| Bridge Lots | `totalBridgeLots` |
| Matched Lots | `totalMatchedLots` |

### Two fields are unverified

`docs/dealing-reporting.md:76` lists what is **confirmed present under
`lite=true`**. Two of the ten are absent from that list:
`totalShiftingRealizedLots` and `totalInternalAccountRealizedLots`.

The reports must keep `lite=true` — `lite=false` returns every match row, about
45 MB for a month, which the old code downloaded and discarded.

So those two fields may simply not arrive. **A missing field renders as `—`, never
as `0.00`.** A dash means "could not read"; `0.00` means the value is zero. This
is the rule the wallet work already follows, and it matters more here than usual:
a shifting-realized of zero and a shifting-realized we never received look
identical otherwise.

Verify both against the live API during implementation and record the answer in
`docs/dealing-reporting.md`, extending the confirmed list either way.

## Design

### The funnel

Four stages, each a share of Total MT5 Deals:

```
MT5 VOLUME FUNNEL

Total MT5 Deals   ████████████████  203,109.22
Realized          ████████           99,526.60   49%
Bridge Lots       █                   8,410.15    4%
Matched Lots      ▌                   4,300.00    2%
                                    └ of deal volume

BREAKDOWN                  Deals       Realized
Client                203,109.22      99,526.60
Shifting                 (value)        (value)
Internal                 (value)        (value)
CFD / Equity split           —      1,400.60 / 98,126.00
```

**Internal accounts are deliberately not a funnel stage.**
`totalInternalAccountLots` is a **parallel bucket, not a subset** of client lots
(`docs/dealing-reporting.md:133`). Drawing it inside the funnel would assert a
containment that does not hold. It belongs in the breakdown only.

**Realized mixes two units, and the section must say so.** Equity lots are
share-based: 98,126 equity against 1,400.60 CFD in one week. The backend itself
sums them — `totalRealizedLotsCfd + totalRealizedLotsEquity` equals
`ClientVolume/Run`'s `totalLots` exactly — so the combined figure is established
rather than invented. But the split is what makes it readable, which is why it
gets its own breakdown row rather than a footnote.

### Rendering constraints

The bars are **nested tables with fixed percentage widths and a background
colour** — not CSS shapes, not pseudo-elements, not flex or grid. The report
templates already avoid `::before` and `@media` because Outlook drops them, and
that decision stands.

A stage whose value is unavailable shows `—` with **no bar at all**. A zero-width
bar and a zero-value bar must never look the same.

Percentages are computed against Total MT5 Deals and omitted when that total is
unavailable or zero — a denominator of zero yields `—`, not `0%` and not `NaN`.

### Where the data comes from, per report

| Report | Cost | How |
| --- | --- | --- |
| Deal Match | none | already fetches `DealMatch/Run` (twice — reuse an existing response, do not add a third) |
| Business Summary | none | already fetches `DealMatch/Run` (`reports/summaryCore.js:495`) |
| Slippage | **~40s** | needs a new call; it only fetches `SlippageReport/Run` today |

`DealMatch/Run` costs roughly 40 seconds regardless of date range, so the
Slippage report's runtime roughly doubles. That is the accepted price of the
answer the user chose.

**The Slippage fetch must degrade.** If `DealMatch/Run` fails or times out, the
volume section renders as unavailable naming the reason and **the rest of the
Slippage report still sends**. A new enrichment must never be able to suppress a
report that works today.

### Files

| File | Responsibility |
| --- | --- |
| `reports/volumeSection.js` (create) | `extractVolume(report)` — pure, the ten figures or `null` each; `renderVolumeSection(volume)` — the email HTML; `fetchVolumeReport(from, to)` — the Slippage-only fetch |
| `reports/dealMatchWeeklyReport.js` (modify) | mount the section from its existing response |
| `reports/summaryCore.js` (modify) | mount the section from its existing response |
| `reports/slippageWeeklyReport.js` (modify) | fetch, then mount; degrade on failure |

Extraction, rendering and fetching stay separate so every degradation case is
testable without a network. The section is its own module rather than a fourth
copy of the same markup in three files — `dataCell` is already duplicated three
times across these reports, and this must not become the fourth thing that is.

## Testing

1. **All ten figures** extract from a realistic `DealMatch/Run` payload.
2. **A missing field yields `null`, and renders `—`** — not `0.00`. Assert
   specifically for `totalShiftingRealizedLots` and
   `totalInternalAccountRealizedLots`, the two known to be at risk.
3. **A genuine zero renders `0.00`**, not `—`.
4. **Percentages** are correct against the live figures above (49% / 4% / 2%).
5. **A zero or missing Total MT5 Deals** yields `—` for every percentage, never
   `NaN` or a division by zero.
6. **An unavailable stage draws no bar.**
7. **Internal lots appear in the breakdown and NOT as a funnel stage** — this
   exists so nobody later "completes" the funnel with them.
8. **The Slippage report still sends when `DealMatch/Run` fails**, with the
   section marked unavailable and every existing slippage figure intact.
9. **No report gains an extra `DealMatch/Run` call.** Deal Match and Business
   Summary must make exactly the number they make today.
10. **The rendered HTML contains no `::before`, `::after`, flex, or grid.**

Every test must be shown to fail by mutation. Tests 2, 8 and 9 are the ones most
likely to pass for the wrong reason.

## Risks

**The two unverified fields.** If both are absent under `lite=true`, two of the
ten breakdown cells permanently read `—`. That is honest but unsatisfying; the
alternative is a 45 MB download per report, which is not a trade worth making.
Ask the backend team to include them in the lite payload.

**Slippage runtime doubles.** Accepted deliberately. If it becomes a problem the
section can be dropped from that one report without touching the other two.

**A funnel implies containment.** Bridge and matched volume are compared against
deal lots because that is how the existing analysis frames the 2% figure, but
they are not strictly a subset of it in the way "realized" is. The section says
"of deal volume" beneath the percentages rather than implying a strict funnel.
