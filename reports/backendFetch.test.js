// @vitest-environment node
//
// node, not the suite's default jsdom, because backendFetch() calls
// AbortSignal.timeout() -- the same reason wallet/backendProxy.test.js and
// wallet/pspClients.test.js opt out.
//
// Two properties are under test, and the second matters more than the first:
//
//   1. The Bearer actually gets onto the request. Every report figure now
//      depends on it; without it the backend answers 401 and the emails go out
//      with the sections blank.
//   2. A token failure degrades. These reports each already turn a backend
//      outage into "section unavailable", and a missing or rejected
//      BACKEND_API_KEY has to land in that SAME path -- not as an exception
//      that kills the whole email, and never as a zero, which a reader cannot
//      tell apart from a real figure.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetBackendTokenState } from "../wallet/backendToken.js";
import { backendFetch } from "./reportShared.js";
import { fetchEquityPosition } from "./summaryCore.js";

const realFetch = globalThis.fetch;
const realKey = process.env.BACKEND_API_KEY;

beforeEach(() => {
  resetBackendTokenState();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.BACKEND_API_KEY;
  else process.env.BACKEND_API_KEY = realKey;
  resetBackendTokenState();
});

function stubFetch(calls, { token = "issued-token" } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: token, expires_in: 300 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("backendFetch", () => {
  it("attaches the minted Bearer to the backend call", async () => {
    process.env.BACKEND_API_KEY = "unit-test-key";
    const calls = [];
    stubFetch(calls, { token: "issued-token" });

    const resp = await backendFetch("/Metrics/dashboard");
    expect(resp.status).toBe(200);

    const dataCall = calls.find((c) => c.url.includes("/Metrics/dashboard"));
    expect(dataCall, "the backend call never happened").toBeTruthy();
    expect(dataCall.init.headers.Authorization).toBe("Bearer issued-token");
  });

  it("keeps the query string, which is the whole of a report request", async () => {
    process.env.BACKEND_API_KEY = "unit-test-key";
    const calls = [];
    stubFetch(calls);

    await backendFetch("/DealMatch/Run?group=*&from=1&to=2&lite=true");
    const dataCall = calls.find((c) => c.url.includes("/DealMatch/Run"));
    expect(dataCall.url).toContain("?group=*&from=1&to=2&lite=true");
  });

  it("reports an upstream error status rather than throwing, so `if (!resp.ok)` still owns it", async () => {
    process.env.BACKEND_API_KEY = "unit-test-key";
    globalThis.fetch = async (url) =>
      String(url).includes("/oauth/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 })
        : new Response("upstream exploded", { status: 500 });

    const resp = await backendFetch("/Metrics/dashboard");
    expect(resp.status).toBe(500);
  });

  it("surfaces a token failure as an ordinary rejection, not a swallowed error", async () => {
    // No key at all: backendToken.js fails before any network call, which is
    // the shape a misconfigured server produces.
    process.env.BACKEND_API_KEY = "";
    globalThis.fetch = async () => {
      throw new Error("no request should be attempted without a token");
    };

    await expect(backendFetch("/Metrics/dashboard")).rejects.toThrow(/BACKEND_API_KEY is not set/);
  });
});

describe("a token failure degrades to the section's existing unavailable path", () => {
  it("renders Equity Position as unavailable instead of throwing out of the report", async () => {
    process.env.BACKEND_API_KEY = "";
    globalThis.fetch = async () => {
      throw new Error("no request should be attempted without a token");
    };

    // fetchEquityPosition() wraps each endpoint in its own try/catch. The
    // token error has to be caught there like any other failure: the caller
    // sees nulls, and weeklyBusinessSummary.js turns nulls into the
    // "Withdrawable equity unavailable" note plus a footer notice.
    const position = await fetchEquityPosition();

    expect(position).toEqual({ withdrawable: null, gross: null });
    // The distinction that matters: unavailable, not zero. A zeroed equity row
    // would read as a genuine figure and nobody would question it.
    expect(position.withdrawable).toBeNull();
    expect(position.gross).toBeNull();
  });
});
