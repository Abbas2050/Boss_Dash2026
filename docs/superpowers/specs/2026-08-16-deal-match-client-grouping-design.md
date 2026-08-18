# Deal Match: group revenue by client, report rebate as withdrawn — design

**Status:** implemented
**Date:** 2026-08-16
**Touches:** `reports/dealMatchWeeklyReport.js` only

The Client Revenue Table currently has one row per MT5 account. It should have
one row per CRM client, and its IB column should report commission **withdrawn**
during the week rather than the balance sitting in the IB wallet.

Background definitions and endpoint conventions live in
[`docs/dealing-reporting.md`](../../dealing-reporting.md).

---

## 1. Why

**Clients hold several trading accounts.** In the week of 8–14 Aug the table had
73 rows, and 10 of those clients held more than one account:

| client | accounts |
|---|---|
| Mian Ali Khalid | 4 |
| Traders Hub Currency Brokerage | 3 |
| Nitesh Kumar, Dawei Huang, Milways Gold, Shahid Amin, Inter-Skylinks, RAFMOH GOLD, and two others | 2 each |

One person spread across four rows is hard to read, and it caused a real
arithmetic fault: IB commission was looked up per CRM user but cached per login,
so a client's whole commission was charged to **each** of their accounts. Dawei
Huang's $8,646 was billed as $17,292; Mian Ali Khalid would have been charged
four times over.

That double count is already fixed (commit `cfd9f02`) by splitting the figure
across a client's rows in proportion to lots. But the split is an invention: the
CRM does not attribute commission to a trading account, and IB commission is
earned from the volume of the people that IB **referred**, not from the IB's own
trading. Weighting by the IB's own lots reads as meaningful when it is not.
Grouping by client removes the need to split at all.

**The wallet balance was never a weekly cost.** The previous figure added
`getIbWalletUsdBalance()`, the accumulated and still-unpaid IB wallet balance
read at the instant the report ran. $8,000 of Dawei's $8,646 was balance. It
dwarfed the $467.50 of revenue it was subtracted from and made the same closed
week produce a different Net Revenue on every run.

---

## 2. Scope

**In scope:** the Client Revenue Table in the Deal Match weekly email, and the
IB commission lookup that feeds it. The same grouping is applied to
`getWeeklyDealMatchDataset()` so the two cannot diverge.

**Out of scope:** the Slippage report, the Business Summary, the volume
sections, and the Deal Match charts. Chart inputs are derived from the same row
set, so they follow the grouping without separate work.

---

## 3. Grouping

Rows from `clientRevenueSummaries[]` are grouped by **CRM user id**, resolved
from the MT5 login with `POST /rest/accounts { login }` — the lookup
`attachIbCommissions()` already performs, so no new endpoint is introduced.

Summed per client: `lots`, `markup`, `clientComm`, `lpComm`, `totalRev`.

The client's name is taken from the account with the most lots, so the choice is
deterministic rather than dependent on the order the API happened to return.
Accounts are listed in ascending login order.

**A login that does not resolve to a CRM user remains its own row**, identified
by its login, with a rebate of `$0.00`. Merging it would mean inventing a
relationship the CRM does not assert. The count is reported in the footer.

---

## 4. Table

```
Client | Accounts | Lots | Markup | Client Comm | LP Comm | Total Rev | Rebate Withdrawn | Net Revenue
```

`Accounts` lists the logins that rolled up, e.g. `102244, 102233`, so any row
can be reconciled back to individual accounts.

Nine cells at the 156px inline-block width wrap onto two lines on a desktop and
stack on a phone. Nothing scrolls horizontally — see the layout note in
`reportShared.js` about Zoho stripping `overscroll-behavior` and `touch-action`.

Sort order is unchanged: lots descending.

---

## 5. Rebate semantics

```
Rebate Withdrawn = sum of magnitudes of approved
                   "ib transfer to account" and "ib withdrawal"
                   settled inside the reporting week,
                   one lookup per CRM client

Net Revenue      = (Markup + Client Comm) - (LP Comm + Rebate Withdrawn)
```

The wallet balance is not included and `getIbWalletUsdBalance()` is deleted.

**The column is named "Rebate Withdrawn", not "IB Commission",** because the
figure is cash that left the IB wallet during the week and may have been earned
in an earlier week — an IB can accumulate commission for a month and withdraw it
on one day. The footer states this in plain words.

Net Revenue continues to subtract it. That mixes an accrual figure (trading
revenue earned this week) with a cash figure (commission withdrawn this week);
the decision was taken deliberately in favour of one simple number, with the
column label carrying the warning.

This also makes Deal Match agree with the Weekly Business Summary, which has
always counted the week's settled IB transactions.

---

## 6. Failure handling

Nothing here may pass a failure off as a real number.

| condition | row shows | reported in footer |
|---|---|---|
| CRM user lookup fails for a login | that login as its own row, rebate `$0.00` | count of unresolved logins |
| IB transaction lookup fails for a client | rebate `$0.00` | count of clients affected, stating Net Revenue is overstated |
| Client is not an IB | rebate `$0.00` | nothing — this is the normal case |

A zero rebate **understates** the cost and therefore **overstates** Net Revenue,
which is why both failure modes are named rather than left to look like genuine
zeroes.

---

## 7. Testing

Verified against fixtures that mirror the live data:

1. Dawei Huang's two logins merge into one row of 3.86 lots with the rebate
   counted once, not twice.
2. Mian Ali Khalid's four accounts collapse into a single row.
3. A login with no CRM user stays a separate row and is counted.
4. A failed IB lookup yields `$0.00` and is counted for the footer.
5. A non-IB client is charged nothing and costs no transaction lookup.
6. Column totals equal the sum of the client rows, and per-client lots equal the
   sum of the accounts that rolled up.
7. One IB check and at most one transaction lookup per client, never per login.

---

## 8. Open items

`getWeeklyDealMatchDataset()` has no callers anywhere in the repository. It is
kept in step with the email path so the two cannot drift, but it may be dead
code worth removing separately.
