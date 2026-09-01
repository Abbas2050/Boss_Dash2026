# Excess Funds cards on the Accounts page

**Date:** 2026-09-01
**Status:** approved, not yet implemented
**Source:** handwritten note, 2026-09-01

## Problem

Nothing in the dashboard answers "how much money do we actually have spare".

The terms exist — LP and client equity, crypto balances, the bank rails — but they
are scattered across two cards on two different pages, and two of them (FAB
Operating and FAB Holding) are not in the system at all. Anyone wanting the
figure adds it up by hand.

## Scope

One new **Excess Funds** section on `/departments/accounts`, carrying nine cards:
the seven inputs, then the two figures they produce.

```
Gross Excess Fund = netDifference + Net Crypto + (FAB + MBME) + Gold Souq

Net Excess Fund   = Gross Excess Fund + FAB Operating + FAB Holding
```

Not in scope: changing any existing figure on the page, and any use of these
numbers in the email reports.

## The seven inputs and where they come from

| Card | Value | Source |
| --- | --- | --- |
| Net LP Equity | `lps.netWithdrawableEquity` | `EquityOverview/dashboard` |
| Net Client Equity | `clients.netWithdrawableEquity` | same call |
| Net Crypto | sum of the `group: 'crypto'` PSPs | `/api/closing-balance-report` |
| Net FAB & MBME | `fabTotal + mbme` | same |
| Gold Souq | `googlesheets_goldsouq` | same |
| FAB Operating Balance | `fabOperating` | **new workbook** |
| FAB Holding Balance | `fabHolding` | **new workbook** |

The crypto count is **derived** from `CRYPTO_PSP_COUNT`, never written as a
literal. A hardcoded `cryptoCount = 7` previously mis-grouped the rows, and
`AccountsDepartment.tsx:159` carries the comment saying so.

`fabTotal` is already `fabAed + fabUsd` (`wallet/pspClients.js:428`) — the same
figure the existing "FAB Bank" row shows. MBME is added to it because the note
groups the two in one box; the card is labelled "Net FAB & MBME" so the
combination is visible rather than implied.

### The subtraction is the backend's, not ours

The note writes the first term as `Net LP Equity − Net Client Equity`. The
backend already publishes exactly that as `netDifference`. Verified live on
2026-09-01:

```
lps.netWithdrawableEquity      3,275,567.91
clients.netWithdrawableEquity  4,465,937.54
netDifference                 -1,190,369.63
lp - cl                       -1,190,369.63   identical
```

**Use `netDifference`.** Subtracting the two tiles ourselves would create a
second answer to a question the backend already answers — the mistake that left
the Deal Match tab and the weekly email disagreeing about Net Revenue for weeks.

Note the sign: that term is **negative** today, so Gross Excess Fund will
normally be negative too. Cards colour by sign, and no label may imply the figure
is always a surplus.

### Equity is not currently fetched on this page

`fetchEquityOverviewDashboard()` runs inside `AccountsDepartment.tsx`, but only
when `isLpMode` is true — that is the home page's "Dealing (LP)" card. The
Accounts page renders the same component with `mode` unset and never makes the
call. Enabling it here is a real change, not a re-render.

## The new workbook

**A completely separate spreadsheet**, unrelated to the existing wallet workbook.
Nothing about its structure may be assumed from the current one: not its tab
naming, not its column, not its layout.

It gets its own client (`wallet/fabAccountsSheet.js`), its own spreadsheet ID in
its own environment variable, and its own failure path. It must not share a code
path with `wallet/pspClients.js` — a change to one workbook's layout must not be
able to break the other's read.

Every locating detail is **configuration, not code**: spreadsheet ID, tab, and
the two cell addresses. The existing mapping file carries *three* generations of
cell addresses (`DEFAULT_`, `PRE_OWNBIT_NEW_`, `LEGACY_GOOGLE_SHEETS_FIELDS`)
because someone inserting a row silently shifted every reference. The new
workbook has the same failure mode and gets the same treatment from the start.

**Its ID, tab name and cell addresses are not known yet.** The implementer builds
against this contract and treats any mismatch as a loud failure naming the sheet
and cell, never as a zero:

```
GET /api/fab-accounts

{
  "fabOperating": 1234567.89,
  "fabHolding":   987654.32,
  "fetchedAt":    "2026-09-01T06:00:00Z",
  "source":       { "spreadsheetId": "...", "tab": "...", "cells": { "fabOperating": "B4", "fabHolding": "B5" } }
}
```

