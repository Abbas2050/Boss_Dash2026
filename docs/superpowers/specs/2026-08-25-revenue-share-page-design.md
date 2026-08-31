# Revenue Share Calculation page

**Date:** 2026-08-25
**Status:** approved, not yet implemented
**Reference:** `temporay_for_reference_pages/history 4.html` ("SLC - History & Revenue Share")

## Problem

Nothing in the dashboard shows what each LP is owed under its revenue-share
agreement. The figure exists — the backend computes it — but the only place to
read it is the reference page on `api.skylinkscapital.com`, which is not part of
this dashboard and is not where either department works.

Two departments need it: **dealing**, who watch LP P/L daily, and **accounts**,
who settle against it.

## Scope

One page, mounted in two places. Three views over a shared date range:
revenue-share aggregate, per-LP deal detail, per-LP volume.

Not in scope: computing the revenue share (see below), editing NTP rates, or any
of the other reference pages in the same batch.

## Design

### We display the revenue share; we do not compute it

`realLpPL`, `ntpPercent` and `lpPL` all arrive from `/History/aggregate`. The
arithmetic is visible in the live payload:

```
B2B Coverage account (101487)
  realLpPL     1,196,755.75
  ntpPercent            20
  lpPL           239,351.15     = realLpPL x 20%
```

Reimplementing that here would create a second source of truth for a number that
decides what LPs are paid. This project already has one such split — the Deal
Match tab and the weekly email disagreed on Net Revenue for weeks because each
recomputed it. The page renders the backend's figures and nothing else.

### One component, two mounts

`src/pages/departments/dealing/RevenueShareTab.tsx` holds the whole page. It is
mounted twice:

- **Dealing** — a tab. Add `"revenue-share": "Revenue Share"` to
  `DEALING_MENU_QUERY_MAP` (`DealingDepartmentPage.tsx:74`), giving
  `/departments/dealing?tab=revenue-share`. Identical to the ten existing tabs;
  the URL is already the single source of truth for the active tab.
- **Accounts** — a section. `AccountsDepartment` (960 lines,
  `src/components/dashboard/AccountsDepartment.tsx`) has **no tab structure**: it
  is a scrolling page of live panels. The component is mounted as another such
  panel rather than bolting a tab bar onto a page that has never had one.

One implementation, so the two departments cannot drift apart.

### The three views

A single date range drives all three. Views switch without refetching the others.

| View | Endpoint | Shape |
| --- | --- | --- |
| Revenue Share | `GET /History/aggregate?from=&to=` | object; rows under `.items`, plus `totals` |
| Deals | `GET /History/deals?login=&from=&to=` | object; rows under `.deals` |
| Volume | `GET /History/volume?from=&to=` | object; rows under `.items` |

**Every one of the three nests its rows.** An earlier draft of this spec called
the first and third "bare arrays" — that was wrong, and it came from a probe
script whose `d.items || d.rows || d.data` fallback unwrapped `.items` before
the shape was ever inspected. Verified directly on 2026-08-25:
`GET /History/aggregate` answers `{items, totals, fromTimestamp, toTimestamp}`.
A helper that returns `[]` for a non-array payload renders an empty table with
no error, which is why unwrapping must fail loudly instead.

`POST /History/aggregate` with `{from, to, overrides}` returns the same shape and
additionally accepts per-LP date overrides. The reference page uses POST for
that reason. This page uses GET; overrides are out of scope.

`from`/`to` are unix seconds. All three verified live on 2026-08-25 against
1-24 Aug: HTTP 200, 9 rows each, under 1s.

`/History/deals` answers `{login, lpName, fromTimestamp, toTimestamp,
totalDeals, deals[]}` — its rows are under `deals`, not `items`, so the three
endpoints do not share one unwrap key.

**Revenue Share columns** (all confirmed present in the live payload):
`lpName`, `login`, `source`, `effectiveFrom`, `startEquity`, `endEquity`,
`credit`, `deposit`, `withdrawal`, `netDeposits`, `grossProfit`,
`totalCommission`, `totalSwap`, `netPL`, `realLpPL`, `ntpPercent`, `lpPL`.

