// @vitest-environment node
//
// These exercise the handler object that server.js registers, not server.js
// itself: importing server.js opens a real listener and DB pool on load.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  parseTestCadence,
  parseTestRecipients,
  makeReportTestSendHandler,
  makeCadenceRunner,
  VALID_CADENCES,
} from "./testSendRequest.js";
import { CADENCES } from "./reportShared.js";

// Minimal express-ish res: records what the handler said instead of writing it.
function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

// A stand-in for runSlippageEmailReport / runDealMatchEmailReport that records
// the argument object it was called with -- the thing under test is what
// reaches the runner, not merely that nothing threw.
function fakeRun(result = { ok: true }) {
  return vi.fn(async () => result);
}

const RECIPIENTS = ["ops@example.com"];

describe("VALID_CADENCES", () => {
  it("is exactly the keys of CADENCES, so a new cadence is accepted without editing this module", () => {
    expect(VALID_CADENCES).toEqual(Object.keys(CADENCES));
    expect(VALID_CADENCES).toContain("daily");
    expect(VALID_CADENCES).toContain("weekly");
    expect(VALID_CADENCES).toContain("monthly");
  });
});

describe("parseTestCadence", () => {
  it("returns {} when cadence is absent, so the run function keeps its own default", () => {
    expect(parseTestCadence({})).toEqual({});
    expect(parseTestCadence(undefined)).toEqual({});
    expect(parseTestCadence({ recipients: "a@b.c" })).toEqual({});
  });

  it("returns {} for an empty or whitespace cadence, which is an unset form field, not a choice", () => {
    expect(parseTestCadence({ cadence: "" })).toEqual({});
    expect(parseTestCadence({ cadence: "   " })).toEqual({});
  });

  it.each(["daily", "weekly", "monthly"])("accepts %s", (cadence) => {
    expect(parseTestCadence({ cadence })).toEqual({ cadence });
  });

  it("trims and lowercases, so a form value with stray case or spacing still resolves", () => {
    expect(parseTestCadence({ cadence: " Daily " })).toEqual({ cadence: "daily" });
    expect(parseTestCadence({ cadence: "MONTHLY" })).toEqual({ cadence: "monthly" });
  });

  it("rejects an unknown cadence and names both what was sent and what is accepted", () => {
    const result = parseTestCadence({ cadence: "day" });
    expect(result.cadence).toBeUndefined();
    expect(result.error).toContain("day");
    expect(result.error).toContain("weekly");
  });

  it("rejects a non-string cadence rather than coercing it", () => {
    expect(parseTestCadence({ cadence: 7 }).error).toBeTruthy();
    expect(parseTestCadence({ cadence: ["daily"] }).error).toBeTruthy();
    expect(parseTestCadence({ cadence: true }).error).toBeTruthy();
  });

  it("never falls back to weekly for a bad value", () => {
    expect(parseTestCadence({ cadence: "yearly" }).cadence).toBeUndefined();
  });
});

describe("parseTestRecipients", () => {
  it("accepts an array and a comma-separated string, and drops blanks", () => {
    expect(parseTestRecipients({ recipients: ["a@b.c", " d@e.f "] })).toEqual(["a@b.c", "d@e.f"]);
    expect(parseTestRecipients({ recipients: "a@b.c, d@e.f" })).toEqual(["a@b.c", "d@e.f"]);
    expect(parseTestRecipients({ recipients: " , " })).toEqual([]);
    expect(parseTestRecipients({})).toEqual([]);
  });
});