`source` is echoed back so a wrong figure can be traced to the cell it came from
without opening the server. Both balances are USD. A response missing either key,
or carrying a non-numeric value, throws naming the keys that did arrive — it does
not default to zero.

The route reads the spreadsheet ID from `FAB_ACCOUNTS_SHEET_ID` and the tab and
cell addresses from the same JSON-config mechanism the existing mapping uses, so
a row inserted in the sheet is fixed by editing config rather than shipping code.

## Partial data shows nothing

Three sources feed this section and each can fail on its own.

**If any term is missing, the figure that needs it renders "unavailable" — never
a sum of the terms that did arrive.** A treasury figure quietly missing a
million dollars of crypto is worse than no figure at all, and every report in
this project already follows this rule.

Gross Excess Fund needs five terms; Net Excess Fund needs all seven. So Gross can
be available while Net is not, and that is the expected state on any day the new
workbook is unreachable. Each unavailable card names the source that failed.

An input card whose own source failed shows the same way. Zero is a real balance
and must never be used to mean "we could not read this".

## Two figures that will disagree, deliberately

The page already carries `lpPlusPspDifference` (`AccountsDepartment.tsx:591`):

```js
netDifference + metrics.totalBalance + cryptoReceivable + bankReceivable + lpDepositsTotal
```

Both it and Gross Excess Fund start from `netDifference` and both read as "spare
cash", but they differ in two ways: the existing figure counts **every** PSP and
adds receivables and the to-LP amounts; Gross Excess Fund counts **only** crypto,
FAB, MBME and Gold Souq, and adds neither.

Both stay. That is a deliberate decision, so each carries a note stating what it
includes. Two unexplained numbers answering one question is how a page stops
being trusted.

## Design

### Files

| File | Responsibility |
| --- | --- |
| `src/lib/excessFunds.ts` (create) | `computeExcessFunds(inputs)` — pure, no fetching. Returns each figure or an explicit unavailable-with-reason. |
| `src/lib/excessFundsApi.ts` (create) | Fetches the new workbook's two values. Throws naming the endpoint and the keys present, as `revenueShareApi.ts` does. |
| `src/components/dashboard/ExcessFundsSection.tsx` (create) | The nine cards. |
| `src/components/dashboard/AccountsDepartment.tsx` (modify) | Un-gate the equity fetch for non-LP mode; mount the section. |
| `wallet/fabAccountsSheet.js` (create) | The second workbook client, isolated. |
| `server.js` (modify) | One route serving the two values. |

`AccountsDepartment.tsx` is 964 lines. The section is its own component rather
than a tenth of that file.

### The computation is pure and separate from fetching

`computeExcessFunds` takes the seven values — each a number or `null` — and
returns both figures plus, for an unavailable figure, which inputs were missing.
It performs no I/O, so every degradation case is testable without a network.

## Testing

Pure functions and rendered output, matching how this repo already tests.

1. **Both formulas** against known inputs, including the live figures above.
2. **A negative result** renders as negative and is not clamped or relabelled.
3. **Every single-missing-input case** — seven of them — yields unavailable for
   the figures that need it, and *not* for the figure that does not. A missing
   FAB Operating leaves Gross Excess Fund intact and only kills Net.
4. **A zero input is a value, not a gap** — a genuine 0.00 balance produces a
   number, not "unavailable".
5. **The two figures are allowed to differ.** Given inputs where
   `lpPlusPspDifference` and Gross Excess Fund disagree, both render their own
   value. This exists so nobody later "reconciles" them into one.
6. **The new workbook's response shape is validated** — a payload missing
   `fabOperating` or `fabHolding` throws naming what arrived, rather than
   yielding zeros.

## Risks

**The new workbook is entirely unverified.** No ID, no tab name, no cell
addresses, and no confirmation the service account can read it. This is the same
position the Swaps work was in: build to a stated contract, fail loudly on
mismatch, and budget a correction pass for the day the real sheet appears. It
cannot be tested end to end before then.

**Enabling the equity fetch on the Accounts page adds a call** that page does not
make today, to an endpoint that already serves the home page. Low risk, but it is
a new dependency for a page that currently renders without it — so the section
must degrade rather than block the rest of the page.

**Two similar figures on one page** is a comprehension risk that notes mitigate
but do not remove. Worth revisiting after real use.

## Out of scope

Any change to `lpPlusPspDifference` or to the existing closing-balance tiles.
Using these figures in the daily, weekly or monthly emails. Reading anything from
the new workbook beyond the two FAB balances.
