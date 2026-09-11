// @vitest-environment node
//
// The admin gate on GET /api/reports/schedule.
//
// The gate is tested through the handler rather than by booting Express,
// because importing server.js starts a real listener and a database pool as a
// side effect of module load. The registration in server.js is checked by
// reading the source, the same way auth/routeCoverage.test.js does it.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { makeReportScheduleHandler } from "./reportScheduleRoute.js";
import { REPORT_SCHEDULES } from "./schedulers.js";

// Enough of an Express response to record what the handler decided.
function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const ADMIN = { sub: "1", role: "admin" };
const VIEWER = { sub: "2", role: "viewer" };
const canManage = (auth) => auth?.role === "admin";

describe("GET /api/reports/schedule access", () => {
  it("refuses a caller who cannot manage users", () => {
    const res = fakeRes();
    makeReportScheduleHandler({ canManage, env: {} })({ auth: VIEWER }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("refuses a request with no session payload at all", () => {
    const res = fakeRes();
    makeReportScheduleHandler({ canManage, env: {} })({}, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("answers an admin with one entry per scheduled report", () => {
    const res = fakeRes();
    makeReportScheduleHandler({ canManage, env: {} })({ auth: ADMIN }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.reports).toHaveLength(REPORT_SCHEDULES.length);
  });

  it("refuses to be constructed without a gate at all", () => {
    expect(() => makeReportScheduleHandler()).toThrow(/canManage/);
  });

  it("passes the payload through the repo's redaction before answering", () => {
    // Nothing here should ever look like a credential, but a mistyped .env can
    // put anything in any variable, so the scrubber runs regardless. A 32+ hex
    // run is one of the shapes redactSecrets recognises.
    const res = fakeRes();
    makeReportScheduleHandler({
      canManage,
      env: { SUMMARY_ALERT_RECIPIENTS: "deadbeefdeadbeefdeadbeefdeadbeef@example.com" },
    })({ auth: ADMIN }, res);

    const weekly = res.body.reports.find((r) => r.label === "BusinessWeekly");
    expect(weekly.recipients[0]).toContain("[REDACTED]");
  });

  it("does not expose a write path", () => {
    // The handler is a reader. It never touches process.env and has no branch
    // that could; this pins the shape so a later "while we're here" edit that
    // added one would have to delete a test to do it.
    const handler = makeReportScheduleHandler({ canManage, env: {} });
    const res = fakeRes();
    const req = { auth: ADMIN, method: "GET", body: { SUMMARY_ALERT_RECIPIENTS: "x@y.com" } };
    handler(req, res);
    expect(process.env.SUMMARY_ALERT_RECIPIENTS).toBeUndefined();
  });
});

describe("how server.js registers the route", () => {
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");

  it("mounts it read-only, behind authRequired and the admin gate", () => {
    const at = SERVER.indexOf("'/api/reports/schedule'");
    expect(at, "the report schedule route is not registered in server.js").toBeGreaterThan(-1);

    const registration = SERVER.slice(at, at + 300);
    expect(registration).toMatch(/authRequired/);
    expect(registration).toMatch(/adminOnly|canManageUsers/);
    // GET only: there is deliberately no way to edit .env from the dashboard.
    expect(SERVER.slice(Math.max(0, at - 40), at)).toMatch(/app\.get\(\s*$/);
    expect(SERVER).not.toMatch(/app\.(post|put|patch|delete)\(\s*'\/api\/reports\/schedule'/);
  });
});

// A guard against the suite above going quiet: if the handler stopped calling
// the gate, these fakes would still be called and the assertions would still
// have something to say.
describe("the gate is actually consulted", () => {
  it("asks canManage exactly once per request, with the session payload", () => {
    const spy = vi.fn().mockReturnValue(true);
    const res = fakeRes();
    makeReportScheduleHandler({ canManage: spy, env: {} })({ auth: ADMIN }, res);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(ADMIN);
  });
});
