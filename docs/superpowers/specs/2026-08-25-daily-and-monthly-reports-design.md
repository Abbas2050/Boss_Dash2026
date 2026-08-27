# Daily digest and monthly review

**Date:** 2026-08-25
**Status:** approved, not yet implemented

## Problem

Three reports exist, all weekly: Business Summary, Deal Match and Slippage. Two
reporting rhythms are missing.

A week is too coarse to notice a bad day. A large withdrawal on Monday is visible
only the following Saturday, by which point it is history rather than something
to act on.

A week is also too fine to see a trend. Nothing in the current set answers "is
this month better than last", because every email compares a week to nothing.

## Scope

**One daily digest and one monthly review.** Not daily and monthly variants of
all three reports — that would put nine emails a week in front of the same
reader, and a daily Slippage report on a quiet day is a screen of zeros.

The daily is a **routine snapshot**, sent every morning whether or not anything
happened. The alternative — sending only when a threshold trips — was rejected
because silence is ambiguous: a quiet day and a dead scheduler look identical,
and this project has already had a scheduler fail silently for want of
configured recipients.

## Design

### Extract the engine from the weekly email

`reports/weeklyBusinessSummary.js` is 1,227 lines doing two separate jobs: a
reusable summary engine, and the weekly email built on it. The engine is already
period-agnostic — `aggregate(transactions)` takes transactions and nothing else,
and `attachClientNames`, `fetchEquityPosition`, `fetchClosingBalance`,
`topInstruments`, `findFirstTimeDepositors` and `dedupeById` are all exported.

The engine moves to `reports/summaryCore.js`. All three periods import from it.
Without this, the daily and monthly reports either import from a file named
"weekly" or duplicate its logic, and the second option guarantees the three
drift apart the way the tab and the email did over Net Revenue.

`weeklyBusinessSummary.js` keeps only what is weekly: the email body, the
schedule, and `runWeeklyBusinessSummary`.

### Period boundaries

`previousFullDayUtc(now)` and `previousFullMonthUtc(now)` sit beside the existing
`previousFullWeekUtc(now)` in `reportShared.js`, returning the same `{start, end}`
shape. Each excludes the period in progress, matching the weekly function.

### The daily digest

`reports/dailyDigest.js`. Sends **08:00 Asia/Dubai every day**, covering the
previous calendar day.

Every day, including weekends. The market is shut but deposits and withdrawals
are not, so a weekend email is quiet rather than empty — and a fixed daily cadence
keeps a missing email unambiguous.

Five sections, deliberately short, **no charts**:

| Section | Content |
| --- | --- |
| At a Glance | Net Flow, Deposits, Withdrawals, Total Revenue, Net Revenue, Lots |
| Closing Balance | the eight treasury cards |
| Large Deposits | yesterday only, same `SUMMARY_LARGE_DEPOSIT_THRESHOLD` as the weekly (default $1,000) |
| Top Instruments | yesterday only |
| Money Movement by PSP | yesterday only |

Charts are omitted on purpose. They cost render time on every send, and a single
day has no trend to draw. Closing Balance is included even though it is a
send-time snapshot rather than a daily figure — a daily email is the natural home
for it, and the section already carries that caveat in its heading.

### The monthly review

`reports/monthlyReview.js`. Sends **10:00 Asia/Dubai on the 1st**, covering the
previous calendar month.

Everything the weekly Business Summary carries, plus the two things only a month
can show:

- **Month-over-month comparison** on the headline figures — deposits,
  withdrawals, net flow, revenue, net revenue, lots — as a prior-month column and
  a percentage change, so each number is read against something.
- **Week-by-week breakdown** inside the month, one row per week, so a month that
  ends flat but fell through the middle does not read as steady.

Charts are worth their render cost here.

The month is fetched from `DealMatch/Run` in a single `lite=true` call. Verified
on 2026-08-25 against July: HTTP 200 in 43.1s, 127 clients, $325,643.91 gross,
374KB. This is the slowest operation either report performs and it sits inside
the existing 180s timeout. The Deal Performance tab splits its range by month
because it requests `lite=false`, which returns the heavy match arrays; the
reports do not need those.

### Configuration

Mirrors the weekly convention exactly, so an operator who knows one knows all:

```
DAILY_DIGEST_ENABLED=true
DAILY_DIGEST_CRON=0 8 * * *
DAILY_DIGEST_TIMEZONE=Asia/Dubai
DAILY_DIGEST_RUN_ON_START=false
DAILY_DIGEST_RECIPIENTS=

MONTHLY_REVIEW_ENABLED=true
MONTHLY_REVIEW_CRON=0 10 1 * *
MONTHLY_REVIEW_TIMEZONE=Asia/Dubai
MONTHLY_REVIEW_RUN_ON_START=false
MONTHLY_REVIEW_RECIPIENTS=
```

Each recipients variable falls back to `SUMMARY_ALERT_RECIPIENTS`, so the default
is the weekly audience and a separate list is opt-in. Both schedulers warn loudly
at boot when no recipients resolve — the failure that made the weekly summary
skip silently.

### The send guard

`alreadySentFor(reportKey, windowKey)` and `recordSentFor` need no change. The
daily passes the covered date as `windowKey`, the monthly passes `YYYY-MM`. This
is the protection that stopped duplicate sends when the app pool recycled
overnight, and it applies unchanged at both new cadences.

## Testing

Follows the existing report tests, which parse the rendered HTML rather than
booting anything.

1. **Period boundaries.** `previousFullDayUtc` and `previousFullMonthUtc` exclude
   the period in progress; month arithmetic is correct across a year boundary
   (1 Jan returns December) and for a 28-, 30- and 31-day month.
2. **The daily renders its five sections** and omits chart markup entirely.
3. **Month-over-month arithmetic**, including the cases that break naive percentage
   change: a prior month of zero, and a sign flip from negative to positive net
   flow.
4. **The week-by-week rows sum to the month total**, so the breakdown cannot
   silently disagree with the headline.
5. **Degradation.** Each section reports which source failed rather than rendering
   a plausible zero — the rule the existing reports already follow.
6. **No double-escaped HTML entities**, the guard the weekly report carries after
   `&ndash;` rendered literally.

## Risks

**The extraction touches the weekly report that sends this Saturday.** Moving the
engine to `summaryCore.js` changes a file with a live schedule. Merge and verify
it well before Saturday 10:00 UAE, or hold the whole change until after that
send.

**Email volume triples**, from three a week to ten. If the daily is not worth
opening it will train the reader to ignore all of them, including the weekly. The
daily is deliberately five short sections for this reason, and it is the part
most worth revisiting after a fortnight of real use.

**The monthly fires on the 1st**, which lands on a weekend twice a year. It sends
anyway; a month-end review is not time-critical to the hour.

## Out of scope

Daily or monthly variants of the Deal Match and Slippage reports. Alert
thresholds and exception-based sending. Any change to the three existing weekly
reports beyond the extraction described above.
