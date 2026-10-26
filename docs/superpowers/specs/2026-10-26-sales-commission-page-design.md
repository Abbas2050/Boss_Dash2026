# Sales department page — commission at $1 per lot

**Date:** 2026-10-26
**Status:** approved, not yet implemented

A new department page at `/departments/sales` showing what each salesperson has
earned in commission, and — for Abbas and Daniel only — what the company earned
from the clients that commission was paid on.

Three salespeople, identified by their FXBO **manager id**:

| Manager id | Name |
|---|---|
| 28 | Mitul Kapadia |
| 23 | Aditya |
| 20 | Smit |

A client belongs to a salesperson when that client's `managerId` is theirs.
Commission is **$1 per lot** traded by those clients in the selected period.

---

## The decisions, and why

### 1. "Lot" means a realized CFD/FX lot

There is no single lots figure. `docs/dealing-reporting.md` §1 documents several
that disagree enormously. For one verified week (20–26 Jul 2026), whole book:

| Metric | Lots | At $1/lot |
|---|---|---|
| Deal lots (`totalMt5DealLots + totalShiftingMt5DealLots`) | 203,109 | $203,109 |
| Realized lots, all classes | 99,527 | $99,527 |
| ↳ equity (share-based) | 98,126 | — |
| ↳ **CFD/FX** | **1,401** | **$1,401** |

A 145× spread. Deal lots count a round trip **twice**; equity "lots" are
share-based and not comparable to a 100k-unit FX lot, and they dominate the
total by ~70×.

**Commission is paid on realized CFD/FX lots only** — closed positions, counted
once, equity excluded. A client who trades only shares therefore earns their
salesperson no commission. That is deliberate and should be said out loud to the
sales team, because it is the one consequence of this choice that will surprise
them.

### 2. Live view over a chosen date range

The page recalculates on demand from the live API and stores nothing, matching
the other department pages. Default range: the current month.

The cost: a past month's figure can move if the backend restates, so **this page
is not a payroll record**. If commission is ever disputed, freezing closed
months is the follow-up — deliberately not built now, because the numbers have
not yet been checked against reality.

### 3. "What we earn" is Total Revenue

`totalRevenueUsd` from the client revenue row: markup + client commission +
swap − LP commission. It is the backend's own figure, carried on the row at no
extra cost.

**Net Revenue (after IB rebate) is deliberately not used.** It needs a CRM
lookup per client, and it is the exact figure `docs/dealing-reporting.md` §5
records being got wrong twice — once double-charging a client with two accounts,
$8,646 billed as $17,292. IB rebate is also a different channel's cost, not this
salesperson's.

### 4. Visibility is enforced on the server, not in the UI

Roles and `access[]` live in `localStorage` (`src/lib/auth.ts`), so a UI filter
is a tidiness feature and not a confidentiality boundary: a salesperson can edit
their own role, and the `/api` proxy serves any client's data to any logged-in
browser.

The server already verifies a JWT (`auth/router.js`, `requireSession` gating
`/api` and `/rest`), so real enforcement is available and is what this uses.
**Data a user may not see is never sent to their browser.**

---

## Data flow

**Four** fetches, joined on **MT5 login**, all performed server-side.

| # | Source | Gives |
|---|---|---|
| 1 | FXBO `/rest/users`, filtered `managerIds: [28, 23, 20]` | which CRM clients belong to which salesperson |
| 2 | FXBO `/rest/accounts`, batched by client id | **the MT5 logins** — `/rest/users` does not carry them |
| 3 | `GET /ClientVolume/Run?from&to&group=*` → `byClient[]` | `cfdLots` per login — **the commission basis** |
| 4 | `GET /DealMatch/Run?from&to&lite=true` → `clientRevenueSummaries[]` | `totalRevenueUsd` per client — what we earned |

**Corrected 2026-10-26 during implementation.** This section originally said
`/rest/users` returned the logins and that there were three fetches. It does
not: `User` carries `{id, managerId, country, city, firstName, lastName,
middleName, email, secondaryEmail, referrer, phone}` and no login. Logins live
on `/rest/accounts`, which `reports/dealMatchWeeklyReport.js:88` already uses
for exactly this resolution. Without that second call there is no join key and
every commission would be zero.

Two further corrections from the same pass:

- **`DealMatch/Run` needs a window and `lite=true`.** Called without one it
  returns the whole history. It takes **Unix seconds** while `ClientVolume/Run`
  takes `YYYY-MM-DD` — the formats genuinely differ (`dealing-reporting.md` §2).
- **The two windows may not be the same window.** ClientVolume's dates are
  documented as MT5 **server-local**; DealMatch's are UTC. The same date pair in
  can mean slightly different periods out. It cannot affect anyone's pay —
  commission is ClientVolume-only — but a Super Admin's revenue column may cover
  a marginally different period from the lots beside it. Not resolvable from
  this repo.

`/rest/users`' `managerIds` filter is **unverified** — it is not in the typed
request shape, and the only `managerIds` elsewhere in the codebase is on a
ticket search. It is sent *and* the returned rows are re-filtered by
`managerId`, so an ignored filter makes the call expensive, never wrong. **Worth
confirming against the live CRM before go-live.**

`ByClientRow` carries `login`, `name`, `group`, `lots`, `stocksLots`, `cfdLots`.
A single call returns every client, so there is **no per-client fan-out**.

Roll multiple MT5 logins up to one CRM client, then group by manager.

```
commission(salesperson) = Σ cfdLots(their clients, in range) × $1
```

### Two risks to settle before anyone is paid from this

**The DealMatch join key.** `docs/dealing-reporting.md` §5 says the client
revenue table is "grouped one row per CRM client, not per MT5 account", yet the
row carries a `login`. Which login a multi-account client reports is unverified.
**Verify against real data before trusting the revenue column**; the commission
column does not depend on it.

**Load time.** `DealMatch/Run` costs ~40 s regardless of range. Expect a ~45 s
page load with a progress state, as on other heavy pages.

---

## Access model

A new field, `crmManagerId`, on the dashboard user record
(`AuthUser`, `src/lib/auth.ts`), set in User Management. Email matching was
rejected: it breaks silently the day someone's address changes.

New route: `GET /api/sales/commission?from&to`. It resolves the caller from the
verified JWT and returns only what they may see.

| Caller | Receives |
|---|---|
| User with a `crmManagerId` | their own clients, lots, commission. No other salesperson. **No revenue fields at all.** |
| Abbas / Daniel (Super Admin) | all three salespeople, plus revenue and margin after commission |

A user with neither a `crmManagerId` nor the elevated permission gets the
existing `UnauthorizedPage`.

### What the page renders

**Salesperson:** their clients — name, lots, commission — and a total.

**Abbas / Daniel:** the three salespeople side by side — lots, commission owed,
revenue earned, margin after commission — each expandable to per-client rows.

---

## Out of scope

- Freezing closed months into an immutable payout record (see §2)
- Net Revenue / IB rebate per client (see §3)
- Any change to how commission is actually paid — this page reports, it does
  not disburse
- Tiered or per-symbol commission rates; the rate is a flat $1/lot
