// @vitest-environment node
//
// The suite's default environment is jsdom (vite.config.ts), whose
// AbortSignal has no .timeout() -- and the token exchange calls
// AbortSignal.timeout(). Node's has it, the same reason pspClients.test.js
// and auth/routeCoverage.test.js opt into node.
//
// Everything here stubs fetch. Nothing in this file talks to the real
// api.skylinkscapital.com, and nothing needs BACKEND_API_KEY to be real.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getBackendToken,
  fetchWithBackendToken,
  resetBackendTokenState,
  getRememberedCandidateName,
  TOKEN_REQUEST_CANDIDATES,
} from "./backendToken.js";

const KEY = "sk_backend_live_9f3a1c2b4d";

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
  process.env.BACKEND_API_BASE_URL = "https://api.skylinkscapital.com";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.BACKEND_API_KEY;
  delete process.env.BACKEND_API_BASE_URL;
});

function bodyOfCall(i) {
  return String(fetchMock.mock.calls[i][1].body || "");
}

function headersOfCall(i) {
  return fetchMock.mock.calls[i][1].headers || {};
}

describe("candidate discovery", () => {
  // The parameter name for the key could not be established by probing --
  // the key exists only in the server .env -- so the first exchange walks an
  // ordered list. This is the test that the walk stops at the first shape
  // that actually yields a token, and that the answer is not re-derived on
  // every later refresh.
  it("selects the first candidate that returns a token and remembers it", async () => {
    fetchMock
      // 0. direct Bearer -> rejected, so the walk falls through to the
      //    /oauth/token exchange shapes exactly as it would without it.
      .mockResolvedValueOnce(reply(401, { error: "invalid_token" }))
      // 1. client_secret+client_id -> rejected outright
      .mockResolvedValueOnce(reply(400, { error: "invalid_client" }))
      // 2. client_secret -> 200 but no token in it, which must NOT count as
      //    working: remembering it would poison every later call.
      .mockResolvedValueOnce(reply(200, { error_description: "missing claims" }))
      // 3. api_key -> the real winner
      .mockResolvedValueOnce(reply(200, { access_token: "tok-A", expires_in: 3600 }));

    const token = await getBackendToken();

    expect(token).toBe("tok-A");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(getRememberedCandidateName()).toBe("form api_key");

    // The winning request really was form-encoded with the key under api_key.
    expect(headersOfCall(3)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(bodyOfCall(3)).toContain("grant_type=client_credentials");
    expect(bodyOfCall(3)).toContain(`api_key=${encodeURIComponent(KEY)}`);
    expect(fetchMock.mock.calls[3][0]).toBe("https://api.skylinkscapital.com/oauth/token");
    // And the direct-Bearer attempt really did hit the validation endpoint,
    // not the token endpoint.
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.skylinkscapital.com/Metrics/dashboard");
  });

  it("uses only the remembered shape on a later refresh instead of re-probing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));

    fetchMock
      .mockResolvedValueOnce(reply(401, { error: "invalid_token" })) // direct Bearer
      .mockResolvedValueOnce(reply(400, { error: "invalid_client" }))
      .mockResolvedValueOnce(reply(400, { error: "invalid_client" }))
      .mockResolvedValueOnce(reply(200, { access_token: "tok-A", expires_in: 3600 }));
    await getBackendToken();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Walk past the cached token's usable life so the next call must re-mint.
    vi.setSystemTime(new Date("2026-09-02T07:30:00Z"));
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "tok-B", expires_in: 3600 }));

    const second = await getBackendToken();

    expect(second).toBe("tok-B");
    // One more call, not five: the direct-Bearer attempt and the two shapes
    // already known to fail are not tried again.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(bodyOfCall(4)).toContain(`api_key=${encodeURIComponent(KEY)}`);
  });

  it("accepts a response that names the token `token` rather than `access_token`", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, { error: "invalid_token" })) // direct Bearer
      .mockResolvedValueOnce(reply(200, { token: "tok-plain" }));
    expect(await getBackendToken()).toBe("tok-plain");
  });

  it("sends the key as a header for the header-shaped candidates", async () => {
    // Force the walk past the direct-Bearer attempt and the first three
    // exchange shapes to prove the header candidates put the key in a header
    // and not in the form body.
    fetchMock
      .mockResolvedValueOnce(reply(401, "no")) // direct Bearer
      .mockResolvedValueOnce(reply(400, "no"))
      .mockResolvedValueOnce(reply(400, "no"))
      .mockResolvedValueOnce(reply(400, "no"))
      .mockResolvedValueOnce(reply(200, { access_token: "tok-H", expires_in: 600 }));

    await getBackendToken();

    expect(getRememberedCandidateName()).toBe("header X-Api-Key");
    expect(headersOfCall(4)["X-Api-Key"]).toBe(KEY);
    expect(bodyOfCall(4)).not.toContain(KEY);
  });
});

