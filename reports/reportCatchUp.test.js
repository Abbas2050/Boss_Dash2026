// @vitest-environment node
//
// The 1 November 2026 miss: a Sunday, the only day of the month with scheduled
// reports and no daily or weekly to keep the app pool awake. Nobody visited the
// site that morning, IIS had no worker running, and node-cron lives inside that
// worker -- so 11:00, 11:30, 12:00 and 12:30 Dubai passed with nothing alive to
// fire them. The first process of the day booted at 17:30, five and a half
// hours late, and had no idea it had missed anything.
//
// Catch-up closes that: on boot each schedule asks "has my last slot already
// been handled?" and runs it if not. A dead pool then delays a report instead
// of losing it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let dir;
let stateFile;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "catchup-"));
  stateFile = path.join(dir, "state.json");
  process.env.WEEKLY_REPORT_STATE_FILE = stateFile;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.WEEKLY_REPORT_STATE_FILE;
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const load = () => import("./reportShared.js");

// Asia/Dubai, UTC+4 all year.
const DUBAI = "Asia/Dubai";

describe("lastScheduledOccurrence", () => {
  it("finds the monthly slot that passed on 1 November", async () => {
    const { lastScheduledOccurrence } = await load();
    // 02:00 Dubai on 2 November -- when the app pool actually came back up.
    const now = new Date("2026-11-01T22:00:00Z");
    const hit = lastScheduledOccurrence("0 12 1 * *", DUBAI, now);
    // 12:00 Dubai on the 1st is 08:00 UTC.
    expect(hit?.toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });

  it("returns null when the last slot is older than the grace window", async () => {
    const { lastScheduledOccurrence, CATCH_UP_GRACE_MS } = await load();
    expect(CATCH_UP_GRACE_MS).toBe(72 * 60 * 60 * 1000);
    // Mid-month: the 1st is weeks back, far outside the window. A report that
    // stale is noise, not news.
    const now = new Date("2026-11-20T06:00:00Z");
    expect(lastScheduledOccurrence("0 12 1 * *", DUBAI, now)).toBeNull();
  });

  it("honours the day-of-week field, so a Sunday is not a daily slot", async () => {
    const { lastScheduledOccurrence } = await load();
    // 10:00 Dubai Sunday 1 Nov. The dailies run Tue-Sat; the most recent one
    // was Saturday 31 October at 08:00 Dubai (04:00 UTC), not today.
    const now = new Date("2026-11-01T06:00:00Z");
    const hit = lastScheduledOccurrence("0 8 * * 2-6", DUBAI, now);
    expect(hit?.toISOString()).toBe("2026-10-31T04:00:00.000Z");
  });

  it("reads the hour in the schedule's timezone, not the server's", async () => {
    const { lastScheduledOccurrence } = await load();
    const now = new Date("2026-11-01T22:00:00Z");
    // The same expression in UTC resolves four hours later than in Dubai.
    expect(lastScheduledOccurrence("0 12 1 * *", "UTC", now)?.toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });

  it("never returns a slot in the future", async () => {
    const { lastScheduledOccurrence } = await load();
    const now = new Date("2026-11-01T07:30:00Z"); // 11:30 Dubai, before the 12:00 slot
    const hit = lastScheduledOccurrence("0 12 1 * *", DUBAI, now);
    expect(hit).toBeNull();
  });
});

describe("runCatchUps", () => {
  const occurrence = new Date("2026-11-01T08:00:00Z");

  it("runs a slot that was missed", async () => {
    const { runCatchUps } = await load();
    const run = vi.fn(async () => ({ ok: true }));
    const result = await runCatchUps([{ label: "BusinessMonthly", occurrence, run }]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.ran).toEqual(["BusinessMonthly"]);
  });

  it("does not run it again on the next boot", async () => {
    const { runCatchUps } = await load();
    const run = vi.fn(async () => ({ ok: true }));
    await runCatchUps([{ label: "BusinessMonthly", occurrence, run }]);
    await runCatchUps([{ label: "BusinessMonthly", occurrence, run }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The app pool recycles every few minutes on this host. Without a durable
  // mark, every recycle would be a fresh boot that re-ran everything.
  it("keeps the mark in the send log, so a new process still sees it", async () => {
    const first = await load();
    await first.runCatchUps([{ label: "BusinessMonthly", occurrence, run: async () => ({ ok: true }) }]);
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    expect(saved["catchup:BusinessMonthly"].window).toBe(occurrence.toISOString());

    vi.resetModules();
    const second = await load();
    const run = vi.fn(async () => ({ ok: true }));
    await second.runCatchUps([{ label: "BusinessMonthly", occurrence, run }]);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the next month's slot once it comes round", async () => {
    const { runCatchUps } = await load();
    const run = vi.fn(async () => ({ ok: true }));
    await runCatchUps([{ label: "BusinessMonthly", occurrence, run }]);
    await runCatchUps([{ label: "BusinessMonthly", occurrence: new Date("2026-12-01T08:00:00Z"), run }]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // Marking before the run, not after: a job that crashes the worker would
  // otherwise be retried by the next boot, which starts the same crash again.
  it("marks the slot even when the run throws, and carries on with the rest", async () => {
    const { runCatchUps } = await load();
    const boom = vi.fn(async () => { throw new Error("backend down"); });
    const after = vi.fn(async () => ({ ok: true }));
    const result = await runCatchUps([
      { label: "BusinessMonthly", occurrence, run: boom },
      { label: "SwapsMonthly", occurrence, run: after },
    ]);
    expect(after).toHaveBeenCalledTimes(1);
    expect(result.failed).toEqual(["BusinessMonthly"]);

    const again = vi.fn(async () => ({ ok: true }));
    await runCatchUps([{ label: "BusinessMonthly", occurrence, run: again }]);
    expect(again).not.toHaveBeenCalled();
  });

  it("runs them one at a time, never in parallel", async () => {
    const { runCatchUps } = await load();
    let live = 0;
    let peak = 0;
    const slow = async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
    };
    await runCatchUps([
      { label: "A", occurrence, run: slow },
      { label: "B", occurrence, run: slow },
      { label: "C", occurrence, run: slow },
    ]);
    expect(peak).toBe(1);
  });

  // With no writable send log there is no mark, so every boot would re-run
  // every report -- on a host that recycles every few minutes, that is a mail
  // flood. Doing nothing is the safe failure.
  it("does nothing at all when the send log cannot be written", async () => {
    vi.resetModules();
    // Every candidate path refuses, the way the live host refuses to create
    // httpdocs/storage (EPERM), leaving getSendLogFile with nothing to return.
    vi.doMock("fs/promises", async (importOriginal) => {
      const real = await importOriginal();
      const deny = async () => { throw new Error("EPERM: operation not permitted"); };
      return { ...real, default: { ...real, open: deny, mkdir: deny }, open: deny, mkdir: deny };
    });
    const { runCatchUps } = await import("./reportShared.js");
    const run = vi.fn(async () => ({ ok: true }));
    const result = await runCatchUps([{ label: "BusinessMonthly", occurrence, run }]);
    vi.doUnmock("fs/promises");
    expect(run).not.toHaveBeenCalled();
    expect(result.skipped).toBe("no-send-log");
  });
});

describe("startReportScheduler and catch-up together", () => {
  const spy = () => {
    const calls = [];
    const fn = (expr, handler, opts) => { calls.push({ expr, handler, opts }); return { stop() {} }; };
    fn.calls = calls;
    return fn;
  };

  const cfg = (over = {}) => ({
    label: "BusinessMonthly",
    defaultCron: "0 12 1 * *",
    enabledVar: "CU_ENABLED",
    cronVar: "CU_CRON",
    timezoneVar: "CU_TZ",
    runOnStartVar: "CU_ROS",
    recipientVars: ["CU_RECIPIENTS"],
    run: async () => {},
    schedule: spy(),
    ...over,
  });

  beforeEach(() => { process.env.CU_RECIPIENTS = "someone@example.com"; });
  afterEach(() => { delete process.env.CU_RECIPIENTS; });

  it("hands back the slot it missed while the app was down", async () => {
    const { startReportScheduler } = await load();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T22:00:00Z"));
    const out = startReportScheduler(cfg());
    expect(out.catchUp?.occurrence.toISOString()).toBe("2026-11-01T08:00:00.000Z");
    expect(out.catchUp?.label).toBe("BusinessMonthly");
  });

  it("hands back nothing when no slot has passed recently", async () => {
    const { startReportScheduler } = await load();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T06:00:00Z"));
    expect(startReportScheduler(cfg()).catchUp).toBeNull();
  });

  // The cron firing normally has to leave the same mark the catch-up looks
  // for. Otherwise the next recycle -- minutes later -- sees an unhandled slot
  // and sends the whole report a second time.
  it("marks the slot when the cron fires, so a later boot does not repeat it", async () => {
    const { startReportScheduler, runCatchUps } = await load();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T08:00:00Z"));
    const schedule = spy();
    const run = vi.fn(async () => ({ ok: true }));
    startReportScheduler(cfg({ schedule, run }));
    await schedule.calls[0].handler();
    expect(run).toHaveBeenCalledTimes(1);

    const later = vi.fn(async () => ({ ok: true }));
    await runCatchUps([{ label: "BusinessMonthly", occurrence: new Date("2026-11-01T08:00:00Z"), run: later }]);
    expect(later).not.toHaveBeenCalled();
  });

  it("offers no catch-up for a disabled report", async () => {
    const { startReportScheduler } = await load();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T22:00:00Z"));
    process.env.CU_ENABLED = "false";
    const out = startReportScheduler(cfg());
    delete process.env.CU_ENABLED;
    expect(out.registered).toBe(false);
    expect(out.catchUp).toBeFalsy();
  });
});
