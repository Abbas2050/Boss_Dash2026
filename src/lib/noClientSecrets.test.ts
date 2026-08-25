// @vitest-environment node
//
// No credential may be read from browser code.
//
// Vite exposes only VITE_-prefixed variables to the client, so the prefix is a
// declaration that a value is publishable. VITE_API_TOKEN carried the CRM
// credential and was therefore compiled into the shipped bundle: a build on
// 2026-08-21 found it in 13 public files, 35 times.
//
// It is worse than a single substitution. Vite can only do a targeted replace
// for a STATIC `import.meta.env.VITE_FOO`. Any dynamic access -- including
// `(import.meta as any).env?.X` and a bare `import.meta.env.DEV` -- makes it
// inline the WHOLE env object, so one such access anywhere publishes every
// VITE_ variable defined at build time.
//
// The fix is therefore not "stop reading it" but "stop defining it as VITE_".
// Credentials are named without the prefix and are read only by server code
// (server.js, reports/), which reaches the CRM on the browser's behalf via the
// authenticated /rest proxy.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { globSync } from "fs";
import path from "path";

const SECRET_ISH = /VITE_[A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)[A-Z0-9_]*/g;

// A URL is not a credential even when its name contains TOKEN.
const ALLOWED = new Set(["VITE_SIGNALR_TOKEN_URL"]);

function sourceFiles(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
    .map((f) => path.resolve(f))
    .filter((f) => !f.endsWith("noClientSecrets.test.ts"));
}

describe("browser code holds no credentials", () => {
  it("reads no secret-shaped VITE_ variable", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.match(SECRET_ISH) || []) {
        if (ALLOWED.has(match)) continue;
        // A mention inside a comment is documentation, not a read.
        const isRead = new RegExp(`env[?.\s]*\[?['"\`]?${match}`).test(source);
        if (isRead) offenders.push(`${path.relative(process.cwd(), file)}: ${match}`);
      }
    }
    expect(
      offenders,
      offenders.length
        ? `These publish a credential to the browser bundle. Name the variable without the VITE_ prefix and read it in server.js, then reach it through the /rest proxy: ${offenders.join(", ")}`
        : "",
    ).toEqual([]);
  });

  it("keeps the CRM config free of any token", () => {
    const source = readFileSync(path.resolve("src/lib/crmConfig.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/TOKEN|SECRET|Authorization/i);
  });

  // The app's OWN session JWT also travels in the Authorization header, and the
  // /rest proxy is behind authRequired. Stripping the CRM credential without
  // keeping the session header took the dashboard down with 401 missing_token
  // on 2026-08-21, so both halves are pinned: no literal credential below, and
  // authHeaders() present.
  it("still sends the app session header to the guarded /rest proxy", () => {
    const libs = ["api", "applicationsApi", "dealMatchApi", "lpAccounts", "rebateApi", "ticketsApi"];
    const missing = libs.filter(
      (lib) => !readFileSync(path.resolve(`src/lib/${lib}.ts`), "utf8").includes("authHeaders()"),
    );
    expect(
      missing,
      missing.length
        ? `/rest is behind authRequired, so these must spread ...authHeaders() into their request headers or every call 401s: ${missing.join(", ")}`
        : "",
    ).toEqual([]);
  });

  // The six CRM client libraries must send no Authorization header of their own;
  // the proxy attaches one upstream.
  it("sends no Authorization header from the CRM client libraries", () => {
    const libs = ["api", "applicationsApi", "dealMatchApi", "lpAccounts", "rebateApi", "ticketsApi"];
    const offenders = libs.filter((lib) =>
      /Authorization/i.test(
        readFileSync(path.resolve(`src/lib/${lib}.ts`), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, ""),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
