# Nine Report Cadences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send all three reports — Business Summary, Slippage and Deal Matching — at three cadences each, from one scheduler implementation rather than nine copies.

**Architecture:** A `CADENCES` table and a `startReportScheduler` factory move the shared scheduler block into `reportShared.js`. Each report's `run*` function gains a `cadence` parameter that selects its period function, guard key, recipient variables and subject wording. A single nine-row table in a new `reports/schedulers.js` declares every scheduled send, and `server.js` starts them all with one call.

**Tech Stack:** Node 20+ ESM, Express, node-cron, vitest. No new dependencies.

## Global Constraints

- **Timezone is `Asia/Dubai` for every scheduler.** No DST.
- **Daily cron day-of-week field is `2-6`** (Tuesday–Saturday). Every daily covers the previous UTC day.
- **Scheduler order at every cadence: Deal Match, then Slippage, then Business Summary.** The Business Summary's At a Glance computes Total Revenue from `DealMatch/Run` and must never run first.
- **Exact schedules.** Daily `0 7 * * 2-6` / `30 7 * * 2-6` / `0 8 * * 2-6`. Weekly `0 9 * * 6` / `30 9 * * 6` / `0 10 * * 6`. Monthly `0 11 1 * *` / `30 11 1 * *` / `0 12 1 * *`.
- **No two schedulers may share a minute on any date.**
- **The nine send-guard keys, verbatim:** `daily`, `summary`, `monthly`, `slippage-daily`, `slippage`, `slippage-monthly`, `dealmatch-daily`, `dealmatch`, `dealmatch-monthly`. The Business Summary's three are deliberately inconsistent with the rest — they were recorded against real sends on 1 September 2026 and renaming them would let those sends repeat on the next app-pool restart.
- **The three weekly emails must render byte-identical before and after every change**, proven by sha256 over a fixed fixture. They send live every Saturday.
- **Every new `_RECIPIENTS` variable falls back to that report's existing list**, so the six new sends work with no environment changes.
- **`process.env` is read at call time, never captured at module scope**, so tests can set it.
- Run tests with `npx vitest run`. This project's `tsconfig.json` has `"files": []`, so `npx tsc --noEmit` checks nothing — use `npx tsc -b --noEmit`. The `reports/` directory is plain JavaScript and is not type-checked at all.
- Comments explain **why**, in prose. No comment restates what the line does.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `reports/reportShared.js` (modify) | Gains `CADENCES` and `startReportScheduler`. Already holds the period functions, send guard, formatters and email shell. |
| `reports/schedulers.js` (create) | The nine-row table and `startAllReportSchedulers()`. Nothing else. This is the one place a reader looks to answer "what sends, when". |
| `reports/slippageWeeklyReport.js` (modify) | `runSlippageEmailReport({ cadence, ... })`. |
| `reports/dealMatchWeeklyReport.js` (modify) | `runDealMatchEmailReport({ cadence, ... })`, plus the `DealMatch/Run` timeout fix. |
| `reports/weeklyBusinessSummary.js`, `dailyDigest.js`, `monthlyReview.js` (modify) | Cron defaults only; their schedulers are deleted in favour of the table. |
| `server.js` (modify) | One `startAllReportSchedulers()` call; two new test-send routes. |
| `.env.example` (modify) | The four new variable sets. |

---

## Task 1: The cadence table and the scheduler factory

**Files:**
- Modify: `reports/reportShared.js` (append after `previousFullMonthUtc`)
- Test: `reports/reportScheduler.test.js` (create)

**Interfaces:**
- Consumes: `previousFullDayUtc`, `previousFullWeekUtc`, `previousFullMonthUtc`, `parseRecipients` — all already exported from `reportShared.js`.
- Produces:
  - `CADENCES` — an object keyed `daily` | `weekly` | `monthly`, each `{ noun, subjectWord, period(now?), windowKey(fromYmd, toYmd) }`.
  - `startReportScheduler({ label, defaultCron, enabledVar, cronVar, timezoneVar, runOnStartVar, recipientVars, run, schedule? })` returning `{ registered, schedule, timezone, reason, warnedNoRecipients }`.
  - `resolveRecipients(recipientVars)` returning `string[]`.

- [ ] **Step 1: Write the failing test**

Create `reports/reportScheduler.test.js`:

```javascript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CADENCES,
  resolveRecipients,
  startReportScheduler,
  toYmdUtc,
} from "./reportShared.js";

// The factory must never call the real cron.schedule in a test -- a registered
// job would outlive the test file. Every case injects a spy instead.
const spy = () => {
  const calls = [];
  const fn = (expr, handler, opts) => {
    calls.push({ expr, handler, opts });
    return { stop() {} };
  };
  fn.calls = calls;
  return fn;
};

const CLEAN = [
  "T_ENABLED", "T_CRON", "T_TZ", "T_ROS", "T_RECIPIENTS", "T_FALLBACK",
];
beforeEach(() => { for (const k of CLEAN) delete process.env[k]; });
afterEach(() => { for (const k of CLEAN) delete process.env[k]; });

const cfg = (over = {}) => ({
  label: "TestReport",
  defaultCron: "0 9 * * 6",
  enabledVar: "T_ENABLED",
  cronVar: "T_CRON",
  timezoneVar: "T_TZ",
  runOnStartVar: "T_ROS",
  recipientVars: ["T_RECIPIENTS", "T_FALLBACK"],
  run: async () => {},
  ...over,
});

describe("CADENCES", () => {
  it("covers exactly the three cadences", () => {
    expect(Object.keys(CADENCES).sort()).toEqual(["daily", "monthly", "weekly"]);
  });

  it("gives each cadence the noun its email copy uses", () => {
    expect(CADENCES.daily.noun).toBe("day");
    expect(CADENCES.weekly.noun).toBe("week");
    expect(CADENCES.monthly.noun).toBe("month");
  });

  it("gives each cadence the word its subject line starts with", () => {
    expect(CADENCES.daily.subjectWord).toBe("Daily");
    expect(CADENCES.weekly.subjectWord).toBe("Weekly");
    expect(CADENCES.monthly.subjectWord).toBe("Monthly");
  });

  it("resolves each period from the same instant", () => {
    const now = new Date("2026-09-01T06:00:00Z");
    expect(toYmdUtc(CADENCES.daily.period(now).start)).toBe("2026-08-31");
    expect(toYmdUtc(CADENCES.weekly.period(now).start)).toBe("2026-08-22");
    expect(toYmdUtc(CADENCES.monthly.period(now).start)).toBe("2026-08-01");
  });

  // A daily that wrote "2026-08-31..2026-08-31" would not collide with anything,
  // but the monthly MUST collapse to YYYY-MM or a restart on the 1st re-sends.
  it("keys each window the way the send guard already records it", () => {
    expect(CADENCES.daily.windowKey("2026-08-31", "2026-08-31")).toBe("2026-08-31");
    expect(CADENCES.weekly.windowKey("2026-08-22", "2026-08-28")).toBe("2026-08-22..2026-08-28");
    expect(CADENCES.monthly.windowKey("2026-08-01", "2026-08-31")).toBe("2026-08");
  });
});

describe("resolveRecipients", () => {
  it("takes the first variable that has a value", () => {
    process.env.T_RECIPIENTS = "a@x.com";
    process.env.T_FALLBACK = "b@x.com";
    expect(resolveRecipients(["T_RECIPIENTS", "T_FALLBACK"])).toEqual(["a@x.com"]);
  });

  it("falls through an unset variable", () => {
    process.env.T_FALLBACK = "b@x.com,c@x.com";
    expect(resolveRecipients(["T_RECIPIENTS", "T_FALLBACK"])).toEqual(["b@x.com", "c@x.com"]);
  });

  // An empty string is not a configured list. Treating it as one would make the
  // fallback unreachable the moment someone wrote DAILY_SLIPPAGE_RECIPIENTS= in
  // the env file.
  it("falls through a variable set to an empty string", () => {
    process.env.T_RECIPIENTS = "";
    process.env.T_FALLBACK = "b@x.com";
    expect(resolveRecipients(["T_RECIPIENTS", "T_FALLBACK"])).toEqual(["b@x.com"]);
  });

  it("returns an empty list when nothing is set", () => {
    expect(resolveRecipients(["T_RECIPIENTS", "T_FALLBACK"])).toEqual([]);
  });
});

describe("startReportScheduler", () => {
  it("registers with the default cron and Asia/Dubai", () => {
    process.env.T_FALLBACK = "a@x.com";
    const s = spy();
    const r = startReportScheduler(cfg({ schedule: s }));
    expect(r.registered).toBe(true);
    expect(r.schedule).toBe("0 9 * * 6");
    expect(r.timezone).toBe("Asia/Dubai");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].expr).toBe("0 9 * * 6");
    expect(s.calls[0].opts).toEqual({ timezone: "Asia/Dubai" });
  });

  it("lets the environment override the cron and timezone", () => {
    process.env.T_CRON = "15 3 * * *";
    process.env.T_TZ = "UTC";
    process.env.T_FALLBACK = "a@x.com";
    const s = spy();
    const r = startReportScheduler(cfg({ schedule: s }));
    expect(r.schedule).toBe("15 3 * * *");
    expect(r.timezone).toBe("UTC");
  });

  it("does not register when disabled", () => {
    process.env.T_ENABLED = "false";
    const s = spy();
    const r = startReportScheduler(cfg({ schedule: s }));
    expect(r).toMatchObject({ registered: false, reason: "disabled" });
    expect(s.calls).toHaveLength(0);
  });

  // A typo in a cron expression must not take the process down, and must not
  // silently register something that never fires.
  it("does not register an invalid cron expression", () => {
    process.env.T_CRON = "not a cron";
    const s = spy();
    const r = startReportScheduler(cfg({ schedule: s }));
    expect(r).toMatchObject({ registered: false, reason: "invalid-cron" });
    expect(s.calls).toHaveLength(0);
  });

  // The failure that made the weekly summary send nothing for weeks: the job
  // registers, fires, finds no recipients and returns quietly. It must shout at
  // BOOT, while someone is watching.
  it("registers but flags a missing recipient list", () => {
    const s = spy();
    const r = startReportScheduler(cfg({ schedule: s }));
    expect(r.registered).toBe(true);
    expect(r.warnedNoRecipients).toBe(true);
  });

  it("does not flag when recipients resolve from the fallback", () => {
    process.env.T_FALLBACK = "a@x.com";
    const s = spy();
    const r = startReportScheduler(cfg({ schedule: s }));
    expect(r.warnedNoRecipients).toBe(false);
  });

  it("runs on start only when asked", async () => {
    process.env.T_FALLBACK = "a@x.com";
    const run = vi.fn(async () => {});
    startReportScheduler(cfg({ schedule: spy(), run }));
    expect(run).not.toHaveBeenCalled();

    process.env.T_ROS = "true";
    startReportScheduler(cfg({ schedule: spy(), run }));
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(1);
  });

  // A throwing job must not become an unhandled rejection that kills the worker
  // and takes the other eight schedulers with it.
  it("swallows an error thrown by the job", async () => {
    process.env.T_FALLBACK = "a@x.com";
    const s = spy();
    startReportScheduler(cfg({ schedule: s, run: async () => { throw new Error("boom"); } }));
    await expect(s.calls[0].handler()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run reports/reportScheduler.test.js`
