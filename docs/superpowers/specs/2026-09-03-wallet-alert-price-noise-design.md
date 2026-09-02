# Wallet balance alert: stop emailing on price movement

**Date:** 2026-09-03
**Status:** approved, not yet implemented

## Problem

The `[WALLET] Closing Balance` email fires when no money has moved.

The most recent send was triggered by `LetKnow Pay $191.37 (+$0.05)`. Nobody
deposited or withdrew five cents. The ETH price moved.

This is a regression introduced on 2026-09-03 by commit `06ba6b4`, which taught
LetKnow Pay and Bitpace to price their non-dollar holdings from a live spot
rate. Before that change LetKnow Pay was frozen at `$184.46` and never drifted;
its ETH was simply excluded from the total. Now the row is marked to market, so
its USD value changes continuously while the holding itself sits still.

The alert asks **"did the dollar value change?"**. What it is meant to ask is
**"did money move in or out?"**. A price move separates those two questions for
the first time.

### Scale of the noise

`on-change` mode polls every 5 minutes (`wallet/scheduler.js:445`). LetKnow Pay
holds `0.00288773 ETH`. At an ETH price near $2,358 a **$17 move** — routine
inside five minutes — shifts the row by $0.05 and clears the one-cent
comparison. The alert can therefore fire many times a day on a completely
static wallet.

### A second, larger false alarm this also fixes

If the rate lookup fails, ETH falls out of `valued` and back into `unvalued`,
and LetKnow Pay's balance drops by the **entire $6.81** rather than a few cents.
Today that sends an email reporting a loss that did not happen.

This is not hypothetical. Binance is very likely returning HTTP 451 to the
production server (US-hosted), leaving Coinbase as the only working source, so
a single-source outage is a live possibility. Any fix that only silences *small*
changes leaves this one intact.

## Which providers are actually affected

Only providers that mark holdings to market can drift, and only two do —
`bitpace` and `letknowpay`, the two that call `withUsdRates()`
(`wallet/pspClients.js:355` and `:514`).

| Provider | Can drift without money moving? | Why |
| --- | --- | --- |
| `letknowpay` | **yes** | holds ETH, priced from live spot |
| `bitpace` | **yes** | same pricing path |
| `ownbit`, `ownbitnew` | no | USDT TRC20, held at 1:1 |
| `heropayment` | no | provider supplies its own USD figures |
| `googlesheets_*` (6 rows) | no | sheet cells; change only when a human edits one |

The noise is therefore **narrow and new**, not general dust across eleven
providers.

### Why not a dollar threshold

A threshold high enough to silence ETH drift would also silence genuine small
movements everywhere else, including deliberate Google Sheets edits. It is a
number with no defensible value: too low and the noise returns, too high and
real deposits vanish. It also leaves the $6.81 rate-failure alarm untouched,
since that is large enough to clear any sane threshold.

Comparing holdings needs no tuned constant and targets the actual cause. A
threshold can be added later if real dust appears; this design deliberately
does not include one.

## Design

**Compare what is held, not what it is worth.**

### Where the change goes

`filterIgnoredChangeItems()` (`wallet/scheduler.js:142`) already exists to drop
one class of noise: a PSP dropping to exactly `$0` on an API failure and
recovering afterwards. Price movement is a second noise class and belongs at the
same seam.

The send decision keeps its current shape. One precondition is added: **a change
explained entirely by price is not a change.**

This is deliberately layered rather than a rewrite of the trigger. The snapshot
hash, the channel dedupe, and the existing "Total Combined must have changed"
gate all keep working exactly as they do today; a price-only movement is
recognised and dropped in the same place the API-failure noise already is,
returning `status: 'ignored'`.

### Recording holdings in the snapshot

`extractSnapshot()` (`wallet/scheduler.js:78`) currently stores one rounded USD
number per provider. It gains a second, parallel record: each provider's
**currency map** — for LetKnow Pay,
`{USD: 130.95, USDC: 53.498525, ETH: 0.00288773, USDCSOL: 0.001932, USDTTRC20: 0.006487}`.

Two rules govern it:

**Amounts are rounded to 8 decimal places, not to cents.** `roundMoney()` would
flatten `0.00288773 ETH` to `0.00`, making every crypto holding look identical
and defeating the comparison entirely.

