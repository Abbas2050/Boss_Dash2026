import { maskEmail } from "./normalise.js";
// The one list of destinations, shared with the statements that build column
// names out of it. Imported rather than injected or restated: two copies of
// three strings is exactly the kind of list that drifts, and the route refusing
// a destination the store would accept (or the other way round) is a 400 or a
// 500 nobody can explain.
import { DESTINATIONS } from "./store.js";

/**
 * POST /api/crm-events/requeue  { "destination": "brevo" }
 *
 * The settings tab's one write. Everything else in this module is driven by
 * FXBO or by a clock; this is the single action a person takes, and it ends in
 * messages going out to clients, so it is admin-gated, it is logged, and the
 * count is shown before it is pressed.
 *
 * Bulk and per destination (2026-10-14, user's call). The destination is a body
 * parameter for the same reason the webhook's stage is: paths are what the
 * public allow-list is matched against, and this route is deliberately NOT on
 * that list -- it is session-gated by design, and the list is capped at six
 * entries for FXBO's sake.
 *
 * The answer carries both numbers. `requeued` is what the statement matched;
 * `alreadyScrubbed` is the rest of the destination's failures, whose client data
 * the thirty-day backstop has taken and which can therefore never be resent.
 * Without the second number an operator who can see 40 failures on the card and
 * gets 12 resends has to guess at the other 28.
 */
export function makeCrmEventsRequeueHandler({
  canManage,
  requeue,
  count,
  kick,
  logger = console,
}) {
  const required = { canManage, requeue, count, kick };
  for (const [name, fn] of Object.entries(required)) {
    if (typeof fn !== "function") throw new TypeError(`makeCrmEventsRequeueHandler: ${name} is required`);
  }

  return async function crmEventsRequeueHandler(req, res) {
    if (!canManage(req?.auth)) return res.status(403).json({ error: "forbidden" });

    // Refused, never defaulted. A typo that quietly became "meta" would requeue
    // the wrong destination, and the one the operator meant would stay failed
    // while the answer said it had been resent.
    const destination = String(req?.body?.destination ?? "").trim();
    if (!DESTINATIONS.includes(destination)) {
      return res.status(400).json({ error: "unknown_destination", destinations: DESTINATIONS });
    }

    let requeued;
    try {
      requeued = await requeue(destination);
    } catch (error) {
      // The message can name internal schema, so it is logged and not returned.
      logger.error?.(`[crm-events] requeue failed for ${destination}: ${error?.message || String(error)}`);
      return res.status(500).json({ error: "requeue_failed" });
    }

    // Asked AFTER the requeue, and that is not a race: the statement only ever
    // touches rows where `scrubbed_at IS NULL`, so it cannot change the number of
    // scrubbed failures. A read that fails here must not turn a requeue that
    // happened into a 500 -- the rows are already pending and the sends are about
    // to go out -- so the shortfall is reported as unknown instead.
    let alreadyScrubbed = null;
    try {
      alreadyScrubbed = (await count())?.[destination]?.scrubbed ?? null;
    } catch (error) {
      logger.error?.(`[crm-events] requeue counted nothing for ${destination}: ${error?.message || String(error)}`);
    }

    // The audit trail. This action sends messages to clients, so who asked for it
    // is part of the record -- it goes to the iisnode stdout log that CUTOVER
    // step 2 reads. No client data in the line: the actor is the session's own
    // user id, and their address is masked like every other address this module
    // logs. Nothing here is a client's.
    logger.log?.(
      `[crm-events] requeue by user=${String(req?.auth?.sub ?? "unknown")} ` +
        `(${maskEmail(req?.auth?.email) || "no address"}): destination=${destination} ` +
        `requeued=${requeued} already_scrubbed=${alreadyScrubbed}`
    );

    // So the sends go now rather than up to a sweep later: the operator is
    // watching the tab. Skipped only on a hard zero -- a store that reported no
    // count at all returns null, and reading that as "nothing to send" would
    // leave the rows for the timer with nothing saying why.
    if (requeued !== 0) {
      try {
        kick();
      } catch (error) {
        // The rows ARE pending. The next sweep takes them, so a failed kick is
        // worth a line and is not worth failing the answer over.
        logger.error?.(`[crm-events] requeue could not kick the worker: ${error?.message || String(error)}`);
      }
    }

    return res.status(200).json({ destination, requeued, alreadyScrubbed });
  };
}
