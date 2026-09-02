// @vitest-environment node
//
// The suite's default environment is jsdom (vite.config.ts), whose
// AbortSignal has no .timeout() -- and the token exchange calls
// AbortSignal.timeout(). Node's has it, the same reason pspClients.test.js
// and auth/routeCoverage.test.js opt into node.
//
// Everything here stubs fetch. Nothing in this file talks to the real
// api.skylinkscapital.com, and nothing needs BACKEND_API_KEY or
// BACKEND_CLIENT_ID to be real.
//
// What these pin is the protocol the backend team DOCUMENTED: a
// client_credentials exchange with the key as client_secret, in a form body or
// in an HTTP Basic header, and nothing else. In particular they pin that the
// key never leaves for a data endpoint, which is the rule that the old
// direct-Bearer attempt broke.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getBackendToken,
  fetchWithBackendToken,
  resetBackendTokenState,
  getRememberedShapeName,
  TOKEN_REQUEST_SHAPES,
} from "./backendToken.js";

const KEY = "slc_live_9f3a1c2b4d8e7f60";
const CLIENT_ID = "4071";
const TOKEN_URL = "https://api.skylinkscapital.com/oauth/token";

// A minimal stand-in for a fetch Response: the exchange only reads .ok,
// .status and .text().
function reply(status, body) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
  };
}

let fetchMock;

beforeEach(() => {
  resetBackendTokenState();
  process.env.BACKEND_API_KEY = KEY;
  process.env.BACKEND_CLIENT_ID = CLIENT_ID;
  process.env.BACKEND_API_BASE_URL = "https://api.skylinkscapital.com";
  delete process.env.BACKEND_API_SCOPE;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.BACKEND_API_KEY;
  delete process.env.BACKEND_CLIENT_ID;
  delete process.env.BACKEND_API_SCOPE;
  delete process.env.BACKEND_API_BASE_URL;
});

function bodyOfCall(i) {
  return new URLSearchParams(String(fetchMock.mock.calls[i][1].body || ""));
}

function headersOfCall(i) {
  return fetchMock.mock.calls[i][1].headers || {};
}

describe("the documented form-body exchange", () => {
  it("posts grant_type, client_id and client_secret form-encoded to /oauth/token", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { access_token: "abcdef0123456789", token_type: "Bearer", expires_in: 3600, scope: "frontend" }),
    );

    const token = await getBackendToken();

    expect(token).toBe("abcdef0123456789");
    // One request, not a walk: there is nothing to discover any more.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(TOKEN_URL);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(headersOfCall(0)["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const form = bodyOfCall(0);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(KEY);
    expect(getRememberedShapeName()).toBe("form body (client_id + client_secret)");
  });

  it("omits scope entirely when BACKEND_API_SCOPE is unset", async () => {
    // Not "scope=" and not "scope=undefined": an empty or bogus scope NARROWS
    // the grant, whereas omitting the parameter is what asks for the client's
    // full set.
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "tok-A", expires_in: 3600 }));
    await getBackendToken();

    expect(bodyOfCall(0).has("scope")).toBe(false);
    expect(String(fetchMock.mock.calls[0][1].body)).not.toContain("scope");
  });

  it("includes scope when BACKEND_API_SCOPE is set", async () => {
    process.env.BACKEND_API_SCOPE = "frontend";
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "tok-A", expires_in: 3600 }));
    await getBackendToken();

    expect(bodyOfCall(0).get("scope")).toBe("frontend");
  });
});

describe("the documented HTTP Basic alternative", () => {
  it("falls through to Basic exactly once, with a correctly encoded client_id:client_secret", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, { error: "invalid_client" })) // form body rejected
      .mockResolvedValueOnce(reply(200, { access_token: "tok-basic", expires_in: 3600 }));

    const token = await getBackendToken();

    expect(token).toBe("tok-basic");
    // Exactly two attempts: the form body, then Basic, then stop. There is no
    // third documented shape and nothing here may invent one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(TOKEN_REQUEST_SHAPES).toHaveLength(2);

    const auth = headersOfCall(1).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${KEY}`, "utf8").toString("base64")}`);
    // Decoding it really does yield the pair, rather than something merely
    // base64-shaped.
    expect(Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8")).toBe(
      `${CLIENT_ID}:${KEY}`,
    );
    // grant_type still travels in the body on the Basic shape; the credential
    // does not appear twice.
    const form = bodyOfCall(1);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.has("client_secret")).toBe(false);
    expect(String(fetchMock.mock.calls[1][1].body)).not.toContain(KEY);
    expect(getRememberedShapeName()).toBe("HTTP Basic (client_id:client_secret)");
  });

  it("uses only the shape that worked on a later refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(reply(401, { error: "invalid_client" }))
      .mockResolvedValueOnce(reply(200, { access_token: "tok-basic", expires_in: 3600 }));
    await getBackendToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-09-02T07:30:00Z"));
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "tok-basic-2", expires_in: 3600 }));

    expect(await getBackendToken()).toBe("tok-basic-2");
    // One more call, not two: the form body already known to be refused here
    // is not re-sent on every refresh.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(headersOfCall(2).Authorization).toMatch(/^Basic /);
  });
});

