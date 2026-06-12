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
