// The Report Schedule & Recipients panel renders what the server resolved; it
// resolves nothing itself. So these tests feed it a payload and assert the
// three things an operator has to be able to see without asking anyone:
// which variable is in force, which are being shadowed by it, and which
// reports will send nothing at all.
//
// The panel deliberately has no list of its own of the nine reports -- it
// renders whatever the endpoint returns -- so a ten-report payload must
// produce ten cards. The "derived from REPORT_SCHEDULES" guarantee itself is
// asserted server-side in reports/reportRecipientsView.test.js.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import {
  ReportScheduleRecipientsPanel,
  REPORT_SCHEDULE_ENDPOINT,
  type ReportScheduleView,
  type ScheduledReportView,
} from "./ReportScheduleRecipientsPanel";

vi.mock("@/lib/auth", () => ({
  authHeaders: () => ({ Authorization: "Bearer test-token" }),
  getCurrentUser: () => ({ email: "abbas@skylinkscapital.com" }),
}));

function reportView(over: Partial<ScheduledReportView> = {}): ScheduledReportView {
  return {
    label: "BusinessWeekly",
    report: "Business Summary",
    cadence: "weekly",
    enabled: true,
    enabledVar: "WEEKLY_SUMMARY_ENABLED",
    cron: { var: "WEEKLY_SUMMARY_CRON", value: "0 10 * * 6", default: "0 10 * * 6", source: "default" },
    timezone: { var: "WEEKLY_SUMMARY_TIMEZONE", value: "Asia/Dubai", default: "Asia/Dubai", source: "default" },
    recipientChain: [{ var: "SUMMARY_ALERT_RECIPIENTS", recipients: ["talat@skylinkscapital.com"], status: "active" }],
    activeVar: "SUMMARY_ALERT_RECIPIENTS",
    recipients: ["talat@skylinkscapital.com"],
    willNotSend: false,
    ...over,
  };
}

function payload(reports: ScheduledReportView[]): ReportScheduleView {
  return {
    reports,
    total: reports.length,
    willNotSendCount: reports.filter((r) => r.willNotSend).length,
    readOnlyNote: "Read-only. Recipients live in the server's .env and take effect on restart.",
  };
}

