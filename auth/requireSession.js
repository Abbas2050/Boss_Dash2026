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
