# Volume section for the three reports

**Date:** 2026-09-04
**Status:** implemented; revised the same day after the first real send

> **Revision, 2026-09-04 (afternoon).** The section is now **two tables and no
> bars**, and the first heading is **MT5 Volume Flow**, not "MT5 Volume Funnel".
> The funnel diagram and the bar-rendering constraints below describe markup that
> no longer exists; they are kept because they explain the two-axis grouping,
> which does still hold. See "Why the bars were removed" at the end.

## Problem

The ten lot metrics on `departments/dealing?tab=deal` exist nowhere in the
emails. Anyone reading a report sees revenue with no sense of the volume behind
it, and the single most useful fact about that volume is invisible: for 20–26
Jul, **~4,300 matched lots out of ~203,000 deal lots — roughly 2%** reached an
LP. Without that, "we traded 203k lots and made $40k" reads as a bad week rather
than a normal one.

## Scope

One **MT5 volume** section ("MT5 Volume Flow" plus "Volume Breakdown") added to
all three reports — Business Summary, Slippage, and Deal Match — across all three
cadences (daily, weekly, monthly), so nine sends in total.

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

### The two tables

Two `table.data` tables. The first is the routing axis, the second is every
bucket. **Superseded shape** (the bars and the Realized headline are gone; see
"Why the bars were removed"):

```
MT5 VOLUME FUNNEL                       ← superseded, kept for the argument below

Realized                              149.70
CFD / Equity                   100.00 / 49.70
Total MT5 Deals   ████████████████    497.10
Bridge Lots       ███████████         356.84   72%
Matched Lots      ███████████         356.76   72%
```

**What is rendered now**, on the live figures for 2026-09-03:

```
MT5 VOLUME FLOW           Stage        Lots     Share
                Total MT5 Deals      296.09
                    Bridge Lots      260.25       88%
                   Matched Lots      259.95       88%
                └ percentages are of deal volume

VOLUME BREAKDOWN         Bucket       Deals   Realized
                         Client      296.09      56.76
                                └ CFD / Equity split: 56.76 / 0.00
                       Shifting        0.00       0.00
                       Internal     (value)    (value)
                └ Client’s Realized is the headline figure
```

**Corrected again the same evening: the breakdown lost two rows.** It carried a
`Realized` row and a `CFD / Equity split` row above the three buckets, and both
were the wrong shape for a table whose columns are Deals and Realized:

* Neither row *had* a Deals figure — Realized is not a deals metric, and a split
  of realized volume has no deals equivalent — and both filled that cell with
  `—`. In this project `—` means "could not read", so those two cells asserted a
  read failure that never happened, on a column that does not apply.
* The `Realized` row rendered `realizedTotal`, and so did the `Client` row two
  lines below it. The reader saw the same 59.66 twice in a five-row table, once
  labelled "Realized" and once as Client’s realized volume.

A friendlier placeholder would not have fixed either: `table.data` stacks a row
into a card on a phone, so any empty or apologetic cell renders as its label with
nothing real beneath it — the same reason the flow table’s total states `100%`.
So the shape changed instead. The breakdown now carries only buckets that have
**both** figures — Client, Shifting, Internal — and every cell in it is a real
number. The CFD / Equity split rides inside the Client card as a second
full-width `explain()` line, attached to the value it divides, keeping its own
sentence and both components readable.

Every row carries its one-line explanation as a fourth cell of the same row —
`table.data` stacks cells inside one card, so a full-width cell wraps under the
figures instead of opening a second striped row.

**The two tables stay two tables.** Merging them would reassert exactly the
sequence the morning's correction removed: Realized is the same deal flow counted
once per round trip, not a stage downstream of the deal total, and Internal is a
parallel bucket rather than a subset. Realized leads the breakdown — prominent,
and on the bucket axis where it belongs — and appears nowhere in the flow table.

**Realized was a stage until 2026-09-04, and that was wrong.** Rendered against
the live figures for 2026-09-02 the four-stage funnel narrowed to 30% and then
widened back to 72%:

| Stage | Lots | Share |
| --- | --- | --- |
| Total MT5 Deals | 497.10 | 100% |
| Realized | 149.70 | 30% |
| Bridge Lots | 356.84 | 72% ← wider than the stage above it |
| Matched Lots | 356.76 | 72% |

A funnel that widens asserts a sequence that does not exist. The cause is not the
drawing but the grouping: **Realized and the routing metrics are two different
axes.** Realized is not downstream of the deal total — it is the *same* deal flow
counted once per round trip instead of twice. Bridge and Matched are about where
that flow was *routed*: volume that reached the bridge, and the part of that which
paired with an LP order. Only the routing axis is a genuine funnel, and only it is
monotonically non-increasing.

The reference week hid this — 49% / 4% / 2% happens to fall — which is why the
defect survived the original tests. The regression guard therefore asserts
non-increasing shares against the 2026-09-02 figures specifically, and against
2026-09-03 as well, where the two lower shares differ by a tenth of a point and
so catch a reordering that equal shares would not. (It measured bar widths until
the bars were removed; it now reads the rendered share cells.)

Realized stays prominent: it is one of the two headline volume numbers and the
only one that reconciles with `ClientVolume/Run`. It is the **Client row’s
Realized value** — on the bucket axis, named as the headline figure both in that
row’s explanation and in the caption under the table. It is not a footnote and
it is not a step in the flow. (It had a headline row of its own until the evening
of 2026-09-04; that row duplicated this cell and dashed a Deals column that does
not apply to it.)

