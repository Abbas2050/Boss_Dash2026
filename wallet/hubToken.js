/**
 * Hands the logged-in dashboard the short-lived backend access token, so the
 * SignalR hub can authenticate itself.
 *
 * WHY THE BROWSER IS ALLOWED TO HOLD THIS AT ALL
 * Every other backend call goes through the fetch()-based proxy in
 * backendProxy.js precisely so the browser never holds a backend credential.
 * A websocket cannot take that route: /api/backend is built on fetch(), which
 * has no way to carry an Upgrade, so the hub at
 * https://api.skylinkscapital.com/ws/dashboard is spoken to directly by the
 * browser. SignalR's own protocol then requires the CLIENT to present the
 * Bearer -- on POST /ws/dashboard/negotiate as an Authorization header, and on
 * the socket itself as ?access_token=. There is no server-side seam to put a
 * credential in. So either the browser holds a token or live alerts stay dead.
 *
 * That is acceptable here only because of the two-tier scheme the backend team
 * documented, and the distinction is the whole security argument:
 *
 *   - BACKEND_API_KEY (the slc_live_... value) is the LONG-LIVED SECRET. It is
 *     used at exactly one place, POST /oauth/token in backendToken.js, and it
 *     must never reach the browser, a data endpoint, or an access log. Nothing
 *     in this file may ever return it.
 *   - The access token minted from it is short-lived (one hour), opaque, and
 *     is exactly the artefact a client is meant to present. Leaking one costs
 *     an hour of read access, not the account.
 *
 * The endpoint is therefore session-gated: server.js registers it under /api,
 * where the deny-by-default gate in auth/requireSession.js already calls
 * authRequired, so only a browser carrying this dashboard's own session JWT
 * can obtain a token. An anonymous caller gets 401 from the gate and never
 * reaches this handler.
 *
 * It lives here rather than inline in server.js for the same reason
 * backendProxy.js does: server.js opens database pools and registers cron
 * schedulers at import time, so a test cannot import it. This module is a pure
 * function of (req, res, deps).
 */

import { getBackendToken } from './backendToken.js';
import { redactSecretValues, buildSecretList } from './redactSecrets.js';

export const HUB_TOKEN_ROUTE = '/api/backend/hub-token';

/**
 * How much life we promise the caller, in milliseconds.
 *
 * This is a FLOOR, not the real expiry. backendToken.js keeps the true expiry
 * in module-private state and does not export it, and reaching into that state
 * from here would couple this handler to its internals -- so we report what we
 * can prove instead of what we would like to know. What we can prove: that
 * module refreshes REFRESH_SKEW_MS (five minutes) before the stated expiry and
 * only ever returns a cached token while it is still inside that window, so
 * any token it hands back on the documented one-hour lifetime has at least
 * five minutes of real life left.
 *
 * A floor is the safe direction to be wrong in. Report too little and the
 * client refetches a token that was still good, which costs one cached,
 * same-origin GET. Report too much and the client keeps presenting a dead
 * token and the hub silently stops reconnecting. Clients should treat this as
 * a hint only: the shared factory in src/lib/hubAccessToken.ts refetches on
 * every SignalR negotiate rather than trusting any expiry at all.
 */
export const HUB_TOKEN_MIN_LIFETIME_MS = 5 * 60_000;

/**
 * GET /api/backend/hub-token -> { token, expiresAt }
 *
 * `deps` exists only so tests can inject a token source; production passes
 * nothing and gets the real cache-backed exchange.
 */
export async function hubTokenHandler(req, res, deps = {}) {
  const getToken = deps.getBackendToken || getBackendToken;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  let token;
  try {
    token = await getToken();
  } catch (error) {
    // The message from backendToken.js is already redacted, but it is built
    // from operator-facing text about credentials, so redact again on the way
    // out rather than trusting that. 502: our own service is up, the thing we
    // depend on would not issue a token.
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({
      error: 'backend_token_unavailable',
      message: redactSecretValues(message, buildSecretList()),
    });
    return;
  }

  // Defence in depth against the one mistake this endpoint must never make.
  // If a future refactor ever made getBackendToken() hand back the raw API key
  // (the old reverse-engineered code did try the key directly as a Bearer),
  // this route would publish a long-lived secret to every logged-in browser
  // and to its devtools network log. Refuse loudly instead. The check compares
  // values, not names, so it survives the variable being renamed.
  const apiKey = String(process.env.BACKEND_API_KEY || '').trim();
  if (!token || (apiKey && token === apiKey)) {
    res.status(500).json({
      error: 'backend_token_unavailable',
      message: token
        ? 'Refusing to serve the backend API key as a hub token.'
        : 'The backend token exchange produced no token.',
    });
    return;
  }

  // A token is a bearer credential with a short life: it must not sit in a
  // shared cache, and a conditional revalidation must not resurrect it.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token, expiresAt: now() + HUB_TOKEN_MIN_LIFETIME_MS });
}
