/**
 * Two sets of statuses, and they are not the same question.
 *
 * SETTLED answers "do not attempt this action again". SCRUBBABLE answers "this
 * row is safe to forget". A destination that was refused or that failed is
 * finished with -- nothing will attempt it again -- but it is NOT safe to
 * forget: the client data is what a resend would need once the cause is fixed.
 * So `rejected`, `failed` and `invalid` are settled and not scrubbable, and the
 * two sets have to be read for the question each answers.
 *
 * The two mistakes fail in opposite directions, and only one of them is
 * recoverable:
 *
 *   SETTLED where SCRUBBABLE belongs DESTROYS DATA. A misconfigured destination
 *   is scrubbed the minute it fails, and the name, email and phone a resend
 *   needs are gone for good -- which is the gap this distinction closes
 *   (2026-10-14, user's call).
 *
 *   SCRUBBABLE where SETTLED belongs RE-SENDS. A `rejected` or `failed` action
 *   reads as unfinished, the worker claims it again, and the client gets a
 *   second WhatsApp welcome -- the one message with no dedupe behind it.
 *
 * Three layers read these and they must not drift. worker.js reads SETTLED to
 * decide whether a step is still its to attempt, and SCRUBBABLE to decide
 * whether to try the scrub; store.js builds the scrub's own SQL precondition
 * from SCRUBBABLE and the backstop's "still unsent" clause from SETTLED. A
 * status present in one copy and missing from the other would be silent in
 * exactly the direction that costs: the worker would attempt a scrub the
 * statement refuses, and the row would keep its client data until the thirty-day
 * backstop, with nothing anywhere saying so.
 *
 * `pending` and `retrying` are the only two absent from SETTLED, which is why
 * claimClause can name them as the complement rather than negating that list.
 */
export const SETTLED_STATUSES = ["sent", "skipped", "rejected", "failed", "invalid"];

/** The same list as a set, for the reads that happen per row per sweep. */
export const SETTLED = new Set(SETTLED_STATUSES);

/**
 * The statuses that make a row safe to forget: the send succeeded, or there was
 * deliberately nothing to send.
 *
 * Narrower than SETTLED on purpose. A row with a `failed` or `rejected`
 * destination keeps its client data so the cause can be fixed and the send
 * retried; the thirty-day backstop is what bounds that, so a destination nobody
 * ever fixes still does not leave this table a permanent store of client data
 * (2026-10-14, user's call -- the bound was accepted with the decision).
 *
 * `invalid` is absent and that changes nothing about those rows: an invalid row
 * is invalid in all three columns, it never sent anything and never will, and
 * the 7-day delete takes it whole rather than scrubbing it.
 */
export const SCRUBBABLE_STATUSES = ["sent", "skipped"];

/** The same list as a set, read once per row per sweep like SETTLED above. */
export const SCRUBBABLE = new Set(SCRUBBABLE_STATUSES);

/**
 * The statuses a bulk resend may put back to `pending` (2026-10-14, user's
 * call).
 *
 * The third question, and it is not either of the two above: "may an operator
 * ask for this one to be attempted again". Keeping the client data on a failure
 * only made the resend possible; this is what the resend is allowed to touch.
 *
 * `rejected` is in deliberately. A rejection is the provider refusing the
 * request, which sounds like the one thing not worth repeating -- but Brevo's
 * 400 for an attribute that does not exist yet is a `rejected` that succeeds the
 * moment the attribute is created, and that is the commonest reason anybody
 * clicks this. The operator clicks after fixing something, and the system is in
 * no position to second-guess which of the two they fixed.
 *
 * `sent` and `skipped` are out, and that is the direction that matters: a resend
 * that picked up a `sent` row would deliver a second welcome to someone who
 * already got one, which is the one message with nothing deduplicating it. So
 * this list is strictly the complement of SCRUBBABLE within SETTLED, minus
 * `invalid`.
 *
 * `invalid` is out as well, and for its own reason: an invalid row is invalid in
 * all three columns because the payload could not be read or it was an FXBO test
 * press. There is nothing to send from it, and the 7-day delete takes it whole.
 */
export const REQUEUEABLE_STATUSES = ["failed", "rejected"];

/** The same list as a set, for the reader that counts what is resendable. */
export const REQUEUEABLE = new Set(REQUEUEABLE_STATUSES);

/**
 * The three statuses that are the whole difference between the two sets: a
 * destination that went wrong, and whose client data is therefore kept.
 *
 * Checked here, at import, and not only in a test: the two lists above are one
 * keystroke apart and opposite in consequence, and a `failed` that found its way
 * into SCRUBBABLE would scrub every recoverable row with nothing anywhere
 * saying so. This refuses the drift at the first import instead -- the worker,
 * the store and every test in the module read this file. It names only the
 * statuses that decide the question, so a sixth status added later trips nothing
 * it should not.
 */
const ERRORED_STATUSES = ["rejected", "failed", "invalid"];

for (const status of ERRORED_STATUSES) {
  if (!SETTLED.has(status)) {
    throw new Error(`settled.js: '${status}' is terminal and must be in SETTLED_STATUSES`);
  }
  if (SCRUBBABLE.has(status)) {
    throw new Error(
      `settled.js: '${status}' must NOT be in SCRUBBABLE_STATUSES -- a row that went wrong keeps its ` +
        `client data so the cause can be fixed and the send retried`
    );
  }
}

for (const status of ["sent", "skipped"]) {
  if (!SETTLED.has(status) || !SCRUBBABLE.has(status)) {
    throw new Error(
      `settled.js: '${status}' is a success or a deliberate skip and must be in BOTH lists -- dropped from ` +
        `SCRUBBABLE_STATUSES no row would ever scrub, dropped from SETTLED_STATUSES it would be sent again`
    );
  }
  if (REQUEUEABLE.has(status)) {
    throw new Error(
      `settled.js: '${status}' must NOT be in REQUEUEABLE_STATUSES -- a bulk resend would deliver a second ` +
        `WhatsApp welcome to a client who already received one, and nothing deduplicates that message`
    );
  }
}

for (const status of REQUEUEABLE_STATUSES) {
  // Requeueing something the worker would have attempted anyway is not a resend,
  // it is a race: the row is already claimable, and setting its attempt count
  // back to 0 under a sweeper that is mid-send would hand it a fresh budget.
  if (!SETTLED.has(status)) {
    throw new Error(
      `settled.js: '${status}' is requeueable but not in SETTLED_STATUSES -- only an action nothing will ` +
        `attempt again needs an operator to ask for it`
    );
  }
}
