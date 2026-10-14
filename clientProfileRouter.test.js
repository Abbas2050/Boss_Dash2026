// @vitest-environment node
//
// node, not the suite's default jsdom, because this reaches the real
// backendFetch(), which calls AbortSignal.timeout() -- the same reason
// reports/backendFetch.test.js and reports/volumeSection.test.js opt out.
//
// This file exists because of a reported bug with a deceptive symptom: the
// Client Profiling tab showed no results for ANY date range. Two defects were
// stacked, and the second hid the first.
//
//   1. This router called api.skylinkscapital.com with nothing but an Accept
//      header. That backend answers 401 invalid_token to every unauthenticated
//      request, so there was never any data to show. It is the SIXTH caller of
//      that backend and the only one that never picked up the shared token
//      helper -- the helper exists precisely because callers that each write
//      their own drift apart.
//   2. Both handlers caught the resulting failure and answered 200 with empty
//      arrays (and, on the detail route, a zeroed account) plus a `warning`
//      field the tab never rendered. A total authentication failure therefore
//      arrived at the screen looking exactly like a quiet week.
//
// So the assertions below come in two halves: the Bearer really gets onto the
// request, and a failure really leaves here as a failure. The second half is
// the one that matters more -- an outage that renders as an empty list is a
// lie, and it is the lie that cost the time.
//
// The handlers are called directly with a fake `res` rather than through a
// booted Express app, because importing server.js starts a real listener and a
// database pool at module load; the mounting is checked by reading server.js's
// source, the way auth/routeCoverage.test.js does it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { resetBackendTokenState } from "./wallet/backendToken.js";
import { BACKEND_BASE_URL } from "./reports/reportShared.js";
import { topClientsHandler, clientDetailHandler } from "./clientProfileRouter.js";

const KEY = "slc_live_unit_test_secret_value";
const MINTED = "minted-opaque-token-abc123";

// Enough of an Express response to record what the handler decided. Lifted
// from reports/reportScheduleRoute.test.js so the two read the same way.
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const realFetch = globalThis.fetch;
const realKey = process.env.BACKEND_API_KEY;
const realClientId = process.env.BACKEND_CLIENT_ID;
let errorLog;

beforeEach(() => {
  resetBackendTokenState();
  process.env.BACKEND_API_KEY = KEY;
  // The documented client_credentials exchange needs both halves of the
  // credential; a missing client id is backendToken.js's own case.
  process.env.BACKEND_CLIENT_ID = "4071";
  errorLog = [];
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errorLog.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.BACKEND_API_KEY;
  else process.env.BACKEND_API_KEY = realKey;
  if (realClientId === undefined) delete process.env.BACKEND_CLIENT_ID;
  else process.env.BACKEND_CLIENT_ID = realClientId;
  resetBackendTokenState();
  vi.restoreAllMocks();
});

const TOP_CLIENTS = {
  generatedAt: "2026-10-14T02:15:00Z",
  fromDate: "2026-10-01",
  toDate: "2026-10-07",
  topByEquity: [{ rank: 1, login: 5001, name: "Alpha", equity: 123456.78 }],
  topByVolume: [{ rank: 1, login: 5002, name: "Beta", totalOpenLots: 42 }],
  topByDailyVolume: [],
  topByDailyRealized: [],
};

const DETAIL = {
  name: "Alpha Client",
  group: "real\\A",
  account: { equity: 123456.78, balance: 120000, credit: 0 },
  openPositions: [{ symbol: "XAUUSD", netLots: 3 }],
  topSymbols: [],
  summary: { periodClosedDeals: 9, periodTradedLots: 31.5 },
};

/**
 * Stubs the whole network: the token exchange, then the data call.
 *
 * `upstream` decides what the data endpoint answers. Every request is recorded
 * so the tests can assert on the URL and the headers that actually went out.
 */
