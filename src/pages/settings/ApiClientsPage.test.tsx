// API Clients: the seven verbs, the three load outcomes, and the one thing that
// must never be rendered twice.
//
// Two hazards are pinned here per request rather than once in aggregate:
//
//   1. URL. Three settings pages on this project spent weeks fetching a BARE
//      "/api/<route>" path. On a single-page app that is not a 404 -- the SPA
//      catch-all answers with index.html and HTTP 200, so the page renders
//      empty and nobody reports it. The URL every request must carry is
//      "/api/backend/api/admin/api-clients": /api/backend is our proxy and
//      /api/admin/api-clients is the backend's own path under it.
//   2. Auth. /api/backend sits behind the deny-by-default gate in
//      auth/requireSession.js, so a call that reaches the right URL without the
//      dashboard JWT 401s on OUR server. A session is seeded into localStorage
//      below precisely so authHeaders() returns a real Bearer and these
//      assertions can fail -- with no session it returns {} and would pass
//      vacuously.
//
// The third hazard is specific to this page. These endpoints answer 401 today
// and the reason is an open question with the backend team, so the page must
// distinguish THREE outcomes: loaded-and-empty, refused, and broken. Each is
// asserted to exclude the other two. A 401 that fell back to the empty list is
// the exact disguise the three broken pages wore.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ApiClientsPage } from "./ApiClientsPage";
import { formatDubaiInstant } from "@/lib/dubaiTime";

const CLIENTS_URL = "/api/backend/api/admin/api-clients";
const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

// The full secret. It is created by the backend, revealed once, and must never
// appear in any list rendering -- so it is also planted on the list payload
// below, where a careless column would print it.
const RAW_KEY = "slc_live_0f3a9d21c7b84e6fa5d2SECRETVALUE";

const CLIENT = {
  id: 7,
  name: "Worker Host",
  description: "the worker host caller",
  keyPrefixes: ["slc_live"],
  keyCount: 1,
  scopes: ["worker-host"],
  isActive: true,
  // 21:22 UTC on the 1st is 01:22 on the 2nd in Dubai (UTC+4), so a helper-less
  // render cannot accidentally agree with a helper-based one here.
  createdAtUtc: "2026-09-01T21:22:35Z",
  createdBy: "abbas",
  lastUsedAtUtc: null,
  activeTokenCount: 2,
};

const TOKEN_ROW = {
  id: 91,
  keyPrefix: "slc_live",
  scopes: ["worker-host"],
  issuedAtUtc: "2026-09-01T21:22:35Z",
  expiresAtUtc: "2026-09-02T21:22:35Z",
  lastUsedAtUtc: null,
  issuedFromIp: "10.0.0.4",
};

type FetchCall = { url: string; init: RequestInit | undefined };

type FetchState = {
  clients?: unknown[];
  tokens?: unknown[];
  /** Non-2xx status for the client-list GET (401 to refuse it, 500 to break it). */
  listStatus?: number;
  /** Non-2xx status for the tokens GET. */
  tokensStatus?: number;
  /** Body the create/mint endpoints answer with. */
  keyResponse?: unknown;
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function fail(status: number, body = "upstream said no") {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}

/**
 * A fetch double that routes on URL + method the way the backend does, so a
 * reload after a mutation sees the list the test set up.
 */
function installFetch(state: FetchState) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "GET" && u.endsWith("/tokens")) {
      if (state.tokensStatus) return fail(state.tokensStatus);
      return ok(state.tokens ?? []);
    }
    if (method === "GET") {
      if (state.listStatus) return fail(state.listStatus);
      return ok(state.clients ?? []);
    }
    if (method === "POST" && (u.endsWith("/keys") || u === CLIENTS_URL)) {
      return ok(state.keyResponse ?? { rawKey: RAW_KEY, keyPrefix: "slc_live" });
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

/** Opens the row editor on the first client row (the table and the phone card
 *  render the same buttons, and both are in the DOM under jsdom). */
function openEditor() {
  fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
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
  it("GET lists the clients through /api/backend/api/admin/api-clients", async () => {
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);

    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    const gets = callsOfMethod(calls, "GET");
    expect(gets.length).toBe(1);
    expect(gets[0].url).toBe(CLIENTS_URL);
    expect(authOf(gets[0])).toBe(EXPECTED_AUTH);
  });

  it("POST creates against the collection URL", async () => {
    const calls = installFetch({ clients: [] });
    render(<ApiClientsPage />);
    await waitFor(() => screen.getByText("No API clients are configured yet."));

    fireEvent.click(screen.getByRole("button", { name: "New API Client" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Caller" } });
    fireEvent.click(screen.getByLabelText("Scope readonly"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.url).toBe(CLIENTS_URL);
    expect(authOf(post)).toBe(EXPECTED_AUTH);
  });

  it("PATCH updates against the per-client URL", async () => {
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    openEditor();
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "PATCH").length).toBe(1));
    const patch = callsOfMethod(calls, "PATCH")[0];
    expect(patch.url).toBe(`${CLIENTS_URL}/7`);
    expect(authOf(patch)).toBe(EXPECTED_AUTH);
  });

  it("DELETE removes against the per-client URL", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "DELETE").length).toBe(1));
    const del = callsOfMethod(calls, "DELETE")[0];
    expect(del.url).toBe(`${CLIENTS_URL}/7`);
    expect(authOf(del)).toBe(EXPECTED_AUTH);
  });

  it("GET reads the token drilldown from the per-client /tokens URL", async () => {
    const calls = installFetch({ clients: [CLIENT], tokens: [TOKEN_ROW] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "View tokens" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "GET").length).toBe(2));
    const tokensGet = callsOfMethod(calls, "GET")[1];
    expect(tokensGet.url).toBe(`${CLIENTS_URL}/7/tokens`);
    expect(authOf(tokensGet)).toBe(EXPECTED_AUTH);
  });

  it("POST mints a key against the per-client /keys URL", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Add second key" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.url).toBe(`${CLIENTS_URL}/7/keys`);
    expect(authOf(post)).toBe(EXPECTED_AUTH);
    expect(JSON.parse(String(post.init?.body))).toEqual({ environment: "live" });
  });

  it("POST revokes a token against the per-token /revoke URL", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ clients: [CLIENT], tokens: [TOKEN_ROW] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "View tokens" })[0]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revoke" }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    const post = callsOfMethod(calls, "POST")[0];
    expect(post.url).toBe(`${CLIENTS_URL}/7/tokens/91/revoke`);
    expect(authOf(post)).toBe(EXPECTED_AUTH);
  });
});