**A provider with no currency breakdown keeps comparing USD.** The six Google
Sheets rows publish `currencies: {}`, because a sheet cell is a dollar figure
with no composition. They must keep alerting on any change — a Gold Souq edit is
a deliberate human action and is exactly what the alert is for.

### The rule

A change item is dropped as price noise when **all** of the following hold:

1. it is a provider row, not `total_balance`;
2. both snapshots record a currency map for that provider, and the two maps are
   identical;
3. neither side is a transition to or from zero (that case is already owned by
   the existing API-failure filter and must keep its current behaviour).

`total_balance` is dropped when its entire delta is explained by the provider
rows that were themselves dropped — the same accounting the existing filter
already performs for API noise.

If no change items survive, nothing is sent and the run returns
`status: 'ignored'`, exactly as it does when API noise is filtered.

### What does not change

The email and Telegram message are **untouched**. They still show market value
and USD deltas. Only the decision to send stops caring about price.

Real movements behave exactly as today: a 0.001 ETH deposit changes the currency
map and alerts, however small its dollar value. A Google Sheets edit alerts. An
API failure is still absorbed by the existing filter. The "Total Combined must
have changed" gate is preserved unmodified and still runs after this new filter.

## State migration

`storage/` holds a saved state whose `lastSnapshot` predates this change and has
no currency maps.

Without a deliberate migration, the first poll after deploy compares a snapshot
that has holdings against one that does not, cannot prove any change is
price-only, and emails a change list naming providers nobody touched.

**An unrecognised snapshot shape re-baselines silently:** the new snapshot is
written to state, no notification is sent, and the next poll compares two
snapshots of the same shape. The cost is at most one missed alert inside the
restart window; the alternative is a guaranteed spurious email on every deploy.

`sanitizeState()` (`wallet/scheduler.js:195`) recognises a valid hash by
searching the string for `"total_balance"` and `"widgets"`. Both keys survive
this change, so that guard keeps working — but it must be covered by a test,
because a future rename of either key would silently reset the channel dedupe
and re-send the last alert.

## Testing

Pure functions over fixtures, matching how `wallet/` already tests. No network.

1. **The reported bug.** LetKnow Pay `$191.32 → $191.37` with an identical
   currency map produces no notification.
2. **The rate-failure alarm.** ETH moving from `valued` to `unvalued` — a
   `-$6.81` swing with an unchanged currency map — produces no notification.
3. **A real crypto deposit alerts.** ETH `0.00288773 → 0.00388773` sends, even
   though it is worth about $2.
4. **A real dollar deposit alerts.** USD `130.95 → 500.00` sends.
5. **Sheet providers are unaffected.** Gold Souq `$50,694.96 → $50,000.00`, with
   no currency map on either side, still sends.
6. **The existing API-failure filter still works.** A provider dropping to `$0`
   and recovering is still absorbed, and still by that filter.
7. **Mixed case.** A price-only drift on LetKnow Pay *and* a genuine Gold Souq
   edit in the same poll sends, and the email lists only Gold Souq.
8. **Total accounting.** `total_balance` is dropped when its delta is fully
   explained by dropped provider rows, and kept when it is not.
9. **Migration.** An old-shape `lastSnapshot` re-baselines and sends nothing.
10. **Precision.** A crypto amount is stored at full precision, not rounded to
    cents — `0.00288773` and `0.00388773` must not compare equal.
11. **`sanitizeState` guard.** A current-shape snapshot hash is still recognised
    as valid.

Every test must be shown to fail against the unfixed code or a deliberate
mutation. Tests 1, 3 and 9 are the ones that most easily pass for the wrong
reason and must be proven by mutation.

## Risks

**A silenced real event.** If a provider ever reports a changed dollar value
while reporting an unchanged currency map, this filter hides it. That would mean
the provider's own breakdown disagreed with its own total — worth knowing about,
but the currency map is the more trustworthy of the two, since the total is the
derived figure.

**The re-baseline window.** One poll cycle after each deploy cannot detect
change. Accepted, and preferable to a spurious email every restart.

## Out of scope

A dollar threshold. Any change to the email or Telegram templates. Any change to
the poll cadence, the `daily` mode, or which providers are tracked. Changing how
holdings are priced.
