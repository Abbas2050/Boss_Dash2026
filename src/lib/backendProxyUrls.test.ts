// @vitest-environment node
//
// Why a silent fallback is worse than no fallback at all.
//
// Three settings pages -- LP Margin Alerts, Symbol Mapping and LP Info -- each
// carried their own copy of this two-line helper:
//
//     const base = String(env?.<the browser-visible base URL var> || "").replace(...)
//     const apiUrl = (path) => (base ? `${base}${path}` : path);
//
// The variable it reads is undefined in production. Credentials were renamed
// off the browser-visible prefix so they could not reach the bundle, and that
// variable went with them. So `base` was always "", the ternary always took its
// second branch, and every call collapsed to a bare relative path on the
// dashboard's own origin -- where those routes do not exist.
//
// That is the whole point of this file. A wrong absolute URL 404s, or fails
// CORS, or 401s: it makes noise, and somebody fixes it the same day. A bare
// relative path on a single-page app hits the SPA catch-all instead and gets
// back index.html with a 200 -- a successful response, of the wrong document.
// The pages did not crash and did not log anything a user would report; the
// Alerts page just showed a Threshold of "--" and a JSON parse error naming
// "<!doctype", while the real configured threshold sat at 110 on the backend.
// Three pages stayed broken in production that way, unnoticed.
//
// src/lib/backendOriginLiteral.test.ts bans the backend's origin LITERAL for
// the same family of reasons, and these files slipped past it precisely because
// they hard-coded nothing: an empty string is not an origin. So the ban here is
// on the two shapes rather than on any hostname:
//
//   1. any mention of the browser-visible backend base URL variable, and
//   2. the `base ? base + path : path` helper -- a conditional whose test
//      identifier reappears in its own consequent and whose alternate is a bare
//      identifier. That is "use the base if we have one, otherwise aim at
//      ourselves", and aiming at ourselves is never the intent.
//
// Both are banned everywhere under src/ except src/lib/backendBase.ts, which
// owns the decision, and test files, which have to name what they assert about.
// The comment ban is deliberate: a commented-out copy of a broken line is what
// people paste back in. Say "the browser-visible base URL" in prose.
//
// There are exactly two right answers now. A file that needs the trading
// backend imports BACKEND_BASE_URL and gets the same-origin proxy prefix, which
// attaches the backend's Bearer server-side. A file that needs a route on THIS
// server writes a plain relative path and means it -- GoogleSheetMappingPage is
// the one page in this set that was always right, and its regression test is
// below so nobody "fixes" it onto the proxy.
import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "fs";
import path from "path";
import { BACKEND_BASE_URL } from "@/lib/backendBase";

// Assembled rather than written whole so this scan does not have to exempt
// itself from the rule it enforces by name.
const BROWSER_BASE_URL_VAR = ["VITE", "BACKEND", "BASE", "URL"].join("_");

const ALLOWED = new Set([path.resolve("src/lib/backendBase.ts")]);

function sourceFiles(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
    .map((f) => path.resolve(f))
    .filter((f) => !f.includes(".test."))
    .filter((f) => !ALLOWED.has(f));
}

function read(rel: string): string {
  return readFileSync(path.resolve(rel), "utf8");
}

// `(path) => (base ? `${base}${path}` : path)` and `(p) => (base ? base + p : p)`.
//
// Matched narrowly, as a one-line arrow function whose alternate is its own
// parameter, so it cannot fire on ordinary conditionals elsewhere in the app --
// a scan that cried wolf would get exemptions bolted onto it and stop being
// read. Two further conditions make it the fallback shape specifically: the
// alternate must be the parameter itself (return the caller's path untouched),
// and the test identifier must reappear in the consequent (so the branch turns
// on whether that same base is truthy). GoogleSheetMappingPage's surviving
// `isLocalhost ? <dev server> : path` fails the second: it is a real either/or
// between two known destinations, not a base that may be missing.
const BARE_PATH_FALLBACK =
  /\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*=>\s*\(?\s*([A-Za-z_$][\w$]*)\s*\?([^\n]*?):\s*\1\s*[)\n;,]/g;

function offendingLines(file: string): string[] {
  const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
  const source = readFileSync(file, "utf8");
  const offenders: string[] = [];

  source.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(BROWSER_BASE_URL_VAR)) {
      offenders.push(`${rel}:${i + 1}: names the browser-visible base URL variable: ${line.trim()}`);
    }
  });

  for (const m of source.matchAll(BARE_PATH_FALLBACK)) {
    const [whole, , test, consequent] = m;
    if (!consequent.includes(test)) continue;
    const line = source.slice(0, m.index).split("\n").length;
    offenders.push(`${rel}:${line}: falls back to a bare path: ${whole.trim()}`);
  }

  return offenders;
}

// The first argument of every fetch() in a file, with `${BACKEND_BASE_URL}`
// resolved to what the constant actually is, so these assertions are about the
// URL the browser requests and not merely about the text of the source.
function fetchUrls(rel: string): string[] {
  const source = read(rel);
  const urls: string[] = [];
  const fetchRe = /(?<![.\w])fetch\s*\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g;
  for (const m of source.matchAll(fetchRe)) {
    urls.push(
      m[1]
        .slice(1, -1)
        .replace(/\$\{\s*BACKEND_BASE_URL\s*\}/g, BACKEND_BASE_URL)
        .replace(/\$\{[^}]*\}/g, "<expr>"),
    );
  }
  return urls;
}

