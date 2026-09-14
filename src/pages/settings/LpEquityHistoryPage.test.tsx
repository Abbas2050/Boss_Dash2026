// LP Equity History: the two DIFFERENT proxy prefixes on one page, the two
// mutations that must ask first, and the three states that look identical when
// they are wrong.
//
// THE PREFIXES ARE THE POINT OF THIS FILE. This page talks to two backend
// surfaces that are mounted at different depths:
//
//   /LpEquityHistory/lps        -> /api/backend/LpEquityHistory/lps      (no "api")
//   /api/LpEquitySnapshotSchedule -> /api/backend/api/LpEquitySnapshotSchedule (doubled "api")
//
// Getting either one wrong is the single easiest mistake available here, and it
// is also the quietest: a wrong same-origin path on a single-page app is not a
// 404, it is the SPA catch-all answering with index.html and HTTP 200. Three
// settings pages on this project stayed broken in production for weeks that
// way. So each prefix is asserted on its own AND the pair is asserted together,
// including the negative form -- that the "api" segment is absent from one and
// present on the other.
//
// Auth is asserted per verb for the same reason: /api/backend sits behind the
// deny-by-default gate in auth/requireSession.js, so a call that reaches the
// right URL without the dashboard JWT 401s on OUR server. A session is seeded
// into localStorage below precisely so authHeaders() returns a real Bearer and
// these assertions can fail -- with no session it returns {} and would pass
// vacuously.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { LpEquityHistoryPage } from "./LpEquityHistoryPage";
import { formatDubaiInstant } from "@/lib/dubaiTime";

/** Root-mounted on the backend: NO "api" segment under the proxy prefix. */
const LPS_URL = "/api/backend/LpEquityHistory/lps";
const SERIES_PREFIX = "/api/backend/LpEquityHistory/series?";
/** Under the backend's own "api" segment: the doubled "api" is correct. */
const SCHEDULE_URL = "/api/backend/api/LpEquitySnapshotSchedule";

const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

// firstSeen/latestAt arrive with a "+00:00" offset rather than a "Z". 21:22 UTC
// on the 1st is 01:22 on the 2nd in Dubai (UTC+4), so a helper-less render
// cannot accidentally agree with a helper-based one.
const LP_ROWS = [
  {
    login: 900111,
    name: "LMAX Prime",
    source: "Mt5",
    firstSeen: "2026-08-20T10:00:00+00:00",
    latestAt: "2026-09-01T21:22:35+00:00",
  },
];

const SERIES = {
  series: [
    {
      login: 900111,
      name: "LMAX Prime",
      points: [
        {
          timestamp: "2026-09-01T21:22:35+00:00",
          equity: 125000.5,
          balance: 124000,
          credit: 0,
          margin: 1000,
          freeMargin: 124000.5,
          marginLevel: 12500,
          source: "Mt5",
        },
      ],
    },
  ],
};

const SCHEDULE = { snapshotHourUtc: 6, snapshotMinuteUtc: 30, updatedUtc: "2026-09-01T21:22:35+00:00" };

type FetchCall = { url: string; init: RequestInit | undefined };

type FetchState = {
  lps?: unknown;
  lpsStatus?: number;
  series?: unknown;
  seriesStatus?: number;
  schedule?: unknown;
  scheduleStatus?: number;
  runNowBody?: unknown;
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function fail(status: number, body: unknown) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function installFetch(state: FetchState) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith(`${SCHEDULE_URL}/run-now`)) {
      return ok(state.runNowBody ?? { run: { status: "succeeded", recordsProcessed: 32, durationMs: 4100, jobRunId: 9 } });
    }
    if (u === SCHEDULE_URL) {
      const status = state.scheduleStatus ?? 200;
      if (status !== 200) return fail(status, { error: "schedule refused" });
      return ok(state.schedule ?? SCHEDULE);
    }
    if (u.startsWith(SERIES_PREFIX)) {
      const status = state.seriesStatus ?? 200;
      if (status !== 200) return fail(status, { error: "series refused" });
      return ok(state.series ?? SERIES);
    }
    if (u === LPS_URL) {
      const status = state.lpsStatus ?? 200;
      if (status !== 200) return fail(status, { error: "lps refused" });
      return ok(state.lps ?? LP_ROWS);
    }
    // Anything else is a wrong URL, and is answered the way the SPA catch-all
    // would NOT answer it -- so a prefix slip surfaces as a failing assertion
    // rather than as a page that quietly renders nothing.
    return fail(404, { error: "unrouted", url: u });
  });
  global.fetch = fn as unknown as typeof fetch;
  return calls;
}

function callsOfMethod(calls: FetchCall[], method: string) {
  return calls.filter((c) => String(c.init?.method || "GET").toUpperCase() === method);
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers as Record<string, string> | undefined) || {};
}