Expected: FAIL — `CADENCES is not exported`, `startReportScheduler is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `reports/reportShared.js`, after `previousFullMonthUtc`:

```javascript
// The three reporting rhythms, in one place. Every report answers the same
// questions over one of these windows, so the noun its copy uses, the word its
// subject starts with, the period it covers and the key the send guard records
// all belong together rather than being restated in each report module.
export const CADENCES = {
  daily: {
    noun: "day",
    subjectWord: "Daily",
    period: previousFullDayUtc,
    windowKey: (fromYmd) => fromYmd,
  },
  weekly: {
    noun: "week",
    subjectWord: "Weekly",
    period: previousFullWeekUtc,
    windowKey: (fromYmd, toYmd) => `${fromYmd}..${toYmd}`,
  },
  monthly: {
    noun: "month",
    subjectWord: "Monthly",
    period: previousFullMonthUtc,
    // YYYY-MM, not the date range. A monthly re-run on the same 1st after an app
    // pool recycle must find its own key and skip.
    windowKey: (fromYmd) => fromYmd.slice(0, 7),
  },
};

// First variable that carries an actual list wins. An empty string is not a
// list: writing DAILY_SLIPPAGE_RECIPIENTS= in the env file must fall through to
// the report's own list rather than resolving to nobody.
export function resolveRecipients(recipientVars) {
  for (const name of recipientVars) {
    const parsed = parseRecipients(process.env[name] || "");
    if (parsed.length) return parsed;
  }
  return [];
}

// One scheduler for all nine sends. Every report used to carry its own copy of
// this block; five copies meant the boot-time warning below could be forgotten
// in the sixth, which is the failure that made the weekly summary silently send
// nothing for weeks.
//
// `schedule` is injectable so tests can observe registration without leaving a
// live cron job behind.
export function startReportScheduler({
  label,
  defaultCron,
  defaultTimezone = "Asia/Dubai",
  enabledVar,
  cronVar,
  timezoneVar,
  runOnStartVar,
  recipientVars,
  run,
  schedule: scheduleFn = cron.schedule,
}) {
  const enabled = String(process.env[enabledVar] || "true").toLowerCase() !== "false";
  if (!enabled) {
    console.log(`[${label}] disabled by ${enabledVar}=false`);
    return { registered: false, reason: "disabled" };
  }

  const expression = String(process.env[cronVar] || defaultCron);
  const timezone = String(process.env[timezoneVar] || defaultTimezone);
  if (!cron.validate(expression)) {
    console.error(`[${label}] Invalid cron expression: "${expression}"`);
    return { registered: false, reason: "invalid-cron", schedule: expression, timezone };
  }

  scheduleFn(
    expression,
    async () => {
      try {
        await run();
      } catch (error) {
        // One report failing must never take the other eight down with it.
        console.error(`[${label}] run failed:`, error?.message || error);
      }
    },
    { timezone },
  );
  console.log(`[${label}] scheduled with expression "${expression}" (${timezone})`);

  // Say this at BOOT, while someone is watching. On schedule it is invisible:
  // the job fires, logs one line and sends nothing. The test-send routes take
  // their recipients from the request body, so they keep working and hide it.
  const warnedNoRecipients = resolveRecipients(recipientVars).length === 0;
  if (warnedNoRecipients) {
    console.error(
      `[${label}] WILL NOT SEND: none of ${recipientVars.join(", ")} is set. ` +
        "Scheduled runs skip silently; test sends still work because they pass recipients explicitly.",
    );
  }

  if (String(process.env[runOnStartVar] || "false").toLowerCase() === "true") {
    run().catch((error) => {
      console.error(`[${label}] startup run failed:`, error?.message || error);
    });
  }

  return { registered: true, schedule: expression, timezone, warnedNoRecipients };
}
```

Add `import cron from "node-cron";` to the top of `reports/reportShared.js` if it is not already there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run reports/reportScheduler.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. No existing test may change.

- [ ] **Step 6: Commit**

```bash
git add reports/reportShared.js reports/reportScheduler.test.js
git commit -m "Add the cadence table and one scheduler factory"
```

---

## Task 2: Slippage at any cadence

**Files:**
- Modify: `reports/slippageWeeklyReport.js`
- Test: `reports/slippageCadence.test.js` (create)

**Interfaces:**
- Consumes: `CADENCES`, `resolveRecipients` from Task 1.
- Produces: `runSlippageEmailReport({ cadence = "weekly", fromDate, toDate, recipients })`; `buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis, periodNoun = "week", cadence = "weekly" })`; `SLIPPAGE_GUARD_KEYS`; `SLIPPAGE_RECIPIENT_VARS`. The old name `runWeeklySlippageEmailReport` is **removed**, not aliased — two honest-looking names for one function is how call sites drift apart.

- [ ] **Step 1: Write the failing test**

Create `reports/slippageCadence.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import {
  SLIPPAGE_GUARD_KEYS,
  SLIPPAGE_RECIPIENT_VARS,
  buildSlippageEmailHtml,
  slippageSubject,
} from "./slippageWeeklyReport.js";