describe("loaded-and-empty, refused, and broken are three different screens", () => {
  const EMPTY_HEADING = "No API clients are configured yet.";
  const REFUSED_HEADING = "This dashboard is not authorised for the admin API.";
  const BROKEN_HEADING = "Could not load the API clients.";

  it("[] renders the empty state -- not an error, and not a blank area", async () => {
    installFetch({ clients: [] });
    render(<ApiClientsPage />);

    await waitFor(() => screen.getByText(EMPTY_HEADING));
    // It says how to fix it, rather than leaving a void that reads as broken.
    expect(screen.getByText(/Use New API Client above/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
    expect(screen.queryByText(BROKEN_HEADING)).toBeNull();
  });

  it("401 renders the not-authorised state -- neither empty nor a generic error", async () => {
    installFetch({ listStatus: 401 });
    render(<ApiClientsPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(REFUSED_HEADING)).toBeTruthy();
    // The explanation must name the cause and the repair, so a reader who opens
    // this page before access is granted understands it without reading code.
    expect(screen.getByText(/credentials this dashboard authenticates with are not permitted/i)).toBeTruthy();
    expect(screen.getByText(/backend team must grant/i)).toBeTruthy();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    // And it borrows the words of neither other state.
    expect(screen.queryByText(EMPTY_HEADING)).toBeNull();
    expect(screen.queryByText(/Use New API Client above/i)).toBeNull();
    expect(screen.queryByText(BROKEN_HEADING)).toBeNull();
  });

  it("a non-auth failure renders the generic error -- neither empty nor not-authorised", async () => {
    installFetch({ listStatus: 502 });
    render(<ApiClientsPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(BROKEN_HEADING)).toBeTruthy();
    expect(screen.getByText(/This list is not empty - it is unknown/i)).toBeTruthy();
    expect(screen.queryByText(EMPTY_HEADING)).toBeNull();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
  });

  it("the token drilldown tells the same three apart on its own endpoint", async () => {
    installFetch({ clients: [CLIENT], tokensStatus: 401 });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "View tokens" })[0]);

    await waitFor(() => screen.getByText(REFUSED_HEADING));
    expect(screen.queryByText("No live tokens for this client.")).toBeNull();
    expect(screen.queryByText("Could not load the tokens.")).toBeNull();
  });
});

describe("destructive actions confirm, naming what is being destroyed", () => {
  it("delete asks first, names the client, and sends nothing on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("Worker Host");
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/cannot be undone/i);

    await waitFor(() => expect(callsOfMethod(calls, "GET").length).toBe(1));
    expect(callsOfMethod(calls, "DELETE")).toEqual([]);
  });

  it("revoking a token asks first, names the token, and sends nothing on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({ clients: [CLIENT], tokens: [TOKEN_ROW] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "View tokens" })[0]);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Revoke" }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("#91");
    expect(String(confirmSpy.mock.calls[0][0])).toContain("Worker Host");
    expect(callsOfMethod(calls, "POST")).toEqual([]);
  });

  it("minting a key asks first and sends nothing on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Add second key" })[0]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("Worker Host");
    expect(callsOfMethod(calls, "POST")).toEqual([]);
  });

  it("deactivating a client asks first -- it cascade-revokes every live token", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    openEditor();
    fireEvent.click(screen.getAllByLabelText("Edit Active")[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("Worker Host");
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/revoke every live token/i);
    expect(callsOfMethod(calls, "PATCH")).toEqual([]);
  });
});

