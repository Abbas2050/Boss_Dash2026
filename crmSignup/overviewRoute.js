import { summariseCrmEvents, toTableRow } from "./stats.js";

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 90;

function windowDays(raw) {
  // A blank value is an absent one. `?days=` arrives as "", Number("") is 0, and
  // 0 is finite -- so without this the clamp turned it into a ONE-day window and
  // the tab reported a day's funnel as though it were the default month.
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(n)));
}

/**
 * GET /api/crm-events/overview?days=30
 *
 * Everything the settings tab needs in one call, from five reads. All five are
 * required: a missing read would fall back to the rows it was given, and the
 * counts would undercount with no sign of it -- or, for the last of them, the
 * resend control would promise nothing while forty failures waited.
 *
 *   listSince(since, tableLimit)  the newest rows in the window, capped in SQL. Table only.
 *   countSince(since)             grouped counts over the whole window, never capped.
 *   latestReceivedAt()            the newest event in the whole table, ignoring the window.
 *   latestByStage()               the newest event per stage, whole table. A stage with no
 *                                 row has never fired, and is not the same as one gone quiet.
 *   countResendable()             per destination, how many failures the requeue would match
 *                                 and the two reasons it no longer can -- `scrubbed` and, for
 *                                 OpenAI, `expired`. Whole table, like health.
 *
 * Counts and the table follow the window. Health does not: a one-day window must
 * not make an event from thirty hours ago look like silence. Nor does the
 * resendable count, and that is the point of it: the resend is not windowed, so
 * the per-destination counters beside it -- which are, and which count scrubbed
 * rows -- cannot be what the resend control promises.
 */
export function makeCrmEventsOverviewHandler({
  canManage,
  listSince,
  countSince,
  latestReceivedAt,
  latestByStage,
  countResendable,
  tableLimit = 200,
  now = () => new Date(),
  logger = console,
}) {
  const reads = { listSince, countSince, latestReceivedAt, latestByStage, countResendable };
  for (const [name, read] of Object.entries(reads)) {
    if (typeof read !== "function") throw new TypeError(`makeCrmEventsOverviewHandler: ${name} is required`);
  }

  return async function crmEventsOverviewHandler(req, res) {
    if (!canManage(req?.auth)) return res.status(403).json({ error: "forbidden" });

    const days = windowDays(req?.query?.days);
    const at = now();
    const since = new Date(at.getTime() - days * 24 * 3_600_000);

    let rows;
    let counted;
    let latest;
    let byStage;
    let resendable;
    try {
      rows = await listSince(since, tableLimit);
      counted = await countSince(since);
      latest = await latestReceivedAt();
      byStage = await latestByStage();
      resendable = await countResendable();
    } catch (error) {
      // The message can name internal schema, so it is logged, not returned.
      logger.error?.(`[crm-events] overview failed: ${error?.message || String(error)}`);
      return res.status(500).json({ error: "overview_failed" });
    }

    const { health, funnel, destinations } = summariseCrmEvents(counted, {
      now: at,
      latestReceivedAt: latest,
      latestByStage: byStage,
    });

    return res.status(200).json({
      windowDays: days,
      health,
      funnel,
      destinations,
      // Separate from `destinations` on purpose, and not folded into those
      // counters: they are the window's and they count scrubbed rows, while this
      // is what the resend control may promise.
      //
      // Passed through whole rather than picked apart, because the three numbers
      // per destination are one statement's single snapshot and have to stay
      // one: `resendable + scrubbed + expired` is every failure a destination
      // has, and that is the arithmetic the card prints. Dropping `expired`
      // here would leave OpenAI's card short by the rows OpenAI itself refuses
      // on their age, with nothing on the page to account for the difference.
      requeue: resendable,
      events: rows.slice(0, tableLimit).map(toTableRow),
    });
  };
}