function stubFetch(calls, { upstream, token = MINTED, tokenStatus = 200, tokenBody = null } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });

    if (String(url).includes("/oauth/token")) {
      if (tokenStatus !== 200) {
        return new Response(tokenBody ?? JSON.stringify({ error: "invalid_client" }), { status: tokenStatus });
      }
      return new Response(JSON.stringify({ access_token: token, expires_in: 300 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // The backend team's hard rule, pinned here as it is in
    // reports/backendFetch.test.js: the API key is a client_secret for the
    // token endpoint and must NEVER appear on a data endpoint.
    const auth = init.headers?.Authorization || init.headers?.authorization;
    if (auth === `Bearer ${process.env.BACKEND_API_KEY}`) {
      throw new Error("the raw BACKEND_API_KEY was sent to a data endpoint");
    }

    return upstream(String(url), init);
  };
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const dataCalls = (calls) => calls.filter((c) => c.url.includes("/api/ClientProfile"));

// ── half one: the request is actually authenticated ─────────────────────────

describe("the ClientProfile call is authenticated", () => {
  it("sends the minted Bearer on /top-clients, which is the whole of the reported bug", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => jsonResponse(TOP_CLIENTS) });

    const res = fakeRes();
    await topClientsHandler({ query: { from: "2026-10-01", to: "2026-10-07", count: "10" } }, res);

    const call = dataCalls(calls).pop();
    expect(call, "no backend call was made at all").toBeTruthy();
    // The assertion the old code could not pass: it sent only an Accept header.
    expect(call.init.headers.Authorization).toBe(`Bearer ${MINTED}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.topByEquity).toHaveLength(1);
  });

  it("sends the minted Bearer on /:login/detail too", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => jsonResponse(DETAIL) });

    const res = fakeRes();
    await clientDetailHandler({ params: { login: "5001" }, query: { days: "30" } }, res);

    const call = dataCalls(calls).pop();
    expect(call, "no backend call was made at all").toBeTruthy();
    expect(call.init.headers.Authorization).toBe(`Bearer ${MINTED}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe("Alpha Client");
  });

  it("mints the token through the documented exchange rather than guessing a header", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => jsonResponse(TOP_CLIENTS) });

    await topClientsHandler({ query: {} }, fakeRes());

    // If this router ever goes back to a bare fetch(), no exchange happens.
    expect(calls.some((c) => c.url.includes("/oauth/token"))).toBe(true);
  });

  it("asks the backend for the range the user picked, against the shared base URL", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => jsonResponse(TOP_CLIENTS) });

    await topClientsHandler({ query: { from: "2026-09-01", to: "2026-09-30", count: "20" } }, fakeRes());

    const call = dataCalls(calls).pop();
    // Base URL comes from reportShared, not a local constant: the token is
    // minted against that same host, and a second base URL here is how a token
    // ends up presented to a host that never issued it.
    expect(call.url).toBe(`${BACKEND_BASE_URL}/api/ClientProfile/top-clients?from=2026-09-01&to=2026-09-30&count=20`);
  });

  it("passes the detail window through instead of silently using 30 days", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => jsonResponse(DETAIL) });

    await clientDetailHandler({ params: { login: "5001" }, query: { days: "7" } }, fakeRes());

    expect(dataCalls(calls).pop().url).toBe(`${BACKEND_BASE_URL}/api/ClientProfile/5001/detail?days=7`);
  });
});

// ── half two: a failure leaves here as a failure ────────────────────────────

