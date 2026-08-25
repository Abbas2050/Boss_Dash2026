# Deny-by-Default API Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `/api` and `/rest` route require a session unless it appears on a short explicit allow-list, so a newly added route is protected by default.

**Architecture:** One `requireSession` middleware mounts after the security-header middleware and before the first route in `server.js`. It ignores paths outside `/api` and `/rest`, lets an exact `METHOD /path` allow-list through, and delegates everything else to the existing `authRequired`. A source-parsing test enumerates every route and fails when one is neither allow-listed nor covered by the gate.

**Tech Stack:** Node 25, Express 5, ES modules, vitest (`// @vitest-environment node`), `jsonwebtoken`, `bcryptjs`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-25-api-deny-by-default-design.md`.
- Do **not** modify: bcrypt cost, the JWT / `token_version` scheme, the parameterised SQL layer, the `/report-charts/:token/:name` capability-token design, or the existing `nosniff` / `X-Frame-Options` / `Referrer-Policy` headers.
- Do **not** send a request to any write endpoint on production at any point.
- Server tests run under Node, never jsdom: every new test file starts with `// @vitest-environment node`.
- Tests must not boot the Express app or open a DB connection. They parse source, matching the existing pattern in `src/lib/noClientSecrets.test.ts`.
- Full suite is `npx vitest run`. Typecheck is `npx tsc -b --noEmit` — plain `tsc --noEmit` checks **nothing** in this repo (`tsconfig.json` has `"files": []`).
- Add no new runtime dependency. The repo currently carries 30 advisories; the rate limiter is ~20 lines and does not justify another package.

### Scope correction carried from the spec

The spec's allow-list table lists eight rows, but four of them — `GET /health`, `POST /oauth/token`, `GET /report-charts/:token/:name`, and static assets — are **not** under `/api` or `/rest`. The gate never sees them, so they need no allow-list entry. The allow-list is therefore **four** entries, all under `/api`. Those four routes stay reachable either way; this is a change to how they are described, not to what is public.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `auth/requireSession.js` (create) | The gate and the allow-list. Exports `PUBLIC_API_ROUTES` and `requireSession`. |
| `auth/rateLimit.js` (create) | A minimal in-memory per-IP limiter. Exports `createRateLimiter`. |
| `auth/requireSession.test.js` (create) | Unit tests for the gate's exemption logic. |
| `auth/routeCoverage.test.js` (create) | Parses `server.js` and the routers; fails on any unclassified route. |
| `auth/rateLimit.test.js` (create) | Unit tests for the limiter. |
| `auth/corsPolicy.test.js` (create) | Pins the CORS default to same-origin. |
| `server.js` (modify) | Mount the gate; tighten the CORS default. |
| `auth/router.js` (modify) | Apply the limiter to `POST /login`. |
| `docs/security-dependency-triage.md` (create) | Written triage of the 30 advisories. |

---

## Task 1: The gate and its allow-list

**Files:**
- Create: `auth/requireSession.js`
- Test: `auth/requireSession.test.js`

**Interfaces:**
- Consumes: `authRequired` from `auth/router.js` (exported at `auth/router.js:528`).
- Produces:
  - `PUBLIC_API_ROUTES: Set<string>` — entries formatted `"METHOD /path"`, uppercase method.
  - `isPublicApiRoute(method: string, path: string): boolean`
  - `requireSession(req, res, next)` — Express middleware.

- [ ] **Step 1: Write the failing test**

Create `auth/requireSession.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run auth/requireSession.test.js`
Expected: FAIL — `Failed to resolve import "./requireSession.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `auth/requireSession.js`:

```javascript
import { authRequired } from "./router.js";

/**
 * Routes under /api that genuinely cannot carry a session.
 *
 * Entries are exact "METHOD /path" strings. Matching is never by prefix: a
 * prefix rule such as /api/docusign would also exempt every sibling route added
 * under it later, which is the drift this gate exists to stop.
 *
 * Paths outside /api and /rest -- /health, /oauth/token, the SPA, and
 * /report-charts/:token/:name, which mail clients fetch with no session and
 * which carries its own unguessable capability token -- never reach the gate
 * and so need no entry here.
 */
