/**
 * GET /api/sales/commission?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * What each salesperson earned at $1 per realized CFD/FX lot, and -- for a
 * Super Admin only -- what the company earned from the clients that commission
 * was paid on.
 *
 * A factory taking its three fetches as dependencies, following
 * crmSignup/overviewRoute.js. That is what lets the whole of this file be
 * tested without a port, a database, a CRM token or Express: the tests pass
 * fakes and assert on the object handed to `res.json`.
 *
 * WHY THIS IS A SERVER ROUTE AND NOT A UI FILTER (spec §4): roles and `access[]`
 * live in localStorage, so a salesperson can edit their own role, and the /api
 * proxy serves any client's data to any logged-in browser. Data a user may not
 * see is never sent to their browser -- and for revenue it is never even
 * fetched, because the DealMatch leg is skipped for a sales caller.
 */

import { buildCommissionReport, resolveCommissionScope, resolveRange } from "./commissionCore.js";

export function makeSalesCommissionHandler({
  fetchSalesClients,
  fetchClientVolume,
  fetchClientRevenue,
  now = () => new Date(),
  logger = console,
}) {
  const deps = { fetchSalesClients, fetchClientVolume, fetchClientRevenue };
  for (const [name, dep] of Object.entries(deps)) {
    if (typeof dep !== "function") throw new TypeError(`makeSalesCommissionHandler: ${name} is required`);
  }

  return async function salesCommissionHandler(req, res) {
    // `req.auth` and nothing else. authRequired has verified the JWT signature
    // and re-read the user's role and crmManagerId from the database by the
    // token's `sub`, so this cannot be influenced by a query parameter, a
    // header or a body -- which is the whole point of the endpoint.
    const scope = resolveCommissionScope(req?.auth);
    if (scope.kind === "denied") return res.status(403).json({ error: "forbidden" });

    const range = resolveRange(req?.query, now());
    if (range.error) return res.status(400).json({ error: range.error });

    // All legs START before any of them is awaited. DealMatch/Run costs ~40s
    // whatever window it is asked for, so serialising these would add that 40s
    // to the CRM and ClientVolume legs rather than hiding behind them. Each
    // fetch carries its own timeout (see commissionSources.js); allSettled is
    // what lets the revenue leg fail on its own.
    const pending = [
      fetchSalesClients({ managerIds: scope.managerIds }),
      fetchClientVolume({ from: range.from, to: range.to }),
      // Not fetched at all for a sales caller.
      scope.includeRevenue ? fetchClientRevenue({ from: range.from, to: range.to }) : Promise.resolve(null),
    ];
    const [crmResult, volumeResult, revenueResult] = await Promise.allSettled(pending);

    // The CRM leg decides WHOSE clients these are. Without it there is no
    // scope, so there is no degraded answer to give -- a page of zeroes would
    // be read as "nobody traded", and a zero is indistinguishable from a real
    // figure. Same for ClientVolume, which is the commission basis itself.
    if (crmResult.status === "rejected") {
      logger.warn?.(`[sales] CRM client lookup failed: ${reason(crmResult)}`);
      return res.status(502).json({ error: "crm_unavailable" });
    }
    if (volumeResult.status === "rejected") {
      logger.warn?.(`[sales] ClientVolume/Run failed: ${reason(volumeResult)}`);
      return res.status(502).json({ error: "volume_unavailable" });
    }

    // Revenue is the one leg allowed to fail. Commission comes from cfdLots and
    // never from this, so a dead DealMatch degrades the page to the commission
    // columns and SAYS SO, rather than failing a payout report over a figure
    // only two people can see anyway.
    let revenue = { available: false, reason: "unavailable" };
    const degraded = [];
    if (scope.includeRevenue) {
      if (revenueResult.status === "fulfilled") {
        revenue = { available: true, rows: revenueResult.value?.rows ?? [] };
      } else {
        logger.warn?.(`[sales] DealMatch/Run failed: ${reason(revenueResult)}`);
        revenue = { available: false, reason: "fetch_failed" };
        degraded.push("revenue");
      }
    }

    const report = buildCommissionReport({
      scope,
      range,
      clients: crmResult.value?.clients ?? [],
      accounts: crmResult.value?.accounts ?? [],
      volumeRows: volumeResult.value?.rows ?? [],
      volumeWindow: volumeResult.value?.window ?? null,
      revenue,
    });

    // `degraded` is only ever non-empty for the elevated caller, and for a sales
    // caller it is an empty array rather than absent so the page has one shape
    // to render.
    return res.status(200).json({ ...report, degraded });
  };
}

// The upstream message can name an internal host or echo a CRM error body, so
// it is logged and never returned. It never contains a token: crmPost and
// backendFetch put the credential in a header, not in the URL or the message.
function reason(settled) {
  const error = settled?.reason;
  return error instanceof Error ? error.message : String(error);
}