describe("makeReportTestSendHandler -- cadence routes", () => {
  it.each(["daily", "weekly", "monthly"])(
    "passes cadence %s through to the runner exactly as the schedulers do",
    async (cadence) => {
      const run = fakeRun();
      const res = fakeRes();
      await makeReportTestSendHandler({ run })({ body: { recipients: RECIPIENTS, cadence } }, res);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toEqual({ recipients: RECIPIENTS, cadence });
      expect(res.statusCode).toBe(200);
    },
  );

  it("calls the runner with recipients ONLY when cadence is omitted -- the regression guard for every existing caller", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await makeReportTestSendHandler({ run })({ body: { recipients: RECIPIENTS } }, res);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({ recipients: RECIPIENTS });
    expect("cadence" in run.mock.calls[0][0]).toBe(false);
  });

  it("returns the runner's own result body unchanged", async () => {
    const run = fakeRun({ ok: true, sent: 3 });
    const res = fakeRes();
    await makeReportTestSendHandler({ run })({ body: { recipients: RECIPIENTS } }, res);
    expect(res.body).toEqual({ ok: true, sent: 3 });
  });

  it("400s on an invalid cadence and does NOT send", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await makeReportTestSendHandler({ run })(
      { body: { recipients: RECIPIENTS, cadence: "fortnightly" } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("bad_cadence");
    expect(res.body.message).toContain("fortnightly");
    expect(run).not.toHaveBeenCalled();
  });

  it("400s rather than quietly sending a weekly, which would let an operator believe they checked the daily", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await makeReportTestSendHandler({ run })({ body: { recipients: RECIPIENTS, cadence: "day" } }, res);
    expect(res.statusCode).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("400s recipient_required with no recipients and does NOT send", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await makeReportTestSendHandler({ run })({ body: { cadence: "daily" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "recipient_required" });
    expect(run).not.toHaveBeenCalled();
  });

  it("400s recipient_required on an empty body, with no env fallback", async () => {
    const run = fakeRun();
    const previous = process.env.SLIPPAGE_ALERT_RECIPIENTS;
    process.env.SLIPPAGE_ALERT_RECIPIENTS = "someone@example.com";
    try {
      const res = fakeRes();
      await makeReportTestSendHandler({ run })({ body: {} }, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "recipient_required" });
      expect(run).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.SLIPPAGE_ALERT_RECIPIENTS;
      else process.env.SLIPPAGE_ALERT_RECIPIENTS = previous;
    }
  });

  it("checks recipients before cadence, so a caller missing both is told about recipients first", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await makeReportTestSendHandler({ run })({ body: { cadence: "nonsense" } }, res);
    expect(res.body).toEqual({ error: "recipient_required" });
  });

  it("400s when a cadence and a from/to period arrive together, instead of honouring one silently", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await makeReportTestSendHandler({ run })(
      { body: { recipients: RECIPIENTS, cadence: "daily", from: "2026-08-01", to: "2026-08-31" } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("cadence_period_conflict");
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores from/to when no cadence is sent, exactly as this route always has", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await makeReportTestSendHandler({ run })(
      { body: { recipients: RECIPIENTS, from: "2026-08-01", to: "2026-08-31" } },
      res,
    );
    expect(run.mock.calls[0][0]).toEqual({ recipients: RECIPIENTS });
  });

  it("502s send_failed when the runner throws, and never leaks a stack", async () => {
    const run = vi.fn(async () => {
      throw new Error("smtp refused");
    });
    const res = fakeRes();
    await makeReportTestSendHandler({ run })({ body: { recipients: RECIPIENTS } }, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ ok: false, error: "send_failed", message: "smtp refused" });
  });
});

