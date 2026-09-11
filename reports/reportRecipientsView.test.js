// @vitest-environment node
//
// What the Report Schedule & Recipients panel is allowed to say.
//
// These are written against the VIEW OBJECT rather than the markup, because
// the thing that can silently be wrong here is the resolution, not the layout:
// resolveRecipients takes the first non-empty variable and stops, and a view
// that merged the chain instead would look perfectly reasonable while telling
// an operator to edit a line that does nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildReportRecipientsView, describeRecipientChain, DEFAULT_TIMEZONE } from "./reportRecipientsView.js";
import { REPORT_SCHEDULES } from "./schedulers.js";

// An env with nothing in it: every report falls back to its coded default and
// has nowhere to send.
const EMPTY = Object.create(null);

function viewFor(env) {
  return buildReportRecipientsView(env);
}

function reportNamed(view, label) {
  return view.reports.find((r) => r.label === label);
}

describe("every scheduled report appears", () => {
  it("has one entry per row of REPORT_SCHEDULES, with the same labels", () => {
    const view = viewFor(EMPTY);
    expect(view.reports).toHaveLength(REPORT_SCHEDULES.length);
    expect(view.total).toBe(REPORT_SCHEDULES.length);
    expect(view.reports.map((r) => r.label).sort()).toEqual(REPORT_SCHEDULES.map((s) => s.label).sort());
  });

  it("splits each label into a report name and a cadence", () => {
    const view = viewFor(EMPTY);
    expect(reportNamed(view, "DealMatchDaily")).toMatchObject({ report: "Deal Match", cadence: "daily" });
    expect(reportNamed(view, "SlippageWeekly")).toMatchObject({ report: "Slippage", cadence: "weekly" });
    expect(reportNamed(view, "BusinessMonthly")).toMatchObject({ report: "Business Summary", cadence: "monthly" });
  });
});

// The assertion that a hardcoded list of nine cannot pass. Comparing a count
// against REPORT_SCHEDULES.length is not enough on its own -- both are nine
// today -- so the table is replaced with a ten-row one and the view must
// follow it.
describe("the list is derived from REPORT_SCHEDULES, not copied", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports a tenth scheduled report the moment the table declares one", async () => {
    vi.doMock("./schedulers.js", () => ({
      REPORT_SCHEDULES: [
        ...REPORT_SCHEDULES,
        {
          label: "SlippageDaily2",
          defaultCron: "0 6 * * 2-6",
          enabledVar: "TENTH_ENABLED",
          cronVar: "TENTH_CRON",
          timezoneVar: "TENTH_TIMEZONE",
          runOnStartVar: "TENTH_RUN_ON_START",
          recipientVars: ["TENTH_RECIPIENTS"],
          run: () => {},
        },
      ],
    }));
    const { buildReportRecipientsView: build } = await import("./reportRecipientsView.js");
    const view = build(EMPTY);

    expect(view.reports).toHaveLength(REPORT_SCHEDULES.length + 1);
    expect(view.total).toBe(REPORT_SCHEDULES.length + 1);
    expect(view.reports.map((r) => r.label)).toContain("SlippageDaily2");
  });
});

