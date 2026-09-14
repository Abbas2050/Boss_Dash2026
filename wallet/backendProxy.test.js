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
import { Readable } from "node:stream";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  backendProxy,
  buildBackendProxyHeaders,
  backendTargetUrl,
  backendProxyWantsRawBody,
  backendRawBodyParser,
  BACKEND_PROXY_RAW_BODY_LIMIT,
} from "./backendProxy.js";
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
// rather than about the exchange (backendToken.test.js covers the documented
// client_credentials protocol). Anything that is not the token endpoint is
// refused here: the API key is a client_secret and must never reach a data
// endpoint, so the proxy has no business calling one with it.
function tokenFetch(token = "backend-token-xyz") {
  return vi.fn(async (url) => {
    if (!String(url).includes("/oauth/token")) {
      return { ok: false, status: 401, text: async () => '{"error":"invalid_token"}' };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: token, expires_in: 3600 }),
    };
  });
}

beforeEach(() => {
  resetBackendTokenState();
  process.env.BACKEND_API_KEY = KEY;
  // Both halves of the documented client credential; the exchange refuses to
  // run without the client id.
  process.env.BACKEND_CLIENT_ID = "4071";
  process.env.BACKEND_API_BASE_URL = "https://api.skylinkscapital.com";
});

afterEach(() => {
  delete process.env.BACKEND_API_KEY;
  delete process.env.BACKEND_CLIENT_ID;
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

// Per-route timeout budgets.
//
// The bug these cover, measured live against production on 2026-09-14: a
// SINGLE-DAY GET /api/backend/api/SwapsReport?from=..&to=..&liveFinalto=false
// returned 504 after 45.3s with {"error":"proxy_timeout"} -- our own budget, not
// the backend's -- so the Swaps Report tab could not load at all.
//
// Every assertion here reads the value actually handed to AbortSignal.timeout,
// not merely "no error was thrown": the old code also threw nothing, it just
// used the wrong number.
describe("backendProxy per-route timeout budgets", () => {
  // AbortSignal.timeout() gives back an opaque signal, so the argument is
  // captured at the call and remembered against the signal it produced. Keying
  // by signal rather than just collecting the numbers matters: the token
  // exchange in backendToken.js arms its OWN abort timeout on the way through,
  // so a flat list would mix its budget in with the proxy's.
  function spyOnAbortTimeout() {
    const budgetOf = new WeakMap();
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      // A real signal, so the fetch options stay the shape the runtime expects;
      // the huge value keeps it from firing during the test.
      const signal = real(3_600_000);
      budgetOf.set(signal, ms);
      return signal;
    });
    return { budgetOf, restore: () => spy.mockRestore() };
  }

  // Returns the budget armed on the signal the FORWARDED request actually
  // carried -- the number that decides whether this endpoint gets to answer.
  async function timeoutUsedFor(originalUrl, deps = {}) {
    const { budgetOf, restore } = spyOnAbortTimeout();
    const budgets = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      budgets.push(budgetOf.get(init.signal));
      return upstreamReply(200, "{}");
    });
    try {
      await backendProxy(makeReq({ originalUrl }), makeRes(), {
        fetchImpl,
        tokenFetchImpl: tokenFetch(),
        ...deps,
      });
    } finally {
      restore();
    }
    return budgets;
  }

  afterEach(() => {
    delete process.env.PROXY_TIMEOUT_MS;
  });

  it("gives /api/SwapsReport the 180s budget the report layer proved these endpoints need", async () => {
    expect(await timeoutUsedFor("/api/backend/api/SwapsReport?from=1757808000&to=1757894400&liveFinalto=false")).toEqual([180_000]);
  });

  it("gives DealMatch/Run the same 180s budget", async () => {
    // ~40s whatever the window (41.8s for one day, 40.4s for a month, measured
    // 2026-08-31), so 45s left under four seconds of headroom.
    expect(await timeoutUsedFor("/api/backend/DealMatch/Run?from=2026-08-25&to=2026-09-01")).toEqual([180_000]);
  });

  it("matches the slow routes whatever their casing, because the backend routes are case-insensitive", async () => {
    expect(await timeoutUsedFor("/api/backend/api/swapsreport?from=1&to=2")).toEqual([180_000]);
    expect(await timeoutUsedFor("/api/backend/dealmatch/RUN?from=1&to=2")).toEqual([180_000]);
  });

  it("leaves an unlisted path on the 45s default", async () => {
    // Most endpoints answer in well under a second. A long GLOBAL budget would
    // let one hung backend hold sockets and worker capacity for minutes.
    expect(await timeoutUsedFor("/api/backend/Metrics?from=1&to=2")).toEqual([45_000]);
  });

  it("does not give the long budget to a near-miss path", async () => {
    // An exact match, never a prefix or substring test: a different endpoint of
    // unknown cost must not inherit 180s just because its name starts the same.
    expect(await timeoutUsedFor("/api/backend/api/SwapsReportSomethingElse?from=1&to=2")).toEqual([45_000]);
    expect(await timeoutUsedFor("/api/backend/DealMatch/RunAll?from=1&to=2")).toEqual([45_000]);
  });

  it("still lets PROXY_TIMEOUT_MS override the default budget", async () => {
    process.env.PROXY_TIMEOUT_MS = "9000";
    expect(await timeoutUsedFor("/api/backend/Metrics?from=1&to=2")).toEqual([9_000]);
  });

  it("treats the slow-route budget as a floor PROXY_TIMEOUT_MS cannot lower", async () => {
    // Deliberate: the 45s-ish global is below the MEASURED cost of these
    // endpoints, so letting the global knob cut them back would silently
    // reintroduce the 504 in a deployment where nobody touched these routes.
    process.env.PROXY_TIMEOUT_MS = "9000";
    expect(await timeoutUsedFor("/api/backend/api/SwapsReport?from=1&to=2")).toEqual([180_000]);
    // Raising it above the floor still reaches the slow routes.
    process.env.PROXY_TIMEOUT_MS = "240000";
    expect(await timeoutUsedFor("/api/backend/api/SwapsReport?from=1&to=2")).toEqual([240_000]);
  });

  it("names the route and the budget that was exceeded when a slow route times out", async () => {
    const res = makeRes();
    const aborted = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });

    await backendProxy(
      makeReq({ originalUrl: "/api/backend/api/SwapsReport?from=1757808000&to=1757894400" }),
      res,
      { fetchImpl: vi.fn().mockRejectedValue(aborted), tokenFetchImpl: tokenFetch() },
    );

    expect(res.statusCode).toBe(504);
    expect(res.jsonBody.error).toBe("proxy_timeout");
    // Today's message says only that something was aborted -- it does not say
    // which budget ran out, so nobody can tell our limit from the backend's.
    expect(res.jsonBody.message).toContain("/api/SwapsReport");
    expect(res.jsonBody.message).toContain("180000ms");
    expect(res.jsonBody.route).toBe("/api/SwapsReport");
    expect(res.jsonBody.timeoutMs).toBe(180_000);
  });
});

