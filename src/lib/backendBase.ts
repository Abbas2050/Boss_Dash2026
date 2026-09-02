/**
 * Where the browser sends trading-backend calls, and where the SignalR hub
 * lives. The two are no longer the same origin, and that is deliberate.
 *
 * WHY HTTP NOW GOES THROUGH OUR OWN SERVER
 * api.skylinkscapital.com used to answer anyone; it now rejects every request
 * with 401 invalid_token unless a Bearer is attached. That Bearer is minted
 * from BACKEND_API_KEY, a credential that must never reach the browser bundle,
 * so the browser cannot hold it and cannot call the backend directly any more.
 * server.js therefore mounts a same-origin proxy at /api/backend
 * (wallet/backendProxy.js) which attaches the token server-side and strips the
 * caller's own Authorization header before forwarding. Pointing this constant
 * at that prefix is what moves all ~27 calling files onto it at once.
 *
 * Because /api/backend sits under the deny-by-default gate in
 * auth/requireSession.js, every call built on this base must also carry the
 * dashboard session JWT (`...authHeaders()` from @/lib/auth). Without it the
 * request now 401s on OUR server before it ever reaches the backend.
 *
 * THE ORIGINAL WARNING, WHICH STILL APPLIES TO THE HUB BELOW
 * The fallback is not a convenience. Credentials were renamed off the `VITE_`
 * prefix so they could not reach the browser bundle, and `VITE_BACKEND_BASE_URL`
 * went with them — so in production this variable is undefined. Without the
 * fallback every caller collapses to a relative path and hits THIS server,
 * which does not host the trading API. That is how live alerts broke: the
 * SignalR hub URL became `/ws/dashboard` on our own origin, where only a dev
 * mock ever answered.
 *
 * This is a public hostname, not a secret, so hard-coding it is safe.
 */
const BACKEND_DIRECT_ORIGIN = String(
  (import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com",
).replace(/\/+$/, "");

/**
 * Same-origin prefix, not an origin. Callers concatenate a path onto it exactly
 * as before, so `${BACKEND_BASE_URL}/Metrics/dashboard` becomes
 * `/api/backend/Metrics/dashboard`; the proxy strips the prefix and forwards
 * the rest, query string included, to the real backend.
 *
 * Deliberately NOT overridable from VITE_BACKEND_BASE_URL. Setting that would
 * send the browser straight at the backend again with no token and reintroduce
 * the 401. The backend's real address is configured server-side instead, by
 * BACKEND_API_BASE_URL, which the proxy reads.
 *
 * Anything that parses this as an absolute URL will break. `new URL(path,
 * window.location.origin)` is fine and is the shape already used in
 * src/lib/rebateApi.ts and src/lib/dealingApi.ts; bare `new URL(base)` is not.
 */
export const BACKEND_BASE_URL = "/api/backend";

/**
 * The one SignalR hub, registered by the backend as
 * `app.MapHub<DashboardHub>("/ws/dashboard")`.
 *
 * NOT repointed at the proxy, on purpose. /api/backend is an HTTP proxy built
 * on fetch(); it cannot carry a websocket upgrade, so routing the hub through
 * it would fail in a way that looks like a hub bug rather than a missing
 * feature. Do not "fix" it by pointing this at BACKEND_BASE_URL.
 *
 * Because the hub is spoken to directly, its auth is the client's job, and
 * that is now solved rather than outstanding: SignalR presents a Bearer on
 * negotiate and as ?access_token= on the socket, obtained by every hub site
 * from the one factory in src/lib/hubAccessToken.ts, which reads it from the
 * session-gated /api/backend/hub-token on our own server. Only the SHORT-LIVED
 * access token ever reaches the browser; BACKEND_API_KEY stays server-side.
 */
export const DASHBOARD_HUB_URL = `${BACKEND_DIRECT_ORIGIN}/ws/dashboard`;