describe("direct Bearer", () => {
  // "First thing tried, before any exchange": BACKEND_API_KEY is sent as-is
  // against a real endpoint, and only adopted if that comes back 2xx.
  it("adopts BACKEND_API_KEY as-is when it validates, without ever contacting /oauth/token", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { status: "ok" }));

    const token = await getBackendToken();

    expect(token).toBe(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.skylinkscapital.com/Metrics/dashboard");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(headersOfCall(0).Authorization).toBe(`Bearer ${KEY}`);
    expect(getRememberedCandidateName()).toBe("direct Bearer (BACKEND_API_KEY as-is)");
    // The exchange endpoint was never hit at all.
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/oauth/token"))).toBe(false);
  });

  it("falls through to the exchange shapes when the direct Bearer gets a 401", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, { error: "invalid_token" })) // direct Bearer: not a Bearer
      .mockResolvedValueOnce(reply(400, { error: "invalid_client" })) // client_secret+client_id
      .mockResolvedValueOnce(reply(200, { access_token: "tok-exchange", expires_in: 3600 })); // client_secret

    const token = await getBackendToken();

    expect(token).toBe("tok-exchange");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.skylinkscapital.com/Metrics/dashboard");
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.skylinkscapital.com/oauth/token");
    expect(getRememberedCandidateName()).toBe("form client_secret");
  });

  it("caches the adopted direct key and does not re-validate on every call", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { status: "ok" }));

    expect(await getBackendToken()).toBe(KEY);
    expect(await getBackendToken()).toBe(KEY);
    expect(await getBackendToken()).toBe(KEY);

    // Only the first call actually validated; the rest were served from cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-validates the direct Bearer exactly once on a 401 and does not loop", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await getBackendToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRememberedCandidateName()).toBe("direct Bearer (BACKEND_API_KEY as-is)");

    // A backend that rejects the direct key on every call, which is exactly
    // the shape that would send a naive implementation into a re-validation
    // loop.
    const call = vi.fn().mockResolvedValue({ status: 401 });
    const response = await fetchWithBackendToken(call);

    expect(response.status).toBe(401);
    expect(call).toHaveBeenCalledTimes(2); // the original and ONE retry
    expect(fetchMock).toHaveBeenCalledTimes(2); // the warm-up and ONE re-validation
    expect(call.mock.calls[0][0]).toBe(KEY);
    expect(call.mock.calls[1][0]).toBe(KEY);
  });
});

