# Dealing reporting — definitions, endpoints, and gotchas

Working notes for the Slippage and Deal Match tabs and their weekly emails.
Everything below was verified against the live API on 2026-07-27 / 2026-08-02,
or is quoted from the reference pages in `temporay_for_reference_pages/`.

---

## 1. The lot metrics (and why two "totals" disagree)

There is no single "lots" number. The backend reports several, and they measure
different things. This is the source of most "the numbers don't reconcile"
questions.

| Metric | Field(s) | Meaning |
|---|---|---|
| **Deal lots** | `totalMt5DealLots` + `totalShiftingMt5DealLots` | Every MT5 deal. A round trip is **two** deals (open + close), so this roughly doubles realized. |
| **Realized lots** | `totalRealizedLotsCfd` + `totalRealizedLotsEquity` | The closed position, counted **once**. |
| **Bridge lots** | `totalBridgeLots` | Volume that reached the Centroid bridge to be hedged. |
| **Matched lots** | `totalMatchedLots` | Of the bridged volume, what actually paired with an LP order. |
| **Internal lots** | `totalInternalAccountLots` | Internal accounts. A **separate bucket** — see §4. |

### Verified identities (20–26 Jul 2026)

```
sum(clientRevenueSummaries[].lots)          = 203,109.22
totalMt5DealLots + totalShiftingMt5DealLots = 203,109.22   ← exact
totalRealizedLotsCfd + totalRealizedLotsEquity = 99,526.60
ClientVolume/Run  →  totalLots                 = 99,526.60  ← exact
```

So:

- The Deal Match **client revenue table sums DEAL lots**.
- `ClientVolume/Run` (and the dashboard's *Dealing (LP) → Client Volume* tile)
  reports **REALIZED lots**.
- Ratio observed: **2.036** (13–19 Jul) and **2.032** (20–26 Jul). Consistent
  across weeks, so it is definitional, not a bug. The residual above 2.00 is
  presumably partial closes / positions carried across the week boundary —
  unconfirmed, and only the `api.skylinkscapital.com` owner can settle it.

### Scale check worth remembering

For 20–26 Jul: **~4,300 matched lots out of ~203,000 deal lots** — roughly 2% of
flow is hedged externally. Almost all the rest is equity. Any statement like
"we traded 203k lots and only made $40k" is missing that context.

### Equity lots are not FX lots

Equity 98,126 vs CFD 1,400.60 for the same week. Equity lots appear to be
share-based, so summing the two produces a number dominated by equity. Treat
"total lots" across instrument classes with care.

---

## 2. Endpoints

All on `BACKEND_BASE_URL` (default `https://api.skylinkscapital.com`).

### `GET /DealMatch/Run`

| Param | Notes |
|---|---|
| `group` | `*` for all |
| `from`, `to` | **Unix seconds** |
| `symbol` | empty for all |
| `lite` | see below |

**`lite=true` returns KPIs + revenue-by-client + revenue-by-LP.**
**`lite=false` additionally returns every match row — ~45 MB for a month.**

The weekly email only reads `clientRevenueSummaries` and the `total*` scalars,
so it uses `lite=true`. Do not switch it back to `lite=false` "to be safe" —
that was the old behaviour and it downloaded tens of MB it then discarded.

Confirmed present under `lite=true`: `clientRevenueSummaries`, `totalMt5DealLots`,
`totalShiftingMt5DealLots`, `totalRealizedLotsCfd`, `totalRealizedLotsEquity`,
`totalMatchedLots`, `totalBridgeLots`, `totalInternalAccountLots`,
`internalAccountBreakdown`.

### `GET /DealMatch/ClientRevenueDetail?login=<login>`

Per-client LP allocation detail. Fetched on row click.

### `GET /ClientVolume/Run`

| Param | Notes |
|---|---|
| `from`, `to` | **`YYYY-MM-DD` strings** — note the format differs from DealMatch |
| `group` | `*` for all |

Returns `totalLots`, `totalStocksLots`, `totalCfdLots`, and `byDate[]`.

> **Open question:** it returned **6 days for a 7-day week** (25 Jul missing for
> 20–26 Jul). Fine if Saturday has no trading; a dropped day otherwise. Worth
> confirming with the backend owner.

### `GET /SlippageReport/Run`

Params `from`, `to` (`YYYY-MM-DD`), `group`, optional `symbol`, `login`.
Returns `rows`, `internalRows`, `rowCount`, `fromDate`, `toDate`.

---

## 3. Slippage column definitions

Quoted from `temporay_for_reference_pages/slippage-report 1.html`, which is
**newer than the React tab was** — it carried a column the tab lacked.

- **`clientPlImpact` — "Client Slippage USD"**
  Pure execution slip vs the marked-up client quote:
  `(ext_bid − avg_price) × side × units × conv`. Excludes MT5 broker markup.
  Reconciles with Centroid bridge *"Order Slippage Broker"* (col 29).

- **`clientCostUsd` — "Client Cost USD"**
  Total client cost above the LP market price = `Client Slippage USD − MT5
  markup revenue`. Reconciles with Centroid bridge *"Client Order Slippage Ext"*
  (col 33). **The same $ also appears as broker revenue in Deal Matching
  MT5 Markup / Gross — that is correct ledger accounting, not a double-count.**

Sign convention throughout: **positive = favourable (gain), negative = adverse.**
KPI "cost per lot" flips the sign for display.

---

## 4. Internal accounts

- The **Slippage** report returns them separately in `internalRows` and excludes
  them from KPIs, the By-LP rollup, and the detail totals.
- In **Deal Match**, internal logins do **not** appear in
  `clientRevenueSummaries` — verified: 0 of 4 internal logins overlap. So the
  weekly revenue email is not contaminated by internal flow.
- `totalInternalAccountLots` is therefore a parallel bucket, not a subset of the
  reported client lots.

---

## 5. Revenue formulas

```
Total Revenue = (Markup + Client Comm) − LP Comm
Net Revenue   = (Markup + Client Comm) − (LP Comm + Rebate Withdrawn)
```

Rebate Withdrawn is the IB commission actually withdrawn or transferred out
during the reporting week — it excludes the running IB wallet balance. The
Deal Match Client Revenue Table is grouped one row per CRM client, not per
MT5 account; a client with several MT5 accounts is rolled up into a single row.

Three things the weekly email gets wrong if you are not careful — all previously
fixed, all verified against the Deal Performance tab:

1. **LP commission may arrive signed-negative.** Take `Math.abs()` before
   subtracting, or the minus sign flips a cost into revenue.
2. **IB transfers/withdrawals may arrive signed-negative.** Sum magnitudes.
   Without this, IB commission goes negative and **Net Revenue exceeds Total
   Revenue**, which is impossible. (Observed: Total $40,490.37 / Net $46,510.97.)
3. **Do NOT use the backend's `totalRevenueUsd`.** For 13–19 Jul it sums to
   63,405.11 while the Deal Performance tab shows **65,571.75**, which is
   `markup + clientComm − lpComm`. Recompute; do not trust that field.

IB commission itself is computed in this repo (CRM wallet balance + approved IB
transfers/withdrawals), so it is the one revenue input that is auditable here.

---

## 6. Email rendering constraints (hard-won, do not "clean up")

- **Zoho strips `@media` entirely.** Verified from both directions in
  production: a `max-width` query did not fire on a phone, and a `min-width`
  query did not fire on desktop. One layout must therefore serve both screens.
  The data tables are real tables by default, inside a horizontally scrollable
  wrapper so a phone swipes rather than crushing the columns.
- **Mail clients strip CSS pseudo-elements.** Row labels must be real DOM text
  (`<span class="lbl">`), never `td:before { content: attr(data-label) }`.
- **`box-sizing: border-box`** on the layout wrappers, or `width:100%` plus
  padding overflows the viewport.
- **TOTAL rows sit at the top of `<tbody>`**, not in `<tfoot>` — `<tfoot>`
  always renders at the bottom regardless of source order, and the headline
  figures should not require scrolling past every client.
- **Brevo's transactional API ignores `cid:`.** Inline images must be fetched
  over HTTPS; see §7. Attaching a PNG and referencing `cid:name` produces a
  plain attachment.
- Numeric cells use `white-space: nowrap`. A figure broken mid-value
  (`51,/90/0.0/0`) is worse than no table at all.

---

## 7. Chart images in the weekly emails

Charts render to PNG via `chartjs-node-canvas`, are written to disk, and are
referenced by URL from the email body.

- `publishChartImages()` in `reports/reportShared.js` writes them under a
  128-bit random folder and returns absolute URLs.
- Served by `GET /report-charts/:token/:name` in `server.js`. Token must match
  `^[a-f0-9]{32}$`, filename must be a plain `.png`, plus a path-resolve check.
  Nothing is listable.
- **The URLs are unauthenticated** — they have to be, because a mail client
  fetches images with no session. Unguessable, but anyone with the link can view
  that chart.
- Storage directory resolution order: `REPORT_CHART_DIR` → `<app>/storage/
  report-charts` → OS temp. The site root is **not writable** under Plesk/IIS
  (`EPERM ... mkdir 'C:\Inetpub\vhosts\app.skylinkscapital.com\httpdocs\storage'`),
  which is why the fallback exists. Setting `REPORT_CHART_DIR` to a folder the
  app pool owns is the durable fix — the temp folder can be cleaned by the OS
  while an old email is still being read.
- If rendering fails the email falls back to CSS bar charts rather than shipping
  broken images, and prints the reason in the footer.

---

## 8. Reference pages

`temporay_for_reference_pages/slippage-report 1.html` and
`deal-matching 7.html` are the standalone SLC dashboard pages. When the React
tabs and these disagree, **the reference pages are newer** — they carried
`clientCostUsd` and the whole MT5-volume KPI block before the tabs did.
