/**
 * The three network legs behind GET /api/sales/commission.
 *
 * Separated from commissionRoute.js so the route's rules can be tested with
 * fakes, and so importing those tests does not drag in reportShared.js (and
 * with it the chart renderer and node-cron) for arithmetic that needs none of
 * it. This module is wired into the route in server.js and nowhere else.
 *
 * TWO DIFFERENT SYSTEMS, TWO DIFFERENT CREDENTIALS -- and they have been
 * confused before, which is why crmSignup/depositValue.js carries the same
 * warning:
 *
 *   FXBO / the CRM    REST_PROXY_TARGET + API_TOKEN + API_VERSION, via crmPost.
 *                     Knows which client belongs to which salesperson.
 *   The trading API   api.skylinkscapital.com + BACKEND_API_KEY, via backendFetch.
 *                     Knows lots and revenue. 401s without the Bearer.
 *
 * Sending either secret to the other company is the failure this comment
 * exists to prevent.
 */

import { backendFetch, crmConfigured, crmPost } from "../reports/reportShared.js";
import {
  clientVolumeQuery,
  dealMatchQuery,
  salesAccountsPayload,
  salesUsersPayload,
  toManagerId,
} from "./commissionCore.js";

// ── budgets ─────────────────────────────────────────────────────────────────
// Every call is bounded, for the reason crmSignup/sendTimeout.js gives: Node's
// native fetch has no timeout, so a stalled connection waits forever -- and
// here it would hold an HTTP request open until the IIS worker recycled.
//
// The numbers differ because the endpoints do. The CRM searches answer in well
// under a second; ClientVolume/Run is a few seconds for a month; DealMatch/Run
// costs ~40s regardless of range and has been measured above a whole minute for
// a week, which is why the weekly report gives it 180s and so does this.
export const CRM_TIMEOUT_MS = 45_000;
export const CLIENT_VOLUME_TIMEOUT_MS = 60_000;
export const DEAL_MATCH_TIMEOUT_MS = 180_000;

// FXBO pages its searches through `segment`. The page size is large because the
// three books together are a few thousand clients at most, and MAX_PAGES exists
// because the loop's exit condition is "a short page": if FXBO ever ignored
// `segment` it would return the same full page forever and this would not
// return at all. src/lib/api.ts's fetchAllUsers has exactly that hole.
export const CRM_PAGE_SIZE = 1000;
export const CRM_MAX_PAGES = 25;
// How many client ids go into one account search. Mirrors USER_BATCH in
// reports/summaryCore.js.
export const ACCOUNT_ID_BATCH = 200;

async function crmPages(path, buildPayload) {
  const rows = [];
  for (let page = 0; page < CRM_MAX_PAGES; page += 1) {
    const payload = buildPayload({ limit: CRM_PAGE_SIZE, offset: page * CRM_PAGE_SIZE });
    const batch = await crmPost(path, payload, { timeoutMs: CRM_TIMEOUT_MS });
    rows.push(...batch);
    if (batch.length < CRM_PAGE_SIZE) return rows;
  }
  // Loud, not silent: a truncated client list would quietly underpay whoever
  // fell off the end.
  throw new Error(`CRM /rest/${path} returned more than ${CRM_MAX_PAGES * CRM_PAGE_SIZE} rows; refusing a truncated book`);
}

/**
 * Which clients belong to these salespeople, and the MT5 logins of each.
 *
 * TWO CALLS, not one. FXBO's `/rest/users` record carries `managerId` but no
 * logins (see the `User` interface in src/lib/api.ts) -- logins live on
 * `/rest/accounts`, which carries `userId` and `login`. The design document
 * says `/rest/users` gives "their MT5 logins"; it does not, and the accounts
 * call is how reports/dealMatchWeeklyReport.js already resolves a login to a
 * CRM client.
 *
 * The `managerIds` filter is sent AND the result is filtered again by
 * `commissionCore.buildCommissionReport`. `managerIds` is not part of the typed
 * UserRequest shape, so whether FXBO honours it is unverified; if it ignores
 * the filter this call is merely expensive rather than wrong.
 */