beforeEach(() => {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: TOKEN,
      user: { id: "u1", name: "T", email: "t@t", role: "Super Admin", access: [], status: "active" },
      at: Date.now(),
    }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the two prefixes on this one page are different, and both are right", () => {
  it("the LP list and the series use the ROOT-mounted prefix, with no api segment", async () => {
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);

    await waitFor(() => expect(calls.some((c) => c.url.startsWith(SERIES_PREFIX))).toBe(true));

    const lpsCall = calls.find((c) => c.url === LPS_URL);
    expect(lpsCall, `expected a GET to ${LPS_URL}; saw ${calls.map((c) => c.url).join(", ")}`).toBeTruthy();
    expect(headersOf(lpsCall!).Authorization).toBe(EXPECTED_AUTH);

    const seriesCall = calls.find((c) => c.url.startsWith(SERIES_PREFIX))!;
    expect(headersOf(seriesCall).Authorization).toBe(EXPECTED_AUTH);

    // The negative form: /api/backend/api/LpEquityHistory/... is the mistake.
    for (const c of calls) {
      expect(c.url.includes("/api/backend/api/LpEquityHistory")).toBe(false);
    }
  });

  it("the snapshot schedule uses the api-segment prefix, doubled api and all", async () => {
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);

    await waitFor(() => expect(calls.some((c) => c.url === SCHEDULE_URL)).toBe(true));
    const call = calls.find((c) => c.url === SCHEDULE_URL)!;
    expect(call.url).toBe("/api/backend/api/LpEquitySnapshotSchedule");
    expect(headersOf(call).Authorization).toBe(EXPECTED_AUTH);

    // The negative form: dropping the backend's own "api" is the mistake.
    for (const c of calls) {
      expect(/^\/api\/backend\/LpEquitySnapshotSchedule/.test(c.url)).toBe(false);
    }
  });

  it("both prefixes appear on the same mount, and they are not the same shape", async () => {
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    const urls = calls.map((c) => c.url);

    expect(urls.some((u) => u.startsWith("/api/backend/LpEquityHistory/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/api/backend/api/LpEquitySnapshotSchedule"))).toBe(true);
    // Every call is on the proxy, and none of them sits at a third shape.
    for (const u of urls) {
      expect(u.startsWith("/api/backend/")).toBe(true);
      expect(
        u.startsWith("/api/backend/LpEquityHistory/") || u.startsWith("/api/backend/api/LpEquitySnapshotSchedule"),
      ).toBe(true);
    }
  });

  it("the series query carries the selected logins and the UTC day bounds", async () => {
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);

    await waitFor(() => expect(calls.some((c) => c.url.startsWith(SERIES_PREFIX))).toBe(true));
    const url = calls.find((c) => c.url.startsWith(SERIES_PREFIX))!.url;
    const qs = new URLSearchParams(url.slice(SERIES_PREFIX.length));
    expect(qs.getAll("logins")).toEqual(["900111"]);
    expect(String(qs.get("from"))).toMatch(/T00:00:00Z$/);
    expect(String(qs.get("to"))).toMatch(/T23:59:59Z$/);
  });
});

describe("nothing that writes or triggers work fires on mount", () => {
  it("mount issues reads only", async () => {
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);

    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    expect(callsOfMethod(calls, "POST")).toEqual([]);
    expect(callsOfMethod(calls, "PUT")).toEqual([]);
    expect(calls.filter((c) => c.url.includes("run-now"))).toEqual([]);
  });
});

