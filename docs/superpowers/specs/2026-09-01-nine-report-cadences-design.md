# Nine report cadences: every report daily, weekly and monthly

**Date:** 2026-09-01
**Status:** approved, not yet implemented
**Supersedes the scope decision in:** `2026-08-25-daily-and-monthly-reports-design.md`

## Problem

Three reports exist — Business Summary, Slippage and Deal Matching — and until
yesterday all three were weekly only. Yesterday's work added a daily digest and
a monthly review, both built on the Business Summary alone.

That was a deliberate narrowing. The earlier spec rejected daily and monthly
variants of all three on the grounds that nine emails a week in front of one
reader trains them to ignore all of them.

**That decision is reversed.** Slippage and Deal Matching answer questions the
Business Summary does not — execution quality and revenue by client — and both
are wanted at all three rhythms. This spec covers the six variants that do not
yet exist and the schedule the full set of nine runs on.

## Scope

Nine scheduled sends: three reports × three cadences.

No new email bodies. `runWeeklySlippageEmailReport` and
`runWeeklyDealMatchEmailReport` already take `{ fromDate, toDate }` — "weekly"
is only their name, their default period and their schedule. A cadence is
therefore a schedule, a period function, a send-guard key and one word of copy.

Not in scope: any change to what the three reports compute, and month-over-month
comparison for the Slippage and Deal Matching monthlies.

## The schedule

| | 07:00 | 07:30 | 08:00 | 09:00 | 09:30 | 10:00 | 11:00 | 11:30 | 12:00 |
|---|---|---|---|---|---|---|---|---|---|
| **Daily** — Tue–Sat, covers the previous day | Deal Match | Slippage | Business ✓ | | | | | | |
| **Weekly** — Sat, covers Sat–Fri | | | | Deal Match ✓ | Slippage ✓ | Business ✓ | | | |
| **Monthly** — 1st, covers the previous month | | | | | | | Deal Match | Slippage | Business ✓ |

✓ = already implemented and live. All times Asia/Dubai.

### Why Tue–Sat

The daily runs on the five days whose previous day was a trading day:

```
Mon  no send   (would cover Sunday)
Tue  covers Mon
Wed  covers Tue
Thu  covers Wed
Fri  covers Thu
Sat  covers Fri
Sun  no send   (would cover Saturday)
```

Cron `2-6` in the day-of-week field. Every trading day gets exactly one daily,
and nothing fires for a market that was shut — a Slippage or Deal Matching
report for a Sunday is a screen of zeros.

This differs from the Business Summary daily as built yesterday, which sends all
seven days on the reasoning that deposits and withdrawals continue at weekends.
It moves to Tue–Sat with the other two: one rule for all three dailies is worth
more than two days of weekend money movement, which the weekly still reports.

### Why that ordering

Deal Match, then Slippage, then Business Summary — at every cadence. This is
inherited, not invented: the Business Summary's At a Glance strip computes Total
Revenue from `DealMatch/Run`, so it must never run before the Deal Match report
it summarises. The existing weeklies are staggered 09:00 / 09:30 / 10:00 for
exactly that reason.

### Why the monthlies move to 11:00

The Business Summary monthly currently fires at `0 10 1 * *` and the weekly at
`0 10 * * 6`. **When the 1st falls on a Saturday, both fire in the same minute** —
two Business Summary runs racing, each making its own 40-second `DealMatch/Run`
call. 1 August 2026 was a Saturday, so this is a live fault, not a hypothetical.

Placing the monthlies after the weeklies removes every collision. A Saturday
that is also the 1st then runs nine sends cleanly across five hours. The next
monthly is Thursday 1 October, so the move costs nothing.

### Saturday carries six

Saturday is both a daily day (covering Friday) and the weekly day, and the
weekly period Sat–Fri already contains that Friday. Friday therefore appears
twice: alone in the daily, and inside the week. That is different granularity
rather than a contradiction, and it is the only arrangement in which every
trading day gets its own daily. Eighteen emails a week, six on a Saturday, nine
on a Saturday that is also the 1st. Accepted deliberately.

## Design

### One scheduler, declared nine times

Every scheduler in `reports/` is the same 45 lines: read an enabled flag, read a
cron expression, validate it, `cron.schedule`, log the registration, shout if no
recipients resolve, optionally run on start. There are five copies today.

That block moves to `startReportScheduler(config)` in `reportShared.js`, and all
nine schedulers become entries in one table:

```
{ label, cronVar, defaultCron, enabledVar, timezoneVar, runOnStartVar,
  recipientVars: [own, fallback], run }
```

The three existing weekly schedulers are retrofitted onto it. Adding four more
copies of the block instead would put six near-identical schedulers in the
codebase, and near-identical code drifts — that is how the Deal Match tab and
the weekly email came to disagree about Net Revenue for weeks.

The factory owns the boot-time warning that made the weekly summary skip
silently for want of configured recipients. One implementation means it cannot
be forgotten in the ninth scheduler.