describe("an upstream failure is reported as a failure, not as an empty result", () => {
  it("does not answer 200 with empty arrays when the backend 500s", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => new Response("upstream exploded", { status: 500 }) });

    const res = fakeRes();
    await topClientsHandler({ query: { from: "2026-10-01", to: "2026-10-07" } }, res);

    expect(res.statusCode).toBe(502);
    // The shape of the old lie, pinned so it cannot come back: a reader who
    // receives these cannot tell an outage from a quiet week.
    expect(res.body.topByEquity).toBeUndefined();
    expect(res.body.topByVolume).toBeUndefined();
    expect(res.body.topByDailyVolume).toBeUndefined();
    expect(res.body.topByDailyRealized).toBeUndefined();
    expect(res.body.error).toMatch(/not an empty result/i);
  });

  it("does not answer 200 with a zeroed account when the backend 500s on /:login/detail", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => new Response("upstream exploded", { status: 500 }) });

    const res = fakeRes();
    await clientDetailHandler({ params: { login: "5001" }, query: { days: "30" } }, res);

    expect(res.statusCode).toBe(502);
    // A zeroed account is the worse half of the old fallback: it reads as a
    // real client holding no money, so there is nothing to question.
    expect(res.body.account).toBeUndefined();
    expect(res.body.summary).toBeUndefined();
    expect(res.body.name).toBeUndefined();
    expect(res.body.error).toMatch(/not an empty result/i);
  });

  it("names an authentication failure as one when the backend refuses the Bearer", async () => {
    const calls = [];
    stubFetch(calls, {
      upstream: () =>
        jsonResponse({ error: "invalid_token", error_description: "Bearer token missing, expired, or revoked." }, 401),
    });

    const res = fakeRes();
    await topClientsHandler({ query: {} }, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/BACKEND_API_KEY/);
    expect(res.body.error).toMatch(/authentication failure/i);
  });

  it("answers a non-2xx, not a 200, when no token can be minted at all", async () => {
    // The misconfigured-server shape: no key, so backendToken.js refuses
    // before any network call and backendFetch rejects with a
    // BackendTokenError.
    process.env.BACKEND_API_KEY = "";
    globalThis.fetch = async () => {
      throw new Error("no request should be attempted without a token");
    };

    const res = fakeRes();
    await topClientsHandler({ query: {} }, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/BACKEND_API_KEY/);
    expect(res.body.topByEquity).toBeUndefined();
  });

  it("answers a non-2xx on /:login/detail too when no token can be minted", async () => {
    process.env.BACKEND_API_KEY = "";
    globalThis.fetch = async () => {
      throw new Error("no request should be attempted without a token");
    };

    const res = fakeRes();
    await clientDetailHandler({ params: { login: "5001" }, query: {} }, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.account).toBeUndefined();
  });

  it("says the backend could not be reached when the request never completes", async () => {
    const calls = [];
    stubFetch(calls, {
      upstream: () => {
        throw new TypeError("fetch failed");
      },
    });

    const res = fakeRes();
    await topClientsHandler({ query: {} }, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/could not be reached/i);
  });

  it("calls a timeout a timeout, so nobody goes looking for a bug in the range", async () => {
    const calls = [];
    stubFetch(calls, {
      upstream: () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      },
    });

    const res = fakeRes();
    await topClientsHandler({ query: {} }, res);

    expect(res.statusCode).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
    expect(res.body.error).toMatch(/narrower date range/i);
  });

  it("gives every failure a reason a person can act on, not just a status", async () => {
    // "HTTP 502" on its own is what the tab used to display, and it tells
    // nobody that the backend credential is being refused. Each branch has to
    // carry a sentence, and a sentence long enough to be one.
    const branches = [
      { name: "upstream 401", upstream: () => jsonResponse({ error: "invalid_token" }, 401) },
      { name: "upstream 503", upstream: () => new Response("", { status: 503 }) },
      {
        name: "transport failure",
        upstream: () => {
          throw new TypeError("fetch failed");
        },
      },
    ];

    for (const branch of branches) {
      resetBackendTokenState();
      const calls = [];
      stubFetch(calls, { upstream: branch.upstream });

      const res = fakeRes();
      await topClientsHandler({ query: {} }, res);

      expect(res.statusCode, branch.name).toBeGreaterThanOrEqual(500);
      expect(typeof res.body.error, branch.name).toBe("string");
      expect(res.body.error.length, `${branch.name}: no reason for the reader`).toBeGreaterThan(40);
      expect(res.body.error, branch.name).toMatch(/Client profiling/);
    }
  });
});

// ── a genuinely quiet range is still a clean empty state ────────────────────

describe("a range with no activity is not an error", () => {
  it("passes the backend's own empty arrays through as a 200", async () => {
    const calls = [];
    const empty = {
      generatedAt: "2026-10-14T02:15:00Z",
      fromDate: "2026-01-01",
      toDate: "2026-01-02",
      topByEquity: [],
      topByVolume: [],
      topByDailyVolume: [],
      topByDailyRealized: [],
    };
    stubFetch(calls, { upstream: () => jsonResponse(empty) });

    const res = fakeRes();
    await topClientsHandler({ query: { from: "2026-01-01", to: "2026-01-02" } }, res);

    // The distinction the whole fix turns on: this reaches the tab as data, so
    // the tab renders "No clients found for this period" and no error box.
    expect(res.statusCode).toBe(200);
    expect(res.body.topByEquity).toEqual([]);
    expect(res.body.error).toBeUndefined();
    expect(errorLog, "a quiet range should not be logged as a failure").toEqual([]);
  });
});

