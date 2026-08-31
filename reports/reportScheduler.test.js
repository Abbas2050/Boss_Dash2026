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