describe("run-now asks before it makes the backend go and do something", () => {
  it("sends nothing when the answer is no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);
    await waitFor(() => screen.getByRole("button", { name: "Take Snapshot Now" }));

    fireEvent.click(screen.getByRole("button", { name: "Take Snapshot Now" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/snapshot row/i);
    expect(calls.filter((c) => c.url.includes("run-now"))).toEqual([]);
  });

  it("POSTs run-now on the api-segment prefix once the answer is yes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);
    await waitFor(() => screen.getByRole("button", { name: "Take Snapshot Now" }));

    fireEvent.click(screen.getByRole("button", { name: "Take Snapshot Now" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.url).toBe(`${SCHEDULE_URL}/run-now`);
    expect(headersOf(post).Authorization).toBe(EXPECTED_AUTH);
    await waitFor(() => expect(screen.getByText(/32 snapshot row\(s\) written/)).toBeTruthy());
  });
});

describe("changing the snapshot schedule asks first, and states what it is leaving", () => {
  it("sends nothing when the answer is no, and the prompt names both values", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);
    await waitFor(() => screen.getByLabelText("Hour (0-23)"));

    fireEvent.change(screen.getByLabelText("Hour (0-23)"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Minute (0-59)"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Schedule" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const prompt = String(confirmSpy.mock.calls[0][0]);
    // The value being left, next to the value being moved to: an operator has
    // to be able to see what they are changing FROM.
    expect(prompt).toContain("Current: 06:30 UTC");
    expect(prompt).toContain("New:     07:45 UTC");
    expect(prompt).toMatch(/for everyone/i);
    expect(callsOfMethod(calls, "PUT")).toEqual([]);
  });

  it("PUTs the schedule on the api-segment prefix once the answer is yes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);
    await waitFor(() => screen.getByLabelText("Hour (0-23)"));

    fireEvent.change(screen.getByLabelText("Hour (0-23)"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Minute (0-59)"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Schedule" }));

    await waitFor(() => expect(callsOfMethod(calls, "PUT").length).toBe(1));
    const put = callsOfMethod(calls, "PUT")[0];
    expect(put.url).toBe(SCHEDULE_URL);
    expect(headersOf(put).Authorization).toBe(EXPECTED_AUTH);
    expect(JSON.parse(String(put.init?.body))).toEqual({ snapshotHourUtc: 7, snapshotMinuteUtc: 45 });
  });

  it("refuses an out-of-range hour without asking or calling the API", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({});
    render(<LpEquityHistoryPage />);
    await waitFor(() => screen.getByLabelText("Hour (0-23)"));

    fireEvent.change(screen.getByLabelText("Hour (0-23)"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Schedule" }));

    await waitFor(() => screen.getByText(/Hour must be a whole number from 0 to 23/i));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(callsOfMethod(calls, "PUT")).toEqual([]);
  });
});

describe("loaded-and-empty, not authorised, and other failure are three different states", () => {
  it("an empty series renders the empty state -- not an error", async () => {
    installFetch({ series: { series: [] } });
    render(<LpEquityHistoryPage />);

    await waitFor(() => screen.getByText("No snapshots in the selected range."));
    expect(screen.getByText(/Widen the From\/To window/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Could not load the snapshots.")).toBeNull();
  });

  it("a 401 on the series says we are not allowed -- not that there is nothing", async () => {
    installFetch({ seriesStatus: 401 });
    render(<LpEquityHistoryPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText("This dashboard is not authorised for the LP equity history API.")).toBeTruthy();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    expect(screen.queryByText("No snapshots in the selected range.")).toBeNull();
    expect(screen.queryByText("Could not load the snapshots.")).toBeNull();
  });

  it("a 502 on the series says the load broke -- and borrows neither of the other two", async () => {
    installFetch({ seriesStatus: 502 });
    render(<LpEquityHistoryPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText("Could not load the snapshots.")).toBeTruthy();
    expect(screen.queryByText("No snapshots in the selected range.")).toBeNull();
    expect(screen.queryByText("This dashboard is not authorised for the LP equity history API.")).toBeNull();
  });

  it("an empty LP list is an answer, and a 401 on it is not", async () => {
    const { unmount } = render(<div />);
    unmount();

    installFetch({ lps: [] });
    render(<LpEquityHistoryPage />);
    await waitFor(() => screen.getByText("No LP accounts have ever been snapshotted."));
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();

    installFetch({ lpsStatus: 403 });
    render(<LpEquityHistoryPage />);
    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(/HTTP 403/)).toBeTruthy();
    expect(screen.queryByText("No LP accounts have ever been snapshotted.")).toBeNull();
  });
});

describe("every instant is rendered in Dubai time", () => {
  it("firstSeen, latestAt and the snapshot timestamp all go through formatDubaiInstant", async () => {
    installFetch({});
    render(<LpEquityHistoryPage />);
    await waitFor(() => expect(screen.getAllByText("125,000.50").length).toBeGreaterThan(0));

    const latest = formatDubaiInstant(LP_ROWS[0].latestAt);
    const first = formatDubaiInstant(LP_ROWS[0].firstSeen);
    // Sanity: the helper must actually be doing the UTC+4 shift on a "+00:00"
    // offset, otherwise this test would pass against a helper that had been
    // gutted -- and the offset form is exactly what a past bug mis-parsed.
    expect(latest).toContain("02");
    expect(latest).toContain("01:22:35");

    expect(screen.getAllByText(latest).length).toBeGreaterThan(0);
    expect(screen.getAllByText(first).length).toBeGreaterThan(0);
    // The snapshot row's timestamp is the same instant, rendered the same way.
    expect(screen.getAllByText(latest).length).toBeGreaterThan(1);

    expect(screen.queryByText(LP_ROWS[0].latestAt)).toBeNull();
    expect(screen.queryByText(new Date(LP_ROWS[0].latestAt).toLocaleString())).toBeNull();
  });
});
