// Pure decision logic for alerts — no I/O, fully unit-testable.

/**
 * Decide which currently-breached LP logins are "newly breached" (and should be emailed),
 * applying a per-login cooldown so a persistent/flapping breach does not spam.
 *
 * @param {Map<string, number>} active  login -> last-emailed epoch ms
 * @param {Array<{login?: string|number}>} rows  currently-breached rows from LpMarginAlerts
 * @param {number} nowMs
 * @param {number} cooldownMs
 * @returns {{ newlyBreached: Array<object>, nextActive: Map<string, number> }}
 */
export function diffBreaches(active, rows, nowMs, cooldownMs) {
  const next = new Map();
  const newlyBreached = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const login = String(row?.login ?? "").trim();
    if (!login) continue;
    const last = active.get(login);
    if (last === undefined || nowMs - last >= cooldownMs) {
      newlyBreached.push(row);
      next.set(login, nowMs);
    } else {
      next.set(login, last);
    }
  }
  return { newlyBreached, nextActive: next };
}

/**
 * Tells apart the two failures that both look like "the hub is not connected".
 *
 * They are not the same incident and they do not have the same fix. A 401/403
 * on negotiate means the backend is up, answering, and refusing US: the
 * dashboard's credentials are missing, wrong or expired, and the person who
 * gets the email has to look at BACKEND_API_KEY / BACKEND_CLIENT_ID on our
 * server. A timeout, a DNS failure, a refused socket or a 5xx means the
 * backend itself is not serving, and there is nothing to fix on our side.
 * Sending "Data backend unreachable" for the first case sent an operator
 * looking at a backend that was healthy the whole time.
 *
 * SignalR's HttpError carries the negotiate status on `statusCode`; a bare
 * network failure carries no status at all. The text checks are a backstop for
 * errors that have been re-wrapped and lost the property, and for the
 * BackendTokenError thrown by wallet/backendToken.js when the client_credentials
 * exchange itself is refused -- that is a credential problem too, one step
 * earlier.
 *
 * @param {unknown} error
 * @returns {"auth"|"unreachable"}
 */
export function classifyHubFailure(error) {
  const status = Number(error?.statusCode ?? error?.status);
  if (status === 401 || status === 403) return "auth";
  // Any other status at all means the backend answered, so it is reachable and
  // whatever went wrong is not our credentials.
  if (Number.isFinite(status) && status > 0) return "unreachable";
  if (error?.name === "BackendTokenError") return "auth";
  const text = String(error?.message || error || "");
  if (/\b(401|403)\b/.test(text)) return "auth";
  if (/unauthori[sz]ed|forbidden|invalid_token|invalid_client/i.test(text)) return "auth";
  return "unreachable";
}

/**
 * Gates the "still down" re-notification.
 *
 * The watcher retries every 15 seconds forever, so without this gate the retry
 * path would be an email every 15 seconds. Returns true only once the whole
 * interval has elapsed since the last notification; the caller records a new
 * timestamp when it fires, which is what makes the next one another full
 * interval away.
 *
 * intervalMs <= 0 disables re-notification entirely, so an operator who does
 * not want the reminder can turn it off without editing code.
 *
 * @param {number|null} lastNotifiedAt  epoch ms of the last down email, or null if none
 * @param {number} nowMs
 * @param {number} intervalMs
 */
export function shouldRenotify(lastNotifiedAt, nowMs, intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;
  if (lastNotifiedAt === null || lastNotifiedAt === undefined) return false;
  return nowMs - lastNotifiedAt >= intervalMs;
}

/**
 * Edge-triggered backend connection state machine.
 * @param {"up"|"down"} prev
 * @param {"connected"|"closed"} event
 * @returns {{ state: "up"|"down", action: null|"down-email"|"recovered-email" }}
 */
export function nextConnState(prev, event) {
  if (event === "connected") {
    return prev === "down" ? { state: "up", action: "recovered-email" } : { state: "up", action: null };
  }
  if (event === "closed") {
    return prev !== "down" ? { state: "down", action: "down-email" } : { state: "down", action: null };
  }
  return { state: prev, action: null };
}