describe("slippage guard keys", () => {
  // The weekly key stays bare for backward compatibility with sends already
  // recorded in the send log. If the daily reused it, Saturday's weekly would
  // be skipped as "already sent".
  it("gives each cadence its own key, with the weekly key unchanged", () => {
    expect(SLIPPAGE_GUARD_KEYS).toEqual({
      daily: "slippage-daily",
      weekly: "slippage",
      monthly: "slippage-monthly",
    });
  });

  it("has three distinct keys", () => {
    expect(new Set(Object.values(SLIPPAGE_GUARD_KEYS)).size).toBe(3);
  });
});

describe("slippage recipient variables", () => {
  it("falls back to the existing list at every cadence", () => {
    expect(SLIPPAGE_RECIPIENT_VARS).toEqual({
      daily: ["DAILY_SLIPPAGE_RECIPIENTS", "SLIPPAGE_ALERT_RECIPIENTS"],
      weekly: ["SLIPPAGE_ALERT_RECIPIENTS"],
      monthly: ["MONTHLY_SLIPPAGE_RECIPIENTS", "SLIPPAGE_ALERT_RECIPIENTS"],
    });
  });
});

describe("slippage subject", () => {
  // The weekly subject must not change by one character: it is what the
  // recipients' inbox rules and eyes already key on.
  it("keeps the weekly subject exactly as it was", () => {
    expect(slippageSubject("weekly", "2026-08-22", "2026-08-28"))
      .toBe("Weekly Slippage Report (2026-08-22 to 2026-08-28)");
  });

  it("names a single day once, not as a range of one", () => {
    expect(slippageSubject("daily", "2026-08-31", "2026-08-31"))
      .toBe("Daily Slippage Report (2026-08-31)");
  });

  it("names a month as a range", () => {
    expect(slippageSubject("monthly", "2026-08-01", "2026-08-31"))
      .toBe("Monthly Slippage Report (2026-08-01 to 2026-08-31)");
  });
});

const BUCKETS = [
  { lp: "LP One", deals: 120, volume: 45.5, slippageUsd: -320.25, avgSlipUsd: -2.67, positive: 40, negative: 70, neutral: 10 },
];
const KPIS = { totalDeals: 120, totalSlippageUsd: -320.25, avgSlipUsd: -2.67, worstLp: "LP One" };

const html = (over = {}) =>
  buildSlippageEmailHtml({ fromYmd: "2026-08-31", toYmd: "2026-08-31", buckets: BUCKETS, kpis: KPIS, ...over });

describe("period wording", () => {
  it("says day in a daily email and never week", () => {
    const out = html({ periodNoun: "day", cadence: "daily" });
    expect(out).toMatch(/this day|the day/i);
    expect(out).not.toMatch(/this week|the week/i);
  });

  it("says month in a monthly email and never week", () => {
    const out = html({ periodNoun: "month", cadence: "monthly" });
    expect(out).not.toMatch(/this week|the week/i);
  });

  it("still says week by default", () => {
    expect(html()).toMatch(/week/i);
  });
});

