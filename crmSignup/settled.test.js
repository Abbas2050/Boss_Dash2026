// @vitest-environment node
//
// Two sets of statuses that answer two different questions, and the whole point
// of this file is that reading one where the other belongs is silent. SETTLED is
// "do not attempt this action again"; SCRUBBABLE is "this row is safe to
// forget". The mistakes fail in opposite directions and only one of them is
// recoverable: the wide set at the scrub destroys the client data a failed send
// would be resent from, while the narrow set at the step skip re-sends a message.
import { describe, it, expect } from "vitest";
import { SETTLED, SETTLED_STATUSES, SCRUBBABLE, SCRUBBABLE_STATUSES } from "./settled.js";

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