// Raw body passthrough for uploads.
//
// THE BUG THESE COVER. server.js mounts express.json() and express.urlencoded()
// and nothing else. Neither claims multipart/form-data, so a file upload to
// POST /api/backend/api/LpStatements/import arrived at the proxy with no parsed
// body, buildBody() returned nothing, and the proxy forwarded a perfectly valid
// request carrying NO FILE. The backend answered 200, the page reported a
// successful import, and not a single row was imported. Nothing logged an error
// anywhere, which is why every assertion below reads the bytes actually handed
// to fetch rather than merely checking that a call happened -- "a call
// happened" was true the whole time this was broken.
describe("backendProxy raw body passthrough", () => {
  const BOUNDARY = "----SkylinksBoundary7MA4YWxkTrZu0gW";

  // A multipart envelope around bytes that do not survive a text round trip: a
  // NUL, a lone CR, and two bytes that are not valid UTF-8. A real broker
  // statement is a PDF and is full of them.
  function multipartUpload() {
    const head = Buffer.from(
      `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="statement.pdf"\r\n' +
        "Content-Type: application/pdf\r\n\r\n",
      "latin1",
    );
    const pdf = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0d, 0x0a, 0x00, 0xff, 0xfe, 0x0a,
    ]);
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "latin1");
    return Buffer.concat([head, pdf, tail]);
  }

  // A request that is a real readable stream, because that is what the raw
  // parser consumes. A plain object would let a broken predicate look fine.
  function makeStreamReq({
    method = "POST",
    originalUrl = "/api/backend/api/LpStatements/import",
    headers = {},
    payload = null,
    declareLength = true,
  }) {
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.originalUrl = originalUrl;
    req.url = originalUrl;
    req.headers = { ...headers };
    if (payload && declareLength && req.headers["content-length"] === undefined) {
      req.headers["content-length"] = String(payload.length);
    }
    return req;
  }

  // Runs the middleware and settles whether it called next() or answered the
  // request itself, so the refusal path can be asserted without hanging.
  function runRawParser(parser, req) {
    const res = makeRes();
    const next = vi.fn();
    const settled = new Promise((resolve) => {
      const sendJson = res.json;
      res.json = (payload) => {
        sendJson(payload);
        resolve();
        return res;
      };
      next.mockImplementation(() => resolve());
    });
    parser(req, res, next);
    return settled.then(() => ({ res, next }));
  }

  it("forwards a multipart upload byte-for-byte with its boundary intact", async () => {
    const payload = multipartUpload();
    const req = makeStreamReq({
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        accept: "application/json",
      },
      payload,
    });

    const { next } = await runRawParser(backendRawBodyParser(), req);
    expect(next).toHaveBeenCalledTimes(1);

    const res = makeRes();
    const upstream = vi.fn().mockResolvedValue(upstreamReply(200, '{"imported":42}'));
    await backendProxy(req, res, { fetchImpl: upstream, tokenFetchImpl: tokenFetch() });

    const sent = upstream.mock.calls[0][1];
    // The bytes themselves, not "something was sent". Re-encoding a multipart
    // body mints a new boundary and mangles the binary parts; this is a PDF.
    expect(Buffer.isBuffer(sent.body)).toBe(true);
    expect(Buffer.compare(sent.body, payload)).toBe(0);
    // A multipart body is meaningless without the boundary parameter -- the
    // backend cannot tell where one part ends and the next begins.
    expect(sent.headers["content-type"]).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
    expect(sent.headers["content-type"]).toContain(BOUNDARY);
    expect(sent.method).toBe("POST");
    expect(upstream.mock.calls[0][0]).toBe(
      "https://api.skylinkscapital.com/api/LpStatements/import",
    );
  });

  it("still strips the caller's Authorization and attaches the backend Bearer on a multipart request", async () => {
    const payload = multipartUpload();
    const req = makeStreamReq({
      headers: {
        Authorization: "Bearer session-jwt-from-browser",
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload,
    });

    await runRawParser(backendRawBodyParser(), req);
    const res = makeRes();
    const upstream = vi.fn().mockResolvedValue(upstreamReply(200, "{}"));
    await backendProxy(req, res, { fetchImpl: upstream, tokenFetchImpl: tokenFetch() });

    const sent = upstream.mock.calls[0][1].headers;
    const authKeys = Object.keys(sent).filter((k) => k.toLowerCase() === "authorization");
    expect(authKeys).toEqual(["authorization"]);
    expect(sent.authorization).toBe("Bearer backend-token-xyz");
    expect(JSON.stringify(sent)).not.toContain("session-jwt-from-browser");
  });

  // The regression that matters most: every route that exists today posts JSON.
  it("leaves a JSON POST exactly as express.json() parsed it", async () => {
    // Shaped the way express.json() hands it over: parsed object, content-type
    // and content-length still on the request. Deliberately NOT a stream -- if
    // the raw parser ever decided to claim application/json it would try to
    // read this and fail loudly here, rather than quietly emptying req.body in
    // production.
    const req = {
      method: "POST",
      originalUrl: "/api/backend/Deal/Match",
      url: "/api/backend/Deal/Match",
      headers: {
        "content-type": "application/json",
        "content-length": "21",
      },
      body: { from: "2026-08-25" },
    };

    const { next } = await runRawParser(backendRawBodyParser(), req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body).toEqual({ from: "2026-08-25" });

    const res = makeRes();
    const upstream = vi.fn().mockResolvedValue(upstreamReply(200, "{}"));
    await backendProxy(req, res, { fetchImpl: upstream, tokenFetchImpl: tokenFetch() });

    const sent = upstream.mock.calls[0][1];
    expect(sent.body).toBe('{"from":"2026-08-25"}');
    expect(typeof sent.body).toBe("string");
    expect(sent.headers["content-type"]).toBe("application/json");
  });

  it("claims only the content types the global parsers decline", () => {
    expect(
      backendProxyWantsRawBody({
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    ).toBe(false);
    expect(
      backendProxyWantsRawBody({ headers: { "content-type": "application/json; charset=utf-8" } }),
    ).toBe(false);
    expect(
      backendProxyWantsRawBody({ headers: { "content-type": "MULTIPART/FORM-DATA; boundary=x" } }),
    ).toBe(true);
    expect(backendProxyWantsRawBody({ headers: { "content-type": "application/pdf" } })).toBe(true);
    // No content type, nothing to capture.
    expect(backendProxyWantsRawBody({ headers: {} })).toBe(false);
  });

  it("sends no body at all for a GET", async () => {
    const req = makeStreamReq({
      method: "GET",
      originalUrl: "/api/backend/Metrics?from=1&to=2",
      headers: { accept: "application/json" },
    });

    const { next } = await runRawParser(backendRawBodyParser(), req);
    expect(next).toHaveBeenCalledTimes(1);

    const res = makeRes();
    const upstream = vi.fn().mockResolvedValue(upstreamReply(200, "{}"));
    await backendProxy(req, res, { fetchImpl: upstream, tokenFetchImpl: tokenFetch() });

    // Not a zero-length buffer: a bodyless request must look to the backend
    // exactly as it did before this parser existed.
    expect(upstream.mock.calls[0][1].body).toBeUndefined();
  });

  it("refuses a body over the limit with an error naming it, and forwards nothing", async () => {
    // Declared length over the cap: the read is refused before a byte is taken,
    // so an oversized statement never lands in this process's memory at all.
    const req = makeStreamReq({
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": String(30 * 1024 * 1024),
      },
      payload: multipartUpload(),
      declareLength: false,
    });

    const { res, next } = await runRawParser(backendRawBodyParser(), req);

    expect(res.statusCode).toBe(413);
    expect(res.jsonBody.error).toBe("payload_too_large");
    expect(res.jsonBody.limit).toBe(BACKEND_PROXY_RAW_BODY_LIMIT);
    expect(res.jsonBody.message).toContain(BACKEND_PROXY_RAW_BODY_LIMIT);
    // next() is never called, so backendProxy never runs and nothing reaches
    // the backend. A truncated multipart body is not a smaller statement, it is
    // a corrupt one, and importing it would write partial rows.
    expect(next).not.toHaveBeenCalled();
  });

  it("refuses an undeclared body that grows past the limit rather than truncating it", async () => {
    // No content-length, so the cap can only be enforced while reading. A
    // chunked upload must still be refused outright.
    const oversized = Buffer.alloc(4096, 0x41);
    const req = makeStreamReq({
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "transfer-encoding": "chunked",
      },
      payload: oversized,
      declareLength: false,
    });

    const { res, next } = await runRawParser(backendRawBodyParser({ limit: "1kb" }), req);

    expect(res.statusCode).toBe(413);
    expect(res.jsonBody.message).toContain("1kb");
    expect(next).not.toHaveBeenCalled();
    // Emphatically not a 1kb prefix of the upload.
    expect(Buffer.isBuffer(req.body)).toBe(false);
  });
});
