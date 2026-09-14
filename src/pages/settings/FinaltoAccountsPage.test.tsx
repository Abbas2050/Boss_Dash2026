// Finalto Accounts: the five verbs, the three load outcomes, the nested
// { aggregate, subAccounts } shape, and the confirmations on the writes that
// change what the rest of the dashboard counts.
//
// Two hazards are pinned here per request rather than once in aggregate:
//
//   1. URL. Three settings pages on this project spent weeks fetching a BARE
//      "/api/<route>" path. On a single-page app that is not a 404 -- the SPA
//      catch-all answers with index.html and HTTP 200, so the page renders
//      empty and nobody reports it. The URL every request must carry is
//      "/api/backend/api/admin/finalto-accounts...": /api/backend is our proxy
//      and /api/admin/finalto-accounts is the backend's own path under it.
//   2. Auth. /api/backend sits behind the deny-by-default gate in
//      auth/requireSession.js, so a call that reaches the right URL without the
//      dashboard JWT 401s on OUR server. A session is seeded into localStorage
//      below precisely so authHeaders() returns a real Bearer and these
//      assertions can fail -- with no session it returns {} and would pass
//      vacuously.
//
// The third hazard is that these endpoints answer 401 today, so the page must
// distinguish THREE outcomes: loaded-and-empty, refused, and broken. Each is
// asserted to exclude the other two.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { FinaltoAccountsPage } from "./FinaltoAccountsPage";
import { formatDubaiInstant } from "@/lib/dubaiTime";

const ACCOUNTS_URL = "/api/backend/api/admin/finalto-accounts";
const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

// Captured live from the backend with an admin session.
const PARENT = {
  id: 52,
  lpName: "Finalto Prime",
  apiLoginText: "SLC_LIVE",
  environment: "Production",
  isActive: true,
};

const AGGREGATE = {
  lpAccountId: 52,
  lpName: "Finalto Prime",
  includeInEquity: true,
  includeInPositions: true,
  includeInDealMatching: false,
  includeInHistory: false,
};

const SUB = {
  id: 301,
  lpAccountId: 52,
  finaltoAccountId: 88123,
  finaltoAccountName: "SLC MAIN",
  finaltoAccountType: "Margin",
  displayName: "Main book",
  isActive: true,
  includeInEquity: true,
  includeInPositions: false,
  includeInDealMatching: false,
  includeInHistory: true,
  firstSeenAtUtc: "2026-08-15T06:10:00Z",
  // 21:22 UTC on the 1st is 01:22 on the 2nd in Dubai (UTC+4), so a helper-less
  // render cannot accidentally agree with a helper-based one here.
  lastSeenAtUtc: "2026-09-01T21:22:35Z",
  updatedAtUtc: "2026-09-01T21:22:35Z",
};

type FetchCall = { url: string; init: RequestInit | undefined };

