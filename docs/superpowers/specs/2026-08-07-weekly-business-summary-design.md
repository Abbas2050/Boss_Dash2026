# Weekly Business Summary report — design

**Status:** approved in brainstorming, not yet implemented
**Date:** 2026-08-07

A third weekly email covering money movement and account activity, with a
"last week at a glance" strip that also carries the trading headline. It is the
one email you read on a Monday; Deal Match and Slippage remain the drill-downs.

Background definitions, endpoint conventions and email rendering constraints
live in [`docs/dealing-reporting.md`](../../dealing-reporting.md). This spec
assumes them rather than repeating them.

---

## 1. Scope

**In scope**

- New standalone module `reports/weeklyBusinessSummary.js`.
- Scheduler, env config, an on-demand test route, and a third entry in the
  Settings → Alerts report picker.

**Explicitly out of scope**

- **The two existing reports are not modified.** The CRM helpers and the email
  shell are *added* to `reportShared.js` as new exports and used only by the new
  report. The existing two keep their private copies and are left alone, so
  there is zero risk to working code; they can be migrated onto the shared shell
  later, or never. New reports import from shared rather than hand-copying.
- The IB wallet-balance issue described in §7 is *reported* here, not fixed.

---

## 2. Report structure

### Section 1 — Week at a Glance (KPI strip)

| Tile | Source |
|---|---|
| Net Flow | this report |
| Deposits | this report |
| Withdrawals | this report |
| Total Revenue | `DealMatch/Run` |
| IB Rebate | this report |
| Net Revenue | Total Revenue less IB Rebate |
| Traded Lots (realized) | `ClientVolume/Run` |
| LP Slippage | `SlippageReport/Run` |
| Active Accounts | this report |

### Section 2 -- Account Activity

Every account that moved money during the week -- a client deposit, or IB
commission received. `Login | Name | Deposits | Withdrawals | IB Rebate | Net`,
largest deposit first, TOTAL row on top.

`Net = Deposits - Withdrawals - IB Rebate`, the same chain the Deal Match report
uses for `Total Revenue - IB Commission = Net Revenue`.

**Deposits and Withdrawals are client money only.** IB movements are held in
their own column and excluded from both. This is load-bearing, not cosmetic: an
`ib withdrawal` counted in Withdrawals *and* in IB Rebate would be deducted
twice, and the per-row Net would be wrong (observed: -$6,500 instead of -$1,375
for one IB account). The same split is applied to Sections 4 and 5 so every
level reconciles.

IB accounts appear even with no client deposit -- otherwise their rebate would
be absent from the report entirely. Such rows show $0 deposits and a negative
Net.

This section makes no claim about an account's history. It deliberately
replaced an earlier "New Funded Accounts" design -- see §10.

### Section 3 -- Large Depositors

The subset of Section 2 whose **client deposits exceeded the threshold**
(default $1,000). Same columns. An account funded only by IB commission does not
qualify, because an IB transfer is not a client deposit.

### Section 4 -- Daily flow + chart

`Day | Deposits | Withdrawals | IB Rebate | Net`, TOTAL row on top, followed by
grouped deposit/withdrawal bars with values drawn on them, rendered as a PNG and
published exactly as the Deal Match charts are (`publishChartImages`).

### Section 5 -- Money Movement by PSP

`PSP | Deposits | Withdrawals | IB Rebate | Net | Count`, TOTAL row first,
sorted by net descending. Rows with an empty `psp` group under `Unattributed`,
matching how the slippage report handles an empty `lpsid`. IB movements carry no
PSP, so they land in `Unattributed` -- which is why the IB Rebate column matters
here too.

Placed last: it is the reconciliation view, not the headline.

---

## 3. Data sources

### `POST /rest/transactions` — via `REST_PROXY_TARGET`

One call, scoped to the week by `processedAt`:

```jsonc
{ "processedAt": { "begin": "<from> 00:00:00", "end": "<to> 23:59:59" },
  "statuses": ["approved"],
  "segment": { "limit": 5000, "offset": 0 } }
```

Every section is derived from this single result set. The report makes no
historical lookups and does not use `userFtd` — see §10.

Fields consumed: `type`, `psp`, `processedAmount`, `requestedAmount`,
`processedCurrency`, `fromUserId`, `fromLoginSid`, `processedAt`, `status`.

### Read-only calls for the glance

- `DealMatch/Run` with **`lite=true`** — gross/net revenue.
- `ClientVolume/Run` — realized traded lots.
- `SlippageReport/Run` — total LP slippage.

Each figure is computed with the **same helper the source report uses**, so a
discrepancy can only ever come from timing, never from method.

---

## 4. Classification rules

**Direction.** A transaction is an outflow when its `type` contains the word
`withdrawal` (covers `withdrawal`, `ib withdrawal`, `cashback withdrawal`);
everything else counts as an inflow. Chosen over an explicit allow-list because
the CRM doc enumerates withdrawal types but not deposit types, and the live
system already uses at least one type absent from the doc
(`ib transfer to account`).

**Amounts.** Use `processedAmount`, falling back to `requestedAmount`, and
always take `Math.abs()`. Direction comes from the type, never from the sign.
This is the trap that previously made Net Revenue exceed Total Revenue.

