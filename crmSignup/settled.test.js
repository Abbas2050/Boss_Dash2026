// @vitest-environment node
//
// Two sets of statuses that answer two different questions, and the whole point
// of this file is that reading one where the other belongs is silent. SETTLED is
// "do not attempt this action again"; SCRUBBABLE is "this row is safe to
// forget". The mistakes fail in opposite directions and only one of them is
// recoverable: the wide set at the scrub destroys the client data a failed send
// would be resent from, while the narrow set at the step skip re-sends a message.
import { describe, it, expect } from "vitest";
import {
  SETTLED,
  SETTLED_STATUSES,
  SCRUBBABLE,
  SCRUBBABLE_STATUSES,
  REQUEUEABLE,
  REQUEUEABLE_STATUSES,
} from "./settled.js";

describe("SETTLED: do not attempt this action again", () => {
  it("is every status except pending and retrying", () => {
    // claimClause names `pending` and `retrying` as the complement rather than
    // negating this list, so a status added here that is also claimable would make
    // the two disagree.
    expect(SETTLED_STATUSES).toEqual(["sent", "skipped", "rejected", "failed", "invalid"]);
    expect(SETTLED.has("pending")).toBe(false);
    expect(SETTLED.has("retrying")).toBe(false);
  });
});

describe("SCRUBBABLE: this row is safe to forget", () => {
  it("is successes and deliberate skips, and nothing else", () => {
    // 2026-10-14, user's call. A row becomes scrubbable only once every
    // destination either succeeded or was deliberately skipped.
    expect(SCRUBBABLE_STATUSES).toEqual(["sent", "skipped"]);
  });

  it("excludes the three statuses whose rows have to stay recoverable", () => {
    // `rejected` and `failed` are the gap this closes: a destination that was
    // misconfigured -- an unusable BREVO_LIST_ID, say -- fails every row, and
    // scrubbing on settle made those clients permanently unrecoverable, because
    // the name, email and phone a resend needs were gone. The thirty-day backstop
    // still takes such a row, so this does not become a permanent store.
    //
    // `invalid` is excluded too and that changes nothing about those rows: an
    // invalid row is invalid in all three columns, it never sent anything and
    // never will, and the 7-day delete takes it whole rather than scrubbing it.
    for (const status of ["rejected", "failed", "invalid"]) {
      expect(SCRUBBABLE.has(status), status).toBe(false);
      expect(SETTLED.has(status), status).toBe(true);
    }
  });

  it("is a strict subset of SETTLED, never the other way about", () => {
    // A scrubbable status that was not settled would be scrubbed while an attempt
    // was still ahead of it: the retry would read a nulled phone number and send
    // a nameless template to nobody.
    for (const status of SCRUBBABLE_STATUSES) expect(SETTLED.has(status), status).toBe(true);
    expect(SCRUBBABLE_STATUSES.length).toBeLessThan(SETTLED_STATUSES.length);
  });

  it("refuses the drift at import rather than waiting for a deploy", async () => {
    // The two lists are one keystroke apart and opposite in consequence, so
    // settled.js checks the relation when it loads: the worker, the store and
    // every test in the module import it. This is that check, read back.
    const source = (await import("node:fs")).readFileSync(new URL("./settled.js", import.meta.url), "utf8");
    expect(source).toMatch(/throw new Error\(/);
    // Each half of the invariant, named: the error statuses must not be
    // scrubbable, and the two good ones must be in both lists.
    expect(source).toMatch(/if \(SCRUBBABLE\.has\(status\)\)/);
    expect(source).toMatch(/if \(!SETTLED\.has\(status\) \|\| !SCRUBBABLE\.has\(status\)\)/);
  });
});

describe("REQUEUEABLE: an operator may ask for this one again", () => {
  it("is the two statuses a bulk resend may put back to pending", () => {
    // 2026-10-14, user's call. `failed` and `rejected`, and nothing else.
    expect(REQUEUEABLE_STATUSES).toEqual(["failed", "rejected"]);
  });

  it("includes rejected, because a rejection can stop being one", () => {
    // Brevo answers 400 for an attribute that does not exist yet, which is
    // classified `rejected` -- and it succeeds the moment the attribute is
    // created. The operator presses this after fixing something, and the system
    // is in no position to second-guess which of the two they fixed, so it does
    // not try to.
    expect(REQUEUEABLE.has("rejected")).toBe(true);
    expect(REQUEUEABLE.has("failed")).toBe(true);
  });

  it("excludes sent and skipped, which is the direction that sends a second welcome", () => {
    // The one mistake this set can make. A `sent` row put back to `pending` is
    // claimed on the next sweep and the client gets their welcome message twice,
    // with nothing anywhere deduplicating it. A `skipped` row is a deliberate
    // decision not to send -- no key, or a stage the website pixel owns -- and
    // re-deciding that in bulk is not this action's business either.
    for (const status of SCRUBBABLE_STATUSES) expect(REQUEUEABLE.has(status), status).toBe(false);
  });

  it("excludes invalid, which has nothing to send", () => {
    // An invalid row is invalid in all three columns: the payload could not be
    // read, or it was an FXBO test press. Requeueing one would hand the
    // providers a payload we already know is unusable. The 7-day delete takes
    // those rows whole.
    expect(REQUEUEABLE.has("invalid")).toBe(false);
  });

  it("is settled statuses only, so nothing the worker would retry anyway is in it", () => {
    // `pending` and `retrying` are claimable already. Resetting the attempt count
    // under a sweeper that is mid-send is not a resend, it is a race that hands
    // the row a fresh budget.
    for (const status of REQUEUEABLE_STATUSES) expect(SETTLED.has(status), status).toBe(true);
    expect(REQUEUEABLE.has("pending")).toBe(false);
    expect(REQUEUEABLE.has("retrying")).toBe(false);
  });

  it("is exactly SETTLED minus SCRUBBABLE minus invalid, with no status unaccounted for", () => {
    // Every settled status is in one of the three buckets, and the three do not
    // overlap. A sixth status added later lands here rather than quietly
    // defaulting into whichever list someone edited first.
    const accounted = [...SCRUBBABLE_STATUSES, ...REQUEUEABLE_STATUSES, "invalid"].sort();
    expect(accounted).toEqual([...SETTLED_STATUSES].sort());
  });

  it("refuses a sent or skipped status in it at import, not at deploy", async () => {
    // The same guard the other two sets get, for the same reason: the lists are
    // one keystroke apart and this one's mistake delivers messages to clients.
    const source = (await import("node:fs")).readFileSync(new URL("./settled.js", import.meta.url), "utf8");
    expect(source).toMatch(/if \(REQUEUEABLE\.has\(status\)\)/);
    expect(source).toMatch(/for \(const status of REQUEUEABLE_STATUSES\)/);
  });
});