`lpPL` is the answer the page exists to give and is styled as the result:
emphasised, coloured by sign.

**An LP on 0% is hidden**, unless it is an error row. The reference page does
this (`if (!item.isError && item.ntpPercent === 0) return;`) and it is correct:
an LP with no revenue-share agreement has no revenue share to report, and a
screen of 0.00 rows buries the ones that matter. Nothing in the sampled data is
currently on 0%, so this will not be visible until one is.

**Volume columns** (confirmed): `lpName`, `login`, `source`, `tradeCount`,
`totalLots`, `notionalUsd`, `volumeYards`.

**Deal columns** are taken from the reference page and are **not verified against
a live payload** — every `/History/deals` response sampled had `deals: []`. The
implementer must confirm the field names against a non-empty response before
trusting them: `dealTicket`, `symbol`, `timeString`, `direction`, `entry`,
`volume`, `price`, `contractSize`, `marketValue`, `profit`, `commission`, `fee`,
`swap`, `lpCommission`, `lpCommPerLot`.

### Error rows

Every aggregate and volume row carries `isError` and `errorMessage`. A row that
failed renders its message in place of its figures, not zeros. A zero in a
revenue-share table is a number someone may act on; an error is not.

### The Deals view needs an LP first

It cannot load until an LP is chosen, so it opens with a prompt and an LP
selector populated from the aggregate rows, rather than firing a request for
nothing. Selecting an LP loads that LP's deals for the same date range.

### Reuse

`SortableTable` as every other tab uses, `BACKEND_BASE_URL` from
`src/lib/backendBase.ts`, and the money/number formatters already in the dealing
tabs. Requests carry `authHeaders()` by convention, matching every other tab.

Note that nothing enforces this here: `src/lib/apiAuthHeaders.test.ts` only scans
paths under `/api` and `/rest`, and `/History/*` is neither. The header is
harmless to the backend and keeps the tab consistent with its siblings, but a
future omission will not fail the suite.

## Testing

Follows the existing tab tests, which exercise pure functions rather than
rendering.

1. **The deals response is unwrapped correctly** — rows come from `.deals`, and
   an object with no `deals` key yields an empty list rather than throwing.
2. **Error rows are surfaced** — a row with `isError: true` renders its
   `errorMessage`, and its numeric cells do not render as `0.00`.
3. **The revenue-share identity holds on the rendered row** — given
   `realLpPL` and `ntpPercent`, the displayed `lpPL` is the backend's value, not
   a recomputation. A test asserts the component does not multiply.
4. **The date range converts to unix seconds** at both bounds, with `to`
   inclusive of the whole day.
5. **An empty range renders "no rows"** rather than an error — July 2026 legitimately
   returns 0 LPs because the aggregate is scoped by revenue-share periods
   (`effectiveFrom`/`effectiveTo`), not merely by the date range.

## Risks

**The aggregate is period-scoped, not date-scoped.** 1-24 Aug returns 9 LPs;
1 Jul-24 Aug returns 0. A user picking a wide range and seeing nothing will read
it as a bug. The empty state must say the range matched no revenue-share period,
not "no data".

**Deal column names are unverified.** If they are wrong the grid renders blank
columns rather than failing, which is the quiet kind of wrong. Verify against a
non-empty response first.

**Accounts placement is a judgement call.** `AccountsDepartment` is a 960-line
component with 25 hooks; adding a panel to it is low-risk, but it is already
large enough that a further section is worth reviewing rather than assuming.

## Out of scope

The other ten reference pages in this batch. Five of them are blocked on backend
endpoints that currently return 404 — `/api/SwapsReport`,
`/api/ClientAccountMonitor`, `/api/admin/api-clients`, `/api/admin/vendor-urls`,
and the `excludeFromSwaps` field, which is absent from `/api/LpAccount`. The two
Finalto pages return 401, so their backend exists and they are buildable
separately.
