// @vitest-environment node
//
// Every SignalR connection in the app must (a) address the real hub and
// (b) present a Bearer, and both have been silently wrong here before.
//
// (a) Two sites carried an automatic-semicolon-insertion slip:
//
//       const backendBaseUrl = (import.meta as any).env?.VITE_BACKEND_BASE_URL || '';
//       const hubUrl = backendBaseUrl
//     DASHBOARD_HUB_URL;
//
//     That is not a ternary. ASI ends the declaration after `backendBaseUrl`,
//     so `DASHBOARD_HUB_URL;` is a dead expression statement and the hub URL
//     is thrown away. VITE_BACKEND_BASE_URL is undefined in production -- the
//     credentials were renamed off the VITE_ prefix and it went with them --
//     so hubUrl was the empty string and those connections could not work at
//     all, with or without auth. It compiles and it type-checks; only reading
//     the source or watching the network catches it.
//
// (b) The backend now 401s negotiate without a Bearer, and a connection built
//     with no accessTokenFactory never even asks for one.
//
// This is static text analysis, like auth/routeCoverage.test.js: the
// components need a DOM, a router and a live hub to instantiate, so scanning
// source is what can actually run here. It sees the shapes this repo uses --
// `hubUrl:` / `hubUrl =` in a SignalRConnectionManager options object, and
// `.withUrl(` for a raw HubConnectionBuilder. A connection registered some
// other way will not be seen; extend this if one appears.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Every file that opens a hub connection. Listed explicitly rather than
// globbed so that deleting a connection is a visible edit to this list.
const HUB_FILES = [
  "src/components/AlertsHubProvider.tsx",
  "src/components/LiveAlertsNotifier.tsx",
  "src/hooks/useAccountAlerts.ts",
  "src/hooks/useLiveTransactionAlerts.ts",
  "src/pages/departments/DealingDepartmentPage.tsx",
  "src/pages/departments/dealing/LpRiskAlertsTab.tsx",
  "src/pages/settings/WSTestPage.tsx",
];

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

// Strip comments before judging code, so the prose ABOUT the old broken
// expression (which this repo deliberately keeps, to stop it being
// reintroduced) is not mistaken for the expression itself.
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// The two sites that carried the ASI slip.
const ASI_SITES = ["src/hooks/useAccountAlerts.ts", "src/pages/settings/WSTestPage.tsx"];

describe("hub URL", () => {
  it.each(ASI_SITES)("%s assigns hubUrl the real hub URL, not \"\"", (file) => {
    const body = code(file);

    // The bug's signature: an assignment to hubUrl that ends on its own line
    // with DASHBOARD_HUB_URL orphaned below it.
    expect(
      body,
      `${file} has the ASI slip back: \`const hubUrl = backendBaseUrl\` followed by a ` +
        "bare `DASHBOARD_HUB_URL;` is two statements, and hubUrl ends up the empty string",
    ).not.toMatch(/hubUrl\s*=\s*[A-Za-z_$][\w$]*\s*\n\s*DASHBOARD_HUB_URL\s*;/);

    // And the positive statement of what it must be instead.
    expect(
      body,
      `${file} no longer assigns hubUrl from DASHBOARD_HUB_URL`,
    ).toMatch(/hubUrl\s*=\s*DASHBOARD_HUB_URL\s*;/);

    // VITE_BACKEND_BASE_URL is undefined in production, so nothing may derive
    // the hub address from it any more.
    expect(
      body,
      `${file} still reads VITE_BACKEND_BASE_URL, which is undefined in production`,
    ).not.toMatch(/VITE_BACKEND_BASE_URL/);
  });

  it("never points a hub at the /api/backend proxy", () => {
    for (const file of HUB_FILES) {
      const body = code(file);
      expect(
        body,
        `${file} routes the hub through BACKEND_BASE_URL; /api/backend is a fetch-based ` +
          "HTTP proxy and cannot carry a websocket upgrade",
      ).not.toMatch(/hubUrl\s*[:=]\s*BACKEND_BASE_URL/);
    }
  });
});

describe("hub authentication", () => {
  it.each(HUB_FILES)("%s takes its Bearer from the shared factory", (file) => {
    const body = code(file);
    expect(
      body,
      `${file} opens a hub connection without importing the shared token factory`,
    ).toMatch(/hubAccessTokenFactory/);
  });

  it.each(HUB_FILES)("%s configures accessTokenFactory on every connection", (file) => {
    const body = code(file);
    // One factory per connection: each `new SignalRConnectionManager(` and
    // each raw `.withUrl(` opens one and needs its own. Counted this way
    // rather than by counting `hubUrl` references, because a hub URL can be
    // computed in a helper without a connection being opened there.
    const connections =
      (body.match(/new\s+SignalRConnectionManager\s*\(/g) || []).length +
      (body.match(/\.withUrl\(/g) || []).length;
    // Lowercase 'a': this counts the OPTION `accessTokenFactory:`, not the
    // imported identifier `hubAccessTokenFactory`, which would double-count.
    const factories = (body.match(/(?<![A-Za-z])accessTokenFactory/g) || []).length;
    expect(connections, `${file} was listed as a hub file but opens no connection`).toBeGreaterThan(0);
    expect(
      factories,
      `${file} opens ${connections} hub connection(s) but configures ${factories} ` +
        "accessTokenFactory: an unconfigured one negotiates anonymously and gets 401",
    ).toBeGreaterThanOrEqual(connections);
  });

  // Two ways to fetch the same credential meant two ways for it to be missing
  // and no way to tell them apart from the symptom. The VITE_SIGNALR_TOKEN_URL
  // probe was unset in production, returned null, and let negotiate go out
  // unauthenticated.
  it("keeps exactly one mechanism for obtaining the token", () => {
    for (const file of HUB_FILES) {
      expect(
        code(file),
        `${file} still probes VITE_SIGNALR_TOKEN_URL: there must be one token source, ` +
          "src/lib/hubAccessToken.ts",
      ).not.toMatch(/VITE_SIGNALR_TOKEN_URL/);
    }
  });
});