function stubFetch(body: unknown, { ok = true, status = 200 } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderWith(body: unknown, opts?: { ok?: boolean; status?: number }) {
  const fetchMock = stubFetch(body, opts);
  render(<ReportScheduleRecipientsPanel />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("what the panel asks for", () => {
  it("reads the admin-gated schedule endpoint, with the session header and no body", async () => {
    const fetchMock = await renderWith(payload([reportView()]));
    expect(fetchMock.mock.calls[0][0]).toBe(REPORT_SCHEDULE_ENDPOINT);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(fetchMock.mock.calls[0][1].method ?? "GET").toBe("GET");
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });
});

describe("every report the server returned is shown", () => {
  // Nine today. The payload drives the count, so a tenth scheduled report
  // appears here with no change to this component.
  const NINE = [
    "DealMatchDaily", "SlippageDaily", "BusinessDaily",
    "DealMatchWeekly", "SlippageWeekly", "BusinessWeekly",
    "DealMatchMonthly", "SlippageMonthly", "BusinessMonthly",
  ];

  it("renders one card per report", async () => {
    await renderWith(payload(NINE.map((label) => reportView({ label }))));
    await waitFor(() => expect(screen.getAllByTestId(/^report-/)).toHaveLength(9));
    for (const label of NINE) expect(screen.getByTestId(`report-${label}`)).toBeTruthy();
  });

  it("renders a tenth without being changed", async () => {
    await renderWith(payload([...NINE, "SomethingNewWeekly"].map((label) => reportView({ label }))));
    await waitFor(() => expect(screen.getAllByTestId(/^report-/)).toHaveLength(10));
    expect(screen.getByText(/10 scheduled reports/)).toBeTruthy();
  });
});

describe("which variable is in force", () => {
  const shadowed = reportView({
    label: "BusinessDaily",
    report: "Business Summary",
    cadence: "daily",
    activeVar: "DAILY_DIGEST_RECIPIENTS",
    recipients: ["talat@skylinkscapital.com"],
    recipientChain: [
      { var: "DAILY_DIGEST_RECIPIENTS", recipients: ["talat@skylinkscapital.com"], status: "active" },
      { var: "SUMMARY_ALERT_RECIPIENTS", recipients: ["abbas@skylinkscapital.com"], status: "overridden" },
    ],
  });

  it("names the winner and marks it in use", async () => {
    await renderWith(payload([shadowed]));
    const card = await screen.findByTestId("report-BusinessDaily");
    expect(card.textContent).toContain("DAILY_DIGEST_RECIPIENTS");
    expect(card.textContent).toContain("In use");
    expect(card.textContent).toContain("talat@skylinkscapital.com");
  });

  it("shows the shadowed variable as overridden, with the addresses it is not delivering to", async () => {
    await renderWith(payload([shadowed]));
    const card = await screen.findByTestId("report-BusinessDaily");
    expect(card.textContent).toContain("SUMMARY_ALERT_RECIPIENTS");
    expect(card.textContent).toContain("Overridden");
    // The operator must be told which line to edit instead, in words.
    expect(card.textContent).toContain("Ignored for this report");
    expect(card.textContent).toContain("only the first non-empty");
    expect(card.textContent).toContain("abbas@skylinkscapital.com");
  });

  it("says outright that variables are not merged", async () => {
    await renderWith(payload([shadowed]));
    expect(screen.getByText(/first one that is not empty/i)).toBeTruthy();
  });
});

describe("a report that will send nothing", () => {
  const silent = reportView({
    label: "SlippageWeekly",
    report: "Slippage",
    activeVar: null,
    recipients: [],
    willNotSend: true,
    recipientChain: [{ var: "SLIPPAGE_ALERT_RECIPIENTS", recipients: [], status: "unset" }],
  });

  it("is warned about on its own card and in the header count", async () => {
    await renderWith(payload([silent, reportView()]));
    const card = await screen.findByTestId("report-SlippageWeekly");
    expect(card.textContent).toContain("Will not send");
    expect(card.textContent).toContain("SLIPPAGE_ALERT_RECIPIENTS");
    expect(screen.getByText(/1 will not send/)).toBeTruthy();
  });

  it("leaves a healthy report unwarned", async () => {
    await renderWith(payload([reportView()]));
    const card = await screen.findByTestId("report-BusinessWeekly");
    expect(card.textContent).not.toContain("Will not send");
    expect(screen.queryByText(/will not send/i)).toBeNull();
  });
});

describe("the cron actually in effect", () => {
  it("shows the default and says the override is unset", async () => {
    await renderWith(payload([reportView()]));
    const card = await screen.findByTestId("report-BusinessWeekly");
    expect(card.textContent).toContain("0 10 * * 6");
    expect(card.textContent).toContain("Asia/Dubai");
    expect(card.textContent).toContain("the coded default");
    expect(card.textContent).toContain("WEEKLY_SUMMARY_CRON");
  });

  it("shows the env override in place of the default, and names both", async () => {
    await renderWith(
      payload([
        reportView({
          cron: { var: "WEEKLY_SUMMARY_CRON", value: "15 6 * * 1", default: "0 10 * * 6", source: "env" },
          timezone: { var: "WEEKLY_SUMMARY_TIMEZONE", value: "Europe/London", default: "Asia/Dubai", source: "env" },
        }),
      ]),
    );
    const card = await screen.findByTestId("report-BusinessWeekly");
    expect(card.textContent).toContain("15 6 * * 1");
    expect(card.textContent).toContain("Europe/London");
    expect(card.textContent).toContain("overriding the default");
    expect(card.textContent).toContain("0 10 * * 6");
    expect(card.textContent).not.toContain("the coded default");
  });
});

describe("it is read-only and says so", () => {
  it("offers no save control and explains where the values live", async () => {
    await renderWith(payload([reportView()]));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/Read-only/i)).toBeTruthy();
    expect(screen.getByText(/take effect on\s+restart/i)).toBeTruthy();
  });
});

describe("when the caller is not an admin", () => {
  it("says so rather than rendering an empty list", async () => {
    await renderWith({ error: "forbidden" }, { ok: false, status: 403 });
    expect(await screen.findByText(/do not have permission/i)).toBeTruthy();
    expect(screen.queryAllByTestId(/^report-/)).toHaveLength(0);
  });
});
