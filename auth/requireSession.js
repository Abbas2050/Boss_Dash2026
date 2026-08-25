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
  // Express's default "case sensitive routing" is false, so Express itself
  // will route /API/closing-balance-report to the real handler (server.js
  // mounts /api/ClientProfile in mixed case, so casing genuinely varies in
  // this app). Lowercasing here makes the gate judge a path exactly the way
  // Express will route it -- both for deciding what's guarded and for
  // matching the allow-list -- so a request in a different case can't sail
  // past either check untouched.
  const lower = withoutQuery.toLowerCase();
  // "/api/auth/login/" and "/api/auth/login" are the same route to Express.
  return lower.length > 1 ? lower.replace(/\/+$/, "") : lower;
}

export function isPublicApiRoute(method, path) {
  return PUBLIC_API_ROUTES.has(`${String(method || "").toUpperCase()} ${normalisePath(path)}`);
}

function isGuardedPath(path) {
  const clean = normalisePath(path);
  return GUARDED_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`));
}

export function requireSession(req, res, next) {
  const rawPath = req.path ?? req.originalUrl ?? req.url;
  // A deny-by-default gate must fail CLOSED on a path it cannot make sense
  // of. If req.path/originalUrl/url are all missing, normalisePath would
  // otherwise collapse the input to "", which isGuardedPath reads as "not
  // guarded" -- letting next() run with no auth check at all. Anything
  // that isn't a real, non-empty string path goes straight to authRequired
  // instead of being assumed safe to skip.
  if (typeof rawPath !== "string" || rawPath === "") {
    return authRequired(req, res, next);
  }
  const path = normalisePath(rawPath);
  if (!isGuardedPath(path)) return next();
  if (isPublicApiRoute(req.method, path)) return next();
  return authRequired(req, res, next);
}
