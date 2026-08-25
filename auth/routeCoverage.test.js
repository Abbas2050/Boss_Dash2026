// @vitest-environment node
//
// Every /api and /rest route must be either allow-listed or behind the gate.
//
// This is the test that would have caught the original seventeen. It parses
// source rather than booting Express, so it needs no database and no port.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { PUBLIC_API_ROUTES } from "./requireSession.js";

const SERVER = readFileSync(path.resolve("server.js"), "utf8");

// app.get('/api/x', ...) / app.post("/rest/y", ...) / app.use('/api/z', ...)
const ROUTE_RE = /^app\.(get|post|put|delete|patch|all|use)\(\s*['"`](\/(?:api|rest)[^'"`]*)['"`]/gm;

function declaredRoutes(source) {
  const found = [];
  let m;
  while ((m = ROUTE_RE.exec(source)) !== null) {
    found.push({ method: m[1].toUpperCase(), route: m[2] });
  }
  return found;
}

describe("route coverage", () => {
  it("finds the routes it is meant to be checking", () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously true.
    expect(declaredRoutes(SERVER).length).toBeGreaterThan(15);
  });

  it("mounts the gate above every route definition", () => {
    const gate = SERVER.indexOf("app.use(requireSession)");
    expect(gate, "requireSession is not mounted in server.js").toBeGreaterThan(-1);
    for (const { route } of declaredRoutes(SERVER)) {
      const at = SERVER.indexOf(`'${route}'`);
      if (at === -1) continue;
      expect(gate, `route ${route} is declared above the gate, so the gate does not cover it`).toBeLessThan(at);
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