describe("create and update send the reference page's field names", () => {
  it("POST body carries name, description, scopes, environment", async () => {
    const calls = installFetch({ clients: [] });
    render(<ApiClientsPage />);
    await waitFor(() => screen.getByText("No API clients are configured yet."));

    fireEvent.click(screen.getByRole("button", { name: "New API Client" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Terminal Push" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "pushes terminals" } });
    fireEvent.click(screen.getByLabelText("Scope terminal-push"));
    fireEvent.click(screen.getByLabelText("Environment test"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(callsOfMethod(calls, "POST").length).toBe(1));
    expect(JSON.parse(String(callsOfMethod(calls, "POST")[0].init?.body))).toEqual({
      name: "Terminal Push",
      description: "pushes terminals",
      scopes: ["terminal-push"],
      environment: "test",
    });
  });

  it("PATCH body carries name, description, scopes, isActive", async () => {
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    openEditor();
    fireEvent.change(screen.getAllByLabelText("Edit Name")[0], { target: { value: "Worker Host 2" } });
    fireEvent.click(screen.getAllByLabelText("Edit scope readonly")[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "PATCH").length).toBe(1));
    expect(JSON.parse(String(callsOfMethod(calls, "PATCH")[0].init?.body))).toEqual({
      name: "Worker Host 2",
      description: "the worker host caller",
      scopes: ["worker-host", "readonly"],
      isActive: true,
    });
  });

  it("refuses a client with no scope, without calling the API", async () => {
    const calls = installFetch({ clients: [] });
    render(<ApiClientsPage />);
    await waitFor(() => screen.getByText("No API clients are configured yet."));

    fireEvent.click(screen.getByRole("button", { name: "New API Client" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Scopeless" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => screen.getByText("Pick at least one scope."));
    expect(callsOfMethod(calls, "POST")).toEqual([]);
  });
});

describe("a full secret is never rendered in a list", () => {
  it("a list payload carrying a raw key never prints it", async () => {
    // The backend does not return a raw key on the list endpoint, and the page
    // must not print one even if it ever did: the page renders named fields,
    // not whatever arrives.
    installFetch({ clients: [{ ...CLIENT, rawKey: RAW_KEY, secret: RAW_KEY, key: RAW_KEY }] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    expect(document.body.textContent).not.toContain(RAW_KEY);
    // The prefix -- which is not a secret -- is what identifies a key here.
    expect(screen.getAllByText("slc_live").length).toBeGreaterThan(0);
  });

  it("a token list prints the key prefix and nothing more", async () => {
    installFetch({ clients: [CLIENT], tokens: [{ ...TOKEN_ROW, rawKey: RAW_KEY, token: RAW_KEY }] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "View tokens" })[0]);
    await waitFor(() => expect(screen.getAllByText("10.0.0.4").length).toBeGreaterThan(0));

    expect(document.body.textContent).not.toContain(RAW_KEY);
  });

  it("a newly minted key is revealed exactly once, then dropped from the DOM", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Add second key" })[0]);

    // Shown once, with the warning that it will not be shown again.
    await waitFor(() => expect(screen.getByText(RAW_KEY)).toBeTruthy());
    expect(screen.getByText(/only time you will see this key/i)).toBeTruthy();

    // Close is gated on an explicit acknowledgement so a stray click cannot
    // lose a credential that the server cannot re-issue.
    const close = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I have copied and stored this key."));
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByText(RAW_KEY)).toBeNull());
    expect(document.body.textContent).not.toContain(RAW_KEY);
  });

  it("never writes a secret to browser storage, and never puts one in a URL", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Add second key" })[0]);
    await waitFor(() => expect(screen.getByText(RAW_KEY)).toBeTruthy());

    expect(JSON.stringify(localStorage)).not.toContain(RAW_KEY);
    expect(JSON.stringify(sessionStorage)).not.toContain(RAW_KEY);
    for (const call of calls) expect(call.url).not.toContain(RAW_KEY);
    expect(window.location.href).not.toContain(RAW_KEY);
  });
});

describe("UTC instants render in Dubai time", () => {
  it("createdAtUtc goes through formatDubaiInstant, not the raw instant", async () => {
    installFetch({ clients: [CLIENT] });
    render(<ApiClientsPage />);
    await waitFor(() => expect(screen.getAllByText("Worker Host").length).toBeGreaterThan(0));

    const expected = formatDubaiInstant(CLIENT.createdAtUtc);
    // Sanity: the helper must actually be doing the UTC+4 shift, otherwise this
    // test would pass against a helper that had been gutted.
    expect(expected).toContain("02");
    expect(expected).toContain("01:22:35");

    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    expect(screen.queryByText(CLIENT.createdAtUtc)).toBeNull();
    // Nor the value any zone-less `new Date(...).toLocaleString()` would give.
    expect(screen.queryByText(new Date(CLIENT.createdAtUtc).toLocaleString())).toBeNull();
  });
});
