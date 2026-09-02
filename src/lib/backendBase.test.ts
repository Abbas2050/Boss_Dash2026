// The two constants in backendBase.ts now deliberately point at DIFFERENT
// places, and both halves of that split are load-bearing:
//
//   - BACKEND_BASE_URL must stay same-origin. api.skylinkscapital.com requires
//     a Bearer minted from BACKEND_API_KEY, and that credential must never be
//     in the browser bundle, so the browser has to go through our /api/backend
//     proxy which attaches it server-side. Putting the direct origin back here
//     reinstates the 401 that took the dashboard's main data source down.
//   - DASHBOARD_HUB_URL must stay on the direct origin. It is a SignalR
//     websocket and the HTTP proxy cannot carry an upgrade, so routing it
//     through /api/backend would not fix live alerts, it would only make them
//     fail somewhere less obvious. Broken and visible beats broken and hidden.
import { describe, it, expect } from "vitest";
import { BACKEND_BASE_URL, DASHBOARD_HUB_URL } from "./backendBase";

describe("backend base URLs", () => {
  it("routes HTTP through the same-origin proxy, never the backend origin", () => {
    expect(BACKEND_BASE_URL).toBe("/api/backend");
    expect(BACKEND_BASE_URL.startsWith("/")).toBe(true);
    expect(BACKEND_BASE_URL).not.toContain("api.skylinkscapital.com");
    expect(BACKEND_BASE_URL).not.toMatch(/^https?:\/\//i);
  });

  it("appends paths to a prefix, not an origin, so callers need no change", () => {
    expect(`${BACKEND_BASE_URL}/Metrics/dashboard`).toBe("/api/backend/Metrics/dashboard");
    // The one shape callers may not use: parsing the base as absolute. This is
    // what `new URL(BACKEND_BASE_URL)` would do, and it must fail loudly here
    // rather than at runtime in somebody's component.
    expect(() => new URL(BACKEND_BASE_URL)).toThrow();
    // The shape they may use, and do (rebateApi.ts, dealingApi.ts).
    expect(new URL(`${BACKEND_BASE_URL}/Deal/GetDealsByLogin`, "https://app.example.com").pathname).toBe(
      "/api/backend/Deal/GetDealsByLogin",
    );
  });

  it("leaves the SignalR hub on the direct backend origin", () => {
    expect(DASHBOARD_HUB_URL).toMatch(/^https?:\/\//i);
    expect(DASHBOARD_HUB_URL.endsWith("/ws/dashboard")).toBe(true);
    expect(DASHBOARD_HUB_URL.startsWith(BACKEND_BASE_URL)).toBe(false);
    // With no VITE_BACKEND_BASE_URL configured -- the production case, since
    // that variable was renamed off the VITE_ prefix -- it is the real backend.
    expect(new URL(DASHBOARD_HUB_URL).hostname).toBe("api.skylinkscapital.com");
  });
});