describe("the winning recipient variable", () => {
  it("is the first non-empty one, and the rest are reported as overridden", () => {
    // The Business daily reads DAILY_DIGEST_RECIPIENTS then the shared
    // SUMMARY_ALERT_RECIPIENTS. With both set, the shared one does nothing --
    // which is the whole reason the panel exists.
    const view = viewFor({
      DAILY_DIGEST_RECIPIENTS: "talat@skylinkscapital.com",
      SUMMARY_ALERT_RECIPIENTS: "abbas@skylinkscapital.com, ops@skylinkscapital.com",
    });
    const daily = reportNamed(view, "BusinessDaily");

    expect(daily.activeVar).toBe("DAILY_DIGEST_RECIPIENTS");
    expect(daily.recipients).toEqual(["talat@skylinkscapital.com"]);
    expect(daily.recipientChain.map((e) => [e.var, e.status])).toEqual([
      ["DAILY_DIGEST_RECIPIENTS", "active"],
      ["SUMMARY_ALERT_RECIPIENTS", "overridden"],
    ]);
    // The shadowed list is still carried, so the panel can show WHAT is being
    // ignored rather than just that something is.
    expect(daily.recipientChain[1].recipients).toEqual([
      "abbas@skylinkscapital.com",
      "ops@skylinkscapital.com",
    ]);
  });

  it("never merges the chain", () => {
    const view = viewFor({
      DAILY_DIGEST_RECIPIENTS: "talat@skylinkscapital.com",
      SUMMARY_ALERT_RECIPIENTS: "abbas@skylinkscapital.com",
    });
    const daily = reportNamed(view, "BusinessDaily");
    expect(daily.recipients).not.toContain("abbas@skylinkscapital.com");
    expect(daily.recipients).toHaveLength(1);
    expect(daily.recipientChain.filter((e) => e.status === "active")).toHaveLength(1);
  });

  it("falls through an empty variable rather than resolving to nobody", () => {
    // Writing DAILY_DIGEST_RECIPIENTS= in the env file is not a list.
    const view = viewFor({
      DAILY_DIGEST_RECIPIENTS: "",
      SUMMARY_ALERT_RECIPIENTS: "talat@skylinkscapital.com",
    });
    const daily = reportNamed(view, "BusinessDaily");
    expect(daily.activeVar).toBe("SUMMARY_ALERT_RECIPIENTS");
    expect(daily.recipientChain[0].status).toBe("unset");
    expect(daily.recipients).toEqual(["talat@skylinkscapital.com"]);
  });

  it("marks a shadowed variable overridden, and an empty one merely unset", () => {
    const chain = describeRecipientChain(["A", "B", "C"], { A: "", B: "one@x.com", C: "two@x.com" });
    expect(chain.map((e) => e.status)).toEqual(["unset", "active", "overridden"]);
  });
});

describe("a report with nowhere to send", () => {
  it("is flagged will-not-send when no variable in its chain is set", () => {
    const view = viewFor(EMPTY);
    for (const report of view.reports) {
      expect(report.recipients).toEqual([]);
      expect(report.activeVar).toBeNull();
      expect(report.willNotSend).toBe(true);
    }
    expect(view.willNotSendCount).toBe(REPORT_SCHEDULES.length);
  });

  it("is not flagged once any variable in its chain carries an address", () => {
    const view = viewFor({ SUMMARY_ALERT_RECIPIENTS: "talat@skylinkscapital.com" });
    expect(reportNamed(view, "BusinessWeekly").willNotSend).toBe(false);
    expect(reportNamed(view, "SlippageWeekly").willNotSend).toBe(true);
  });

  it("does not flag a report that is switched off, because silence is the point there", () => {
    const view = viewFor({ WEEKLY_SUMMARY_ENABLED: "false" });
    const weekly = reportNamed(view, "BusinessWeekly");
    expect(weekly.enabled).toBe(false);
    expect(weekly.willNotSend).toBe(false);
  });

  it("treats anything but a literal false as enabled, exactly as the scheduler does", () => {
    expect(reportNamed(viewFor({}), "BusinessWeekly").enabled).toBe(true);
    expect(reportNamed(viewFor({ WEEKLY_SUMMARY_ENABLED: "FALSE" }), "BusinessWeekly").enabled).toBe(false);
    expect(reportNamed(viewFor({ WEEKLY_SUMMARY_ENABLED: "yes" }), "BusinessWeekly").enabled).toBe(true);
  });
});