export const PUBLIC_API_ROUTES = new Set([
  // Issues the session.
  "POST /api/auth/login",
  // Monitoring probe.
  "GET /api/docusign/health",
  // External callers. Public to the network but not unauthenticated: each
  // carries its own shared secret (DOCUSIGN_FXBO_WEBHOOK_BEARER and
  // DOCUSIGN_CONNECT_HMAC_SECRET). Exempt from SESSION auth, not from auth.
  "POST /api/docusign/webhooks/fxbo/application-approved",
  "POST /api/docusign/webhooks/connect",
]);

const GUARDED_PREFIXES = ["/api", "/rest"];

function normalisePath(path) {
  const withoutQuery = String(path || "").split("?")[0];
  // "/api/auth/login/" and "/api/auth/login" are the same route to Express.
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
}

export function isPublicApiRoute(method, path) {
  return PUBLIC_API_ROUTES.has(`${String(method || "").toUpperCase()} ${normalisePath(path)}`);
}

function isGuardedPath(path) {
  const clean = normalisePath(path);
  return GUARDED_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`));
}

export function requireSession(req, res, next) {
  const path = normalisePath(req.path ?? req.originalUrl ?? req.url);
  if (!isGuardedPath(path)) return next();
  if (isPublicApiRoute(req.method, path)) return next();
  return authRequired(req, res, next);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run auth/requireSession.test.js`
Expected: PASS — 10 tests.

If the `requireSession` describe block fails because importing `auth/router.js` opens a DB pool at module load, do **not** weaken the test. Change the import in `auth/requireSession.js` to a lazy one inside the function body:

```javascript
export async function requireSession(req, res, next) {
  const path = normalisePath(req.path ?? req.originalUrl ?? req.url);
  if (!isGuardedPath(path)) return next();
  if (isPublicApiRoute(req.method, path)) return next();
  const { authRequired } = await import("./router.js");
  return authRequired(req, res, next);
}
```

and delete the top-level `import { authRequired }` line. Re-run the test.

- [ ] **Step 5: Commit**

```bash
git add auth/requireSession.js auth/requireSession.test.js
git commit -m "Add the deny-by-default session gate"
```

---

## Task 2: Mount the gate

**Files:**
- Modify: `server.js` — insert after the security-header middleware that ends at line 213, before `app.get('/api/lp-equity-snapshots'` at line 215.

**Interfaces:**
- Consumes: `requireSession` from `auth/requireSession.js` (Task 1).
- Produces: nothing new; every `/api` and `/rest` route is now gated.

- [ ] **Step 1: Add the import**

At the top of `server.js`, directly below the existing line `import { authRequired, canManageUsers } from './auth/router.js';` (line 24), add:

```javascript
import { requireSession } from './auth/requireSession.js';
```

- [ ] **Step 2: Mount the middleware**

Find this block in `server.js` (it currently ends at line 213):

```javascript
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
```

Insert immediately after it:

```javascript
// Deny by default. Every /api and /rest route needs a session unless it is on
// the allow-list in auth/requireSession.js. Seventeen routes shipped without
// authentication -- including the treasury report and six write endpoints --
// because the default was open and nothing made the omission visible.
//
// This must stay ABOVE every route definition below; mounted after them it
// would silently protect nothing.
app.use(requireSession);
```

- [ ] **Step 3: Verify the file still parses**

Run: `node --check server.js`
Expected: no output.

- [ ] **Step 4: Verify the gate sits above the routes**

Run: `node -e "const s=require('fs').readFileSync('server.js','utf8');const g=s.indexOf('app.use(requireSession)');const r=s.indexOf(\"app.get('/api/lp-equity-snapshots'\");console.log(g>0&&r>0&&g<r?'OK: gate is above the routes':'FAIL: gate is below the routes')"`
Expected: `OK: gate is above the routes`

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "Mount the session gate ahead of every /api and /rest route"
```

---

## Task 3: Fail the build when a route is unclassified

**Files:**
- Create: `auth/routeCoverage.test.js`

**Interfaces:**
- Consumes: `PUBLIC_API_ROUTES` from `auth/requireSession.js` (Task 1).
- Produces: nothing importable; this is the regression gate for the whole change.

This is the task that stops the problem recurring. Tasks 1 and 2 fix today's seventeen; this one fails the suite when someone adds an eighteenth.

- [ ] **Step 1: Write the failing test**

Create `auth/routeCoverage.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run auth/routeCoverage.test.js`
Expected: PASS — 4 tests. (Tasks 1 and 2 already satisfy it; it exists to fail on future regressions.)

- [ ] **Step 3: Prove the test actually catches a regression**

Temporarily append a new unguarded route to the very end of `server.js`:

```javascript
app.get('/api/regression-probe', (req, res) => res.json({ ok: true }));
```

Run: `npx vitest run auth/routeCoverage.test.js`
Expected: FAIL — `route /api/regression-probe is declared above the gate...` **or** a pass. If it passes, the test is wrong: a route appended after the gate IS covered by the gate, so this probe is not a regression. Instead move the probe line to just above `app.use(requireSession)` and re-run; it must then FAIL.

Remove the probe line afterwards and re-run to confirm PASS.

- [ ] **Step 4: Commit**

```bash
git add auth/routeCoverage.test.js
git commit -m "Fail the suite when an /api route escapes the gate"
```

---

## Task 4: Stop CORS reflecting arbitrary origins

**Files:**
- Modify: `server.js:194-197`
- Test: `auth/corsPolicy.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing importable.

- [ ] **Step 1: Replace the CORS config**

Find in `server.js` (line 194):

```javascript
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true,
  credentials: true,
}));
```

Replace with:

```javascript
// `origin: true` reflects whatever Origin the caller sends. Combined with
// credentials: true that lets any website a signed-in user visits call this API
// as them. The default is now same-origin; set CORS_ORIGIN to widen it.
const CORS_ALLOWED = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: CORS_ALLOWED.length ? CORS_ALLOWED : false,
  credentials: true,
}));
if (!CORS_ALLOWED.length) {
  console.log('[CORS] No CORS_ORIGIN set; cross-origin requests are refused (same-origin only).');
}
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check server.js`
Expected: no output.

- [ ] **Step 3: Write the test**

Create `auth/corsPolicy.test.js`:

```javascript
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
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run auth/corsPolicy.test.js`
Expected: PASS — 3 tests.

To prove it is not vacuous, temporarily restore the old line
`origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true,`
in place of the new block and re-run: it must FAIL. Restore the new block afterwards.

- [ ] **Step 5: Commit**

```bash
git add server.js auth/corsPolicy.test.js
git commit -m "Refuse cross-origin requests unless CORS_ORIGIN names them"
```

---

## Task 5: Rate-limit the login endpoint

**Files:**
- Create: `auth/rateLimit.js`
- Create: `auth/rateLimit.test.js`
- Modify: `auth/router.js:296`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createRateLimiter({ windowMs, max, now }): (req, res, next) => void`

`now` is an injectable clock returning milliseconds, defaulting to `Date.now`. The test needs it; production does not pass it.

- [ ] **Step 1: Write the failing test**

Create `auth/rateLimit.test.js`:

```javascript
// @vitest-environment node
//
// Login had no rate limit, so guessing a password against a known address was
// bounded only by bcrypt's cost.
import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rateLimit.js";

const mkRes = () => {
  const res = { statusCode: 0, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
};
const run = (limiter, ip) => {
  const res = mkRes();
  let passed = false;
  limiter({ ip, headers: {}, socket: { remoteAddress: ip } }, res, () => { passed = true; });
  return { res, passed };
};

describe("createRateLimiter", () => {
  it("allows requests up to the limit", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(run(limiter, "1.1.1.1").passed, `request ${i + 1} should pass`).toBe(true);
    }
  });

  it("refuses the one after with 429", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) run(limiter, "1.1.1.1");
    const { res, passed } = run(limiter, "1.1.1.1");
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeGreaterThan(0);
  });

  it("counts each IP separately", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    run(limiter, "1.1.1.1");
    expect(run(limiter, "1.1.1.1").passed).toBe(false);
    expect(run(limiter, "2.2.2.2").passed).toBe(true);
  });

  it("forgets a caller once the window passes", () => {
    let clock = 0;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => clock });
    expect(run(limiter, "1.1.1.1").passed).toBe(true);
    expect(run(limiter, "1.1.1.1").passed).toBe(false);
    clock += 60_001;
    expect(run(limiter, "1.1.1.1").passed).toBe(true);
  });

  // An unbounded map keyed by attacker-controlled IPs is itself a denial of
  // service.
  it("does not grow without bound", () => {
    let clock = 0;
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1, now: () => clock });
    for (let i = 0; i < 5_000; i += 1) {
      clock += 1;
      run(limiter, `10.0.${Math.floor(i / 255)}.${i % 255}`);
    }
    clock += 10_000;
    run(limiter, "9.9.9.9");
    expect(limiter.size()).toBeLessThan(1_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run auth/rateLimit.test.js`
Expected: FAIL — `Failed to resolve import "./rateLimit.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `auth/rateLimit.js`:

```javascript
/**
 * A minimal in-memory per-IP rate limiter.
 *
 * Deliberately not a dependency: the repo already carries 30 advisories and
 * this is twenty lines. The trade-off is that counts are per process, so a
 * multi-worker host divides the effective limit by the worker count. That is
 * acceptable for slowing password guessing; it is not a general quota system.
 */
export function createRateLimiter({ windowMs, max, now = Date.now } = {}) {
  const hits = new Map();

  const clientIp = (req) =>
    String(req.ip || req.socket?.remoteAddress || "unknown");

  // Sweep on write rather than on a timer, so an idle process holds nothing.
  const sweep = (t) => {
    for (const [key, entry] of hits) {
      if (t - entry.start >= windowMs) hits.delete(key);
    }
  };

  const limiter = (req, res, next) => {
    const t = now();
    if (hits.size > 500) sweep(t);

    const key = clientIp(req);
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return next();
    }
    if (entry.count < max) {
      entry.count += 1;
      return next();
    }
    const retryAfter = Math.max(1, Math.ceil((entry.start + windowMs - t) / 1000));
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).json({ error: "too_many_requests", retryAfterSeconds: retryAfter });
  };

  limiter.size = () => hits.size;
  return limiter;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run auth/rateLimit.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Apply it to login**

In `auth/router.js`, add below the existing `import bcrypt from "bcryptjs";` (line 2):

```javascript
import { createRateLimiter } from "./rateLimit.js";
```

Then find (line 296):

```javascript
router.post("/login", async (req, res) => {
```

and replace that single line with:

```javascript
// Ten attempts per IP per fifteen minutes. Enough that a person mistyping a
// password is never blocked; far too few to guess one.
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

router.post("/login", loginLimiter, async (req, res) => {
```

- [ ] **Step 6: Verify and commit**

Run: `node --check auth/router.js && npx vitest run auth/rateLimit.test.js`
Expected: no parse output, then PASS.

```bash
git add auth/rateLimit.js auth/rateLimit.test.js auth/router.js
git commit -m "Rate-limit login to ten attempts per IP per fifteen minutes"
```

---

## Task 6: Triage the dependency advisories

**Files:**
- Create: `docs/security-dependency-triage.md`
- Modify: `package.json`, `package-lock.json` (via npm)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing importable.

- [ ] **Step 1: Capture the current state**

Run: `npm audit --production --json > /tmp/audit-before.json; node -e "const d=require('/tmp/audit-before.json');console.log(JSON.stringify(d.metadata.vulnerabilities))"`
Expected: a line like `{"info":0,"low":3,"moderate":5,"high":20,"critical":2,"total":30}`. Record it.

- [ ] **Step 2: Apply only non-breaking fixes**

Run: `npm audit fix`

Do **not** run `npm audit fix --force`. It installs breaking major versions and this repo has no end-to-end coverage to catch what that breaks.

- [ ] **Step 3: Verify nothing regressed**

Run: `npx vitest run && npx tsc -b --noEmit && node --check server.js`
Expected: all tests pass, zero type errors, no parse output.

If the suite fails, run `git checkout -- package.json package-lock.json`, re-run the suite to confirm green, and record in the triage doc that `npm audit fix` could not be applied cleanly.

- [ ] **Step 4: Write the triage**

Create `docs/security-dependency-triage.md`. Fill the table from `npm audit --production` **after** the fix, one row per remaining high or critical advisory:

```markdown
# Dependency advisory triage

Snapshot: 2026-08-25. Re-run `npm audit --production` before trusting this.

Counts before `npm audit fix`: low 3, moderate 5, high 20, critical 2 (total 30).
Counts after: <fill from Step 3>

## Reachable at runtime

These ship in the running server or the browser bundle. Fix first.

| Package | Severity | Advisory | Reached via | Action |
| --- | --- | --- | --- | --- |
| axios | high | NO_PROXY hostname normalization bypass | server-side HTTP calls | upgrade |
| @remix-run/router | high | XSS via open redirect | react-router in the SPA | upgrade |

## Build-time only

These run during `npm install` or `npm run build` and are not reachable by a
request. Lower priority, not zero: they still execute on the build host.

| Package | Severity | Advisory | Reached via | Action |
| --- | --- | --- | --- | --- |
| tar | critical | arbitrary file overwrite | install-time extraction | upgrade when convenient |
| glob | high | command injection via the CLI `-c` flag | build tooling; the CLI is not invoked | accept |

## Accepted

One row per advisory being left, each with the reason and who decided.
```

Replace every example row with the real remaining advisories. Do not leave the samples in.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json docs/security-dependency-triage.md
git commit -m "Apply non-breaking dependency fixes and triage the rest"
```

---

## Task 7: Verify against the running server

**Files:** none — this is a deploy-time check.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

The spec's stated risk is a misclassified endpoint breaking on deploy. This task is how that gets caught before the boss's Saturday email.

- [ ] **Step 1: Full local verification**

Run: `npx vitest run && npx tsc -b --noEmit && node --check server.js && node --check auth/router.js`
Expected: all pass.

- [ ] **Step 2: Hand off to the user for deploy**

Do not deploy. Tell the user to push, restart, and report back. Give them exactly this check list:

1. Sign in. Every dashboard panel should populate as before.
2. The treasury endpoint must now refuse an anonymous caller:
   `curl -s -o /dev/null -w "%{http_code}\n" https://app.skylinkscapital.com/api/closing-balance-report`
   Expected: `401`. It returned `200` before this change.
3. Open a **report chart URL from an existing weekly email in a signed-out browser**. It must still load. If it 401s, `/report-charts` has been caught by the gate and images in already-delivered mail are broken — revert before doing anything else.
4. Watch for a wave of 401s in the dashboard. A few are expected while a stale tab retries; a flood means a route was misclassified.

- [ ] **Step 3: Only after the user confirms, mark done**

Do not tick this box on the strength of local tests. It is ticked when the user reports step 2 returning 401 and step 3 still loading.

---

## Out of scope

Tracked separately, not part of this plan:

- Rotating the exposed CRM token.
- Pointing the alerts hub back at the real backend, so live alerts work again after the mock was disabled in `e959225`.
- CSP and HSTS headers.
