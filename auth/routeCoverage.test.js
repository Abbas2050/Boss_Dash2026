// @vitest-environment node
//
// Every /api and /rest route must be either allow-listed or behind the gate.
//
// This is the test that would have caught the original seventeen. It parses
// source rather than booting Express, so it needs no database and no port.
//
// Known limitation: this is static text analysis, not a parser. It reliably
// sees two shapes -- a literal app.<method>('/api/...', ...) call (any of
// ', ", ` as the quote, at any indentation), and the single-level
// array-of-strings + .forEach((v) => app.<method>(v, ...)) shape that
// server.js uses for the backend-proxy prefixes. A route registered some
// other dynamic way (built from a config object, assembled with string
// concatenation, produced by a named function passed to forEach, looked up
// from a map) will not be seen and will not be checked. If server.js grows
// a new way of registering routes, extend the regexes below or check the
// new route by hand -- don't assume a passing suite means it's covered.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { PUBLIC_API_ROUTES } from "./requireSession.js";

const SERVER = readFileSync(path.resolve("server.js"), "utf8");

// app.get('/api/x', ...) / app.post("/rest/y", ...) / app.use('/api/z', ...)
// Anchored on optional leading tabs/spaces (not column 0) so a route
// declared inside an if/for/function body is still seen; '//' is not
// whitespace, so a commented-out line still will not match.
const ROUTE_RE = /^[ \t]*app\.(get|post|put|delete|patch|all|use)\(\s*(['"`])(\/(?:api|rest)[^'"`]*)\2/gm;

function declaredRoutes(source) {
  const found = [];
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(source)) !== null) {
    // m.index is the route declaration's real position in the file. Earlier
    // versions of this test re-searched for the route text via
    // SERVER.indexOf(`'${route}'`) with a hardcoded single quote, which
    // silently returned -1 (and skipped the check) for any route declared
    // with double or backtick quotes. Using the match's own position avoids
    // that re-search entirely, so the quote style used at the call site
    // never matters.
    found.push({ method: m[1].toUpperCase(), route: m[3], at: m.index });
  }
  return found;
}

// Routes registered by iterating an array of path-prefix strings rather than
// a literal app.<method>('/api/...', ...) call, e.g. server.js's:
//   ['/api/ContractSize', ...].forEach((prefix) => { app.use(prefix, ...); });
// ROUTE_RE can't see these -- the first argument to app.use is a variable,
// not a string literal. Match the array-literal + .forEach + app.<method>(var)
// shape directly and pull the /api and /rest strings out of the array itself.
const FOREACH_RE =
  /\[([^[\]]*)\]\s*\.forEach\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?[\s\S]{0,200}?\bapp\.(get|post|put|delete|patch|all|use)\(\s*\2\b/g;

function declaredForEachRoutes(source) {
  const found = [];
  let m;
  FOREACH_RE.lastIndex = 0;
  while ((m = FOREACH_RE.exec(source)) !== null) {
    const method = m[3].toUpperCase();
    const at = m.index; // position of the array literal, always above the loop body
    const routeRe = /['"`](\/(?:api|rest)[^'"`]*)['"`]/g;
    let rm;
    while ((rm = routeRe.exec(m[1])) !== null) {
      found.push({ method, route: rm[1], at });
    }
  }
  return found;
}

function allDeclaredRoutes(source) {
  return declaredRoutes(source).concat(declaredForEachRoutes(source));
}

describe("route coverage", () => {
  it("finds the routes it is meant to be checking", () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true.
    expect(allDeclaredRoutes(SERVER).length).toBeGreaterThan(15);
  });

  it("mounts the gate above every route definition", () => {
    const gate = SERVER.indexOf("app.use(requireSession)");
    expect(gate, "requireSession is not mounted in server.js").toBeGreaterThan(-1);
    for (const { method, route, at } of allDeclaredRoutes(SERVER)) {
      expect(
        gate,
        `${method} ${route} is declared above the gate, so the gate does not cover it`
      ).toBeLessThan(at);
    }
  });

  it("keeps the allow-list to routes that actually exist", () => {
    const orphans = [...PUBLIC_API_ROUTES].filter((entry) => {
      const routePath = entry.split(" ")[1];
      // Allow-listed routes may live in a mounted router rather than server.js.
      const inServer = SERVER.includes(`'${routePath}'`);
      const suffix = routePath.replace(/^\/api\/[a-zA-Z]+/, "");
      const routerFiles = ["auth/router.js", "docusign/router.js"];
      const inRouter = routerFiles.some((f) => {
        try {
          return readFileSync(path.resolve(f), "utf8").includes(`"${suffix}"`);
        } catch {
          return false;
        }
      });
      return !inServer && !inRouter;
    });
    expect(orphans, `allow-listed but no such route: ${orphans.join(", ")}`).toEqual([]);
  });

  // The allow-list is the only way to be public. Anything added to it is a
  // deliberate decision that should be visible in review, so its size is pinned.
  it("keeps the allow-list small", () => {
    expect(PUBLIC_API_ROUTES.size).toBeLessThanOrEqual(6);
  });
});

// The twelve bare backend proxy prefixes sit OUTSIDE /api and /rest, so
// requireSession never sees them. They were relaying the trading backend
// unauthenticated: GET /EquityOverview/dashboard returned every client's login,
// equity, balance and margin to anyone. They carry authRequired directly.
describe("bare backend proxy prefixes", () => {
  const forEachBlock = SERVER.slice(
    SERVER.lastIndexOf("[", SERVER.indexOf("'/EquityOverview'")),
    SERVER.indexOf("});", SERVER.indexOf("'/EquityOverview'")) + 3,
  );

  it("finds the block it is meant to be checking", () => {
    expect(forEachBlock).toContain("'/EquityOverview'");
    expect(forEachBlock).toContain(".forEach(");
  });

  it("guards every prefix with authRequired", () => {
    expect(
      forEachBlock,
      "a bare proxy prefix is mounted without authRequired, so this server relays the trading backend to anonymous callers",
    ).toMatch(/app\.use\(prefix,\s*authRequired\s*,/);
  });
});