type FetchState = {
  parents?: unknown[];
  page?: unknown;
  /** Non-2xx status for the parents GET. */
  parentsStatus?: number;
  /** Non-2xx status for the ?lpAccountId= page GET. */
  pageStatus?: number;
  /** Body the refresh POST answers with. */
  refreshBody?: unknown;
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function fail(status: number, body = "upstream said no") {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}

function installFetch(state: FetchState) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "POST" && u.includes("/refresh")) {
      return ok(state.refreshBody ?? { aggregate: AGGREGATE, subAccounts: [SUB] });
    }
    if (method === "PUT") return ok({});
    if (method === "GET" && u.includes("/parents")) {
      if (state.parentsStatus) return fail(state.parentsStatus);
      return ok(state.parents ?? []);
    }
    if (method === "GET") {
      if (state.pageStatus) return fail(state.pageStatus);
      return ok(state.page ?? { aggregate: null, subAccounts: [] });
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

const LOADED = { parents: [PARENT], page: { aggregate: AGGREGATE, subAccounts: [SUB] } };

async function renderLoaded(state: FetchState = LOADED) {
  const calls = installFetch(state);
  render(<FinaltoAccountsPage />);
  await waitFor(() => expect(screen.getAllByText(/Sub-account #88123/).length).toBeGreaterThan(0));
  return calls;
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
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("every request goes to the proxy path and carries the session bearer", () => {
  it("GET reads the parent list from /parents", async () => {
    const calls = await renderLoaded();
    const gets = callsOfMethod(calls, "GET");
    expect(gets[0].url).toBe(`${ACCOUNTS_URL}/parents`);
    expect(authOf(gets[0])).toBe(EXPECTED_AUTH);
  });

  it("GET reads the page shape from the collection URL with ?lpAccountId=", async () => {
    const calls = await renderLoaded();
    const gets = callsOfMethod(calls, "GET");
    expect(gets.length).toBe(2);
    expect(gets[1].url).toBe(`${ACCOUNTS_URL}?lpAccountId=52`);
    expect(authOf(gets[1])).toBe(EXPECTED_AUTH);
  });

  it("PUT saves the aggregate against /aggregate/{lpAccountId}", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = await renderLoaded();

    fireEvent.click(screen.getByLabelText("Aggregate Include in Deal Matching"));
    fireEvent.click(screen.getByRole("button", { name: "Save aggregate" }));

    await waitFor(() => expect(callsOfMethod(calls, "PUT").length).toBe(1));
    const put = callsOfMethod(calls, "PUT")[0];
    expect(put.url).toBe(`${ACCOUNTS_URL}/aggregate/52`);
    expect(authOf(put)).toBe(EXPECTED_AUTH);
    expect(JSON.parse(String(put.init?.body))).toEqual({
      lpName: "Finalto Prime",
      includeInEquity: true,
      includeInPositions: true,
      includeInDealMatching: true,
      includeInHistory: false,
    });
  });

  it("PUT saves a sub-account against /sub/{id}", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = await renderLoaded();

    fireEvent.change(screen.getByLabelText("Sub 301 display name"), { target: { value: "Main book 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save sub-account #88123" }));

    await waitFor(() => expect(callsOfMethod(calls, "PUT").length).toBe(1));
    const put = callsOfMethod(calls, "PUT")[0];
    expect(put.url).toBe(`${ACCOUNTS_URL}/sub/301`);
    expect(authOf(put)).toBe(EXPECTED_AUTH);
    expect(JSON.parse(String(put.init?.body))).toEqual({
      displayName: "Main book 2",
      includeInEquity: true,
      includeInPositions: false,
      includeInDealMatching: false,
      includeInHistory: true,
    });
  });

  it("POST refreshes against /refresh?lpAccountId=", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Refresh from Finalto" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.url).toBe(`${ACCOUNTS_URL}/refresh?lpAccountId=52`);
    expect(authOf(post)).toBe(EXPECTED_AUTH);
  });
});

describe("loaded-and-empty, refused, and broken are three different screens", () => {
  const EMPTY_HEADING = "No saved Finalto accounts.";
  const REFUSED_HEADING = "This dashboard is not authorised for the admin API.";
  const BROKEN_HEADING = "Could not load the Finalto parent accounts.";

  it("[] renders the empty state -- not an error, and not a blank area", async () => {
    installFetch({ parents: [] });
    render(<FinaltoAccountsPage />);

    await waitFor(() => screen.getByText(EMPTY_HEADING));
    expect(screen.getByText(/Add a Finalto LP account on the LP Manager page/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
    expect(screen.queryByText(BROKEN_HEADING)).toBeNull();
  });

  it("401 renders the not-authorised state -- neither empty nor a generic error", async () => {
    installFetch({ parentsStatus: 401 });
    render(<FinaltoAccountsPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(REFUSED_HEADING)).toBeTruthy();
    expect(screen.getByText(/credentials this dashboard authenticates with are not permitted/i)).toBeTruthy();
    expect(screen.getByText(/backend team must grant/i)).toBeTruthy();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    expect(screen.getByText(/finalto-accounts\/parents/)).toBeTruthy();
    // And it borrows the words of neither other state.
    expect(screen.queryByText(EMPTY_HEADING)).toBeNull();
    expect(screen.queryByText(/Add a Finalto LP account on the LP Manager page/i)).toBeNull();
    expect(screen.queryByText(BROKEN_HEADING)).toBeNull();
  });

  it("a non-auth failure renders the generic error -- neither empty nor not-authorised", async () => {
    installFetch({ parentsStatus: 502 });
    render(<FinaltoAccountsPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(BROKEN_HEADING)).toBeTruthy();
    expect(screen.getByText(/This list is not empty - it is unknown/i)).toBeTruthy();
    expect(screen.queryByText(EMPTY_HEADING)).toBeNull();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
  });

  it("the sub-account load tells the same three apart on its own endpoint", async () => {
    installFetch({ parents: [PARENT], pageStatus: 401 });
    render(<FinaltoAccountsPage />);

    await waitFor(() => screen.getByText(REFUSED_HEADING));
    expect(screen.queryByText("No sub-accounts stored for this login.")).toBeNull();
    expect(screen.queryByText("Could not load the Finalto sub-accounts.")).toBeNull();
  });

  it("a login with no stored sub-accounts says so, and is not an error", async () => {
    installFetch({ parents: [PARENT], page: { aggregate: AGGREGATE, subAccounts: [] } });
    render(<FinaltoAccountsPage />);

    await waitFor(() => screen.getByText("No sub-accounts stored for this login."));
    expect(screen.getByText(/Use Refresh from Finalto above/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the nested { aggregate, subAccounts } shape renders", () => {
  it("renders the aggregate switches from the aggregate half", async () => {
    await renderLoaded();

    expect((screen.getByLabelText("Aggregate LP name") as HTMLInputElement).value).toBe("Finalto Prime");
    expect((screen.getByLabelText("Aggregate Include in Equity") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Aggregate Include in Positions") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Aggregate Include in Deal Matching") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Aggregate Include in History") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/LP account #52/)).toBeTruthy();
  });

  it("renders each sub-account with its own switches, independent of the aggregate", async () => {
    await renderLoaded();

    expect(screen.getByText(/\(SLC MAIN\)/)).toBeTruthy();
    expect(screen.getByText("Margin")).toBeTruthy();
    expect((screen.getByLabelText("Sub 301 display name") as HTMLInputElement).value).toBe("Main book");
    // Deliberately the opposite of the aggregate on two switches, so a page that
    // mixed the two halves up would fail here.
    expect((screen.getByLabelText("Sub 301 Include in Positions") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Sub 301 Include in History") as HTMLInputElement).checked).toBe(true);
  });

  it("the refresh response replaces both halves, being the same shape", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderLoaded({
      ...LOADED,
      refreshBody: {
        aggregate: { ...AGGREGATE, lpName: "Finalto Prime (renamed)" },
        subAccounts: [{ ...SUB, id: 302, finaltoAccountId: 88999, finaltoAccountName: "SLC HEDGE" }],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh from Finalto" }));

    await waitFor(() => expect(screen.getAllByText(/Sub-account #88999/).length).toBeGreaterThan(0));
    expect((screen.getByLabelText("Aggregate LP name") as HTMLInputElement).value).toBe("Finalto Prime (renamed)");
    expect(screen.queryByText(/Sub-account #88123/)).toBeNull();
    expect(screen.getByText(/Refreshed 1 sub-account from Finalto/)).toBeTruthy();
  });
});

describe("writes confirm, naming the target and the routing effect", () => {
  it("refresh asks first, names the parent, and sends nothing on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Refresh from Finalto" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("Finalto Prime");
    expect(callsOfMethod(calls, "POST")).toEqual([]);
  });

  it("refresh never fires on mount -- the page load is a read", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = await renderLoaded();

    expect(callsOfMethod(calls, "POST")).toEqual([]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("saving the aggregate names the switch that moves, and sends nothing on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = await renderLoaded();

    fireEvent.click(screen.getByLabelText("Aggregate Include in Deal Matching"));
    fireEvent.click(screen.getByRole("button", { name: "Save aggregate" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const prompt = String(confirmSpy.mock.calls[0][0]);
    expect(prompt).toContain("Finalto Prime");
    expect(prompt).toContain("Include in Deal Matching: off -> on");
    expect(prompt).toMatch(/whole Finalto login/i);
    expect(callsOfMethod(calls, "PUT")).toEqual([]);
  });

  it("saving a sub-account names the sub-account, and sends nothing on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = await renderLoaded();

    fireEvent.click(screen.getByLabelText("Sub 301 Include in Positions"));
    fireEvent.click(screen.getByRole("button", { name: "Save sub-account #88123" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const prompt = String(confirmSpy.mock.calls[0][0]);
    expect(prompt).toContain("#88123");
    expect(prompt).toContain("SLC MAIN");
    expect(prompt).toContain("Include in Positions: off -> on");
    expect(callsOfMethod(calls, "PUT")).toEqual([]);
  });

  it("an untouched row cannot be saved at all", async () => {
    await renderLoaded();
    expect((screen.getByRole("button", { name: "Save aggregate" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save sub-account #88123" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("UTC instants render in Dubai time", () => {
  it("lastSeenAtUtc and updatedAtUtc go through formatDubaiInstant, not the raw instant", async () => {
    await renderLoaded();

    const expected = formatDubaiInstant(SUB.lastSeenAtUtc);
    // Sanity: the helper must actually be doing the UTC+4 shift, otherwise this
    // test would pass against a helper that had been gutted.
    expect(expected).toContain("02");
    expect(expected).toContain("01:22:35");

    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    expect(screen.queryByText(SUB.lastSeenAtUtc)).toBeNull();
    // Nor the value any zone-less `new Date(...).toLocaleString()` would give.
    expect(screen.queryByText(new Date(SUB.lastSeenAtUtc).toLocaleString())).toBeNull();
    expect(document.body.textContent).not.toContain(SUB.firstSeenAtUtc);
    expect(screen.getAllByText(formatDubaiInstant(SUB.firstSeenAtUtc)).length).toBeGreaterThan(0);
  });
});