### Period plumbing

Each `run*` function already accepts `{ fromDate, toDate }`. The daily and
monthly variants call the same function with a different period, from
`previousFullDayUtc` and `previousFullMonthUtc` — both added yesterday and
already used by the two live schedulers.

Email copy takes a `periodNoun` parameter, exactly as `buildSummaryEmailHtml`
did yesterday. Three user-visible sites in Slippage, eight in Deal Matching.

**Two of the Business Summary's footer lines were plain strings, so an added
interpolation rendered as literal `${periodNoun}` text.** JavaScript will not
catch this and neither will the type checker. The byte-identity check below is
what caught it, and it must be run for both files here.

### Send guard

`alreadySentFor(reportKey, windowKey)` needs no change; it takes an arbitrary
key. Nine distinct keys:

| Report | Daily | Weekly | Monthly |
| --- | --- | --- | --- |
| Business Summary | `daily` | `summary` | `monthly` |
| Slippage | `slippage-daily` | `slippage` | `slippage-monthly` |
| Deal Matching | `dealmatch-daily` | `dealmatch` | `dealmatch-monthly` |

The Business Summary's two are unprefixed and inconsistent with the rest. They
stay that way: they were recorded against real sends on 1 September, and
renaming them would let those two sends repeat on the next app-pool restart.

Window keys follow what each cadence already uses — the covered date for daily,
`from..to` for weekly, `YYYY-MM` for monthly.

### Configuration

New variables follow the existing convention exactly, so an operator who knows
one knows all:

```
DAILY_DEALMATCH_ENABLED / _CRON / _TIMEZONE / _RUN_ON_START / _RECIPIENTS
DAILY_SLIPPAGE_...
MONTHLY_DEALMATCH_...
MONTHLY_SLIPPAGE_...
```

Each `_RECIPIENTS` falls back to that report's existing list —
`DEALMATCH_ALERT_RECIPIENTS`, `SLIPPAGE_ALERT_RECIPIENTS`. **The six new sends
therefore work the moment they deploy, with no environment changes.** A separate
list per cadence is opt-in.

The Business Summary daily's cron default changes from `0 8 * * *` to
`0 8 * * 2-6`, and the monthly's from `0 10 1 * *` to `0 12 1 * *`.

### Test-send routes

Two more admin-only routes mirroring the existing four, so August's Slippage and
Deal Matching monthlies can be sent by hand once deployed:

```
POST /api/reports/slippage-monthly/test
POST /api/reports/dealmatch-monthly/test
```

Same contract as every other test route: body recipients only, no environment
fallback, so a green test send never implies the scheduled one has anywhere to
go. They accept an explicit `from`/`to` so a past period can be sent.

## Testing

1. **One table over all nine schedulers.** Each resolves the expected cron
   expression, timezone, guard key and recipient fallback chain. A tenth report
   added without a table entry fails the count assertion.
2. **The retrofit changes nothing.** Each of the three weekly emails renders
   byte-identical, by sha256 over a fixed fixture, before and after. This is the
   check that caught the literal-`${periodNoun}` bug twice yesterday; it is the
   single most important test here because these three send live.
3. **The daily fires Tue–Sat and no other day**, computed by walking a calendar
   rather than asserted by hand, and each fire covers the previous weekday.
4. **No two schedulers share a minute**, computed across a year — the check that
   would have caught the 10:00 Saturday-the-1st collision.
5. **Period wording.** A one-day Slippage email says "day" and a month-long one
   says "month"; neither says "week".
6. **No double-escaped HTML entities**, the guard both other reports carry.
7. **Nine distinct guard keys**, asserted as a set, so a copy-paste that reuses
   `slippage` for the daily fails rather than silently suppressing a send.

## Risks

**The retrofit touches three live send paths.** All three send Saturday 5
September; there are four days of margin, and the byte-identity test is the
guard. Merge and verify well before Saturday 10:00 UAE.

**Email volume triples again**, from ten a week to eighteen. Six land on a
Saturday morning. If the set is not worth opening it will train the reader to
ignore all of them, including the weekly. Worth revisiting after a fortnight of
real use; it is easier to switch a cadence off than to notice it is being
ignored.

**`DealMatch/Run` costs ~40 seconds regardless of window size** — measured
2026-08-31: one day 41.8s, one month 40.4s. Three dailies each morning is about
two minutes of backend work, which is fine, but no cadence should ever be
implemented by splitting a range into per-day calls.

**The Business Summary daily changes from seven days to five.** Weekend deposits
and withdrawals will no longer appear in any daily. They remain in the weekly
and the monthly.

## Out of scope

Month-over-month comparison for the Slippage and Deal Matching monthlies. A
week-by-week breakdown for anything other than the Business Summary monthly. Any
change to how slippage, deal matching or revenue are calculated: this spec
changes when reports are sent and over what period, nothing else.
