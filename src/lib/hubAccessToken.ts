import { authHeaders } from "@/lib/auth";

/**
 * The one place the browser gets a Bearer for the SignalR hub.
 *
 * WHY THIS EXISTS AT ALL
 * Every HTTP call to the trading backend goes through the same-origin proxy at
 * /api/backend, which attaches the token server-side so the browser never
 * holds a backend credential. The hub cannot use that road: the proxy is built
 * on fetch(), which cannot carry a websocket upgrade, so DASHBOARD_HUB_URL
 * stays on the direct backend origin (see the comment in backendBase.ts, the
 * only file allowed to name that origin) and the browser speaks to it itself.
 * SignalR's protocol then puts the credential in the CLIENT's hands: the
 * Bearer goes on POST /ws/dashboard/negotiate, and the same value rides the
 * socket as ?access_token=. Without it negotiate answers 401 and live alerts
 * are dead -- which is exactly the state this replaces.
 *
 * WHY IT IS SAFE FOR THE BROWSER TO HOLD THIS
 * There are two different credentials and only one of them is a secret.
 * BACKEND_API_KEY (slc_live_...) is long-lived, is used only at
 * POST /oauth/token on our server, and must never reach the browser. What this
 * function fetches is the ACCESS TOKEN minted from it: opaque, one hour long,
 * and precisely the artefact a client is meant to present. Our endpoint sits
 * behind the dashboard's session gate, so only a logged-in user can get one.
 *
 * WHY IT REFETCHES EVERY TIME
 * SignalR calls accessTokenFactory again on every negotiate and on every
 * automatic reconnect, and a dashboard tab routinely outlives a one-hour
 * token. A token captured at mount and closed over would therefore work until
 * the first reconnect after expiry and then fail forever, in a way that looks
 * like a flaky hub. Asking again each time costs one same-origin GET against a
 * server that is already holding the token in memory.
 */
export const HUB_TOKEN_URL = "/api/backend/hub-token";

interface HubTokenResponse {
  token?: unknown;
  expiresAt?: unknown;
}

/**
 * Fetches a current hub access token, or null if one cannot be had.
 *
 * Never throws. A throw here propagates out of SignalR's negotiate into
 * whatever was awaiting connect(), and in several of the call sites that is a
 * React effect with no catch -- so a logged-out user or a momentary 502 would
 * take out the page rather than just the alerts. Returning null instead lets
 * SignalR fail the connection normally, which surfaces through the existing
 * onError/onStatusChange handlers as a visible "disconnected".
 *
 * The request carries authHeaders() because /api/backend/hub-token is behind
 * the deny-by-default session gate; without the dashboard JWT our own server
 * answers 401 before the backend is ever consulted.
 */
export async function fetchHubAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(HUB_TOKEN_URL, {
      headers: { ...authHeaders() },
      // A bearer credential must not be served from the bfcache or a
      // revalidated 304.
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as HubTokenResponse;
    const token = body?.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Drop-in value for SignalRConnectionManager's `accessTokenFactory` and for a
 * raw HubConnectionBuilder's `.withUrl(url, { accessTokenFactory })`.
 *
 * Deliberately a plain function reference rather than a factory-of-factories:
 * there is no per-connection state to hold, and anything that held state would
 * be the captured-token bug this file exists to avoid.
 */
export const hubAccessTokenFactory = (): Promise<string | null> => fetchHubAccessToken();