export async function fetchSalesClients({ managerIds }) {
  if (!crmConfigured()) throw new Error("API_TOKEN is not set, so the CRM cannot be asked");

  const wanted = new Set(managerIds.map((id) => toManagerId(id)).filter((id) => id !== null));
  if (wanted.size === 0) return { clients: [], accounts: [] };

  const users = await crmPages("users", ({ limit, offset }) =>
    salesUsersPayload({ managerIds: [...wanted], limit, offset }),
  );

  const clients = [];
  for (const user of users) {
    const userId = Number(user?.id);
    const managerId = toManagerId(user?.managerId);
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (managerId === null || !wanted.has(managerId)) continue;
    clients.push({
      userId,
      managerId,
      // Name only. `user` also holds email and phone; nothing downstream needs
      // either, and neither is logged or returned.
      name: [user?.firstName, user?.lastName].map((p) => String(p || "").trim()).filter(Boolean).join(" "),
    });
  }

  const accounts = [];
  const ids = clients.map((c) => c.userId);
  for (let i = 0; i < ids.length; i += ACCOUNT_ID_BATCH) {
    const batch = ids.slice(i, i + ACCOUNT_ID_BATCH);
    const rows = await crmPages("accounts", ({ limit, offset }) =>
      salesAccountsPayload({ userIds: batch, limit, offset }),
    );
    for (const row of rows) {
      accounts.push({
        login: row?.login,
        userId: Number(row?.userId),
        group: String(row?.group || ""),
      });
    }
  }

  return { clients, accounts };
}

/**
 * `byClient[]` from ClientVolume/Run: realized lots per MT5 login, split into
 * `stocksLots` and `cfdLots`.
 *
 * ONE call returns every client, so there is no per-login fan-out. `cfdLots` is
 * the commission basis; `lots` and `stocksLots` ride along only so the page can
 * explain why a share-trading client earned their salesperson nothing.
 */
export async function fetchClientVolumeByClient({ from, to }) {
  const resp = await backendFetch(`/ClientVolume/Run?${clientVolumeQuery({ from, to })}`, {
    timeoutMs: CLIENT_VOLUME_TIMEOUT_MS,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ClientVolume/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const raw = await resp.json();
  const rows = Array.isArray(raw?.byClient) ? raw.byClient : [];
  // `byInternalAccount` is deliberately not merged in: internal accounts are a
  // parallel bucket, not clients (docs/dealing-reporting.md §4), and nobody is
  // paid commission on the firm's own flow.
  return {
    // The window the backend says it answered, carried back so the response can
    // show it. §2 records this endpoint returning SIX days for a seven-day week
    // (25 Jul missing for 20–26 Jul) and the question is still open. A dropped
    // day is a day of somebody's lots, so the figure must not be the only thing
    // on the page: if the echoed dates disagree with the ones we asked for, the
    // join says so.
    window: {
      fromDate: String(raw?.fromDate || ""),
      toDate: String(raw?.toDate || ""),
      activeDays: Number(raw?.activeDays) || 0,
    },
    rows: rows.map((row) => ({
      login: row?.login,
      name: String(row?.name || ""),
      group: String(row?.group || ""),
      lots: Number(row?.lots) || 0,
      stocksLots: Number(row?.stocksLots) || 0,
      cfdLots: Number(row?.cfdLots) || 0,
    })),
  };
}

/**
 * `clientRevenueSummaries[]` from DealMatch/Run: `totalRevenueUsd` per client.
 *
 * `totalRevenueUsd` is passed through untouched. It is the backend's own figure
 * (markup + client commission + swap − LP commission) and must not be rebuilt
 * from its parts -- `markup + clientComm` drops swap, which on 2026-09-16 was
 * $20,313.91 of a $21,609.65 day (docs/dealing-reporting.md §5).
 */
export async function fetchClientRevenueSummaries({ from, to }) {
  const resp = await backendFetch(`/DealMatch/Run?${dealMatchQuery({ from, to })}`, {
    timeoutMs: DEAL_MATCH_TIMEOUT_MS,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DealMatch/Run HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const raw = await resp.json();
  const rows = Array.isArray(raw?.clientRevenueSummaries) ? raw.clientRevenueSummaries : [];
  return {
    rows: rows.map((row) => ({
      login: row?.login,
      totalRevenueUsd: Number(row?.totalRevenueUsd) || 0,
    })),
  };
}
