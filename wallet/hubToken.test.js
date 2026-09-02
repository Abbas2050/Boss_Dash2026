// @vitest-environment node
//
// The endpoint that lets the browser authenticate the SignalR hub.
//
// Its whole reason to exist is a distinction between two credentials, so the
// tests that matter here are about which of the two comes back. The handler is
// exercised directly with a fake req/res rather than through Express:
// server.js opens database pools and registers cron schedulers at import time,
// so it cannot be imported into a test. server.js's only job for this route is
// one app.get line, and auth/routeCoverage.test.js is what proves that line
// sits behind the session gate.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hubTokenHandler, HUB_TOKEN_ROUTE, HUB_TOKEN_MIN_LIFETIME_MS } from "./hubToken.js";
import { isPublicApiRoute } from "../auth/requireSession.js";

// Shaped like the real thing: slc_live_ prefix, long-lived, and the value that
// must never leave the server.
const API_KEY = "slc_live_7c1e4a09b2d84f6e93aa5511";
// What the exchange at /oauth/token actually returns: opaque hex, one hour.
const ACCESS_TOKEN = "a4f9d2c718be40539c6b1af0e8d37256";

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
      return res;
    },
    json(payload) {
      res.jsonBody = payload;
      return res;
    },
  };
  return res;
}

const originalKey = process.env.BACKEND_API_KEY;

beforeEach(() => {
  process.env.BACKEND_API_KEY = API_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.BACKEND_API_KEY;
  else process.env.BACKEND_API_KEY = originalKey;
});

describe("GET /api/backend/hub-token", () => {
  it("returns the exchanged access token", async () => {
    const res = makeRes();
    await hubTokenHandler({ method: "GET" }, res, {
      getBackendToken: async () => ACCESS_TOKEN,
      now: () => 1_000_000,
    });

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.token).toBe(ACCESS_TOKEN);
    expect(res.jsonBody.expiresAt).toBe(1_000_000 + HUB_TOKEN_MIN_LIFETIME_MS);
  });

  // The one thing this endpoint must never do. Asserting on the KEY'S VALUE
  // rather than on a field name is deliberate: a leak would not politely
  // arrive in a field called "apiKey", it would arrive as the token, or
  // embedded in an error message built from the exchange's own diagnostics.
  it("never puts the API key anywhere in the response", async () => {
    const res = makeRes();
    await hubTokenHandler({ method: "GET" }, res, {
      getBackendToken: async () => ACCESS_TOKEN,
    });

    const serialised = JSON.stringify({ body: res.jsonBody, headers: res.headers });
    expect(
      serialised.includes(API_KEY),
      "BACKEND_API_KEY reached the browser: it is the long-lived secret and only " +
        "the short-lived access token may be served here",
    ).toBe(false);
  });

  // Defence in depth: if the token source ever regressed to handing back the
  // raw key (the pre-documentation code really did try the key as a Bearer),
  // serving it would publish a long-lived secret to every logged-in browser.
  it("refuses to serve the API key even if the token source hands it back", async () => {
    const res = makeRes();
    await hubTokenHandler({ method: "GET" }, res, {
      getBackendToken: async () => API_KEY,
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.jsonBody).includes(API_KEY)).toBe(false);
  });

  it("reports a failed exchange as 502 without echoing the key", async () => {
    const res = makeRes();
    await hubTokenHandler({ method: "GET" }, res, {
      getBackendToken: async () => {
        throw new Error(`client_secret ${API_KEY} was rejected`);
      },
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.jsonBody).includes(API_KEY)).toBe(false);
  });

  it("forbids caching the credential", async () => {
    const res = makeRes();
    await hubTokenHandler({ method: "GET" }, res, {
      getBackendToken: async () => ACCESS_TOKEN,
    });
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });
});

// The refusal is the gate's, not the handler's: requireSession denies
// everything under /api that is not on the allow-list, and calls authRequired,
// so an anonymous request never reaches hubTokenHandler at all. What has to be
// true for that is simply that this route was never allow-listed.
describe("session gate", () => {
  it("is refused without a dashboard session", () => {
    expect(
      isPublicApiRoute("GET", HUB_TOKEN_ROUTE),
      "the hub-token route is public: anyone on the network could mint a backend token",
    ).toBe(false);
    // Case and trailing slash are the ways a route sneaks past a naive gate.
    expect(isPublicApiRoute("GET", HUB_TOKEN_ROUTE.toUpperCase())).toBe(false);
    expect(isPublicApiRoute("GET", `${HUB_TOKEN_ROUTE}/`)).toBe(false);
  });

  it("sits under the guarded /api prefix at all", () => {
    expect(HUB_TOKEN_ROUTE.startsWith("/api/")).toBe(true);
  });
});
