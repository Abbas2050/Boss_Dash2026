// @vitest-environment node
//
// The eleventh copy must not reappear.
//
// The backend origin now rejects every unauthenticated request with 401
// invalid_token, and the Bearer that unlocks it is minted from BACKEND_API_KEY,
// which must never be in a browser bundle. So the browser cannot address the
// backend directly at all any more; it goes through the same-origin proxy at
// /api/backend, which attaches the token server-side.
//
// The reason this needs a test rather than a code review is how the breakage
// arrived: backendBase.ts existed, and eleven files still each carried their own
// `String(env?.VITE_BACKEND_BASE_URL || "<the origin>")` line, because that line
// is short, self-contained and looks harmless in a diff. Every one of those
// copies kept ~45 fetch sites pointed at the origin, and they all 401'd at once.
// A single place to change is only a single place to change if nothing can
// quietly grow a twelfth copy.
//
// The literal is therefore banned from src/ outright, with exactly two homes:
//
//   - src/lib/backendBase.ts, which owns BACKEND_DIRECT_ORIGIN and builds
//     DASHBOARD_HUB_URL from it. The SignalR hub genuinely must keep the direct
//     origin -- an HTTP proxy built on fetch() cannot carry a websocket upgrade
//     -- so the origin has to live somewhere, and one file is where.
//   - test files, which have to name the thing they are asserting about.
//
// Note the ban covers comments too, not just code. That is deliberate and not
// pedantry: a commented-out or documented origin is exactly what somebody
// copies back into a fetch call, and a scan that carved out comments would have
// to parse them correctly to stay honest. Say "the backend origin" in prose.
import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "fs";
import path from "path";

// Assembled rather than written whole so this scan does not have to exempt
// itself from the rule it enforces by name.
const BACKEND_ORIGIN_HOST = ["api", "skylinkscapital", "com"].join(".");

// backendBase.ts is the one module allowed to name the origin: it exports both
// the proxy prefix everything else must use and the hub URL that legitimately
// still needs the direct origin.
const ALLOWED = new Set([path.resolve("src/lib/backendBase.ts")]);

function sourceFiles(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
    .map((f) => path.resolve(f))
    .filter((f) => !f.includes(".test."))
    .filter((f) => !ALLOWED.has(f));
}

function offendingLines(file: string): string[] {
  const rel = path.relative(process.cwd(), file);
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes(BACKEND_ORIGIN_HOST))
    .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`);
}

describe("the backend origin is named in exactly one place", () => {
  it("appears nowhere under src/ outside backendBase.ts and tests", () => {
    const offenders = sourceFiles().flatMap(offendingLines);
    expect(
      offenders,
      offenders.length
        ? `Only src/lib/backendBase.ts may name the backend origin. Import BACKEND_BASE_URL from @/lib/backendBase for HTTP (and send ...authHeaders() with it -- /api/backend is behind requireSession), or DASHBOARD_HUB_URL for the SignalR hub:\n${offenders.join("\n")}`
        : "",
    ).toEqual([]);
  });

  it("scans a non-trivial number of files, so a passing run means something", () => {
    // A glob that silently matched nothing would make the assertion above pass
    // for the wrong reason -- the failure mode this whole file exists to catch.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("still finds the origin where it is supposed to live", () => {
    // The counterpart to the ban: backendBase.ts must keep naming it, because
    // DASHBOARD_HUB_URL is built from it. If this stops matching, someone has
    // "cleaned up" the hub onto the proxy and broken it in a quieter way.
    expect(readFileSync(path.resolve("src/lib/backendBase.ts"), "utf8")).toContain(BACKEND_ORIGIN_HOST);
  });
});
