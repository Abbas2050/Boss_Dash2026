/**
 * Base URL of the trading backend (the .NET service), which is a different
 * origin from this dashboard.
 *
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
export const BACKEND_BASE_URL = String(
  (import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com",
).replace(/\/+$/, "");

/** The one SignalR hub, registered by the backend as `app.MapHub<DashboardHub>("/ws/dashboard")`. */
export const DASHBOARD_HUB_URL = `${BACKEND_BASE_URL}/ws/dashboard`;
