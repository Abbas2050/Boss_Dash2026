// @vitest-environment node
//
// The gate that makes /api and /rest deny-by-default.
//
// Seventeen /api routes shipped with no authentication, including the treasury
// report and six write endpoints. Guarding them individually would have left
// the default open, so route eighteen would arrive unprotected the same way.
import { describe, it, expect } from "vitest";
import { PUBLIC_API_ROUTES, isPublicApiRoute } from "./requireSession.js";

describe("allow-list", () => {
  it("contains exactly the four routes that cannot carry a session", () => {
    expect([...PUBLIC_API_ROUTES].sort()).toEqual([
      "GET /api/docusign/health",
      "POST /api/auth/login",
      "POST /api/docusign/webhooks/connect",
      "POST /api/docusign/webhooks/fxbo/application-approved",
    ]);
  });

  it("exempts login", () => {
    expect(isPublicApiRoute("POST", "/api/auth/login")).toBe(true);
  });

  // Prefix matching would exempt every sibling added under an allow-listed
  // path later, which is the drift this exists to stop.
  it("does not exempt a sibling that shares a prefix", () => {
    expect(isPublicApiRoute("POST", "/api/auth/users")).toBe(false);
    expect(isPublicApiRoute("GET", "/api/docusign/overview")).toBe(false);
    expect(isPublicApiRoute("POST", "/api/docusign/webhooks/connect/extra")).toBe(false);
  });

  it("is method-sensitive", () => {
    expect(isPublicApiRoute("GET", "/api/auth/login")).toBe(false);
  });

  it("ignores a query string and a trailing slash", () => {
    expect(isPublicApiRoute("POST", "/api/auth/login?next=/")).toBe(true);
    expect(isPublicApiRoute("POST", "/api/auth/login/")).toBe(true);
  });

  it("accepts a lowercase method", () => {
    expect(isPublicApiRoute("post", "/api/auth/login")).toBe(true);
  });

  // Express's default "case sensitive routing" is false, so Express itself
  // will route /API/auth/login to the real login handler. The allow-list
  // must recognise that request as the same route or a client that happens
  // to send different case gets wrongly locked out of an intentionally
  // public endpoint.
  it("matches the allow-list regardless of incoming case", () => {
    expect(isPublicApiRoute("POST", "/API/auth/login")).toBe(true);
    expect(isPublicApiRoute("post", "/Api/Auth/Login")).toBe(true);
  });

  // The endpoints that were verified publicly readable, plus every
  // unauthenticated write. Named individually so a regression says which.
  it("does not exempt any sensitive route", () => {
    for (const [method, path] of [
      ["GET", "/api/closing-balance-report"],
      ["GET", "/api/wallet/google-sheet-mapping"],
      ["PUT", "/api/wallet/google-sheet-mapping"],
      ["POST", "/api/wallet/google-sheet-mapping/reset"],
      ["POST", "/api/lp-equity-snapshots"],
      ["POST", "/api/lp-equity-live-snapshots"],
      ["POST", "/api/dealing-client-lots-snapshots"],
      ["POST", "/api/mock/alerts/trigger"],
      ["GET", "/rest/trades"],
    ]) {
      expect(isPublicApiRoute(method, path), `${method} ${path} must not be public`).toBe(false);
    }
  });
});

describe("requireSession", () => {
  const mkRes = () => {
    const res = { statusCode: 0, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
  };
  const call = async (req) => {
    const { requireSession } = await import("./requireSession.js");
    const res = mkRes();
    let passed = false;
    await requireSession(req, res, () => { passed = true; });
    return { res, passed };
  };

  it("ignores paths outside /api and /rest", async () => {
    const { passed } = await call({ method: "GET", path: "/report-charts/abc/x.png", headers: {} });
    expect(passed).toBe(true);
  });

  it("lets an allow-listed route through without a token", async () => {
    const { passed } = await call({ method: "POST", path: "/api/auth/login", headers: {} });
    expect(passed).toBe(true);
  });

  it("rejects a guarded route with no token", async () => {
    const { res, passed } = await call({ method: "GET", path: "/api/closing-balance-report", headers: {} });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  // Express itself would route either of these to the real treasury-report
  // handler (case sensitive routing defaults to false, and server.js:1007
  // already mounts /api/ClientProfile in mixed case), so the gate must
  // guard them too or URL casing alone is a full bypass.
  it("guards a sensitive route regardless of incoming case", async () => {
    const upper = await call({ method: "GET", path: "/API/closing-balance-report", headers: {} });
    expect(upper.passed).toBe(false);
    expect(upper.res.statusCode).toBe(401);

    const mixed = await call({ method: "GET", path: "/Api/Closing-Balance-Report", headers: {} });
    expect(mixed.passed).toBe(false);
    expect(mixed.res.statusCode).toBe(401);
  });

  // /apifoo is a different path from /api -- it just happens to share a
  // prefix -- so it must stay ungated in any case, the same as it does
  // lowercase.
  it("does not guard a path that merely shares a prefix with /api, in any case", async () => {
    const lower = await call({ method: "GET", path: "/apifoo/x", headers: {} });
    expect(lower.passed).toBe(true);

    const upper = await call({ method: "GET", path: "/APIFOO/x", headers: {} });
    expect(upper.passed).toBe(true);
  });

  // A deny-by-default gate must fail CLOSED on a path it cannot recognise:
  // an empty, undefined, or non-string path must never be treated as "not
  // guarded" just because it doesn't happen to start with /api or /rest.
  it("fails closed when path, originalUrl and url are all missing", async () => {
    const { res, passed } = await call({ method: "GET", headers: {} });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("fails closed on an empty path", async () => {
    const { res, passed } = await call({ method: "GET", path: "", headers: {} });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("fails closed on a non-string path", async () => {
    const { res, passed } = await call({ method: "GET", path: 42, headers: {} });
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
