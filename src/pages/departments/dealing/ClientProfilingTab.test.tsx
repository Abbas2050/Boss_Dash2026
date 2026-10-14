// The Client Profiling tab was reported as showing no results for any date
// range. The cause was upstream of this file -- clientProfileRouter.js called
// the trading backend with no Bearer and got 401 for every request -- but the
// reason it took so long to find is HERE: the router answered 200 with empty
// arrays and a `warning` field, and this tab rendered neither the warning nor
// anything else that distinguished a dead backend from a quiet week.
//
// So the two cases are pinned side by side below, because the whole value of
// the fix is that they look different on screen:
//
//   * an outage must name itself, with a sentence an operator can act on --
//     "HTTP 502" sends them looking in the wrong place;
//   * a range with genuinely no activity must still be a clean empty state,
//     not an error.
//
// This one runs on the suite's default jsdom, so it carries no environment
// docblock of its own -- and it must not even mention the pragma by name in
// this header, because vitest scans the first comment block for it and will
// happily switch this file to node on the strength of a sentence about it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ClientProfilingTab } from "./ClientProfilingTab";

const SESSION_KEY = "slc.session.v2";

// The sentence the router sends for a refused credential. Asserted as the
// router's own words rather than a paraphrase: if the two drift, the tab shows
// something nobody can act on again.
const AUTH_FAILURE =
  "Client profiling is unavailable: the trading backend rejected this server's access token (HTTP 401). " +
  "The backend credential is missing, expired or revoked -- check BACKEND_API_KEY and BACKEND_CLIENT_ID " +
  "with the backend team. This is an authentication failure, not an empty result.";

const EMPTY_RANGE = {
  generatedAt: "2026-10-14T02:15:00Z",
  fromDate: "2026-01-01",
  toDate: "2026-01-02",
  topByEquity: [],
  topByVolume: [],
  topByDailyVolume: [],
  topByDailyRealized: [],
};

const ONE_CLIENT = {
  ...EMPTY_RANGE,
  topByEquity: [
    {
      rank: 1,
      login: 5001,
      name: "Alpha Client",
      equity: 123456.78,
      balance: 120000,
      credit: 0,
      marginLevel: 450,
      floatingPnl: 1234.5,
      openPositionCount: 3,
      totalOpenLots: 12.5,
      dailyRealizedLots: 4.25,
    },
  ],
};

function installFetch(opts: { status?: number; body?: unknown }) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const props = {
  fromDate: "2026-01-01",
  toDate: "2026-01-02",
  onFromDateChange: () => {},
  onToDateChange: () => {},
  onRefresh: () => {},
};

beforeEach(() => {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token: "test.session.jwt",
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

describe("an upstream failure names itself on screen", () => {
  it("shows the router's reason, not a bare HTTP status", async () => {
    installFetch({ status: 502, body: { error: AUTH_FAILURE } });
    render(<ClientProfilingTab {...props} />);

    await waitFor(() => expect(screen.getByText(AUTH_FAILURE)).toBeTruthy());
    // The old message, and the whole of what a reader used to get.
    expect(screen.queryByText("HTTP 502")).toBeNull();
  });

  it("does not also invite the reader to load the range they just loaded", async () => {
    installFetch({ status: 502, body: { error: AUTH_FAILURE } });
    render(<ClientProfilingTab {...props} />);

    await waitFor(() => expect(screen.getByText(AUTH_FAILURE)).toBeTruthy());
    expect(screen.queryByText(/to see rankings/)).toBeNull();
  });

  it("never reads an outage as 'no clients for this period'", async () => {
    installFetch({ status: 503, body: { error: "Client profiling is unavailable: this server could not obtain an access token." } });
    render(<ClientProfilingTab {...props} />);

    await waitFor(() => expect(screen.getByText(/could not obtain an access token/)).toBeTruthy());
    // This is the sentence the bug wore. It belongs to a quiet range only.
    expect(screen.queryByText("No clients found for this period")).toBeNull();
  });

  it("falls back to the status for a failure that never reached our handler", async () => {
    // A proxy 504 with an HTML body: there is no `error` field to show, so the
    // status is all there is -- but the box still has to appear.
    global.fetch = vi.fn(async () =>
      new Response("<html>Gateway Timeout</html>", { status: 504, headers: { "content-type": "text/html" } }),
    ) as unknown as typeof fetch;
    render(<ClientProfilingTab {...props} />);

    await waitFor(() => expect(screen.getByText("HTTP 504")).toBeTruthy());
  });
});

describe("a range with no activity is a clean empty state", () => {
  it("says no clients were found and shows no error", async () => {
    installFetch({ status: 200, body: EMPTY_RANGE });
    render(<ClientProfilingTab {...props} />);

    await waitFor(() => expect(screen.getByText("No clients found for this period")).toBeTruthy());
    expect(screen.queryByText(/Client profiling is unavailable/)).toBeNull();
    expect(screen.queryByText(/^HTTP /)).toBeNull();
  });
});

describe("a range with data still renders it", () => {
  it("lists the client the backend returned", async () => {
    const calls = installFetch({ status: 200, body: ONE_CLIENT });
    render(<ClientProfilingTab {...props} />);

    await waitFor(() => expect(screen.getByText("Alpha Client")).toBeTruthy());
    expect(screen.queryByText("No clients found for this period")).toBeNull();
    expect(calls.some((u) => u.includes("from=2026-01-01") && u.includes("to=2026-01-02"))).toBe(true);
  });
});