describe("token caching", () => {
  it("reuses a cached token within its lifetime and refreshes before it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(reply(401, "no")) // direct Bearer rejected, so this exercises the exchange path
      .mockResolvedValue(reply(200, { access_token: "tok-1", expires_in: 3600 }));

    expect(await getBackendToken()).toBe("tok-1");
    expect(await getBackendToken()).toBe("tok-1");
    // Well inside the lifetime: still the same token, still the one exchange
    // beyond the rejected direct-Bearer attempt.
    vi.setSystemTime(new Date("2026-09-02T06:30:00Z"));
    expect(await getBackendToken()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 59m30s in: BEFORE the stated 60m expiry, but inside the refresh skew.
    // A token must never be handed out this close to expiring, because a
    // DealMatch/Run call takes ~40 seconds and would expire mid-flight.
    fetchMock.mockResolvedValue(reply(200, { access_token: "tok-2", expires_in: 3600 }));
    vi.setSystemTime(new Date("2026-09-02T06:59:30Z"));
    expect(await getBackendToken()).toBe("tok-2");
    // One more call: the remembered exchange shape re-mints; the direct
    // Bearer (already known not to work) is not retried.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("assumes a short lifetime when the response omits expires_in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(reply(401, "no")) // direct Bearer rejected
      .mockResolvedValue(reply(200, { access_token: "tok-1" }));
    await getBackendToken();

    // Two minutes on, the assumed lifetime has not run out yet.
    vi.setSystemTime(new Date("2026-09-02T06:02:00Z"));
    fetchMock.mockResolvedValue(reply(200, { access_token: "tok-2" }));
    expect(await getBackendToken()).toBe("tok-1");

    // Ten minutes on it has, so a fresh one is minted rather than a stale
    // guess being handed out indefinitely.
    vi.setSystemTime(new Date("2026-09-02T06:10:00Z"));
    expect(await getBackendToken()).toBe("tok-2");
  });

  it("does not fetch a token per caller when several arrive at once", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, "no")) // direct Bearer rejected
      .mockResolvedValue(reply(200, { access_token: "tok-1", expires_in: 3600 }));
    const tokens = await Promise.all([getBackendToken(), getBackendToken(), getBackendToken()]);
    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    // Only one exchange walk (direct Bearer + the winning shape) for all
    // three concurrent callers, not three.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("401 refresh and retry", () => {
  it("retries a 401 exactly once and does not loop", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, "no")) // direct Bearer rejected
      .mockResolvedValue(reply(200, { access_token: "tok-1", expires_in: 3600 }));
    // Warm the cache: the retry only makes sense for a token we were holding.
    await getBackendToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A backend that rejects every token, which is exactly the shape that
    // would send a naive implementation into an infinite refresh loop.
    const call = vi.fn().mockResolvedValue({ status: 401 });
    const response = await fetchWithBackendToken(call);

    expect(response.status).toBe(401);
    expect(call).toHaveBeenCalledTimes(2); // the original and ONE retry
    // One more fetch call: the remembered exchange shape re-mints, the
    // direct-Bearer attempt (already known not to work) is not retried.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The retry used a token minted after the rejection, not the stale one.
    expect(call.mock.calls[0][0]).toBe("tok-1");
  });

  it("returns a successful retry and leaves a non-401 alone", async () => {
    fetchMock.mockResolvedValue(reply(200, { access_token: "tok-1", expires_in: 3600 }));
    await getBackendToken();

    const call = vi
      .fn()
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200 });
    expect((await fetchWithBackendToken(call)).status).toBe(200);
    expect(call).toHaveBeenCalledTimes(2);

    const ok = vi.fn().mockResolvedValue({ status: 500 });
    expect((await fetchWithBackendToken(ok)).status).toBe(500);
    // A 500 is the backend's problem, not a credential problem: re-minting
    // would just double the load on a backend that is already struggling.
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("failure reporting", () => {
  it("names every shape with its status, and leaks neither the key nor a token", async () => {
    // Every candidate rejected, and the gateway echoes the credential back in
    // its complaint -- which is exactly how a key ends up in a log.
    fetchMock.mockResolvedValue(
      reply(400, {
        error: "invalid_client",
        error_description: `no client registered for secret ${KEY}`,
        access_token: "tok-LEAKED-abc123",
      }),
    );

    const error = await getBackendToken().then(
      () => null,
      (e) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BackendTokenError");
    // Something precise to hand the backend team: the endpoint, and each
    // shape with what it actually got back.
    expect(error.message).toContain("https://api.skylinkscapital.com/oauth/token");
    for (const candidate of TOKEN_REQUEST_CANDIDATES) {
      expect(error.message).toContain(candidate.name);
    }
    expect(error.message.match(/HTTP 400/g)).toHaveLength(TOKEN_REQUEST_CANDIDATES.length);
    expect(error.attempts).toHaveLength(TOKEN_REQUEST_CANDIDATES.length);
    expect(error.attempts.every((a) => a.status === 400)).toBe(true);

    // The whole point: the operator gets a diagnosis, not a credential.
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("tok-LEAKED-abc123");
    expect(JSON.stringify(error.attempts)).not.toContain(KEY);
    expect(JSON.stringify(error.attempts)).not.toContain("tok-LEAKED-abc123");
    expect(error.message).toContain("[REDACTED]");
  });

  it("does not echo the token it is already holding when a refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T06:00:00Z"));
    fetchMock
      .mockResolvedValueOnce(reply(401, "no")) // direct Bearer rejected
      .mockResolvedValueOnce(reply(200, { access_token: "tok-HELD-777", expires_in: 3600 }));
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

  it("records a shape that failed at the transport layer and keeps walking", async () => {
    fetchMock
      // The direct-Bearer validation itself is what hits the network blip
      // here; the walk must still continue into the exchange shapes.
      .mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" }))
      .mockResolvedValueOnce(reply(200, { access_token: "tok-A", expires_in: 60 }));
    // A network blip on the first candidate must not abort the walk before
    // the shape that works is ever tried.
    expect(await getBackendToken()).toBe("tok-A");
  });

  it("says so plainly when BACKEND_API_KEY is not set at all", async () => {
    delete process.env.BACKEND_API_KEY;
    const error = await getBackendToken().then(
      () => null,
      (e) => e,
    );
    expect(error.message).toContain("BACKEND_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
