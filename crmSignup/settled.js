/**
 * The statuses that mean a destination is finished with, written once.
 *
 * Two layers read this and they must not drift. worker.js decides from it
 * whether a step is still its to attempt, and whether a row's three are all
 * done; store.js builds the scrub's own SQL precondition from it. A status
 * present in one copy and missing from the other would be silent in exactly the
 * direction that costs: the worker would attempt a scrub the statement refuses,
 * and the row would keep its client data until the thirty-day backstop, with
 * nothing anywhere saying so.
 *
 * `pending` and `retrying` are the only two absent, which is why claimClause can
 * name them as the complement rather than negating this list.
 */
export const SETTLED_STATUSES = ["sent", "skipped", "rejected", "failed", "invalid"];

/** The same list as a set, for the reads that happen per row per sweep. */
export const SETTLED = new Set(SETTLED_STATUSES);
