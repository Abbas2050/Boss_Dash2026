# Swaps: report page and the exclude-from-swaps flag

**Date:** 2026-08-31
**Status:** approved, not yet implemented
**References:** `temporay_for_reference_pages/swaps-report.html`, `lp-manager 5.html`, `internal-accounts 1.html`

## Problem

Swap charges are invisible in this dashboard. There is no per-client or per-LP
swap total anywhere, and no way to mark an account as excluded from swap
reporting the way it can already be excluded from equity, positions, history and
deal matching.

This is group A of four covering the reference-page batch. The others — Client
Account Monitor, the API admin pages, and Finalto — are separate specs.

## Scope

One feature across three surfaces:

1. **Swaps Report** — a new Dealing tab: per-client and per-LP swap totals.
2. **LP Manager** — an `Exclude Swaps` column, plus the field in the create and
   edit forms.
3. **Internal Accounts** — the same column, plus a `Swaps` checkbox in the bulk
   toolbar alongside the existing Equity / Positions / Profiling / Deal Matching
   ones.

They ship together because they are one flag: a report that totals swaps is
meaningless without the ability to exclude an account from it.

## The unverifiable part, stated plainly

**Neither endpoint exists yet, and there is no staging server.** Verified
2026-08-31:

```
GET /api/SwapsReport            -> 404
GET /api/LpAccount              -> 200, but no excludeFromSwaps on any of 44 rows
```

The backend team will deploy once this work is done. So every field name and
response shape below is taken from the reference HTML and **cannot be confirmed
until deployment**.

That is a real risk, and this project has already been bitten by it: the
Revenue Share reference page implied `/History/aggregate` returned a bare array;
the live endpoint returned `{items: [...]}`. Building on a wrong assumption
produced an empty table with no error at all.

**The mitigation is to fail loudly.** Every response is unwrapped through a
function that throws a descriptive error naming the endpoint and the keys
actually present, exactly as `unwrapItems` does in `src/lib/revenueShareApi.ts`.
A shape mismatch on deploy day must produce a message that says what arrived,
not an empty grid.

## Design

### Swaps Report

`GET /api/SwapsReport?from=<unix>&to=<unix>` is expected to return:

```
{
  clients:      [ { login, name,   source, totalSwap, dealVolume, realizedVolume } ],
  clientTotals: { totalSwap, accountCount },
  lps:          [ { login, lpName, source, totalSwap, dealVolume, realizedVolume } ],
  lpTotals:     { totalSwap, accountCount }
}
```

Two tables on one page, each with its own totals line, over a shared date range —
the same control layout as the Revenue Share tab, which users have just learned.

`from`/`to` are unix seconds via the existing `toUnixRange`. The client grid keys
on `name`, the LP grid on `lpName`; that is the only difference between them.

**The totals come from the response, not from summing the rows.** The backend
sends `clientTotals` and `lpTotals`; recomputing them here would create a second
answer to "what did we pay in swaps", which is the mistake the Revenue Share page
exists not to repeat. If a total is absent the row is rendered as unavailable,
not as a sum this page invented.

Mounted as a Dealing tab at `?tab=swaps-report`. That means an entry in
`DEALING_MENU_QUERY_MAP`, a render branch, **and** an entry in `DEALING_TABS` in
`src/lib/permissions.ts` — the nav list and the permission list both come from
that array, and a tab missing from it renders for an instant and then redirects
away.

### The exclude-from-swaps flag

`excludeFromSwaps` is a boolean on an LP account, mirroring the four flags
already present: `excludeFromEquity`, `excludeFromPositions`,
`excludeFromHistory`, `excludeFromDealMatching`. It follows their existing
handling exactly — the same column style, the same form control, the same place
in the payload sent to `POST /api/LpAccount` and `PUT /api/LpAccount/{id}`.

**LP Manager** (`src/pages/settings/LPManagerPage.tsx`) gains the column and the
field in both the create and edit forms.

**Internal Accounts** gains the same column, and a `Swaps` checkbox in the bulk
toolbar which posts through the existing `/api/lpaccount/bulk-update` alongside
the other surfaces.

Because the field does not exist upstream yet, the UI must treat a missing
`excludeFromSwaps` as `false` rather than rendering it blank — an account is
included in swap reporting unless someone says otherwise.

## Testing

Pure functions and source parsing, matching how this repo already tests.

1. **Shape handling.** The swaps unwrapper returns the rows for a well-formed
   payload, returns `[]` for a legitimately empty `clients`/`lps` array, and
   **throws** naming the endpoint and the keys present for anything else —
   including a bare array, `null`, and an error object.
2. **Totals are never invented.** A test asserts the page does not sum
   `totalSwap` across rows to produce the totals line.
3. **A missing total renders as unavailable**, not as `$0.00`.
4. **A missing `excludeFromSwaps` reads as `false`**, and a present `true` round
   trips through the form payload unchanged.
5. **Tab registration.** The existing `src/lib/dealingTabs.test.ts` invariant —
   every label in `DEALING_MENU_QUERY_MAP` exists in `DEALING_TABS` — covers the
   new tab automatically and will fail if only one of the two is added.

## Risks

**Every field name here is unverified.** If the deployed response differs, the
page fails loudly rather than silently, but it still fails. Budget for a
correction pass on deploy day rather than treating this as finished.

**The two grids are near-identical.** The temptation is one generic grid
parameterised by a name field. That is worth resisting only if the two diverge
later; for now a shared column factory taking the label of the name column keeps
them honest without duplicating nine column definitions twice.

**Adding a tab needs three edits in two files.** Missing the `DEALING_TABS` entry
produces a tab that mounts and then redirects — the failure already hit once on
this project. The existing invariant test catches it.

## Out of scope

Client Account Monitor, the API admin pages, and Finalto — separate specs in this
batch. The home-page tiles, whose source file was not provided. Any change to how
swaps are calculated: this reports what the backend returns.
