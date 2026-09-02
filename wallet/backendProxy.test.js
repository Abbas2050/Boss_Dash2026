// @vitest-environment node
//
// node, not the suite's default jsdom, because the proxy calls
// AbortSignal.timeout() -- see the same note in pspClients.test.js.
//
// These exercise the handler directly with a fake req/res rather than booting
// Express: server.js opens database pools and registers cron schedulers at
// import time, so it cannot be imported into a test. server.js's only job for
// this route is one app.use('/api/backend', ...) line, and
// auth/routeCoverage.test.js is what proves that line sits behind the gate.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { backendProxy, buildBackendProxyHeaders, backendTargetUrl } from "./backendProxy.js";
import { resetBackendTokenState } from "./backendToken.js";

const KEY = "sk_backend_live_9f3a1c2b4d";

function makeReq(overrides = {}) {
  return {
    method: "GET",
    originalUrl: "/api/backend/DealMatch/Run?from=2026-08-25&to=2026-09-01",
    headers: { accept: "application/json" },
    ...overrides,
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    jsonBody: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
    },
    send(payload) {
      res.body = payload;
      return res;
    },
    json(payload) {
      res.jsonBody = payload;
      return res;
    },
  };
  return res;
}

function upstreamReply(status, body = "{}", headers = {}) {
  return {
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    arrayBuffer: async () => Buffer.from(body),
  };
}

// A token endpoint that always issues one, so these tests are about the proxy
// rather than about discovery (backendToken.test.js covers discovery).
function tokenFetch(token = "backend-token-xyz") {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ access_token: token, expires_in: 3600 }),
  });
}

beforeEach(() => {
  resetBackendTokenState();
  process.env.BACKEND_API_KEY = KEY;
  process.env.BACKEND_API_BASE_URL = "https://api.skylinkscapital.com";
});

afterEach(() => {
  delete process.env.BACKEND_API_KEY;
  delete process.env.BACKEND_API_BASE_URL;
});

describe("buildBackendProxyHeaders", () => {
  // The browser sends OUR session JWT in Authorization. It means nothing to
  // the trading backend, and forwarding it would hand a third party a
  // credential for this dashboard.
  it("drops a client Authorization header whatever its casing", () => {
    const headers = buildBackendProxyHeaders(
      { headers: { Authorization: "Bearer session-jwt", host: "dash.local", "x-keep": "1" } },
      "backend-token-xyz",
    );
    const authKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "authorization");
    expect(authKeys).toEqual(["authorization"]);
    expect(headers.authorization).toBe("Bearer backend-token-xyz");
    expect(JSON.stringify(headers)).not.toContain("session-jwt");
    // Hop-by-hop headers go; everything else the caller sent survives.
    expect(headers.host).toBeUndefined();
    expect(headers["x-keep"]).toBe("1");
  });
});

describe("backendTargetUrl", () => {
  it("keeps the path and the query string after stripping the mount prefix", () => {
    expect(backendTargetUrl(makeReq(), "https://api.skylinkscapital.com")).toBe(
      "https://api.skylinkscapital.com/DealMatch/Run?from=2026-08-25&to=2026-09-01",
    );
  });
});

describe("backendProxy", () => {
  it("strips the client Authorization header and substitutes the backend token", async () => {
    const req = makeReq({
      headers: { Authorization: "Bearer session-jwt-from-browser", accept: "application/json" },
    });
    const res = makeRes();
    const upstream = vi.fn().mockResolvedValue(upstreamReply(200, '{"ok":true}'));

    await backendProxy(req, res, { fetchImpl: upstream, tokenFetchImpl: tokenFetch() });

    expect(upstream).toHaveBeenCalledTimes(1);
    const sent = upstream.mock.calls[0][1].headers;
    expect(sent.authorization).toBe("Bearer backend-token-xyz");
    expect(JSON.stringify(sent)).not.toContain("session-jwt-from-browser");
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('{"ok":true}');
  });

  it("returns the upstream status and body unchanged on an error", async () => {
    const res = makeRes();
    const upstream = vi
      .fn()
      .mockResolvedValue(upstreamReply(403, '{"error":"forbidden_symbol"}'));

    await backendProxy(makeReq(), res, { fetchImpl: upstream, tokenFetchImpl: tokenFetch() });

    // Not rewritten to a 502/500 wrapper: a caller debugging this needs the
    // backend's own status and its own words.
    expect(res.statusCode).toBe(403);
    expect(res.body.toString()).toBe('{"error":"forbidden_symbol"}');
    expect(res.jsonBody).toBeNull();
  });

  it("preserves the method and body on a POST", async () => {
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/backend/Deal/Match",
      headers: { "content-type": "application/json" },
      body: { from: "2026-08-25" },
    });
    const res = makeRes();
    const upstream = vi.fn().mockResolvedValue(upstreamReply(200, "{}"));

    await backendProxy(req, res, { fetchImpl: upstream, tokenFetchImpl: tokenFetch() });

    expect(upstream.mock.calls[0][0]).toBe("https://api.skylinkscapital.com/Deal/Match");
    expect(upstream.mock.calls[0][1].method).toBe("POST");
    expect(upstream.mock.calls[0][1].body).toBe('{"from":"2026-08-25"}');
  });

  it("answers 503 with a redacted diagnosis when no token can be obtained", async () => {
    const res = makeRes();
    const upstream = vi.fn();
    const deadTokenEndpoint = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => `{"error":"invalid_client for secret ${KEY}"}`,
    });

    await backendProxy(makeReq(), res, {
      fetchImpl: upstream,
      tokenFetchImpl: deadTokenEndpoint,
    });

    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.error).toBe("backend_token_unavailable");
    expect(res.jsonBody.message).toContain("/oauth/token");
    expect(JSON.stringify(res.jsonBody)).not.toContain(KEY);
    // No upstream call was attempted without a credential.
    expect(upstream).not.toHaveBeenCalled();
  });
});
