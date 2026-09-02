// @vitest-environment jsdom
//
// The one place the browser obtains a Bearer for the SignalR hub.
//
// SignalR is the reason a token has to be in the browser at all: it puts the
// credential in the client's hands (Authorization on negotiate, ?access_token=
// on the socket), and the hub cannot go through the server-side /api/backend
// proxy because that is built on fetch() and cannot carry an upgrade. So the
// properties tested here are the ones that make that safe and durable: the
// request is authenticated as this dashboard's user, the value is re-read
// rather than captured, and a failure degrades into a connection error instead
// of an exception in a React effect.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchHubAccessToken, hubAccessTokenFactory, HUB_TOKEN_URL } from "./hubAccessToken";

// The key src/lib/auth.ts writes the session under. Hard-coded rather than
// imported because auth.ts does not export it; if it ever changes, the
// "sends the dashboard session bearer" test below fails loudly, which is the
// right outcome -- a silently unauthenticated request is exactly the bug.
const SESSION_KEY = "slc.session.v2";

function jwtWithNoExpiry(): string {
  const payload = btoa(JSON.stringify({ sub: "abbas@skylinkscapital.com" }));
  return `header.${payload}.signature`;
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<any>) {
  const spy = vi.fn(impl as any);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function okToken(token: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ token, expiresAt: Date.now() + 300_000 }),
  };
}

describe("fetchHubAccessToken", () => {
  it("asks our own session-gated endpoint, not the backend", async () => {
    const spy = stubFetch(async () => okToken("tok-1"));
    await fetchHubAccessToken();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(HUB_TOKEN_URL);
    expect(HUB_TOKEN_URL.startsWith("/api/")).toBe(true);
  });

  // /api/backend/hub-token sits behind the deny-by-default gate in
  // auth/requireSession.js, which accepts only an Authorization: Bearer <jwt>
  // header -- never a cookie. Without this spread our OWN server 401s before
  // the trading backend is ever consulted, and the failure looks identical to
  // the hub 401 this whole change exists to fix.
  it("sends the dashboard session bearer", async () => {
    const token = jwtWithNoExpiry();
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ token, user: { email: "abbas@skylinkscapital.com" }, at: Date.now() }),
    );

    const spy = stubFetch(async () => okToken("tok-1"));
    await fetchHubAccessToken();

    const init = spy.mock.calls[0][1] as RequestInit;
    const headers = (init?.headers || {}) as Record<string, string>;
    expect(
      headers.Authorization,
      "the request must carry authHeaders(): the endpoint is session-gated",
    ).toBe(`Bearer ${token}`);
  });

  it("returns the token from the response body", async () => {
    stubFetch(async () => okToken("a4f9d2c718be40539c6b1af0e8d37256"));
    await expect(fetchHubAccessToken()).resolves.toBe("a4f9d2c718be40539c6b1af0e8d37256");
  });

  // SignalR calls the factory again on every negotiate and every automatic
  // reconnect. A dashboard tab routinely stays open longer than the one-hour
  // token, so a value captured once and closed over would work until the first
  // reconnect after expiry and then fail forever -- looking like a flaky hub
  // rather than an expired credential.
  it("fetches afresh on a second call rather than reusing a captured value", async () => {
    let n = 0;
    const spy = stubFetch(async () => okToken(`tok-${++n}`));

    const first = await hubAccessTokenFactory();
    const second = await hubAccessTokenFactory();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(first).toBe("tok-1");
    expect(second, "the second call returned a token captured on the first").toBe("tok-2");
  });

  // Several call sites build the connection inside a React effect with no
  // catch around connect(). A throw from the factory propagates out of
  // SignalR's negotiate and would take the page down over dead alerts.
  it("returns null instead of throwing when the endpoint refuses", async () => {
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    await expect(hubAccessTokenFactory()).resolves.toBeNull();
  });

  it("returns null instead of throwing when the network fails", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(hubAccessTokenFactory()).resolves.toBeNull();
  });

  it("returns null when the body carries no usable token", async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ token: "" }) }));
    await expect(hubAccessTokenFactory()).resolves.toBeNull();

    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await expect(hubAccessTokenFactory()).resolves.toBeNull();
  });
});
