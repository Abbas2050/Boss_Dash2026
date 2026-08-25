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
});