describe("makeReportTestSendHandler -- fixed-cadence monthly backfill routes", () => {
  const monthly = (run) =>
    makeReportTestSendHandler({ run, cadence: "monthly", allowPeriod: true });

  it("still sends monthly with a caller-chosen from/to window", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await monthly(run)(
      { body: { recipients: RECIPIENTS, from: "2026-08-01", to: "2026-08-31" } },
      res,
    );
    const args = run.mock.calls[0][0];
    expect(args.cadence).toBe("monthly");
    expect(args.recipients).toEqual(RECIPIENTS);
    expect(args.fromDate.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(args.toDate.toISOString()).toBe("2026-08-31T23:59:59.000Z");
  });

  it("still sends monthly with no period at all", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await monthly(run)({ body: { recipients: RECIPIENTS } }, res);
    expect(run.mock.calls[0][0]).toEqual({ recipients: RECIPIENTS, cadence: "monthly" });
  });

  it("400s bad_period on an impossible date and does NOT send", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await monthly(run)({ body: { recipients: RECIPIENTS, from: "2026-02-30", to: "2026-03-01" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("bad_period");
    expect(run).not.toHaveBeenCalled();
  });

  it("400s a body cadence rather than letting it contradict the route's fixed monthly", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await monthly(run)({ body: { recipients: RECIPIENTS, cadence: "daily" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("cadence_not_allowed");
    expect(run).not.toHaveBeenCalled();
  });

  it("400s even a body cadence of monthly, so the two mechanisms are never both in play", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await monthly(run)({ body: { recipients: RECIPIENTS, cadence: "monthly" } }, res);
    expect(res.statusCode).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("400s recipient_required with no recipients and does NOT send", async () => {
    const run = fakeRun();
    const res = fakeRes();
    await monthly(run)({ body: { from: "2026-08-01", to: "2026-08-31" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "recipient_required" });
    expect(run).not.toHaveBeenCalled();
  });
});

// The Business Summary family is three separate run functions, not one that
// takes a cadence, so the cadence-to-runner mapping is the thing to test: a
// request for the monthly review must not quietly rehearse the weekly summary.
describe("makeCadenceRunner -- the Business Summary family", () => {
  const runners = () => ({
    daily: fakeRun({ ok: true, which: "daily" }),
    weekly: fakeRun({ ok: true, which: "weekly" }),
    monthly: fakeRun({ ok: true, which: "monthly" }),
  });

  const summaryHandler = (map) =>
    makeReportTestSendHandler({ run: makeCadenceRunner(map), allowPeriod: true });

  it.each(["daily", "weekly", "monthly"])("routes cadence %s to that cadence's own runner, and to no other", async (cadence) => {
    const map = runners();
    const res = fakeRes();
    await summaryHandler(map)({ body: { recipients: RECIPIENTS, cadence } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, which: cadence });
    for (const [key, run] of Object.entries(map)) {
      expect(run).toHaveBeenCalledTimes(key === cadence ? 1 : 0);
    }
  });

  it("hands the runner recipients only -- the cadence is consumed here, not forwarded to a runner that has no use for it", async () => {
    const map = runners();
    const res = fakeRes();
    await summaryHandler(map)({ body: { recipients: RECIPIENTS, cadence: "monthly" } }, res);
    expect(map.monthly.mock.calls[0][0]).toEqual({ recipients: RECIPIENTS });
  });

  it("with no cadence, calls the WEEKLY runner with recipients only -- exactly what this route did before it took a cadence", async () => {
    const map = runners();
    const res = fakeRes();
    await summaryHandler(map)({ body: { recipients: RECIPIENTS } }, res);

    expect(map.weekly).toHaveBeenCalledTimes(1);
    expect(map.weekly.mock.calls[0][0]).toEqual({ recipients: RECIPIENTS });
    expect(map.daily).not.toHaveBeenCalled();
    expect(map.monthly).not.toHaveBeenCalled();
  });

  it("passes a caller-chosen from/to window through to the default runner", async () => {
    const map = runners();
    const res = fakeRes();
    await summaryHandler(map)(
      { body: { recipients: RECIPIENTS, from: "2026-08-01", to: "2026-08-31" } },
      res,
    );
    const args = map.weekly.mock.calls[0][0];
    expect(args.fromDate.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(args.toDate.toISOString()).toBe("2026-08-31T23:59:59.000Z");
    expect("cadence" in args).toBe(false);
  });

  it("400s a cadence sent alongside a period, and no runner is called at all", async () => {
    const map = runners();
    const res = fakeRes();
    await summaryHandler(map)(
      { body: { recipients: RECIPIENTS, cadence: "daily", from: "2026-08-01", to: "2026-08-31" } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("cadence_period_conflict");
    for (const run of Object.values(map)) expect(run).not.toHaveBeenCalled();
  });

  it("400s an unknown cadence at the handler, so a missing runner never becomes a 502", async () => {
    const map = runners();
    const res = fakeRes();
    await summaryHandler(map)({ body: { recipients: RECIPIENTS, cadence: "quarterly" } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("bad_cadence");
    for (const run of Object.values(map)) expect(run).not.toHaveBeenCalled();
  });

  it("throws rather than silently sending something else when a family has no runner for a cadence", () => {
    const partial = makeCadenceRunner({ weekly: fakeRun() });
    expect(() => partial({ cadence: "daily", recipients: RECIPIENTS })).toThrow(/daily/);
  });
});

// The gate itself lives in server.js (it needs canManageUsers), so it is
// checked the way auth/routeCoverage.test.js checks routes: by reading the
// source. Booting the app to assert it is not an option here -- see the header.
describe("admin gating on the report test-send routes", () => {
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");
  const ROUTE_RE = /app\.post\(\s*'(\/api\/reports\/[^']*\/test)'/g;

  it("finds all seven test-send routes, so the assertion below is not vacuous", () => {
    expect([...SERVER.matchAll(ROUTE_RE)].map((m) => m[1])).toHaveLength(7);
  });

  it("gates every one of them on canManageUsers, directly or via adminOnly", () => {
    for (const m of SERVER.matchAll(ROUTE_RE)) {
      // The gate is either the adminOnly middleware named at registration or
      // the inline canManageUsers check that is the handler's first statement;
      // both sit within a few lines of the route string.
      const registration = SERVER.slice(m.index, m.index + 400);
      expect(
        /adminOnly|canManageUsers/.test(registration),
        `${m[1]} is registered without an admin gate`,
      ).toBe(true);
    }
  });

  it("keeps the cadence-aware routes on the shared handler", () => {
    expect(SERVER).toMatch(/'\/api\/reports\/slippage-weekly\/test',[\s\S]{0,160}makeReportTestSendHandler\(\{ run: runSlippageEmailReport, allowPeriod: true \}\)/);
    expect(SERVER).toMatch(/'\/api\/reports\/dealmatch-weekly\/test',[\s\S]{0,160}makeReportTestSendHandler\(\{ run: runDealMatchEmailReport, allowPeriod: true \}\)/);
  });

  it("puts the Business Summary route on the same handler, fanned out over its three runners", () => {
    const registration = SERVER.slice(SERVER.indexOf("'/api/reports/summary-weekly/test'"));
    const body = registration.slice(0, registration.indexOf("));") + 3);
    expect(body).toContain("makeReportTestSendHandler");
    expect(body).toContain("makeCadenceRunner");
    expect(body).toMatch(/daily: runDailyDigest/);
    expect(body).toMatch(/weekly: runWeeklyBusinessSummary/);
    expect(body).toMatch(/monthly: runMonthlyReview/);
  });
});
