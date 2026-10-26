/**
 * Sales commission: every decision that is arithmetic rather than I/O.
 *
 * Nothing here touches the network, the clock (except through an injected
 * `now`) or Express, so the rules that decide what a salesperson is owed and
 * what a salesperson is allowed to see are testable without a server, a
 * database or a CRM token. `commissionSources.js` does the fetching and
 * `commissionRoute.js` does the HTTP; both import from here.
 *
 * The approved design is docs/superpowers/specs/2026-10-26-sales-commission-page-design.md.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The rate, and what it is paid on
// ─────────────────────────────────────────────────────────────────────────────

/**
 * $1 per realized CFD/FX lot.
 *
 * A named constant so the figure appears once, and **deliberately not read from
 * the environment**. Same reasoning as `DEPOSIT_STATUSES` in
 * crmSignup/depositValue.js, only with wages on the other end: a rate an
 * operator could change by editing a .env would restate every salesperson's
 * past months silently, with nothing in the response to say it had moved. If
 * the rate ever changes it is a commit, a review and a date.
 */
export const COMMISSION_USD_PER_CFD_LOT = 1;

/**
 * The commission basis is `cfdLots` and nothing else.
 *
 * docs/dealing-reporting.md §1: the same week reports 203,109 deal lots,
 * 99,527 realized lots and 1,401 realized CFD/FX lots -- a 145x spread, so the
 * choice of field IS the choice of payout. `lots` double-counts a round trip
 * (open + close are two deals); `stocksLots` are share-based and not
 * comparable to a 100k-unit FX lot, and they outweigh CFD by ~70x. Paying on
 * either would overpay by one or two orders of magnitude.
 *
 * Exported as a string so a test can assert the field name, not just the
 * arithmetic.
 */
export const COMMISSION_BASIS_FIELD = "cfdLots";

/**
 * The sales roster, by FXBO manager id (spec, "Three salespeople").
 *
 * This list is only what the Super Admin view enumerates. A salesperson's OWN
 * view is driven by the `crmManagerId` on their dashboard user record, so a
 * fourth salesperson can be given their own page by setting that field alone --
 * but they stay invisible in the all-salespeople view until they are added
 * here, which is the deliberate trade: one list to maintain, and no way for an
 * unreviewed manager id to appear in the company-wide margin figure.
 */
export const SALES_MANAGERS = Object.freeze([
  Object.freeze({ managerId: 28, name: "Mitul Kapadia" }),
  Object.freeze({ managerId: 23, name: "Aditya" }),
  Object.freeze({ managerId: 20, name: "Smit" }),
]);

export const SALES_MANAGER_IDS = Object.freeze(SALES_MANAGERS.map((m) => m.managerId));

