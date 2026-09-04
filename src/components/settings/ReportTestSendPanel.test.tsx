// The report test-send panel posts a cadence OR a from/to window OR neither.
// These tests are written against the REQUEST THE PANEL ACTUALLY MAKES rather
// than against its markup, because the whole point of the two new controls is
// what ends up in the body: the server 400s cadence_period_conflict on a body
// carrying both, and the panel must be incapable of composing that body.
//
// The first test in "the existing default" is the regression guard for every
// current user of this panel: an operator who picks a report, types an address
// and presses send must send exactly what they sent before the panel grew a
// cadence and a date range.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ReportTestSendPanel, buildTestSendBody, validateDateRange } from "./ReportTestSendPanel";

vi.mock("@/lib/auth", () => ({
  authHeaders: () => ({ Authorization: "Bearer test-token" }),
  getCurrentUser: () => ({ email: "abbas@skylinkscapital.com" }),
}));

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, lps: 4, fromYmd: "2026-08-29", toYmd: "2026-09-04" }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// What the panel posted, parsed back out of the fetch call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function postedBody(fetchMock: any) {
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

async function send() {
  fireEvent.click(screen.getByRole("button", { name: /^Send / }));
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
}

describe("ReportTestSendPanel request body", () => {
  let fetchMock: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchMock = stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("posts recipients and nothing else when nothing but the report is touched", async () => {
    render(<ReportTestSendPanel />);
    await send();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/reports/slippage-weekly/test");
    expect(postedBody(fetchMock)).toEqual({ recipients: ["abbas@skylinkscapital.com"] });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    });
  });

  it.each(["daily", "weekly", "monthly"])("posts cadence %s, and no from/to alongside it", async (cadence) => {
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: cadence } });
    await send();

    const body = postedBody(fetchMock);
    expect(body).toEqual({ recipients: ["abbas@skylinkscapital.com"], cadence });
    expect("from" in body).toBe(false);
    expect("to" in body).toBe(false);
  });

  it("posts a from/to range, and no cadence alongside it", async () => {
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-08-31" } });
    await send();

    const body = postedBody(fetchMock);
    expect(body).toEqual({
      recipients: ["abbas@skylinkscapital.com"],
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect("cadence" in body).toBe(false);
  });

  it("posts to the chosen report's own endpoint", async () => {
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("Report"), { target: { value: "summary" } });
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "monthly" } });
    await send();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/reports/summary-weekly/test");
    expect(postedBody(fetchMock).cadence).toBe("monthly");
  });
});

describe("ReportTestSendPanel: cadence and dates are alternatives", () => {
  let fetchMock: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchMock = stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("stands the date inputs down once a cadence is chosen", () => {
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "daily" } });

    expect((screen.getByLabelText("From date") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("To date") as HTMLInputElement).disabled).toBe(true);
  });

  it("stands the cadence picker down once a date is entered", () => {
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-08-01" } });

    expect((screen.getByLabelText("Cadence") as HTMLSelectElement).disabled).toBe(true);
  });

  it("never posts both, even when both are set -- the guarantee the disabling only suggests", () => {
    const body = buildTestSendBody({
      recipients: ["ops@example.com"],
      cadence: "daily",
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(body).toEqual({ recipients: ["ops@example.com"], cadence: "daily" });
    expect("from" in body).toBe(false);
    expect("to" in body).toBe(false);
  });

  it("Clear period returns the panel to its default request", async () => {
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "monthly" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear period" }));
    await send();

    expect(postedBody(fetchMock)).toEqual({ recipients: ["abbas@skylinkscapital.com"] });
  });
});

describe("ReportTestSendPanel date range validation", () => {
  let fetchMock: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    fetchMock = stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("refuses a from after a to before any request is made", () => {
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-09-01" } });

    expect(screen.getByText("The start date is after the end date.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Send / }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a half-filled range before any request is made", () => {
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-09-01" } });

    expect(screen.getByText("Enter both a start and an end date.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Send / }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validateDateRange accepts an empty range and a same-day range", () => {
    expect(validateDateRange("", "")).toBeNull();
    expect(validateDateRange("2026-09-03", "2026-09-03")).toBeNull();
    expect(validateDateRange("2026-09-10", "2026-09-01")).toBe("The start date is after the end date.");
  });
});

describe("ReportTestSendPanel resolved period and errors", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("names the exact day a daily test covers, without a redundant to-date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T09:00:00Z"));
    stubFetch();
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "daily" } });

    expect(screen.getByText("This test send covers 2026-09-03.")).toBeTruthy();
    vi.useRealTimers();
  });

  it("names the month a monthly test covers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T09:00:00Z"));
    stubFetch();
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "monthly" } });

    expect(screen.getByText("This test send covers 2026-08-01 to 2026-08-31.")).toBeTruthy();
    vi.useRealTimers();
  });

  it("echoes a chosen range back rather than a cadence window", () => {
    stubFetch();
    render(<ReportTestSendPanel />);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-08-15" } });

    expect(screen.getByText("This test send covers 2026-08-01 to 2026-08-15.")).toBeTruthy();
  });

  it("renders the server's conflict code as a sentence, not as the code", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "cadence_period_conflict", message: "send either a cadence or a from/to period, not both" }),
    }) as unknown as typeof fetch;

    render(<ReportTestSendPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Send / }));

    await waitFor(() => screen.getByText("Choose a cadence or a date range, not both."));
  });
});
