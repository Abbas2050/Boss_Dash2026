// Client Account Monitor: the four CRUD verbs, and the two states that look
// identical when they are wrong.
//
// This page is the client-side counterpart of LP Margin Alerts and it reaches
// the trading backend the same way everything else does -- through the
// same-origin proxy prefix, with the dashboard session bearer attached. Two
// things about that have gone wrong on this project before and both are
// asserted here per verb rather than once in aggregate:
//
//   1. URL. Three settings pages spent weeks fetching a BARE "/api/<Route>"
//      path. On a single-page app that is not a 404 -- the SPA catch-all
//      answers with index.html and HTTP 200, so the page renders empty and
//      nobody reports it. The URL every request must carry is
//      "/api/backend/api/ClientAccountMonitor": /api/backend is our proxy and
//      /api/ClientAccountMonitor is the backend's own path under it.
//   2. Auth. /api/backend sits behind the deny-by-default gate in
//      auth/requireSession.js, so a call that reaches the right URL without
//      the JWT 401s on OUR server. A session is seeded into localStorage below
//      precisely so authHeaders() returns a real Bearer and these assertions
//      can fail -- with no session it returns {} and would pass vacuously.
//
// The empty-list and failed-load cases are asserted as mutually exclusive, not
// merely as "something rendered". GET returns [] today, so the empty state is
// the state this page actually ships in; a load failure that fell back to the
// same blank list is the exact disguise the three broken pages wore.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ClientAccountMonitorPage } from "./ClientAccountMonitorPage";
import { formatDubaiInstant } from "@/lib/dubaiTime";

// The live view is fed by the SignalR hub, which needs a real socket. Stubbed
// so these tests exercise only the HTTP surface -- and so the hub's own
// token fetch cannot appear among the fetch calls being asserted on.
vi.mock("@/lib/signalRConnectionManager", () => ({
  SignalRConnectionManager: class {
    onStatusChange(handler: (s: string) => void) {
      handler("disconnected");
      return () => {};
    }
    onEvent() {
      return () => {};
    }
    async connect() {}
    async disconnect() {}
  },
}));

const MONITOR_URL = "/api/backend/api/ClientAccountMonitor";
const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

const ROW = {
  login: 500123,
  name: "Falcon Holdings",
  marginLevelThreshold: 120,
  equityThreshold: 2500,
  notes: "VIP desk",
  // 21:22 UTC on the 1st is 01:22 on the 2nd in Dubai (UTC+4), so a helper-less
  // render cannot accidentally agree with a helper-based one here.
  updatedUtc: "2026-09-01T21:22:35Z",
};

type FetchCall = { url: string; init: RequestInit | undefined };

/**
 * A fetch double that behaves like the real endpoint: GET returns whatever
 * `state.rows` currently holds (so a reload after a mutation sees the new
 * list), mutations answer 204. Set `state.failGet` to make the load fail.
 */
function installFetch(state: { rows: unknown[]; failGet?: boolean }) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "GET") {
      if (state.failGet) {
        return { ok: false, status: 502, text: async () => "upstream unavailable", json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => state.rows, text: async () => JSON.stringify(state.rows) };
    }
    return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
  });
  global.fetch = fn as unknown as typeof fetch;
  return calls;
}

function callsOfMethod(calls: FetchCall[], method: string) {
  return calls.filter((c) => String(c.init?.method || "GET").toUpperCase() === method);
}

function authOf(call: FetchCall): unknown {
  return (call.init?.headers as Record<string, string> | undefined)?.Authorization;
}

beforeEach(() => {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ token: TOKEN, user: { id: "u1", name: "T", email: "t@t", role: "Super Admin", access: [], status: "active" }, at: Date.now() }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("every request goes to the proxy path and carries the session bearer", () => {
  it("GET lists the watchlist through /api/backend/api/ClientAccountMonitor", async () => {
    const calls = installFetch({ rows: [ROW] });
    render(<ClientAccountMonitorPage />);

    await waitFor(() => expect(screen.getAllByText("500123").length).toBeGreaterThan(0));

    const gets = callsOfMethod(calls, "GET");
    expect(gets.length).toBe(1);
    expect(gets[0].url).toBe(MONITOR_URL);
    expect(authOf(gets[0])).toBe(EXPECTED_AUTH);
  });

  it("POST creates against the collection URL", async () => {
    const state = { rows: [] as unknown[] };
    const calls = installFetch(state);
    render(<ClientAccountMonitorPage />);
    await waitFor(() => screen.getByText("No accounts are being monitored yet."));

    fireEvent.change(screen.getByLabelText("Login"), { target: { value: "500999" } });
    fireEvent.change(screen.getByLabelText("MarginLevel <= (%)"), { target: { value: "110" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.url).toBe(MONITOR_URL);
    expect(authOf(post)).toBe(EXPECTED_AUTH);
  });

  it("PUT updates against the per-login URL", async () => {
    const calls = installFetch({ rows: [ROW] });
    render(<ClientAccountMonitorPage />);
    await waitFor(() => expect(screen.getAllByText("500123").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "PUT").length).toBe(1));
    const put = callsOfMethod(calls, "PUT")[0];
    expect(put.url).toBe(`${MONITOR_URL}/500123`);
    expect(authOf(put)).toBe(EXPECTED_AUTH);
  });

  it("DELETE removes against the per-login URL", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ rows: [ROW] });
    render(<ClientAccountMonitorPage />);
    await waitFor(() => expect(screen.getAllByText("500123").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "DELETE").length).toBe(1));
    const del = callsOfMethod(calls, "DELETE")[0];
    expect(del.url).toBe(`${MONITOR_URL}/500123`);
    expect(authOf(del)).toBe(EXPECTED_AUTH);
  });
});

