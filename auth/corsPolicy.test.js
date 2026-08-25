// @vitest-environment node
//
// `origin: true` reflects the caller's Origin header. With credentials: true
// that lets any site a signed-in user visits call this API as them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SERVER = readFileSync(path.resolve("server.js"), "utf8");

describe("CORS policy", () => {
  it("never reflects an arbitrary origin", () => {
    // `origin: true` and the old ternary that fell back to it.
    expect(SERVER).not.toMatch(/origin:\s*true/);
    expect(SERVER).not.toMatch(/origin:\s*process\.env\.CORS_ORIGIN\s*\?/);
  });

  it("refuses cross-origin requests when CORS_ORIGIN is unset", () => {
    expect(SERVER).toMatch(/origin:\s*CORS_ALLOWED\.length\s*\?\s*CORS_ALLOWED\s*:\s*false/);
  });

  // Reflecting an origin is only dangerous because credentials ride along.
  // If credentials are ever dropped, this test should be revisited, not deleted.
  it("still sends credentials, so the origin list is what protects the API", () => {
    expect(SERVER).toMatch(/credentials:\s*true/);
  });

  it("strips trailing slashes from origin entries to avoid silent mismatches", () => {
    // Browsers send Origin: https://foo.com (no trailing slash), so
    // https://foo.com/ in the config must be normalized or it never matches.
    // This is a silent failure (the origin is blocked), not an error, so normalization
    // prevents confusing outages when operators configure CORS_ORIGIN=https://foo.com/
    expect(SERVER).toMatch(/\.replace\([^)]*\$[^)]*\)/);
  });
});