describe("HTML entities are written once, not twice", () => {
  it("contains no double-escaped entities", () => {
    expect(html()).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|middot);/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run reports/slippageCadence.test.js`
Expected: FAIL — `SLIPPAGE_GUARD_KEYS` and `slippageSubject` are not exported.

- [ ] **Step 3: Capture the current weekly email as a baseline**

Before changing the module, record what its weekly email renders. Create `reports/__baseline.mjs`:

```javascript
import { createHash } from "node:crypto";
const m = await import("./slippageWeeklyReport.js");
const buckets = [
  { lp: "LP One", deals: 120, volume: 45.5, slippageUsd: -320.25, avgSlipUsd: -2.67, positive: 40, negative: 70, neutral: 10 },
  { lp: "LP Two", deals: 8, volume: 2.1, slippageUsd: 14.8, avgSlipUsd: 1.85, positive: 6, negative: 1, neutral: 1 },
];
const kpis = { totalDeals: 128, totalSlippageUsd: -305.45, avgSlipUsd: -2.39, worstLp: "LP One" };
const out = m.buildSlippageEmailHtml({ fromYmd: "2026-08-22", toYmd: "2026-08-28", buckets, kpis });
console.log(createHash("sha256").update(out).digest("hex").slice(0, 16), out.length);
```

Run: `node reports/__baseline.mjs`
Record the hash and length. If `buildSlippageEmailHtml` throws because a bucket
or kpi field is missing, read `buildSlippageEmailHtml` at
`reports/slippageWeeklyReport.js:153` and add the missing fields to the fixture
until it renders. Do not change the module to make the fixture work.

- [ ] **Step 4: Write the implementation**

In `reports/slippageWeeklyReport.js`:

Add to the imports from `./reportShared.js`: `CADENCES`, `resolveRecipients`.

Add near the top, after `DEFAULT_TIMEZONE`:

```javascript
// The weekly key is bare because sends already recorded in the send log use it.
// A daily that reused it would make Saturday's weekly skip as "already sent".
export const SLIPPAGE_GUARD_KEYS = {
  daily: "slippage-daily",
  weekly: "slippage",
  monthly: "slippage-monthly",
};

// Each cadence may have its own audience, and falls back to the one list this
// report has always used -- so the new sends work with no environment change.
export const SLIPPAGE_RECIPIENT_VARS = {
  daily: ["DAILY_SLIPPAGE_RECIPIENTS", "SLIPPAGE_ALERT_RECIPIENTS"],
  weekly: ["SLIPPAGE_ALERT_RECIPIENTS"],
  monthly: ["MONTHLY_SLIPPAGE_RECIPIENTS", "SLIPPAGE_ALERT_RECIPIENTS"],
};

export function slippageSubject(cadence, fromYmd, toYmd) {
  const word = CADENCES[cadence].subjectWord;
  // A single day rendered as "2026-08-31 to 2026-08-31" reads like a bug.
  const period = fromYmd === toYmd ? fromYmd : `${fromYmd} to ${toYmd}`;
  return `${word} Slippage Report (${period})`;
}
```

Add a `periodNoun = "week"` parameter to `buildSlippageEmailHtml` and replace
every user-visible occurrence of the word "week" in its body and footer with
`${periodNoun}`. There are three; find them with:

```bash
grep -n "this week\|the week\|per week" reports/slippageWeeklyReport.js
```

**Any string you add `${periodNoun}` to must be a template literal.** Two of the
Business Summary's footer lines were double-quoted, so the interpolation shipped
as literal `${periodNoun}` text. JavaScript will not catch this; Step 6 will.

Replace the signature and the cadence-dependent lines of the run function:

```javascript
export async function runSlippageEmailReport({
  cadence = "weekly",
  fromDate,
  toDate,
  recipients: recipientsOverride,
} = {}) {
  const spec = CADENCES[cadence];
  if (!spec) throw new Error(`Unknown cadence "${cadence}"`);
  const label = `Slippage${cadence[0].toUpperCase()}${cadence.slice(1)}`;

  const period = fromDate && toDate ? { start: fromDate, end: toDate } : spec.period();
  const fromYmd = toYmdUtc(period.start);
  const toYmd = toYmdUtc(period.end);

  const rows = await fetchSlippageRows(fromYmd, toYmd);
  const { buckets } = aggregateByLp(rows);
  const kpis = computeKpis(buckets, rows);

  const isScheduledRun = !(Array.isArray(recipientsOverride) && recipientsOverride.length);
  const recipients = Array.isArray(recipientsOverride) && recipientsOverride.length
    ? recipientsOverride.map((e) => String(e).trim()).filter(Boolean)
    : resolveRecipients(SLIPPAGE_RECIPIENT_VARS[cadence]);
  if (!recipients.length) {
    console.warn(`[${label}] No recipients configured. Skipping.`);
    return { ok: false, reason: "no-recipients", lps: buckets.length, fromYmd, toYmd };
  }

  const windowKey = spec.windowKey(fromYmd, toYmd);
  if (isScheduledRun && (await alreadySentFor(SLIPPAGE_GUARD_KEYS[cadence], windowKey))) {
    console.log(`[${label}] ${windowKey} already sent; skipping (restart, not a new ${spec.noun}).`);
    return { ok: false, reason: "already-sent", fromYmd, toYmd };
  }

  const subject = slippageSubject(cadence, fromYmd, toYmd);
  const html = buildSlippageEmailHtml({ fromYmd, toYmd, buckets, kpis, periodNoun: spec.noun, cadence });
  const attachments = await buildSlippageChartAttachments(buckets, fromYmd, toYmd);
  await sendBrevoEmail({ subject, html, recipients, attachments, senderName: "Slippage Reporter" });

  if (isScheduledRun) await recordSentFor(SLIPPAGE_GUARD_KEYS[cadence], windowKey);

  console.log(`[${label}] Sent to ${recipients.join(", ")} | lps=${buckets.length} | period=${fromYmd}..${toYmd}`);
  return { ok: true, lps: buckets.length, fromYmd, toYmd };
}
```

**Leave `startWeeklySlippageScheduler` in place**, changing only its body to call
`runSlippageEmailReport({ cadence: "weekly" })`. Task 5 deletes it. Removing it
here would break `server.js`, which still imports it, and every task must leave
a tree that boots.

Update the one other caller in `server.js`: change the import
`runWeeklySlippageEmailReport` to `runSlippageEmailReport` and the call in
`/api/reports/slippage-weekly/test` to `runSlippageEmailReport({ recipients })`.

- [ ] **Step 5: Run the cadence test**

Run: `npx vitest run reports/slippageCadence.test.js`
Expected: PASS.

- [ ] **Step 6: Prove the weekly email is byte-identical**

Run: `node reports/__baseline.mjs`
Expected: **the same hash and length recorded in Step 3.**

If they differ, the change altered the live Saturday email. Find where, by
keeping the Step 3 output in a file and diffing against it. Append this to
`reports/__baseline.mjs` before re-running:

```javascript
import { readFileSync, writeFileSync } from "node:fs";
const prev = (() => { try { return readFileSync("reports/__baseline.txt", "utf8"); } catch { return null; } })();
if (prev === null) {
  writeFileSync("reports/__baseline.txt", out);
  console.log("baseline written");
} else if (prev === out) {
  console.log("IDENTICAL");
} else {
  for (let i = 0; i < Math.max(prev.length, out.length); i++) {
    if (prev[i] !== out[i]) {
      console.log("first diff at", i);
      console.log("  before:", JSON.stringify(prev.slice(i - 90, i + 90)));
      console.log("  after :", JSON.stringify(out.slice(i - 90, i + 90)));
      break;
    }
  }
}
```

Run it once before the change to write the baseline, and again after to compare.
Do not proceed with a different hash.

- [ ] **Step 7: Clean up and run the whole suite**

```bash
rm reports/__baseline.mjs
npx vitest run
node --check server.js
```

Expected: all tests pass; `server.js` parses.

- [ ] **Step 8: Commit**

```bash
git add reports/slippageWeeklyReport.js reports/slippageCadence.test.js server.js
git commit -m "Let the Slippage report run at any cadence"
```

---

## Task 3: Deal Matching at any cadence, and the timeout that was always too tight

**Files:**
- Modify: `reports/dealMatchWeeklyReport.js`
- Test: `reports/dealMatchCadence.test.js` (create)

**Interfaces:**
- Consumes: `CADENCES`, `resolveRecipients` from Task 1.
- Produces: `runDealMatchEmailReport({ cadence = "weekly", fromDate, toDate, recipients })`; `DEALMATCH_GUARD_KEYS`; `DEALMATCH_RECIPIENT_VARS`; `dealMatchSubject(cadence, fromYmd, toYmd)`; `DEALMATCH_RUN_TIMEOUT_MS`. `runWeeklyDealMatchEmailReport` is removed.

**Why the timeout matters:** `reports/dealMatchWeeklyReport.js:1204` calls
`DealMatch/Run` with `AbortSignal.timeout(45_000)`. That endpoint was measured
on 2026-08-31 at **41.8s for one day, 40.4s for one month, 39.7s for another
month** — the cost is in starting the match, not in the deals matched. 45s has
always been marginal; at three cadences it will abort regularly. The Business
Summary already raised its own call to 180s for exactly this reason, with the
comment "A week of deals took longer than the original 45s, which is why Total
Revenue came back empty on the first live send."

- [ ] **Step 1: Write the failing test**

Create `reports/dealMatchCadence.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import {
  DEALMATCH_GUARD_KEYS,
  DEALMATCH_RECIPIENT_VARS,
  DEALMATCH_RUN_TIMEOUT_MS,
  dealMatchSubject,
} from "./dealMatchWeeklyReport.js";

describe("deal match guard keys", () => {
  it("gives each cadence its own key, with the weekly key unchanged", () => {
    expect(DEALMATCH_GUARD_KEYS).toEqual({
      daily: "dealmatch-daily",
      weekly: "dealmatch",
      monthly: "dealmatch-monthly",
    });
  });

  it("has three distinct keys", () => {
    expect(new Set(Object.values(DEALMATCH_GUARD_KEYS)).size).toBe(3);
  });
});

describe("deal match recipient variables", () => {
  it("falls back to the existing list at every cadence", () => {
    expect(DEALMATCH_RECIPIENT_VARS).toEqual({
      daily: ["DAILY_DEALMATCH_RECIPIENTS", "DEALMATCH_ALERT_RECIPIENTS"],
      weekly: ["DEALMATCH_ALERT_RECIPIENTS"],
      monthly: ["MONTHLY_DEALMATCH_RECIPIENTS", "DEALMATCH_ALERT_RECIPIENTS"],
    });
  });
});

describe("deal match subject", () => {
  it("keeps the weekly subject exactly as it was", () => {
    expect(dealMatchSubject("weekly", "2026-08-22", "2026-08-28"))
      .toBe("Weekly Deal Match Analysis (2026-08-22 to 2026-08-28)");
  });

  it("names a single day once", () => {
    expect(dealMatchSubject("daily", "2026-08-31", "2026-08-31"))
      .toBe("Daily Deal Match Analysis (2026-08-31)");
  });

  it("names a month as a range", () => {
    expect(dealMatchSubject("monthly", "2026-08-01", "2026-08-31"))
      .toBe("Monthly Deal Match Analysis (2026-08-01 to 2026-08-31)");
  });
});

describe("HTML entities are written once, not twice", () => {
  // The weekly Business Summary once shipped a literal "&ndash;" to a reader's
  // inbox because an entity was passed through escapeHtml. Same guard here,
  // because this task adds a periodNoun interpolation to eight strings.
  it("contains no double-escaped entities in a weekly email", async () => {
    const { buildEmailHtml } = await import("./dealMatchWeeklyReport.js");
    const out = buildEmailHtml({
      fromYmd: "2026-08-22", toYmd: "2026-08-28",
      rows: [], volume: null, volumeStats: null, charts: null, chartError: null, ibNotice: null,
    });
    expect(out).not.toMatch(/&amp;(mdash|ndash|minus|nbsp|rsquo|middot);/);
  });
});

describe("the DealMatch/Run timeout", () => {
  // Measured 2026-08-31 against the live endpoint: 41.8s for one day, 40.4s for
  // a month. The old 45s left under four seconds of headroom on a call whose
  // cost does not shrink with the window. The Business Summary's own call to
  // the same endpoint already uses 180s.
  it("leaves real headroom over the measured ~40s response", () => {
    expect(DEALMATCH_RUN_TIMEOUT_MS).toBe(180_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run reports/dealMatchCadence.test.js`
Expected: FAIL — nothing is exported yet.

- [ ] **Step 3: Capture the current weekly email as a baseline**

Create `reports/__baseline.mjs` rendering `buildEmailHtml` with a fixture. Read
`buildEmailHtml` at `reports/dealMatchWeeklyReport.js:880` for its exact
parameters and build a fixture that renders without throwing. Print the sha256
and length. Record both.

`buildEmailHtml` is module-private at `reports/dealMatchWeeklyReport.js:880`.
**Add `export` to it permanently** — it is a pure function, the baseline needs
it, and so does the double-escaped-entity test in Step 1. Start the fixture from
the minimal call that test uses:

```javascript
buildEmailHtml({
  fromYmd: "2026-08-22", toYmd: "2026-08-28",
  rows: [], volume: null, volumeStats: null, charts: null, chartError: null, ibNotice: null,
})
```

If that throws, read the function and add fields until it renders. Then add two
populated rows so the per-client table is exercised rather than only its empty
state. Do not change the module to make the fixture work.

- [ ] **Step 4: Write the implementation**

In `reports/dealMatchWeeklyReport.js`, mirroring Task 2 exactly:

```javascript
export const DEALMATCH_GUARD_KEYS = {
  daily: "dealmatch-daily",
  weekly: "dealmatch",
  monthly: "dealmatch-monthly",
};

export const DEALMATCH_RECIPIENT_VARS = {
  daily: ["DAILY_DEALMATCH_RECIPIENTS", "DEALMATCH_ALERT_RECIPIENTS"],
  weekly: ["DEALMATCH_ALERT_RECIPIENTS"],
  monthly: ["MONTHLY_DEALMATCH_RECIPIENTS", "DEALMATCH_ALERT_RECIPIENTS"],
};

// DealMatch/Run costs ~40s whatever the window: 41.8s for one day and 40.4s for
// a month, measured 2026-08-31. The cost is in starting the match, not in the
// deals matched, so a shorter period buys no headroom. The old 45s left under
// four seconds of it.
export const DEALMATCH_RUN_TIMEOUT_MS = 180_000;

export function dealMatchSubject(cadence, fromYmd, toYmd) {
  const word = CADENCES[cadence].subjectWord;
  const period = fromYmd === toYmd ? fromYmd : `${fromYmd} to ${toYmd}`;
  return `${word} Deal Match Analysis (${period})`;
}
```

At line 1204, replace `AbortSignal.timeout(45_000)` with
`AbortSignal.timeout(DEALMATCH_RUN_TIMEOUT_MS)`.

Rename `runWeeklyDealMatchEmailReport` to `runDealMatchEmailReport` and apply the
same five changes Task 2 made: `cadence` parameter, `spec.period()`,
`resolveRecipients(DEALMATCH_RECIPIENT_VARS[cadence])`,
`spec.windowKey(fromYmd, toYmd)`, `DEALMATCH_GUARD_KEYS[cadence]`, and
`dealMatchSubject(...)` for the subject. Replace the `[DealMatchWeekly]` log
prefix with the computed `label`.

Add `periodNoun = "week"` to `buildEmailHtml` and replace every user-visible
"week". There are eight; find them with:

```bash
grep -n "this week\|the week\|a week\|Weekly Deal" reports/dealMatchWeeklyReport.js
```

**Every string receiving `${periodNoun}` must be a template literal.**

**Leave `startWeeklyDealMatchScheduler` in place**, changing only its body to
call `runDealMatchEmailReport({ cadence: "weekly" })`. Task 5 deletes it.
Update `server.js`: import `runDealMatchEmailReport` and call it in
`/api/reports/dealmatch-weekly/test`.

- [ ] **Step 5: Run the cadence test**

Run: `npx vitest run reports/dealMatchCadence.test.js`
Expected: PASS.

- [ ] **Step 6: Prove the weekly email is byte-identical**

Run: `node reports/__baseline.mjs`
Expected: **the same hash and length recorded in Step 3.** Do not proceed with a
different hash.

- [ ] **Step 7: Clean up and run the whole suite**

```bash
rm reports/__baseline.mjs
npx vitest run
node --check server.js
```

- [ ] **Step 8: Commit**

```bash
git add reports/dealMatchWeeklyReport.js reports/dealMatchCadence.test.js server.js
git commit -m "Let the Deal Match report run at any cadence, and stop timing out at 45s"
```

---

## Task 4: The Business Summary's three cadences move onto the same footing

**Files:**
- Modify: `reports/weeklyBusinessSummary.js`, `reports/dailyDigest.js`, `reports/monthlyReview.js`
- Test: `reports/summaryCadence.test.js` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SUMMARY_GUARD_KEYS = { daily: "daily", weekly: "summary", monthly: "monthly" }` and `SUMMARY_RECIPIENT_VARS`, both exported from `reports/weeklyBusinessSummary.js`. The three `start*Scheduler` functions are deleted.

- [ ] **Step 1: Write the failing test**

Create `reports/summaryCadence.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import { SUMMARY_GUARD_KEYS, SUMMARY_RECIPIENT_VARS } from "./weeklyBusinessSummary.js";

describe("business summary guard keys", () => {
  // These three are deliberately inconsistent with slippage-* and dealmatch-*.
  // They were recorded against real sends on 1 September 2026; renaming them
  // would let those sends repeat on the next app-pool restart.
  it("keeps the keys already written to the send log", () => {
    expect(SUMMARY_GUARD_KEYS).toEqual({
      daily: "daily",
      weekly: "summary",
      monthly: "monthly",
    });
  });

  it("has three distinct keys", () => {
    expect(new Set(Object.values(SUMMARY_GUARD_KEYS)).size).toBe(3);
  });
});

describe("business summary recipient variables", () => {
  it("falls back to the existing list at every cadence", () => {
    expect(SUMMARY_RECIPIENT_VARS).toEqual({
      daily: ["DAILY_DIGEST_RECIPIENTS", "SUMMARY_ALERT_RECIPIENTS"],
      weekly: ["SUMMARY_ALERT_RECIPIENTS"],
      monthly: ["MONTHLY_REVIEW_RECIPIENTS", "SUMMARY_ALERT_RECIPIENTS"],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run reports/summaryCadence.test.js`
Expected: FAIL — neither constant is exported.

- [ ] **Step 3: Write the implementation**

In `reports/weeklyBusinessSummary.js`, add:

```javascript
// Unprefixed and inconsistent with slippage-* / dealmatch-* on purpose: these
// three keys were recorded against real sends on 1 September 2026, and renaming
// them would let those sends repeat on the next app-pool restart.
export const SUMMARY_GUARD_KEYS = { daily: "daily", weekly: "summary", monthly: "monthly" };

export const SUMMARY_RECIPIENT_VARS = {
  daily: ["DAILY_DIGEST_RECIPIENTS", "SUMMARY_ALERT_RECIPIENTS"],
  weekly: ["SUMMARY_ALERT_RECIPIENTS"],
  monthly: ["MONTHLY_REVIEW_RECIPIENTS", "SUMMARY_ALERT_RECIPIENTS"],
};
```

Change the three run functions to use `resolveRecipients(SUMMARY_RECIPIENT_VARS[...])`
and `SUMMARY_GUARD_KEYS[...]` in place of their inline `process.env` reads and
literal keys. Their periods and window keys are already correct; do not change
them.

**Leave all three `start*Scheduler` functions in place.** Task 5 deletes them
together with the two from Tasks 2 and 3, in the same commit that gives
`server.js` its replacement. Every task must leave a tree that boots.

- [ ] **Step 4: Prove the weekly email is still byte-identical**

This task does not touch `buildSummaryEmailHtml`, only the run function around
it — but the spec requires all three weekly emails proven, and the cost is one
command. Render `buildSummaryEmailHtml` with a fixture before and after and
compare the sha256, exactly as Tasks 2 and 3 do.

Expected: identical hash and length.

- [ ] **Step 5: Run the tests**

```bash
npx vitest run
node --check server.js
```

Expected: PASS, and `server.js` parses — the schedulers are still exported.

- [ ] **Step 6: Commit**

```bash
git add reports/weeklyBusinessSummary.js reports/dailyDigest.js reports/monthlyReview.js reports/summaryCadence.test.js
git commit -m "Move the Business Summary's three cadences onto shared guard-key and recipient tables"
```

---

## Task 5: The nine-row table

**Files:**
- Create: `reports/schedulers.js`
- Modify: `server.js`
- Test: `reports/schedulers.test.js` (create)

**Interfaces:**
- Consumes: `startReportScheduler`, `CADENCES` (Task 1); the six `run*` functions and six `*_GUARD_KEYS` / `*_RECIPIENT_VARS` tables (Tasks 2–4).
- Produces: `REPORT_SCHEDULES` (an array of nine config objects) and `startAllReportSchedulers()`.

- [ ] **Step 1: Write the failing test**

Create `reports/schedulers.test.js`:

```javascript
import { describe, expect, it } from "vitest";
import { REPORT_SCHEDULES } from "./schedulers.js";

const bySlot = Object.fromEntries(REPORT_SCHEDULES.map((s) => [s.label, s]));

describe("the schedule", () => {
  it("declares exactly nine sends", () => {
    expect(REPORT_SCHEDULES).toHaveLength(9);
  });

  it("puts every report at every cadence", () => {
    expect(REPORT_SCHEDULES.map((s) => s.label).sort()).toEqual([
      "BusinessDaily", "BusinessMonthly", "BusinessWeekly",
      "DealMatchDaily", "DealMatchMonthly", "DealMatchWeekly",
      "SlippageDaily", "SlippageMonthly", "SlippageWeekly",
    ]);
  });

  it("uses the exact cron expressions the spec fixes", () => {
    expect(bySlot.DealMatchDaily.defaultCron).toBe("0 7 * * 2-6");
    expect(bySlot.SlippageDaily.defaultCron).toBe("30 7 * * 2-6");
    expect(bySlot.BusinessDaily.defaultCron).toBe("0 8 * * 2-6");
    expect(bySlot.DealMatchWeekly.defaultCron).toBe("0 9 * * 6");
    expect(bySlot.SlippageWeekly.defaultCron).toBe("30 9 * * 6");
    expect(bySlot.BusinessWeekly.defaultCron).toBe("0 10 * * 6");
    expect(bySlot.DealMatchMonthly.defaultCron).toBe("0 11 1 * *");
    expect(bySlot.SlippageMonthly.defaultCron).toBe("30 11 1 * *");
    expect(bySlot.BusinessMonthly.defaultCron).toBe("0 12 1 * *");
  });

  it("gives every send a distinct environment variable set", () => {
    for (const key of ["enabledVar", "cronVar", "timezoneVar", "runOnStartVar"]) {
      expect(new Set(REPORT_SCHEDULES.map((s) => s[key])).size).toBe(9);
    }
  });

  it("gives every send a recipient chain ending in a report-wide list", () => {
    for (const s of REPORT_SCHEDULES) {
      expect(s.recipientVars.length).toBeGreaterThan(0);
      expect(s.recipientVars.at(-1)).toMatch(/_ALERT_RECIPIENTS$/);
    }
  });
});

// The check that would have caught the live fault: the Business Summary monthly
// at "0 10 1 * *" and its weekly at "0 10 * * 6" fire in the same minute
// whenever the 1st is a Saturday. 1 August 2026 was one.
describe("no two schedulers share a minute", () => {
  const fires = (expr, d) => {
    const [mi, hh, dom, mon, dow] = expr.split(" ");
    const f = (part, val) => {
      if (part === "*") return true;
      return part.split(",").some((chunk) => {
        if (!chunk.includes("-")) return Number(chunk) === val;
        const [lo, hi] = chunk.split("-").map(Number);
        return val >= lo && val <= hi;
      });
    };
    return f(mi, d.getUTCMinutes()) && f(hh, d.getUTCHours()) && f(dom, d.getUTCDate())
        && f(mon, d.getUTCMonth() + 1) && f(dow, d.getUTCDay());
  };

  it("holds for every minute of a full year", () => {
    const collisions = [];
    const start = Date.UTC(2026, 0, 1);
    // Every half hour is enough: all nine expressions fire on :00 or :30.
    for (let t = start; t < Date.UTC(2027, 0, 1); t += 30 * 60_000) {
      const d = new Date(t);
      const hit = REPORT_SCHEDULES.filter((s) => fires(s.defaultCron, d));
      if (hit.length > 1) collisions.push(`${d.toISOString()}: ${hit.map((s) => s.label).join(" + ")}`);
    }
    expect(collisions).toEqual([]);
  });

  it("would have caught the 10:00 Saturday-the-1st collision", () => {
    // Guard against the test above being vacuous: with the OLD monthly time the
    // same walk must report a collision.
    const saturdayFirst = new Date(Date.UTC(2026, 7, 1, 10, 0)); // 1 Aug 2026, a Saturday
    expect(fires("0 10 1 * *", saturdayFirst)).toBe(true);
    expect(fires("0 10 * * 6", saturdayFirst)).toBe(true);
  });
});

// Each report's own test asserts three distinct keys within itself. All three
// could pass while slippage-daily and dealmatch-daily collided, which would
// make one of them permanently skip as "already sent".
describe("all nine send-guard keys are distinct", () => {
  it("holds across the three reports together", async () => {
    const [{ SUMMARY_GUARD_KEYS }, { SLIPPAGE_GUARD_KEYS }, { DEALMATCH_GUARD_KEYS }] =
      await Promise.all([
        import("./weeklyBusinessSummary.js"),
        import("./slippageWeeklyReport.js"),
        import("./dealMatchWeeklyReport.js"),
      ]);
    const all = [
      ...Object.values(SUMMARY_GUARD_KEYS),
      ...Object.values(SLIPPAGE_GUARD_KEYS),
      ...Object.values(DEALMATCH_GUARD_KEYS),
    ];
    expect(all).toHaveLength(9);
    expect(new Set(all).size).toBe(9);
  });
});

describe("the daily cadence", () => {
  const dailies = REPORT_SCHEDULES.filter((s) => s.label.endsWith("Daily"));

  it("runs Tuesday to Saturday and no other day", () => {
    for (const s of dailies) expect(s.defaultCron.endsWith(" 2-6")).toBe(true);
  });

  it("covers every weekday exactly once across the week", () => {
    // Tue..Sat sends cover Mon..Fri. Sunday and Saturday are never covered,
    // because the market is shut and those reports would be screens of zeros.
    const covered = [2, 3, 4, 5, 6].map((dow) => (dow + 6) % 7);
    expect(covered.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run reports/schedulers.test.js`
Expected: FAIL — `./schedulers.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `reports/schedulers.js`:

```javascript
import { startReportScheduler } from "./reportShared.js";
import { runDailyDigest } from "./dailyDigest.js";
import { runMonthlyReview } from "./monthlyReview.js";
import { runWeeklyBusinessSummary, SUMMARY_RECIPIENT_VARS } from "./weeklyBusinessSummary.js";
import { runSlippageEmailReport, SLIPPAGE_RECIPIENT_VARS } from "./slippageWeeklyReport.js";
import { runDealMatchEmailReport, DEALMATCH_RECIPIENT_VARS } from "./dealMatchWeeklyReport.js";

// Every scheduled send in the system, in one table. This is the file to read to
// answer "what goes out, when".
//
// Ordering within a cadence is deliberate: Deal Match, then Slippage, then
// Business Summary. The Business Summary's At a Glance strip computes Total
// Revenue from DealMatch/Run, so it must never run before the report it
// summarises.
//
// Dailies use cron day-of-week 2-6, Tuesday to Saturday, each covering the
// previous day. That gives every trading day exactly one daily and fires
// nothing for a shut market.
//
// Monthlies sit AFTER the weeklies. At 10:00 the Business Summary monthly
// ("0 10 1 * *") and weekly ("0 10 * * 6") fired in the same minute whenever the
// 1st was a Saturday -- 1 August 2026 was one -- racing two 40-second
// DealMatch/Run calls.
//
// Design: docs/superpowers/specs/2026-09-01-nine-report-cadences-design.md
export const REPORT_SCHEDULES = [
  {
    label: "DealMatchDaily", defaultCron: "0 7 * * 2-6",
    enabledVar: "DAILY_DEALMATCH_ENABLED", cronVar: "DAILY_DEALMATCH_CRON",
    timezoneVar: "DAILY_DEALMATCH_TIMEZONE", runOnStartVar: "DAILY_DEALMATCH_RUN_ON_START",
    recipientVars: DEALMATCH_RECIPIENT_VARS.daily,
    run: () => runDealMatchEmailReport({ cadence: "daily" }),
  },
  {
    label: "SlippageDaily", defaultCron: "30 7 * * 2-6",
    enabledVar: "DAILY_SLIPPAGE_ENABLED", cronVar: "DAILY_SLIPPAGE_CRON",
    timezoneVar: "DAILY_SLIPPAGE_TIMEZONE", runOnStartVar: "DAILY_SLIPPAGE_RUN_ON_START",
    recipientVars: SLIPPAGE_RECIPIENT_VARS.daily,
    run: () => runSlippageEmailReport({ cadence: "daily" }),
  },
  {
    label: "BusinessDaily", defaultCron: "0 8 * * 2-6",
    enabledVar: "DAILY_DIGEST_ENABLED", cronVar: "DAILY_DIGEST_CRON",
    timezoneVar: "DAILY_DIGEST_TIMEZONE", runOnStartVar: "DAILY_DIGEST_RUN_ON_START",
    recipientVars: SUMMARY_RECIPIENT_VARS.daily,
    run: () => runDailyDigest(),
  },
  {
    label: "DealMatchWeekly", defaultCron: "0 9 * * 6",
    enabledVar: "WEEKLY_DEALMATCH_ENABLED", cronVar: "WEEKLY_DEALMATCH_CRON",
    timezoneVar: "WEEKLY_DEALMATCH_TIMEZONE", runOnStartVar: "WEEKLY_DEALMATCH_RUN_ON_START",
    recipientVars: DEALMATCH_RECIPIENT_VARS.weekly,
    run: () => runDealMatchEmailReport({ cadence: "weekly" }),
  },
  {
    label: "SlippageWeekly", defaultCron: "30 9 * * 6",
    enabledVar: "WEEKLY_SLIPPAGE_ENABLED", cronVar: "WEEKLY_SLIPPAGE_CRON",
    timezoneVar: "WEEKLY_SLIPPAGE_TIMEZONE", runOnStartVar: "WEEKLY_SLIPPAGE_RUN_ON_START",
    recipientVars: SLIPPAGE_RECIPIENT_VARS.weekly,
    run: () => runSlippageEmailReport({ cadence: "weekly" }),
  },
  {
    label: "BusinessWeekly", defaultCron: "0 10 * * 6",
    enabledVar: "WEEKLY_SUMMARY_ENABLED", cronVar: "WEEKLY_SUMMARY_CRON",
    timezoneVar: "WEEKLY_SUMMARY_TIMEZONE", runOnStartVar: "WEEKLY_SUMMARY_RUN_ON_START",
    recipientVars: SUMMARY_RECIPIENT_VARS.weekly,
    run: () => runWeeklyBusinessSummary(),
  },
  {
    label: "DealMatchMonthly", defaultCron: "0 11 1 * *",
    enabledVar: "MONTHLY_DEALMATCH_ENABLED", cronVar: "MONTHLY_DEALMATCH_CRON",
    timezoneVar: "MONTHLY_DEALMATCH_TIMEZONE", runOnStartVar: "MONTHLY_DEALMATCH_RUN_ON_START",
    recipientVars: DEALMATCH_RECIPIENT_VARS.monthly,
    run: () => runDealMatchEmailReport({ cadence: "monthly" }),
  },
  {
    label: "SlippageMonthly", defaultCron: "30 11 1 * *",
    enabledVar: "MONTHLY_SLIPPAGE_ENABLED", cronVar: "MONTHLY_SLIPPAGE_CRON",
    timezoneVar: "MONTHLY_SLIPPAGE_TIMEZONE", runOnStartVar: "MONTHLY_SLIPPAGE_RUN_ON_START",
    recipientVars: SLIPPAGE_RECIPIENT_VARS.monthly,
    run: () => runSlippageEmailReport({ cadence: "monthly" }),
  },
  {
    label: "BusinessMonthly", defaultCron: "0 12 1 * *",
    enabledVar: "MONTHLY_REVIEW_ENABLED", cronVar: "MONTHLY_REVIEW_CRON",
    timezoneVar: "MONTHLY_REVIEW_TIMEZONE", runOnStartVar: "MONTHLY_REVIEW_RUN_ON_START",
    recipientVars: SUMMARY_RECIPIENT_VARS.monthly,
    run: () => runMonthlyReview(),
  },
];

export function startAllReportSchedulers() {
  return REPORT_SCHEDULES.map((config) => ({
    label: config.label,
    ...startReportScheduler(config),
  }));
}
```

In `server.js`:

- Delete the imports of `startWeeklyDealMatchScheduler`,
  `startWeeklySlippageScheduler`, `startWeeklyBusinessSummaryScheduler`,
  `startDailyDigestScheduler` and `startMonthlyReviewScheduler`. Keep the `run*`
  imports the test routes use.
- Add `import { startAllReportSchedulers } from './reports/schedulers.js';`
- Replace the five `start*Scheduler();` calls in the listen callback with
  `startAllReportSchedulers();`

Then delete the five now-orphaned scheduler functions and each file's unused
`DEFAULT_SCHEDULE`, `DEFAULT_TIMEZONE` and `cron` import:
`startWeeklyDealMatchScheduler`, `startWeeklySlippageScheduler`,
`startWeeklyBusinessSummaryScheduler`, `startDailyDigestScheduler`,
`startMonthlyReviewScheduler`. This is the commit where they go, because it is
the first one in which `server.js` no longer needs them.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 5: Verify every scheduler registers**

Create `reports/__boot.mjs`:

```javascript
process.env.SUMMARY_ALERT_RECIPIENTS = "a@x.com";
process.env.SLIPPAGE_ALERT_RECIPIENTS = "a@x.com";
process.env.DEALMATCH_ALERT_RECIPIENTS = "a@x.com";
const { startAllReportSchedulers } = await import("./schedulers.js");
const results = startAllReportSchedulers();
console.table(results.map(({ label, registered, schedule, timezone, warnedNoRecipients }) =>
  ({ label, registered, schedule, timezone, warnedNoRecipients })));
console.log("registered:", results.filter((r) => r.registered).length, "of", results.length);
process.exit(0);
```

Run: `node reports/__boot.mjs`
Expected: nine rows, `registered: 9 of 9`, every `warnedNoRecipients` false, and
the nine cron expressions matching the Global Constraints exactly.

Then `rm reports/__boot.mjs`.

- [ ] **Step 6: Check the server parses**

Run: `node --check server.js`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add reports/schedulers.js reports/schedulers.test.js server.js
git commit -m "Declare all nine scheduled sends in one table"
```

---

## Task 6: Backfill routes and configuration

**Files:**
- Modify: `server.js`, `.env.example`
- Test: `auth/routeCoverage.test.js` (existing — must still pass)

**Interfaces:**
- Consumes: `runSlippageEmailReport`, `runDealMatchEmailReport` (Tasks 2–3).
- Produces: `POST /api/reports/slippage-monthly/test` and
  `POST /api/reports/dealmatch-monthly/test`.

**Why:** August's Slippage and Deal Matching monthlies do not exist, and the next
automatic monthly is 1 October. These routes send a named past period by hand.

- [ ] **Step 1: Add the routes**

In `server.js`, beside the existing report test routes:

```javascript
// Send a monthly for a period chosen by the caller. The four other test routes
// always cover the current default period; these two exist because August's
// monthlies were never sent -- the reports did not exist on 1 September -- and
// the next automatic one is 1 October.
//
// `from` and `to` are YYYY-MM-DD. Omit them for the previous full month.
function parseTestPeriod(body) {
  const { from, to } = body || {};
  if (!from && !to) return {};
  const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  if (!valid(from) || !valid(to)) return { error: 'from and to must both be YYYY-MM-DD' };
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T23:59:59Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { error: 'from or to is not a real date' };
  }
  if (fromDate > toDate) return { error: 'from is after to' };
  return { fromDate, toDate };
}

app.post('/api/reports/slippage-monthly/test', authRequired, async (req, res) => {
  if (!canManageUsers(req.auth)) return res.status(403).json({ error: 'forbidden' });
  const recipients = parseTestRecipients(req.body);
  if (!recipients.length) return res.status(400).json({ error: 'recipient_required' });
  const period = parseTestPeriod(req.body);
  if (period.error) return res.status(400).json({ error: 'bad_period', message: period.error });
  try {
    res.json(await runSlippageEmailReport({ cadence: 'monthly', recipients, ...period }));
  } catch (e) {
    res.status(502).json({ ok: false, error: 'send_failed', message: e?.message || String(e) });
  }
});

app.post('/api/reports/dealmatch-monthly/test', authRequired, async (req, res) => {
  if (!canManageUsers(req.auth)) return res.status(403).json({ error: 'forbidden' });
  const recipients = parseTestRecipients(req.body);
  if (!recipients.length) return res.status(400).json({ error: 'recipient_required' });
  const period = parseTestPeriod(req.body);
  if (period.error) return res.status(400).json({ error: 'bad_period', message: period.error });
  try {
    res.json(await runDealMatchEmailReport({ cadence: 'monthly', recipients, ...period }));
  } catch (e) {
    res.status(502).json({ ok: false, error: 'send_failed', message: e?.message || String(e) });
  }
});
```

- [ ] **Step 2: Verify the auth gate still covers every route**

Run: `npx vitest run auth/routeCoverage.test.js`
Expected: PASS. This project denies API access by default; a route the gate does
not know about is unreachable rather than unprotected, and this test is what
catches it.

- [ ] **Step 3: Document the new configuration**

In `.env.example`, replace the Daily Digest and Monthly Review blocks added on
2026-08-31 with one block covering all nine:

```
# ── Report schedules ────────────────────────────────────────────────────────
# Three reports x three cadences. Times are Asia/Dubai. Ordering within a
# cadence is deliberate: Deal Match, then Slippage, then Business Summary --
# the Business Summary computes Total Revenue from DealMatch/Run and must not
# run first.
#
# Dailies run Tue-Sat (cron 2-6), each covering the previous day, so every
# trading day gets one daily and nothing fires for a shut market.
# Monthlies run after the weeklies so a 1st that falls on a Saturday does not
# fire two reports in the same minute.
#
# Every _RECIPIENTS below falls back to that report's *_ALERT_RECIPIENTS, so
# all nine work with no change to this file.

# DAILY_DEALMATCH_ENABLED=true
# DAILY_DEALMATCH_CRON=0 7 * * 2-6
# DAILY_DEALMATCH_TIMEZONE=Asia/Dubai
# DAILY_DEALMATCH_RUN_ON_START=false
# DAILY_DEALMATCH_RECIPIENTS=

# DAILY_SLIPPAGE_ENABLED=true
# DAILY_SLIPPAGE_CRON=30 7 * * 2-6
# DAILY_SLIPPAGE_TIMEZONE=Asia/Dubai
# DAILY_SLIPPAGE_RUN_ON_START=false
# DAILY_SLIPPAGE_RECIPIENTS=

# DAILY_DIGEST_ENABLED=true
# DAILY_DIGEST_CRON=0 8 * * 2-6
# DAILY_DIGEST_TIMEZONE=Asia/Dubai
# DAILY_DIGEST_RUN_ON_START=false
# DAILY_DIGEST_RECIPIENTS=

# MONTHLY_DEALMATCH_ENABLED=true
# MONTHLY_DEALMATCH_CRON=0 11 1 * *
# MONTHLY_DEALMATCH_TIMEZONE=Asia/Dubai
# MONTHLY_DEALMATCH_RUN_ON_START=false
# MONTHLY_DEALMATCH_RECIPIENTS=

# MONTHLY_SLIPPAGE_ENABLED=true
# MONTHLY_SLIPPAGE_CRON=30 11 1 * *
# MONTHLY_SLIPPAGE_TIMEZONE=Asia/Dubai
# MONTHLY_SLIPPAGE_RUN_ON_START=false
# MONTHLY_SLIPPAGE_RECIPIENTS=

# MONTHLY_REVIEW_ENABLED=true
# MONTHLY_REVIEW_CRON=0 12 1 * *
# MONTHLY_REVIEW_TIMEZONE=Asia/Dubai
# MONTHLY_REVIEW_RUN_ON_START=false
# MONTHLY_REVIEW_RECIPIENTS=
```

Leave the three `WEEKLY_*` blocks where they are; their defaults are unchanged.

- [ ] **Step 4: Full verification**

```bash
npx vitest run
npx tsc -b --noEmit
node --check server.js
```

Expected: all tests pass, no type errors, `server.js` parses.

- [ ] **Step 5: Commit**

```bash
git add server.js .env.example
git commit -m "Add monthly backfill routes and document all nine schedules"
```

---

## Verification before merge

- [ ] `npx vitest run` — all green
- [ ] `npx tsc -b --noEmit` — clean
- [ ] `node --check server.js` — parses
- [ ] The three weekly emails render the same sha256 as before Task 2 began
- [ ] `node reports/__boot.mjs`-style check shows 9 of 9 registered, no `warnedNoRecipients`
- [ ] Nothing in `reports/` still calls `runWeeklySlippageEmailReport` or `runWeeklyDealMatchEmailReport`:
      `grep -rn "runWeekly\(Slippage\|DealMatch\)" --include=*.js . | grep -v node_modules` returns nothing

**Deploy note:** the schedulers register only at boot. This does nothing until
the app pool restarts, and the boot log is the only place that shows whether all
nine registered.

**After deploy:** send August's two missing monthlies by hand.

```bash
curl -X POST https://app.skylinkscapital.com/api/reports/slippage-monthly/test \
  -H "Content-Type: application/json" \
  -d '{"recipients":"abbas@skylinkscapital.com","from":"2026-08-01","to":"2026-08-31"}'
```