export function salesManagerName(managerId) {
  const id = toManagerId(managerId);
  const match = SALES_MANAGERS.find((m) => m.managerId === id);
  // A manager id with no roster entry is not an error -- see SALES_MANAGERS --
  // so it is named rather than left null, because the page prints this.
  return match ? match.name : id === null ? "" : `Manager #${id}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion at every boundary
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A manager id as a positive integer, or null.
 *
 * **Both sides of the comparison go through this.** The dashboard user record
 * stores a number, but FXBO has returned numeric fields as strings before, and
 * `28 === "28"` is false: a salesperson whose id arrived as a string would
 * match none of their own clients and be told they had earned nothing, with no
 * error anywhere. Coercing both sides is the only shape of this comparison that
 * cannot fail quietly.
 */
export function toManagerId(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * The join key for an MT5 login.
 *
 * ClientVolume's `ByClientRow.login` is typed `string | number`, FXBO's account
 * rows carry it as a string, and DealMatch's revenue rows are unverified on the
 * point. A Map keyed on the raw value would put 10218 and "10218" in different
 * buckets and silently halve somebody's lots.
 */
export function toLoginKey(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/** Money and lots are rounded ONCE, here, when the response is built. */
function round2(n) {
  const v = num(n);
  // Number.EPSILON nudge: (1.005).toFixed(2) is "1.00" because 1.005 is stored
  // slightly below 1.005. Matters because these are wages.
  return Math.round((v + Number.EPSILON * Math.sign(v || 1)) * 100) / 100;
}

export { round2 };

// ─────────────────────────────────────────────────────────────────────────────
// The date range
// ─────────────────────────────────────────────────────────────────────────────

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD, or null. "2026-02-30" is not one. */
export function parseYmd(value) {
  const m = YMD_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check: Date.UTC rolls 2026-02-30 forward to 2026-03-02, so
  // comparing the parts back is what rejects a date that does not exist.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return { year, month, day, at };
}

function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * A month of commission is the longest window this page is for, so the cap is
 * a year rather than a month: a quarter or a full year is a plausible ad-hoc
 * question, anything beyond that is a data export and should not be answered by
 * a page that holds the whole result in memory and recomputes on every load.
 */
export const MAX_RANGE_DAYS = 366;

/**
 * The window, defaulted to the current month (spec §2) and validated.
 *
 * Returns `{ from, to }` as YYYY-MM-DD, or `{ error }`. The default is computed
 * in **UTC**, matching how every report module in this repo builds a period
 * (`previousFullWeekUtc` and friends in reports/reportShared.js). The page
 * sends explicit dates, so this default only covers a bare call.
 */
export function resolveRange(query, now = new Date()) {
  const rawFrom = String(query?.from ?? "").trim();
  const rawTo = String(query?.to ?? "").trim();

  if (!rawFrom && !rawTo) {
    const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: ymd(firstOfMonth), to: ymd(now) };
  }
  // Half a range is a client bug, not a range to guess at: silently pairing a
  // supplied `from` with "today" would answer a question nobody asked and the
  // figure would look perfectly plausible.
  if (!rawFrom || !rawTo) return { error: "from_and_to_required" };

  const from = parseYmd(rawFrom);
  const to = parseYmd(rawTo);
  if (!from || !to) return { error: "invalid_date" };
  if (from.at.getTime() > to.at.getTime()) return { error: "from_after_to" };

  const days = Math.round((to.at.getTime() - from.at.getTime()) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) return { error: "range_too_long" };

  return { from: ymd(from.at), to: ymd(to.at) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream request shapes
// ─────────────────────────────────────────────────────────────────────────────

/** FXBO user search. `managerIds` filters server-side; the caller filters again. */
export function salesUsersPayload({ managerIds, limit, offset }) {
  return {
    managerIds: managerIds.map((id) => toManagerId(id)).filter((id) => id !== null),
    segment: { limit, offset },
  };
}

/** FXBO account search. This is the only source of login -> CRM client. */
export function salesAccountsPayload({ userIds, limit, offset }) {
  return {
    userIds: userIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0),
    segment: { limit, offset },
  };
}

/**
 * `GET /ClientVolume/Run?from&to&group=*`.
 *
 * Dates are YYYY-MM-DD here and Unix seconds for DealMatch -- the formats
 * genuinely differ between the two endpoints (docs/dealing-reporting.md §2),
 * which is why these two builders exist side by side rather than one shared one.
 */
export function clientVolumeQuery({ from, to }) {
  return new URLSearchParams({ from, to, group: "*" }).toString();
}

/**
 * `GET /DealMatch/Run` in summary mode.
 *
 * `lite=true` carries `clientRevenueSummaries`, which is all this route reads.
 * `lite=false` adds every match row -- ~45 MB for a month -- and must not be
 * reintroduced "to be safe" (docs/dealing-reporting.md §2).
 *
 * The window is the same YYYY-MM-DD pair as ClientVolume's, converted to the
 * Unix seconds this endpoint takes, with the end at 23:59:59 so the last day is
 * inside the window. Boundaries are UTC, as in reports/reportShared.js.
 */
export function dealMatchQuery({ from, to }) {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (!start || !end) throw new TypeError("dealMatchQuery: from and to must be YYYY-MM-DD");
  const fromUnix = Math.floor(Date.UTC(start.year, start.month - 1, start.day, 0, 0, 0) / 1000);
  const toUnix = Math.floor(Date.UTC(end.year, end.month - 1, end.day, 23, 59, 59) / 1000);
  return new URLSearchParams({
    group: "*",
    from: String(fromUnix),
    to: String(toUnix),
    symbol: "",
    lite: "true",
  }).toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Who may see what
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The caller's scope, from the verified session identity and nothing else.
 *
 * `req.auth` is built by `authRequired` in auth/router.js: it verifies the JWT
 * signature, then re-reads role, access and `crmManagerId` from the users table
 * by the token's `sub`. So the manager id here is a database fact about a
 * verified identity -- it is never taken from a query parameter, a header or a
 * body, which is the entire reason this endpoint exists rather than a UI filter
 * (spec §4).
 *
 * Super Admin wins over `crmManagerId`. Abbas is the only person who would hold
 * both, and the role already short-circuits every other permission check in the
 * app (`hasUserAccess` in src/lib/permissions.ts), so the opposite order would
 * make this one endpoint disagree with the rest of the dashboard.
 */
export function resolveCommissionScope(auth) {
  const role = String(auth?.role || "").trim().toLowerCase();
  if (role === "super admin") {
    return { kind: "all", managerIds: [...SALES_MANAGER_IDS], includeRevenue: true };
  }
  const managerId = toManagerId(auth?.crmManagerId);
  if (managerId !== null) {
    // includeRevenue false is load-bearing, not cosmetic: the route skips the
    // DealMatch fetch entirely for this caller, so there is no revenue figure in
    // the process to leak, let alone in the response.
    return { kind: "self", managerIds: [managerId], includeRevenue: false };
  }
  return { kind: "denied" };
}

// ─────────────────────────────────────────────────────────────────────────────
// The join and the aggregate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commission, per salesperson and per client, from the three (four) sources.
 *
 * @param {object} input
 * @param {{kind:string,managerIds:number[],includeRevenue:boolean}} input.scope
 * @param {{from:string,to:string}} input.range
 * @param {Array<{userId:number,managerId:number|string,name:string}>} input.clients FXBO users
 * @param {Array<{login:string|number,userId:number,group?:string}>} input.accounts FXBO accounts
 * @param {Array<{login:string|number,name?:string,group?:string,lots?:number,stocksLots?:number,cfdLots?:number}>} input.volumeRows ClientVolume byClient
 * @param {{available:boolean,rows?:Array<object>,reason?:string}} [input.revenue] DealMatch clientRevenueSummaries
 *
 * THE COMMISSION FIGURE DOES NOT TOUCH `revenue`. It is built from
 * clients -> accounts -> volumeRows only, so a revenue fetch that fails, or a
 * revenue join key that turns out to be something other than a login, cannot
 * change what anyone is owed. The tests pin that by computing the same input
 * twice, once with revenue and once without, and comparing the commission.
 */
export function buildCommissionReport({ scope, range, clients, accounts, volumeRows, revenue }) {
  const includeRevenue = scope.kind === "all" && Boolean(revenue?.available);
  const scopedManagerIds = new Set(scope.managerIds.map((id) => toManagerId(id)).filter((id) => id !== null));

  // ── in-scope clients ──────────────────────────────────────────────────────
  // Filtered here as well as in the FXBO request. Two independent gates on the
  // same rule: the request asks only for the caller's manager id, and nothing
  // the CRM returns outside it is aggregated even if the filter is ignored --
  // which is a real possibility, since `managerIds` is not in the typed
  // UserRequest shape in src/lib/api.ts.
  const byClient = new Map();
  for (const row of Array.isArray(clients) ? clients : []) {
    const userId = Number(row?.userId);
    const managerId = toManagerId(row?.managerId);
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (managerId === null || !scopedManagerIds.has(managerId)) continue;
    if (byClient.has(userId)) continue;
    byClient.set(userId, {
      crmUserId: userId,
      managerId,
      // Name only. The CRM user record also carries email and phone; neither is
      // needed to report lots and neither goes into the response or a log.
      name: String(row?.name || "").trim() || `Client #${userId}`,
      logins: [],
      lots: 0,
      stocksLots: 0,
      cfdLots: 0,
      revenueUsd: 0,
      revenueRowCount: 0,
    });
  }

  // ── login -> client ───────────────────────────────────────────────────────
  const clientByLogin = new Map();
  for (const row of Array.isArray(accounts) ? accounts : []) {
    const login = toLoginKey(row?.login);
    const userId = Number(row?.userId);
    if (!login) continue;
    const client = byClient.get(userId);
    if (!client) continue; // an account of a client outside this scope
    if (!clientByLogin.has(login)) clientByLogin.set(login, client);
    if (!client.logins.includes(login)) client.logins.push(login);
  }

  // ── lots ──────────────────────────────────────────────────────────────────
  let volumeRowCount = 0;
  let volumeRowsMatched = 0;
  for (const row of Array.isArray(volumeRows) ? volumeRows : []) {
    volumeRowCount += 1;
    const client = clientByLogin.get(toLoginKey(row?.login));
    if (!client) continue; // another manager's client, or an account we did not ask for
    volumeRowsMatched += 1;
    client.lots += num(row?.lots);
    client.stocksLots += num(row?.stocksLots);
    client.cfdLots += num(row?.cfdLots);
  }

  // ── revenue ───────────────────────────────────────────────────────────────
  // `totalRevenueUsd` is taken as the backend gives it. It is NOT rebuilt from
  // markup + clientComm: that drops client swap, and on 2026-09-16 the gap was
  // $20,313.91 of $21,609.65 (docs/dealing-reporting.md §5).
  let revenueRowCount = 0;
  let revenueRowsMatched = 0;
  if (includeRevenue) {
    for (const row of Array.isArray(revenue?.rows) ? revenue.rows : []) {
      revenueRowCount += 1;
      const client = clientByLogin.get(toLoginKey(row?.login));
      if (!client) continue;
      revenueRowsMatched += 1;
      client.revenueUsd += num(row?.totalRevenueUsd);
      client.revenueRowCount += 1;
    }
  }

  // ── group by salesperson ──────────────────────────────────────────────────
  const groups = new Map();
  const groupFor = (managerId) => {
    if (!groups.has(managerId)) {
      groups.set(managerId, {
        managerId,
        name: salesManagerName(managerId),
        clientCount: 0,
        tradingClientCount: 0,
        lots: 0,
        stocksLots: 0,
        cfdLots: 0,
        revenueUsd: 0,
        clients: [],
      });
    }
    return groups.get(managerId);
  };
  // Every id in scope gets a group even with no clients, so a salesperson whose
  // book is empty renders as a zero rather than vanishing from the page.
  for (const id of scopedManagerIds) groupFor(id);

  let clientsWithNoActivity = 0;
  let clientsMissingRevenue = 0;
  let clientsWithMultipleRevenueRows = 0;

  for (const client of byClient.values()) {
    const group = groupFor(client.managerId);
    group.clientCount += 1;

    // "Activity" deliberately includes stocks-only trading. Such a client earns
    // their salesperson nothing (equity is excluded from the basis), and the
    // spec says that is the one consequence of the rate decision that will
    // surprise the sales team -- so the row has to be on the page, with its
    // stocksLots beside a zero commission, to explain itself.
    const traded = client.cfdLots !== 0 || client.lots !== 0 || client.stocksLots !== 0;
    const hasRevenue = client.revenueRowCount > 0;
    if (!traded && !hasRevenue) {
      clientsWithNoActivity += 1;
      continue;
    }
    group.tradingClientCount += 1;
    group.lots += client.lots;
    group.stocksLots += client.stocksLots;
    group.cfdLots += client.cfdLots;
    group.revenueUsd += client.revenueUsd;

    if (includeRevenue) {
      if (client.cfdLots !== 0 && !hasRevenue) clientsMissingRevenue += 1;
      if (client.revenueRowCount > 1) clientsWithMultipleRevenueRows += 1;
    }

    group.clients.push(client);
  }

  // ── serialise ─────────────────────────────────────────────────────────────
  const commissionOf = (cfdLots) => cfdLots * COMMISSION_USD_PER_CFD_LOT;

  const salespeople = [...groups.values()]
    .sort((a, b) => b.cfdLots - a.cfdLots || a.managerId - b.managerId)
    .map((group) => ({
      managerId: group.managerId,
      name: group.name,
      clientCount: group.clientCount,
      tradingClientCount: group.tradingClientCount,
      lots: round2(group.lots),
      stocksLots: round2(group.stocksLots),
      cfdLots: round2(group.cfdLots),
      commissionUsd: round2(commissionOf(group.cfdLots)),
      ...(includeRevenue
        ? {
            revenueUsd: round2(group.revenueUsd),
            marginAfterCommissionUsd: round2(group.revenueUsd - commissionOf(group.cfdLots)),
          }
        : {}),
      clients: group.clients
        .sort((a, b) => b.cfdLots - a.cfdLots || a.crmUserId - b.crmUserId)
        .map((client) => ({
          crmUserId: client.crmUserId,
          name: client.name,
          logins: [...client.logins].sort(),
          lots: round2(client.lots),
          stocksLots: round2(client.stocksLots),
          cfdLots: round2(client.cfdLots),
          commissionUsd: round2(commissionOf(client.cfdLots)),
          ...(includeRevenue
            ? {
                revenueUsd: round2(client.revenueUsd),
                marginAfterCommissionUsd: round2(client.revenueUsd - commissionOf(client.cfdLots)),
                // The join is unverified (§5 says one row per CRM client, yet
                // the row carries a login), so every client says out loud
                // whether a revenue row was found for it and how many.
                revenueMatched: client.revenueRowCount > 0,
                revenueRowCount: client.revenueRowCount,
              }
            : {}),
        })),
    }));

  const totalCfdLots = [...groups.values()].reduce((sum, g) => sum + g.cfdLots, 0);
  const totalRevenueUsd = [...groups.values()].reduce((sum, g) => sum + g.revenueUsd, 0);

  const join = {
    volumeRowCount,
    volumeRowsMatched,
    // Not called "unknown": the ClientVolume call returns the whole book, so
    // most unmatched rows are simply another manager's clients. Claiming they
    // were unrecognised would invent an alarm.
    volumeRowsOutOfScope: volumeRowCount - volumeRowsMatched,
    clientsWithNoActivity,
    warnings: [],
  };
  if (includeRevenue) {
    join.revenueRowCount = revenueRowCount;
    join.revenueRowsMatched = revenueRowsMatched;
    join.revenueRowsNotMatchedToScope = revenueRowCount - revenueRowsMatched;
    join.clientsMissingRevenue = clientsMissingRevenue;
    join.clientsWithMultipleRevenueRows = clientsWithMultipleRevenueRows;
    if (clientsMissingRevenue > 0) {
      join.warnings.push(
        `${clientsMissingRevenue} client(s) traded CFD lots but matched no revenue row; their revenue reads 0 and the margin beside it is understated.`,
      );
    }
    if (clientsWithMultipleRevenueRows > 0) {
      join.warnings.push(
        `${clientsWithMultipleRevenueRows} client(s) matched more than one revenue row. The revenue table is documented as one row per CRM client, so these are summed -- verify against DealMatch before trusting the figure.`,
      );
    }
  }

  return {
    scope: scope.kind,
    ...(scope.kind === "self" ? { managerId: scope.managerIds[0] } : {}),
    range: { from: range.from, to: range.to },
    rate: { usdPerCfdLot: COMMISSION_USD_PER_CFD_LOT, basis: COMMISSION_BASIS_FIELD },
    totals: {
      lots: round2([...groups.values()].reduce((sum, g) => sum + g.lots, 0)),
      stocksLots: round2([...groups.values()].reduce((sum, g) => sum + g.stocksLots, 0)),
      cfdLots: round2(totalCfdLots),
      commissionUsd: round2(commissionOf(totalCfdLots)),
      ...(includeRevenue
        ? {
            revenueUsd: round2(totalRevenueUsd),
            marginAfterCommissionUsd: round2(totalRevenueUsd - commissionOf(totalCfdLots)),
          }
        : {}),
    },
    salespeople,
    join,
    ...(includeRevenue
      ? { revenue: { available: true } }
      : scope.kind === "all"
        // Only the elevated caller is ever told that revenue is missing. For a
        // sales caller there is no key here at all -- not null, not false --
        // because "revenue: unavailable" is still a statement about revenue.
        ? { revenue: { available: false, reason: String(revenue?.reason || "unavailable") } }
        : {}),
  };
}