**Statuses.** `approved` only by default, configurable. Pending, fresh and
cancelled are excluded from every figure.

**Currency.** Figures are summed as reported. If more than one
`processedCurrency` appears in the week the footer says so rather than silently
adding different currencies together. Multi-currency normalisation is out of
scope.

---

## 5. Configuration

| Env var | Default |
|---|---|
| `WEEKLY_SUMMARY_ENABLED` | `true` |
| `WEEKLY_SUMMARY_CRON` | `45 20 * * 5` |
| `WEEKLY_SUMMARY_TIMEZONE` | `Asia/Dubai` |
| `WEEKLY_SUMMARY_RUN_ON_START` | `false` |
| `SUMMARY_ALERT_RECIPIENTS` | — |
| `SUMMARY_LARGE_DEPOSIT_THRESHOLD` | `1000` |
| `SUMMARY_TX_STATUSES` | `approved` |

**Schedule rationale.** 20:45 Dubai on Friday — deliberately *after* Deal Match
(20:00) and Slippage (20:30), so the glance is never computed before the reports
it summarises. Same `previousFullWeekUtc()` window as both, so all three
describe an identical period.

---

## 6. Wiring

- `startWeeklyBusinessSummaryScheduler()` registered in `server.js` alongside the
  other two.
- `POST /api/reports/summary-weekly/test` — admin-only, recipients in the body,
  mirroring the existing test routes and reusing `parseTestRecipients()`.
- A third entry in the `WEEKLY_REPORTS` array in
  `src/pages/settings/AlertsSettingsPage.tsx`, so the report is selectable in
  the existing picker. Its `summary()` returns the PSP count.

---

## 7. IB Rebate, and a known issue in the other report

This report computes **IB Rebate from the week's own transactions**: the
approved `ib transfer to account` and `ib withdrawal` rows already fetched for
money movement, summed as magnitudes. Net Revenue = Total Revenue less that
figure. Because it reads settled transactions inside a closed window, it does
not move between runs, and it costs no extra API calls.

`dealMatchWeeklyReport.js` answers the same question differently:
`getIbWalletUsdBalance()` returns the **current** IB wallet balance and adds it
to the period's transactions, so IB commission for a *closed* week changes every
time that report runs -- the observed cause of Net Revenue rendering as
$64,432.87, $64,411.27 and $64,351.67 for the same week on different runs.

**The two reports can therefore disagree on IB commission.** That is stated in
this report's footer rather than hidden. The underlying question -- whether a
closed week's commission should use the balance as at week end rather than
today's -- belongs to the Deal Match report and needs its own decision.

Note also that IB movements are counted inside Deposits and Withdrawals as
well. IB Rebate is a cross-cutting view of the same money, not a third bucket;
adding it to either total would double count. The footer says so.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Deposit `type` strings are not fully documented | Classify by the `withdrawal` substring; the footer lists **every distinct type and psp seen**, so the first send reveals the real vocabulary |
| `psp` may be null on some rows | Grouped as `Unattributed` and counted, so it is visible rather than silently dropped |
| 5000-row segment cap | If a call returns exactly the cap, the footer flags the report as truncated rather than under-reporting silently |
| A source endpoint is down | Each glance figure is fetched in its own `try`; a failure renders that tile as `—` and the report still sends. Money movement is the only hard dependency |
| Currency mixing | Detected and disclosed (§4) |

---

## 9. Testing

- Render the email from the real template with fixture data and assert every
  section is present, following the pattern already used for the other two
  reports (no `node_modules` here, so the shared deps are shimmed).
- Assert the direction classifier: `withdrawal`, `ib withdrawal`,
  `cashback withdrawal` are outflows; `deposit` and
  `ib transfer to account` are inflows.
- Assert `Math.abs()` handling with deliberately negative `processedAmount`.
- Assert net flow equals deposits minus withdrawals, and that the PSP table
  TOTAL matches the KPI tiles.
- Assert graceful degradation: a thrown glance fetch renders `—` and still sends.
- Verify the layout at 375px and desktop, per the constraints in
  `docs/dealing-reporting.md`.

---

## 10. Decisions and open questions

### Why there is no "first-time depositor" section

The original design had a **New Funded Accounts** section built on the CRM's
`userFtd` flag, whose only documentation is *"Transaction list by first time
deposit"*. That reads two ways:

* this transaction **is** a first-ever deposit, or
* any transaction of a user **who has** an FTD (i.e. any funded client).

The two produce very different lists, and the difference is invisible until a
reader recognises a long-standing client sitting under a "first ever deposit"
heading — which is exactly what happened during review. The flag could not be
settled against live data (the `/rest` proxy requires an authenticated session).

Rather than infer account history from an ambiguous flag, the report now counts
**what actually happened during the week**: every account that deposited, with
its deposit total, withdrawal total, net, and deposit count. No claim about an
account's history is made, so none can be wrong.

If a genuine first-time-depositor breakdown is wanted later, it needs a real
first-deposit determination — an unbounded historical lookup per candidate
login, concurrency-limited — not the `userFtd` flag.

### Open questions

None blocking. Two to confirm from the first real send:

1. The actual deposit `type` vocabulary (the footer will report it).
2. Whether `psp` is populated consistently, or whether `pspId` is the more
   reliable grouping key.
