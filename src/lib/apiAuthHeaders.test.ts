// @vitest-environment node
//
// server.js denies every /api and /rest route by default (see the
// requireSession comment at server.js:228 and auth/requireSession.js):
// authRequired accepts ONLY an `Authorization: Bearer <jwt>` header, never a
// cookie, and there is no global fetch wrapper in this app. So any browser
// call to a same-origin /api or /rest path that forgets to send that header
// 401s the moment this gate is live -- this exact mistake has already taken
// the dashboard down once on this project.
//
// This test statically scans src/**/*.{ts,tsx} for `fetch(...)` call sites
// whose URL argument resolves to a same-origin /api or /rest path, and fails
// if that call does not carry the session bearer token, via one of:
//   - `authHeaders()` (from src/lib/auth.ts) spread directly into the call
//   - a variable spread (`...headers`) where that variable was assigned
//     `authHeaders()` earlier in the file (e.g. auth.ts's logout())
//   - a named helper function used as the whole `headers` value, whose body
//     calls `authHeaders()` (e.g. ticketsApi.ts's crmHeaders())
//   - a manually built `Authorization: Bearer <token>` header sourced from
//     getAuthToken() (agentApi.ts's pattern, equivalent to authHeaders())
//
// SCOPE / LIMITATIONS -- this is intentionally narrower than "every fetch
// call in the app", because a fully general version (tracing every possible
// variable and helper indirection to its origin) proved unreliable and was
// cut back rather than shipped as a check that can't actually fail:
//
//   1. A URL argument is judged "same-origin /api or /rest" only when it is:
//      (a) a string/template literal starting with "/api" or "/rest", or
//      (b) `apiUrl("/api/...")` / `apiUrl("/rest/...")`, where the file's own
//          `apiUrl` helper falls back to the bare path (`: path` / `return
//          path;`) when no backend base URL is configured -- this repo's
//          `apiUrl = (path) => (backendBaseUrl ? base+path : path)` pattern,
//          used across LpInfoPage.tsx, LPManagerPage.tsx, SymbolMappingPage.tsx,
//          AlertsHubProvider.tsx, LpMarginAlerts.tsx and others; or
//      (c) a bare identifier (e.g. `tokenUrl`) whose nearest preceding
//          `const`/`let` assignment in the same file has a fallback branch
//          that is itself a literal "/api" or "/rest" string (the SignalR
//          access-token-factory pattern in useAccountAlerts.ts, WSTestPage.tsx
//          and AlertsHubProvider.tsx).
//      It deliberately does NOT resolve arbitrary variable indirection (e.g.
//      DealingDepartmentPage.tsx's many `const endpoint = ...` reused across
//      functions, or `API_BASE`/`api` constants built from a BACKEND_BASE_URL
//      that falls back to an absolute external origin such as
//      https://api.skylinkscapital.com). Those either resolve to a genuinely
//      different origin in production (out of scope for this app's gate) or
//      are too ambiguous to resolve correctly by text matching alone; they
//      were instead checked by hand (see .superpowers/sdd/final-review-fix-report.md).
//   2. It looks for `fetch(` call sites literally; a wrapper such as
//      clientProfileApi.ts's `fetchJson()` is not itself pattern-matched, but
//      the native `fetch(...)` call inside its definition is, so that file is
//      still covered.
//   3. POST /api/auth/login is explicitly excluded: it is the session-issuing
//      route and is allow-listed as public in auth/requireSession.js, so it
//      correctly carries no session header.
//
// Given these limits, a passing run is evidence for "no known-shape regression
// among the call sites this scan can resolve", not a proof that every fetch
// in the app is guarded -- pair it with the manual audit in the fix report.
import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "fs";
import path from "path";

function sourceFiles(): string[] {
  return globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() })
    .map((f) => path.resolve(f))
    .filter((f) => !f.endsWith("apiAuthHeaders.test.ts") && !f.includes(".test."));
}

function extractBalanced(source: string, openIndex: number, openCh: string, closeCh: string): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === openCh) depth++;
    else if (source[i] === closeCh) {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
}

// This repo's repeated `apiUrl = (path) => (base ? base+path : path)` helper
// (and the isLocalhost-aware variant in GoogleSheetMappingPage.tsx) returns
// the bare path unchanged when no backend base URL is configured -- i.e. it
// targets THIS app's own origin, so /api and /rest calls through it hit the
// deny-by-default gate exactly like a hardcoded relative fetch would.
function definesRelativeFallbackApiUrl(source: string): boolean {
  return (
    /apiUrl\s*=\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(=>|\{)/.test(source) &&
    /:\s*path\b|return\s+path\s*;/.test(source)
  );
}

function findVarAssignments(source: string, name: string): Array<{ index: number; rhs: string }> {
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*`, "g");
  const results: Array<{ index: number; rhs: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].length;
    let depth = 0;
    let inTemplate = false;
    let end = start;
    for (; end < source.length; end++) {
      const c = source[end];
      if (c === "`") inTemplate = !inTemplate;
      if (inTemplate) continue;
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (c === ";" && depth <= 0) break;
    }
    results.push({ index: m.index, rhs: source.slice(start, end) });
  }
  return results;
}

