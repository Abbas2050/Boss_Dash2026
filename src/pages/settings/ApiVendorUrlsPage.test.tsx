// API Vendor URLs: the three verbs, and the three load outcomes that look
// identical when they are wrong.
//
// Two hazards are pinned here per request rather than once in aggregate:
//
//   1. URL. Three settings pages on this project spent weeks fetching a BARE
//      "/api/<route>" path. On a single-page app that is not a 404 -- the SPA
//      catch-all answers with index.html and HTTP 200, so the page renders
//      empty and nobody reports it. The URL every request must carry is
//      "/api/backend/api/admin/vendor-urls": /api/backend is our proxy and
//      /api/admin/vendor-urls is the backend's own path under it.
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
// asserted to exclude the other two. Here the stakes are concrete: a 401 shown
// as "no overrides" would read as "every vendor is on its compiled default",
// which is a statement about production routing that nobody checked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ApiVendorUrlsPage } from "./ApiVendorUrlsPage";
import { formatDubaiInstant } from "@/lib/dubaiTime";

const VENDOR_URLS_URL = "/api/backend/api/admin/vendor-urls";
const SESSION_KEY = "slc.session.v2";
const TOKEN = "test.session.jwt";
const EXPECTED_AUTH = `Bearer ${TOKEN}`;

const OVERRIDE_ROW = {
  vendor: "Finalto",
  environment: "Live",
  url: "https://live.finalto.example/api",
  source: "Override",
  // 21:22 UTC on the 1st is 01:22 on the 2nd in Dubai (UTC+4), so a helper-less
  // render cannot accidentally agree with a helper-based one here.
  updatedAtUtc: "2026-09-01T21:22:35Z",
  updatedBy: "abbas",
};

const DEFAULT_ROW = {
  vendor: "Finalto",
  environment: "Demo",
  url: "https://demo.finalto.example/api",
  source: "Default",
  updatedAtUtc: null,
  updatedBy: null,
};

type FetchCall = { url: string; init: RequestInit | undefined };

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

/**
 * A fetch double that behaves like the real endpoint: GET returns whatever
 * `state.rows` currently holds (so a reload after a mutation sees the new
 * list), mutations answer 204. Set `state.getStatus` to make the load fail.
 */