describe("an empty watchlist and a failed load are told apart", () => {
  it("[] renders the empty state -- not an error, and not a blank area", async () => {
    installFetch({ rows: [] });
    render(<ClientAccountMonitorPage />);

    await waitFor(() => screen.getByText("No accounts are being monitored yet."));
    // It says how to fix it, rather than leaving a void that reads as broken.
    expect(screen.getByText(/Register a login above/i)).toBeTruthy();
    // And it is emphatically not the failure state.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Could not load the monitored accounts.")).toBeNull();
  });

  it("a failed load renders an error -- NOT the empty state", async () => {
    installFetch({ rows: [], failGet: true });
    render(<ClientAccountMonitorPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText("Could not load the monitored accounts.")).toBeTruthy();
    // The distinguishing assertion: a failure must never borrow the words that
    // mean "we asked, and the answer was nothing".
    expect(screen.queryByText("No accounts are being monitored yet.")).toBeNull();
    expect(screen.queryByText(/Register a login above/i)).toBeNull();
  });
});

describe("delete is confirmed before anything is destroyed", () => {
  it("asks, and sends no DELETE when the answer is no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({ rows: [ROW] });
    render(<ClientAccountMonitorPage />);
    await waitFor(() => expect(screen.getAllByText("500123").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // The prompt names the login being removed, so it cannot be mistaken for
    // whichever row the finger happened to land on.
    expect(String(confirmSpy.mock.calls[0][0])).toContain("500123");

    await waitFor(() => expect(callsOfMethod(calls, "GET").length).toBe(1));
    expect(callsOfMethod(calls, "DELETE")).toEqual([]);
  });

  it("sends the DELETE only once the answer is yes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ rows: [ROW] });
    render(<ClientAccountMonitorPage />);
    await waitFor(() => expect(screen.getAllByText("500123").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expect(callsOfMethod(calls, "DELETE").length).toBe(1));
  });
});

describe("create and update send the reference page's field names", () => {
  it("POST body carries login, name, marginLevelThreshold, equityThreshold, notes", async () => {
    const calls = installFetch({ rows: [] });
    render(<ClientAccountMonitorPage />);
    await waitFor(() => screen.getByText("No accounts are being monitored yet."));

    fireEvent.change(screen.getByLabelText("Login"), { target: { value: "500999" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kestrel LLC" } });
    fireEvent.change(screen.getByLabelText("MarginLevel <= (%)"), { target: { value: "110" } });
    fireEvent.change(screen.getByLabelText("Equity <="), { target: { value: "1500" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "watch closely" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const body = JSON.parse(String(callsOfMethod(calls, "POST")[0].init?.body));
    expect(body).toEqual({
      login: 500999,
      name: "Kestrel LLC",
      marginLevelThreshold: 110,
      equityThreshold: 1500,
      notes: "watch closely",
    });
  });

  it("PUT body carries the same field names, with the edited value", async () => {
    const calls = installFetch({ rows: [ROW] });
    render(<ClientAccountMonitorPage />);
    await waitFor(() => expect(screen.getAllByText("500123").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    // The editor renders twice (wide table and phone card); both are bound to
    // the same draft, so changing either one is changing the same value.
    fireEvent.change(screen.getAllByLabelText("Edit MarginLevel <= (%)")[0], { target: { value: "95" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "PUT").length).toBe(1));
    const body = JSON.parse(String(callsOfMethod(calls, "PUT")[0].init?.body));
    expect(body).toEqual({
      login: 500123,
      name: "Falcon Holdings",
      marginLevelThreshold: 95,
      equityThreshold: 2500,
      notes: "VIP desk",
    });
  });

  it("refuses an entry with neither threshold set, without calling the API", async () => {
    const calls = installFetch({ rows: [] });
    render(<ClientAccountMonitorPage />);
    await waitFor(() => screen.getByText("No accounts are being monitored yet."));

    fireEvent.change(screen.getByLabelText("Login"), { target: { value: "500999" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));

    await waitFor(() => screen.getByText(/Set at least one threshold/i));
    expect(callsOfMethod(calls, "POST")).toEqual([]);
  });
});

describe("updatedUtc is rendered in Dubai time", () => {
  it("renders through formatDubaiInstant, not the raw instant", async () => {
    installFetch({ rows: [ROW] });
    render(<ClientAccountMonitorPage />);
    await waitFor(() => expect(screen.getAllByText("500123").length).toBeGreaterThan(0));

    const expected = formatDubaiInstant(ROW.updatedUtc);
    // Sanity: the helper must actually be doing the UTC+4 shift, otherwise
    // this test would pass against a helper that had been gutted.
    expect(expected).toContain("02");
    expect(expected).toContain("01:22:35");

    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    expect(screen.queryByText(ROW.updatedUtc)).toBeNull();
    // Nor the value any zone-less `new Date(...).toLocaleString()` would give.
    expect(screen.queryByText(new Date(ROW.updatedUtc).toLocaleString())).toBeNull();
  });
});