**Internal accounts are deliberately not a funnel stage.**
`totalInternalAccountLots` is a **parallel bucket, not a subset** of client lots
(`docs/dealing-reporting.md:133`). Drawing it inside the funnel would assert a
containment that does not hold. It belongs in the breakdown only.

**Realized mixes two units, and the section must say so.** Equity lots are
share-based: 98,126 equity against 1,400.60 CFD in one week. The backend itself
sums them — `totalRealizedLotsCfd + totalRealizedLotsEquity` equals
`ClientVolume/Run`'s `totalLots` exactly — so the combined figure is established
rather than invented. But the split is what makes it readable, which is why it is
rendered inside the Client row’s card, on the line below its Realized value.

### Rendering constraints

**Both tables are `table.data` built from `dataCell()`** — the one table
construction every shell in this repo already styles. Nothing in the section may
introduce markup of its own: no `<table role="presentation">`, no
`table-layout:fixed`, no class name that is not defined in all three shells.
`::before`, `::after`, flex and grid remain banned, as everywhere else in these
templates.

~~The bars are nested tables with fixed percentage widths and a background
colour.~~ **Removed 2026-09-04** — there are no bars.

A row whose value is unavailable shows `—` for both its lots and its share, and
keeps its place in the table. A genuine zero shows `0.00` and a real share.

The share column prints a whole-number percentage and carries the same share to
one decimal in a `data-share` attribute. The attribute exists for the
monotonicity guard, which used to measure bar widths: 87.9% and 87.8% both print
as 88%, so a test that could only read the printed text would miss an inversion
of less than a point.

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
4. **Percentages** are correct against the reference figures above (4% / 2%).
4b. **The flow table never widens.** Each row's share is ≤ the row above it,
   asserted on the 2026-09-02 figures, which is the day where a non-routing
   stage shows up as an inversion. Reinstating Realized as a stage must fail
   this. Realized itself must still render, with its total and its split, in
   the breakdown table and nowhere in the flow table — asserted structurally,
   not on caption wording, so a copy edit cannot break it.
5. **A zero or missing Total MT5 Deals** yields `—` for every percentage, never
   `NaN` or a division by zero.
6. **There are no bars.** No `role="presentation"`, no `table-layout:fixed`,
   no `vf-bar`, and both tables carry `class="data narrow"` — this is the
   regression that stopped the section rendering. An unavailable row still
   keeps its place, dashed on both axes.
7. **Internal lots appear in the breakdown and NOT as a flow row** — this
   exists so nobody later "completes" the funnel with them.
7b. **No cell dashes a figure that is present.** The converse of test 2, and the
   defect of 2026-09-04 evening: scan the rendered cells and assert `—` appears
   only where the underlying scalar is genuinely null. With it: the breakdown
   has exactly three body rows (Client, Shifting, Internal); `realizedTotal` is
   rendered exactly once in the whole section; and the CFD / Equity split is
   still there with both components readable.
8. **The Slippage report still sends when `DealMatch/Run` fails**, with the
   section marked unavailable and every existing slippage figure intact.
9. **No report gains an extra `DealMatch/Run` call.** Deal Match and Business
   Summary must make exactly the number they make today.
10. **The rendered HTML contains no `::before`, `::after`, flex, or grid**, and
   no table markup of its own beyond the two `table.data` tables.

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
deal lots because that is how the existing analysis frames the 2% figure. The
section says "of deal volume" beneath the percentages rather than implying a
strict subset relation. The 2026-09-04 correction above is this risk landing:
the stage that actually broke containment was Realized, which was assumed safe
because it is "the same volume" — and it is, on a different axis.

## Why the bars were removed (2026-09-04, afternoon)

**A real send did not render.** The reader opened that morning's Daily Digest on
his phone in Zoho and saw two headings — "MT5 Volume Funnel", the word
"Realized", and "Volume Breakdown" — with no figures under either. He asked for
the whole section as a table, and said plainly that a table is better than cards.

**The cause was the markup, not the client.** The flow rows and the Realized
headline were hand-rolled `<table role="presentation">` blocks held together by
inline `<td>` widths and `vf-*` / `vr-*` class names that **no shell stylesheet
defines**. The bars were nested tables inside those cells. The one part of the
section that rendered correctly was the Volume Breakdown — the one part already
built as `table.data` from `dataCell()`, the construction every other table in
every one of these reports uses and every shell styles.

So the section is rebuilt out of that construction alone, and the bars go with
it. Bars in email were always the fragile element: a bar is a nested table whose
only job is to be a shape, and shape is the first thing a mail client discards.
The information a bar carried is in the share column, which is text.

**Do not reintroduce them.** A bar here has failed for this reader once, on a
send he was actually reading. If a future change wants proportion shown visually,
it needs a fresh answer to "does this render in Zoho on Android", not a revival
of the nested-table bar.

The guards that keep this from regressing live in `reports/volumeSection.test.js`:
the section must contain no `role="presentation"`, no `table-layout:fixed` and no
`vf-bar`; both tables must carry `class="data narrow"`; and the flow table's
shares, read off the rendered cells, must never increase down the column.