function literalStartsGuarded(text: string): boolean {
  return /^["'`](\/api|\/rest)(\/|["'`?]|$)/.test(text.trim());
}

function rhsHasGuardedFallback(rhs: string): boolean {
  return /["'`](\/api|\/rest)[^"'`]*["'`]/.test(rhs);
}

function extractHelperBody(source: string, name: string): string {
  let re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  let m = re.exec(source);
  if (m) return extractBalanced(source, m.index + m[0].length - 1, "{", "}");
  re = new RegExp(`(?:const|function)\\s+${name}\\s*=?\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?:=>)?\\s*\\{`);
  m = re.exec(source);
  if (m) return extractBalanced(source, m.index + m[0].length - 1, "{", "}");
  re = new RegExp(`const\\s+${name}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\(`);
  m = re.exec(source);
  if (m) return extractBalanced(source, m.index + m[0].length - 1, "(", ")");
  return "";
}

function findUnguardedFetchCalls(): string[] {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(process.cwd(), file);
    const hasRelativeApiUrl = definesRelativeFallbackApiUrl(source);

    const fetchRe = /(?<![.\w])fetch\s*\(/g;
    let fm: RegExpExecArray | null;
    while ((fm = fetchRe.exec(source))) {
      const openParenIdx = fm.index + fm[0].length - 1;
      const callText = extractBalanced(source, openParenIdx, "(", ")");

      let depth = 0;
      let inTemplate = false;
      let argEnd = -1;
      for (let i = 1; i < callText.length; i++) {
        const c = callText[i];
        if (c === "`") inTemplate = !inTemplate;
        if (inTemplate) continue;
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        if (depth === 0 && c === ",") {
          argEnd = i;
          break;
        }
        if (depth < 0) {
          argEnd = i;
          break;
        }
      }
      const urlArg = (argEnd === -1 ? callText.slice(1, -1) : callText.slice(1, argEnd)).trim();

      let guarded = false;
      if (/^["'`]/.test(urlArg) && literalStartsGuarded(urlArg)) {
        guarded = true;
      } else {
        const apiUrlCallMatch = /^apiUrl\s*\(([\s\S]*)\)$/.exec(urlArg);
        if (apiUrlCallMatch && hasRelativeApiUrl) {
          const inner = apiUrlCallMatch[1].trim();
          if (/^["'`]/.test(inner) && literalStartsGuarded(inner)) guarded = true;
        } else if (/^[A-Za-z_$][\w$]*$/.test(urlArg)) {
          const assigns = findVarAssignments(source, urlArg).filter((a) => a.index < (fm as RegExpExecArray).index);
          if (assigns.length > 0 && rhsHasGuardedFallback(assigns[assigns.length - 1].rhs)) guarded = true;
        }
      }

      if (!guarded) continue;

      // The session-issuing login route is deliberately public
      // (PUBLIC_API_ROUTES in auth/requireSession.js) -- it cannot require a
      // session before one exists.
      if (/^["'`]\/api\/auth\/login\b/.test(urlArg)) continue;

      const hasAuthInline = /authHeaders\s*\(\s*\)/.test(callText);

      let hasManualBearer =
        /Authorization/.test(callText) && /Bearer/.test(callText) && /getAuthToken\s*\(\s*\)/.test(callText);
      if (!hasManualBearer && /Authorization/.test(callText) && /Bearer/.test(callText)) {
        const bearerIdents = [...callText.matchAll(/Bearer\s*\$\{\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
        for (const name of bearerIdents) {
          if (findVarAssignments(source, name).some((a) => /getAuthToken\s*\(\s*\)/.test(a.rhs))) {
            hasManualBearer = true;
            break;
          }
        }
      }

      let hasAuthViaHelper = false;
      let hasAuthViaSpreadVar = false;
      if (!hasAuthInline && !hasManualBearer) {
        const helperMatch =
          /headers\s*:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(callText) ||
          /headers\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(callText);
        if (helperMatch) {
          const body = extractHelperBody(source, helperMatch[1]);
          if (/authHeaders\s*\(\s*\)/.test(body)) hasAuthViaHelper = true;
        }
        const spreadNames = [...callText.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
        for (const name of spreadNames) {
          if (findVarAssignments(source, name).some((a) => /authHeaders\s*\(\s*\)/.test(a.rhs))) {
            hasAuthViaSpreadVar = true;
            break;
          }
        }
      }

      if (!hasAuthInline && !hasManualBearer && !hasAuthViaHelper && !hasAuthViaSpreadVar) {
        const line = source.slice(0, fm.index).split("\n").length;
        offenders.push(`${rel}:${line} -> fetch(${urlArg.slice(0, 80)}, ...) has no authHeaders()`);
      }
    }
  }

  return offenders;
}

describe("same-origin /api and /rest fetch calls carry the session header", () => {
  it("sends authHeaders() (or an equivalent Bearer token) on every resolvable /api or /rest call", () => {
    const offenders = findUnguardedFetchCalls();
    expect(
      offenders,
      offenders.length
        ? `requireSession denies every /api and /rest route by default (server.js:234). These calls will 401 for a signed-in user the moment that gate is live:\n${offenders.join("\n")}`
        : "",
    ).toEqual([]);
  });
});