// ── nothing about the credential leaves this file ───────────────────────────

describe("no credential reaches the response or the log", () => {
  it("does not echo the upstream's words about our token", async () => {
    const calls = [];
    // A deliberately chatty gateway: some put the presented token straight
    // into the rejection. Forwarding an upstream body is how that arrives in
    // a browser response and an access log.
    stubFetch(calls, {
      upstream: () =>
        new Response(`invalid_token: presented bearer ${MINTED} for client_secret ${KEY}`, { status: 401 }),
    });

    const res = fakeRes();
    await topClientsHandler({ query: {} }, res);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(MINTED);
    expect(serialised).not.toContain(KEY);
    expect(serialised).not.toContain("presented bearer");
    expect(errorLog.join("\n")).not.toContain(MINTED);
    expect(errorLog.join("\n")).not.toContain(KEY);
  });

  it("does not leak the key when the token exchange itself is rejected", async () => {
    const calls = [];
    stubFetch(calls, {
      upstream: () => jsonResponse(TOP_CLIENTS),
      tokenStatus: 401,
      tokenBody: `invalid_client: client_secret ${KEY} is not recognised`,
    });

    const res = fakeRes();
    await topClientsHandler({ query: {} }, res);

    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(errorLog.join("\n")).not.toContain(KEY);
    // Still has to say what to fix, or the hygiene is bought with silence.
    expect(res.body.error).toMatch(/BACKEND_API_KEY/);
  });

  it("logs the failure, so an outage is visible on the server as well as the screen", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => new Response("", { status: 500 }) });

    await topClientsHandler({ query: { from: "2026-10-01", to: "2026-10-07" } }, fakeRes());

    expect(errorLog.join("\n")).toMatch(/\[ClientProfile\]/);
    expect(errorLog.join("\n")).toMatch(/2026-10-01\.\.2026-10-07/);
  });
});

// ── input the backend should never be asked about ───────────────────────────

describe("a login that is not a login", () => {
  it("refuses it instead of asking the backend about client 0", async () => {
    const calls = [];
    stubFetch(calls, { upstream: () => jsonResponse(DETAIL) });

    const res = fakeRes();
    await clientDetailHandler({ params: { login: "not-a-login" }, query: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(dataCalls(calls)).toHaveLength(0);
    // The old handler coerced this to 0 and, on the failure that followed,
    // answered 200 with `Client 0` and every figure zeroed.
    expect(res.body.account).toBeUndefined();
  });
});

// ── the mounting, read from source rather than booted ───────────────────────

describe("the router is mounted where the tab calls it", () => {
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");

  it("is registered at /api/ClientProfile", () => {
    expect(SERVER).toMatch(/app\.use\(\s*["'`]\/api\/ClientProfile["'`]\s*,\s*clientProfileRouter\s*\)/);
  });

  it("registers both routes the tab calls", async () => {
    const source = readFileSync(path.resolve("clientProfileRouter.js"), "utf8");
    expect(source).toMatch(/router\.get\("\/top-clients",\s*topClientsHandler\)/);
    expect(source).toMatch(/router\.get\("\/:login\/detail",\s*clientDetailHandler\)/);
  });

  it("has no second base URL of its own", () => {
    // backendFetch owns the base URL. A local constant here is what let the
    // data call and the token exchange disagree about which host they meant,
    // and a hardcoded host is how the unauthenticated version got written in
    // the first place.
    //
    // Comments are dropped line-wise, not with a /\/\/[^\n]*/ strip: that
    // strip treats the `//` in `https://api...` as the start of a comment and
    // deletes the rest of the line, which silently removes the very thing
    // being looked for. Every comment in the file under test is a whole line.
    const source = readFileSync(path.resolve("clientProfileRouter.js"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");

    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toMatch(/VITE_BACKEND_BASE_URL|BACKEND_API_BASE_URL/);
    // The positive half: it has to be getting the URL from somewhere.
    expect(code).toMatch(/backendFetch\(`\/api\/ClientProfile/);
  });
});