function installFetch(state: { rows?: unknown[]; getStatus?: number }) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "GET") {
      if (state.getStatus) {
        return { ok: false, status: state.getStatus, text: async () => "upstream said no", json: async () => ({}) };
      }
      return ok(state.rows ?? []);
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

/** The table and the phone card render the same controls, and both are in the
 *  DOM under jsdom; they are bound to the same draft, so either will do. */
function urlField(vendor: string, environment: string) {
  return screen.getAllByLabelText(`Url for ${vendor} ${environment}`)[0];
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

describe("every request goes to the proxy path and carries the session bearer", () => {
  it("GET lists the effective URLs through /api/backend/api/admin/vendor-urls", async () => {
    const calls = installFetch({ rows: [OVERRIDE_ROW, DEFAULT_ROW] });
    render(<ApiVendorUrlsPage />);

    await waitFor(() => expect(screen.getAllByText("Live").length).toBeGreaterThan(0));

    const gets = callsOfMethod(calls, "GET");
    expect(gets.length).toBe(1);
    expect(gets[0].url).toBe(VENDOR_URLS_URL);
    expect(authOf(gets[0])).toBe(EXPECTED_AUTH);
  });

  it("PUT upserts against the collection URL", async () => {
    const calls = installFetch({ rows: [DEFAULT_ROW] });
    render(<ApiVendorUrlsPage />);
    await waitFor(() => expect(screen.getAllByText("Demo").length).toBeGreaterThan(0));

    fireEvent.change(urlField("Finalto", "Demo"), { target: { value: "https://demo2.finalto.example/api" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "PUT").length).toBe(1));
    const put = callsOfMethod(calls, "PUT")[0];
    expect(put.url).toBe(VENDOR_URLS_URL);
    expect(authOf(put)).toBe(EXPECTED_AUTH);
  });

  it("DELETE reverts against the collection URL with the identifying pair in the query", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = installFetch({ rows: [OVERRIDE_ROW] });
    render(<ApiVendorUrlsPage />);
    await waitFor(() => expect(screen.getAllByText("Live").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Revert" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "DELETE").length).toBe(1));
    const del = callsOfMethod(calls, "DELETE")[0];
    expect(del.url).toBe(`${VENDOR_URLS_URL}?vendor=Finalto&environment=Live`);
    expect(authOf(del)).toBe(EXPECTED_AUTH);
  });
});

describe("loaded-and-empty, refused, and broken are three different screens", () => {
  const EMPTY_HEADING = "No vendor base URLs are configured yet.";
  const REFUSED_HEADING = "This dashboard is not authorised for the admin API.";
  const BROKEN_HEADING = "Could not load the vendor URLs.";

  it("[] renders the empty state -- not an error, and not a blank area", async () => {
    installFetch({ rows: [] });
    render(<ApiVendorUrlsPage />);

    await waitFor(() => screen.getByText(EMPTY_HEADING));
    // It says what would have to happen for a row to appear, rather than
    // leaving a void that reads as broken.
    expect(screen.getByText(/one row per env-driven vendor client/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
    expect(screen.queryByText(BROKEN_HEADING)).toBeNull();
  });

  it("401 renders the not-authorised state -- neither empty nor a generic error", async () => {
    installFetch({ getStatus: 401 });
    render(<ApiVendorUrlsPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(REFUSED_HEADING)).toBeTruthy();
    // The explanation must name the cause and the repair, so a reader who opens
    // this page before access is granted understands it without reading code.
    expect(screen.getByText(/credentials this dashboard authenticates with are not permitted/i)).toBeTruthy();
    expect(screen.getByText(/backend team must grant/i)).toBeTruthy();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    // And it borrows the words of neither other state.
    expect(screen.queryByText(EMPTY_HEADING)).toBeNull();
    expect(screen.queryByText(/one row per env-driven vendor client/i)).toBeNull();
    expect(screen.queryByText(BROKEN_HEADING)).toBeNull();
  });

  it("a non-auth failure renders the generic error -- neither empty nor not-authorised", async () => {
    installFetch({ getStatus: 502 });
    render(<ApiVendorUrlsPage />);

    await waitFor(() => screen.getByRole("alert"));
    expect(screen.getByText(BROKEN_HEADING)).toBeTruthy();
    expect(screen.getByText(/This list is not empty - it is unknown/i)).toBeTruthy();
    expect(screen.queryByText(EMPTY_HEADING)).toBeNull();
    expect(screen.queryByText(REFUSED_HEADING)).toBeNull();
  });
});

describe("revert is confirmed before the override is destroyed", () => {
  it("asks, names the vendor and environment, and sends no DELETE on no", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = installFetch({ rows: [OVERRIDE_ROW] });
    render(<ApiVendorUrlsPage />);
    await waitFor(() => expect(screen.getAllByText("Live").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Revert" })[0]);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("Finalto");
    expect(String(confirmSpy.mock.calls[0][0])).toContain("Live");
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/cannot be undone/i);

    await waitFor(() => expect(callsOfMethod(calls, "GET").length).toBe(1));
    expect(callsOfMethod(calls, "DELETE")).toEqual([]);
  });

  it("a Default row offers no Revert at all -- there is no override to delete", async () => {
    installFetch({ rows: [DEFAULT_ROW] });
    render(<ApiVendorUrlsPage />);
    await waitFor(() => expect(screen.getAllByText("Demo").length).toBeGreaterThan(0));

    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });
});

describe("save sends the reference page's field names", () => {
  it("PUT body carries vendor, environment and url", async () => {
    const calls = installFetch({ rows: [DEFAULT_ROW] });
    render(<ApiVendorUrlsPage />);
    await waitFor(() => expect(screen.getAllByText("Demo").length).toBeGreaterThan(0));

    fireEvent.change(urlField("Finalto", "Demo"), { target: { value: "https://demo2.finalto.example/api" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => expect(callsOfMethod(calls, "PUT").length).toBe(1));
    expect(JSON.parse(String(callsOfMethod(calls, "PUT")[0].init?.body))).toEqual({
      vendor: "Finalto",
      environment: "Demo",
      url: "https://demo2.finalto.example/api",
    });
  });

  it("refuses a non-https URL without calling the API", async () => {
    const calls = installFetch({ rows: [DEFAULT_ROW] });
    render(<ApiVendorUrlsPage />);
    await waitFor(() => expect(screen.getAllByText("Demo").length).toBeGreaterThan(0));

    // Plain http is refused rather than silently upgraded: a live vendor client
    // authenticates against this base URL.
    fireEvent.change(urlField("Finalto", "Demo"), { target: { value: "http://demo.finalto.example/api" } });
    const save = screen.getAllByRole("button", { name: "Save" })[0] as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);

    expect(callsOfMethod(calls, "PUT")).toEqual([]);
  });
});

describe("updatedAtUtc is rendered in Dubai time", () => {
  it("renders through formatDubaiInstant, not the raw instant", async () => {
    installFetch({ rows: [OVERRIDE_ROW] });
    render(<ApiVendorUrlsPage />);
    await waitFor(() => expect(screen.getAllByText("Live").length).toBeGreaterThan(0));

    const expected = formatDubaiInstant(OVERRIDE_ROW.updatedAtUtc);
    // Sanity: the helper must actually be doing the UTC+4 shift, otherwise this
    // test would pass against a helper that had been gutted.
    expect(expected).toContain("02");
    expect(expected).toContain("01:22:35");

    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    expect(screen.queryByText(OVERRIDE_ROW.updatedAtUtc)).toBeNull();
    // Nor the value any zone-less `new Date(...).toLocaleString()` would give.
    expect(screen.queryByText(new Date(OVERRIDE_ROW.updatedAtUtc).toLocaleString())).toBeNull();
  });
});