// Every fetch(`${BACKEND_BASE_URL}...`) call in a file, as its full call text,
// so the auth assertion below can look inside each one.
function backendFetchCalls(rel: string): string[] {
  const source = read(rel);
  const calls: string[] = [];
  const re = /(?<![.\w])fetch\s*\(/g;
  for (const m of source.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const call = source.slice(open, end + 1);
    if (/\$\{\s*BACKEND_BASE_URL\s*\}/.test(call) || /\bapiUrl\s*\(/.test(call)) calls.push(call);
  }
  return calls;
}

describe("nothing under src/ can grow a silent same-origin fallback again", () => {
  it("names neither the browser-visible base URL variable nor the bare-path fallback shape", () => {
    const offenders = sourceFiles().flatMap(offendingLines);
    expect(
      offenders,
      offenders.length
        ? `A file that needs the trading backend must import BACKEND_BASE_URL from @/lib/backendBase (and send ...authHeaders() with it). A file that needs a route on this server writes a plain relative path. Neither is spelled with a fallback, because a fallback here returns index.html with a 200 instead of failing:\n${offenders.join("\n")}`
        : "",
    ).toEqual([]);
  });

  it("scans a non-trivial number of files, so a passing run means something", () => {
    // A glob that silently matched nothing would make the assertion above pass
    // for the wrong reason -- which is the same failure mode, one level up.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });
});

// Asserted per file rather than once over the whole tree. These three broke
// independently and were found independently; one aggregate assertion would let
// a later revert of any single page hide behind the other two.
describe("the pages that were serving index.html now call the proxy", () => {
  it("LP Margin Alerts reads and writes alert settings through the proxy", () => {
    const urls = fetchUrls("src/components/dashboard/LpMarginAlerts.tsx");
    expect(urls).toEqual(["/api/backend/api/AlertSettings", "/api/backend/api/AlertSettings"]);
  });

  it("Symbol Mapping lists, creates and deletes through the proxy", () => {
    const urls = fetchUrls("src/pages/settings/SymbolMappingPage.tsx");
    expect(urls).toEqual([
      "/api/backend/api/SymbolMapping",
      "/api/backend/api/SymbolMapping",
      "/api/backend/api/SymbolMapping/<expr>",
    ]);
  });

  it("LP Info reaches accounts, infos, aliases, bulk update and import through the proxy", () => {
    const urls = fetchUrls("src/pages/settings/LpInfoPage.tsx");
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith("/api/backend/api/")).toBe(true);
    // The five endpoints confirmed by hand against the live proxy.
    for (const endpoint of [
      "/api/backend/api/LpAccount?all=true",
      "/api/backend/api/LpInfo",
      "/api/backend/api/LpInfo/import",
      "/api/backend/api/lpinfo/bulk-update",
      "/api/backend/api/LpCentroidAlias",
    ]) {
      expect(urls).toContain(endpoint);
    }
  });
});

describe("Google Sheet Mapping keeps its same-origin paths", () => {
  // The one page in this set whose routes really do live on this server
  // (wallet/*). Moving it onto the proxy would forward it to the trading
  // backend, which 404s all three. It is asserted here because it looked
  // exactly like the broken files and is the obvious next thing to "fix".
  it("requests its own server's wallet routes, not the proxy", () => {
    const source = read("src/pages/settings/GoogleSheetMappingPage.tsx");
    // This page reaches fetch() through its own one-line helper, so the helper
    // is where a move onto the proxy would happen -- asserting only on the
    // fetch() arguments would pass no matter where they were sent.
    const helper = /const apiUrl\b[^\n]*/.exec(source)?.[0] ?? "";
    expect(helper).not.toBe("");
    expect(helper).not.toContain("BACKEND_BASE_URL");
    const requested = [...source.matchAll(/apiUrl\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) expect(url.startsWith("/api/wallet/")).toBe(true);
  });

  it("still asks for the same three paths it always did", () => {
    const source = read("src/pages/settings/GoogleSheetMappingPage.tsx");
    // Prose may explain why the proxy is wrong here; importing it would mean
    // somebody acted on the opposite conclusion.
    expect(source).not.toMatch(/^\s*import\b[^\n]*backendBase/m);
    const requested = [...source.matchAll(/apiUrl\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(requested).toEqual([
      "/api/wallet/google-sheet-mapping",
      "/api/wallet/google-sheet-mapping",
      "/api/wallet/google-sheet-mapping/reset",
    ]);
  });
});

describe("every proxied call in the touched files carries the session token", () => {
  // /api/backend sits under the deny-by-default gate in auth/requireSession.js,
  // so a call that reaches the right URL without the dashboard JWT 401s on our
  // own server and never gets near the backend -- the same page, broken again
  // for a different reason.
  const files = [
    "src/components/dashboard/LpMarginAlerts.tsx",
    "src/pages/settings/SymbolMappingPage.tsx",
    "src/pages/settings/LpInfoPage.tsx",
    "src/pages/settings/LPManagerPage.tsx",
  ];

  for (const rel of files) {
    it(`${rel} sends authHeaders() on each one`, () => {
      const calls = backendFetchCalls(rel);
      expect(calls.length).toBeGreaterThan(0);
      const unguarded = calls.filter((c) => !/authHeaders\s*\(\s*\)/.test(c));
      expect(unguarded, unguarded.join("\n---\n")).toEqual([]);
    });
  }
});