describe("token caching and expiry", () => {
  it("caches the access_token and does not re-request within its lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));
    fetchMock.mockResolvedValue(reply(200, { access_token: "tok-1", expires_in: 3600 }));

    expect(await getBackendToken()).toBe("tok-1");
    expect(await getBackendToken()).toBe("tok-1");
    vi.setSystemTime(new Date("2026-09-02T06:40:00Z"));
    expect(await getBackendToken()).toBe("tok-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes exactly once when the token passes its safety margin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "tok-1", expires_in: 3600 }));
    expect(await getBackendToken()).toBe("tok-1");

    // 56 minutes in: BEFORE the stated 60-minute expiry, but inside the
    // five-minute refresh margin. A token must never be handed out this close
    // to expiring -- a DealMatch/Run call takes ~40s and the morning report
    // makes a run of them, so it would expire mid-report.
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "tok-2", expires_in: 3600 }));
    vi.setSystemTime(new Date("2026-09-02T06:56:00Z"));

    expect(await getBackendToken()).toBe("tok-2");
    expect(await getBackendToken()).toBe("tok-2");
    // Exactly one refresh, not one per caller.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("assumes a short lifetime when the response omits expires_in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));
    fetchMock.mockResolvedValue(reply(200, { access_token: "tok-1" }));
    await getBackendToken();

    vi.setSystemTime(new Date("2026-09-02T06:02:00Z"));
    fetchMock.mockResolvedValue(reply(200, { access_token: "tok-2" }));
    expect(await getBackendToken()).toBe("tok-1");

    vi.setSystemTime(new Date("2026-09-02T06:10:00Z"));
    expect(await getBackendToken()).toBe("tok-2");
  });

  it("does not fetch a token per caller when several arrive at once", async () => {
    fetchMock.mockResolvedValue(reply(200, { access_token: "tok-1", expires_in: 3600 }));
    const tokens = await Promise.all([getBackendToken(), getBackendToken(), getBackendToken()]);
    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the API key never reaches a data endpoint", () => {
  // The backend team's hard rule. The key as a Bearer on a data endpoint
  // always 401s anyway, so it buys nothing -- but it puts a long-lived secret
  // in front of endpoints and access logs that should only ever see an
  // hour-long token.
  it("hands data requests the minted token and never the key", async () => {
    fetchMock.mockResolvedValue(reply(200, { access_token: "abcdef0123456789", expires_in: 3600 }));

    const seen = [];
    const call = vi.fn(async (token) => {
      seen.push(token);
      return { status: 200 };
    });
    await fetchWithBackendToken(call);

    expect(seen).toEqual(["abcdef0123456789"]);
    expect(seen.some((t) => String(t).includes(KEY))).toBe(false);
    // And the module itself contacted nothing but the token endpoint.
    expect(fetchMock.mock.calls.every(([url]) => String(url) === TOKEN_URL)).toBe(true);
  });

  it("still hands only the minted token to the retry after a 401", async () => {
    fetchMock.mockResolvedValue(reply(200, { access_token: "abcdef0123456789", expires_in: 3600 }));
    await getBackendToken(); // warm the cache: the retry is only for a held token

    const call = vi.fn().mockResolvedValue({ status: 401 });
    const response = await fetchWithBackendToken(call);

    expect(response.status).toBe(401);
    expect(call).toHaveBeenCalledTimes(2); // the original and ONE retry, no loop
    expect(call.mock.calls.flat()).toEqual(["abcdef0123456789", "abcdef0123456789"]);
    expect(call.mock.calls.flat()).not.toContain(KEY);
    // Two token-endpoint calls (the warm-up and the one refresh), and still
    // nothing but the token endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url) === TOKEN_URL)).toBe(true);
  });

  it("returns a successful retry and leaves a non-401 alone", async () => {
    fetchMock.mockResolvedValue(reply(200, { access_token: "tok-1", expires_in: 3600 }));
    await getBackendToken();

    const call = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 200 });
    expect((await fetchWithBackendToken(call)).status).toBe(200);
    expect(call).toHaveBeenCalledTimes(2);

    const ok = vi.fn().mockResolvedValue({ status: 500 });
    expect((await fetchWithBackendToken(ok)).status).toBe(500);
    // A 500 is the backend's problem, not a credential problem: re-minting
    // would just double the load on a backend that is already struggling.
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("configuration failures", () => {
  it("says so plainly when BACKEND_API_KEY is not set at all", async () => {
    delete process.env.BACKEND_API_KEY;
    const error = await getBackendToken().then(
      () => null,
      (e) => e,
    );
    expect(error.message).toContain("BACKEND_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails immediately naming BACKEND_CLIENT_ID, without contacting the endpoint", async () => {
    // Attempting the exchange with the secret alone is what produced the
    // confusing 500 ("missing required claims") that hid the real problem, so
    // there is deliberately no fallback here.
    delete process.env.BACKEND_CLIENT_ID;

    const error = await getBackendToken().then(
      () => null,
      (e) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BackendTokenError");
    expect(error.message).toContain("BACKEND_CLIENT_ID");
    expect(error.message).toContain("is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("failure reporting", () => {
  it("names the endpoint and both shapes with their status", async () => {
    fetchMock.mockResolvedValue(reply(400, { error: "invalid_client" }));

    const error = await getBackendToken().then(
      () => null,
      (e) => e,
    );

    expect(error.name).toBe("BackendTokenError");
    expect(error.message).toContain(TOKEN_URL);
    for (const shape of TOKEN_REQUEST_SHAPES) expect(error.message).toContain(shape.name);
    expect(error.message.match(/HTTP 400/g)).toHaveLength(TOKEN_REQUEST_SHAPES.length);
    expect(error.attempts).toHaveLength(TOKEN_REQUEST_SHAPES.length);
    expect(error.attempts.every((a) => a.status === 400)).toBe(true);
  });

  it("keeps the word 'token' from the backend's own prose but redacts real credentials", async () => {
    // The regression this pins: a blanket rule on everything after "Bearer "
    // rewrote the backend's "Bearer token missing, expired, or revoked." to
    // "Bearer [REDACTED] missing, expired, or revoked." -- redacting the WORD
    // "token" out of THEIR message and destroying the only diagnostic the
    // operator had. Secret VALUES go; vocabulary stays.
    const plantedToken = "abcdef0123456789abcdef0123456789";
    fetchMock.mockResolvedValue(
      reply(401, {
        error: "invalid_token",
        error_description: `Bearer token missing, expired, or revoked. The access token for client ${CLIENT_ID} was not issued.`,
        rejected_secret: KEY,
        access_token: plantedToken,
      }),
    );

    const error = await getBackendToken().then(
      () => null,
      (e) => e,
    );

    // The diagnosis survives, word for word.
    expect(error.message).toContain("Bearer token missing, expired, or revoked.");
    expect(error.message).toContain("invalid_token");
    expect(error.message).toContain("The access token for client");
    // The credentials do not.
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(plantedToken);
    expect(JSON.stringify(error.attempts)).not.toContain(KEY);
    expect(JSON.stringify(error.attempts)).not.toContain(plantedToken);
    expect(error.message).toContain("[REDACTED]");
    // The client id is an identifier, not a secret, and knowing which one was
    // refused is most of the diagnosis.
    expect(error.message).toContain(CLIENT_ID);
  });

  it("does not echo the token it is already holding when a refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "tok-HELD-777", expires_in: 3600 }));
    await getBackendToken();

    // The refresh is rejected with a body that quotes the token it is
    // refusing -- the shape a gateway uses to say "this one is revoked".
    vi.setSystemTime(new Date("2026-09-02T07:30:00Z"));
    fetchMock.mockResolvedValue(reply(401, `{"error":"revoked: tok-HELD-777"}`));

    const error = await getBackendToken().then(
      () => null,
      (e) => e,
    );
    expect(error.message).toContain("HTTP 401");
    expect(error.message).not.toContain("tok-HELD-777");
  });

  it("records a shape that failed at the transport layer and keeps going", async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" }))
      .mockResolvedValueOnce(reply(200, { access_token: "tok-basic", expires_in: 3600 }));
    // A network blip on the form body must not abort before Basic is tried.
    expect(await getBackendToken()).toBe("tok-basic");
    expect(getRememberedShapeName()).toBe("HTTP Basic (client_id:client_secret)");
  });
});
