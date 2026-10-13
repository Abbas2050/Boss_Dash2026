import { newestReceivedAt, summariseCrmEvents, toTableRow } from "./stats.js";

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 90;

function windowDays(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(n)));
}

/**
 * GET /api/crm-events/overview?days=30
 *
 * Everything the settings tab needs in one call, from three reads:
 *   listSince(since, tableLimit)  the newest rows in the window, capped in SQL. Table only.
 *   countSince(since)             grouped counts over the whole window, never capped.
 *   latestReceivedAt()            the newest event in the whole table, ignoring the window.
 *
 * Counts and the table follow the window. Health does not: a one-day window must
 * not make an event from thirty hours ago look like silence.
 */
export function makeCrmEventsOverviewHandler({
  canManage,
  listSince,
  countSince,
  latestReceivedAt,
  tableLimit = 200,
  now = () => new Date(),
  logger = console,
}) {
  return async function crmEventsOverviewHandler(req, res) {
    if (!canManage(req?.auth)) return res.status(403).json({ error: "forbidden" });

    const days = windowDays(req?.query?.days);
    const at = now();
    const since = new Date(at.getTime() - days * 24 * 3_600_000);

    let rows;
    let counted;
    let latest;
    try {
      rows = await listSince(since, tableLimit);
      // Without a grouped count the rows are counted, which is only as complete as the rows.
      counted = countSince ? await countSince(since) : rows;
      latest = latestReceivedAt ? await latestReceivedAt() : newestReceivedAt(rows);
    } catch (error) {
      // The message can name internal schema, so it is logged, not returned.
      logger.error?.(`[crm-events] overview failed: ${error?.message || String(error)}`);
      return res.status(500).json({ error: "overview_failed" });
    }

    const { health, funnel, destinations } = summariseCrmEvents(counted, { now: at, latestReceivedAt: latest });

    return res.status(200).json({
      windowDays: days,
      health,
      funnel,
      destinations,
      events: rows.slice(0, tableLimit).map(toTableRow),
    });
  };
}