describe("the cron expression actually in effect", () => {
  it("reports the coded default, and says so, when the override is unset", () => {
    const weekly = reportNamed(viewFor(EMPTY), "BusinessWeekly");
    expect(weekly.cron).toEqual({
      var: "WEEKLY_SUMMARY_CRON",
      value: "0 10 * * 6",
      default: "0 10 * * 6",
      source: "default",
    });
    expect(weekly.timezone).toEqual({
      var: "WEEKLY_SUMMARY_TIMEZONE",
      value: DEFAULT_TIMEZONE,
      default: DEFAULT_TIMEZONE,
      source: "default",
    });
  });

  it("reports the env override in place of the default, and keeps the default alongside it", () => {
    const weekly = reportNamed(
      viewFor({ WEEKLY_SUMMARY_CRON: "15 6 * * 1", WEEKLY_SUMMARY_TIMEZONE: "Europe/London" }),
      "BusinessWeekly",
    );
    expect(weekly.cron).toEqual({
      var: "WEEKLY_SUMMARY_CRON",
      value: "15 6 * * 1",
      default: "0 10 * * 6",
      source: "env",
    });
    expect(weekly.timezone).toMatchObject({ value: "Europe/London", source: "env" });
  });

  it("does not treat a blank override as an override", () => {
    const weekly = reportNamed(viewFor({ WEEKLY_SUMMARY_CRON: "   " }), "BusinessWeekly");
    expect(weekly.cron.source).toBe("default");
    expect(weekly.cron.value).toBe("0 10 * * 6");
  });

  it("uses each row's own default, so every report is reported separately", () => {
    const view = viewFor(EMPTY);
    for (const row of REPORT_SCHEDULES) {
      expect(reportNamed(view, row.label).cron.value).toBe(row.defaultCron);
      expect(reportNamed(view, row.label).enabledVar).toBe(row.enabledVar);
    }
  });
});

// The security assertion. This view reads env by explicit variable name only;
// if it ever started enumerating process.env, or echoing a whole config
// object, this is the test that notices.
describe("nothing but recipients, crons, timezones and enabled flags", () => {
  it("carries no value from any other environment variable", () => {
    const secrets = {
      BREVO_API_KEY: "SECRET-brevo-11111111",
      BACKEND_API_KEY: "SECRET-backend-22222222",
      VITE_API_TOKEN: "SECRET-crm-33333333",
      DB_PASSWORD: "SECRET-db-44444444",
      EMAIL_FROM: "SECRET-from-55555555@example.com",
      PUBLIC_BASE_URL: "https://SECRET-host-66666666.example.com",
      DOCUSIGN_CONNECT_HMAC_SECRET: "SECRET-hmac-77777777",
    };
    const view = viewFor({
      ...secrets,
      SUMMARY_ALERT_RECIPIENTS: "talat@skylinkscapital.com",
      WEEKLY_SUMMARY_CRON: "0 10 * * 6",
    });
    const serialised = JSON.stringify(view);

    for (const value of Object.values(secrets)) {
      expect(serialised, `${value} leaked into the report schedule view`).not.toContain(value);
    }
    for (const name of Object.keys(secrets)) {
      expect(serialised, `${name} is named in the report schedule view`).not.toContain(name);
    }
  });

  it("names only the variables REPORT_SCHEDULES declares", () => {
    const allowed = new Set(
      REPORT_SCHEDULES.flatMap((s) => [s.enabledVar, s.cronVar, s.timezoneVar, ...s.recipientVars]),
    );
    for (const report of viewFor(EMPTY).reports) {
      expect(allowed.has(report.enabledVar)).toBe(true);
      expect(allowed.has(report.cron.var)).toBe(true);
      expect(allowed.has(report.timezone.var)).toBe(true);
      for (const entry of report.recipientChain) expect(allowed.has(entry.var)).toBe(true);
    }
  });

  it("says in the payload itself that there is nothing to save here", () => {
    expect(viewFor(EMPTY).readOnlyNote).toMatch(/read-only/i);
    expect(viewFor(EMPTY).readOnlyNote).toMatch(/restart/i);
  });
});
