// @vitest-environment node
//
// The SQL layer, run against a fake pool. A fake pool cannot tell us how MySQL
// behaves, but it does show which statement runs, which parameter binds to which
// placeholder, and how a duplicate-key error becomes a return value. Those are
// the things a careless edit to store.js would change silently.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
  SIGNUP_EVENTS_SCHEMA,
  INSERT_COLUMNS,
  buildInsertParams,
  initCrmSignupStore,
  findExistingFbc,
  insertSignupEvent,
  UNSTORABLE_KEY_CODE,
  claimDueEvents,
  updateMetaStatus,
  updateWhatsappStatus,
  updateBrevoStatus,
  listEventsSince,
  countEventsSince,
  latestEventReceivedAt,
  latestReceivedAtByStage,
  SCRUB_COLUMNS,
  SIGNUP_EVENTS_ADDED_COLUMNS,
  scrubSignupEvent,
  deleteInvalidSignupEvents,
  scrubStaleSignupEvents,
} from "./store.js";
// The two vocabularies the worker and these statements are built from, imported
// so a test can prove each statement names every value in the one it belongs to
// -- and none of the values in the other. The scrub is built from SCRUBBABLE
// ("this row is safe to forget"); the backstop's settle statements are built
// from SETTLED ("do not attempt this action again").
import { SETTLED_STATUSES, SCRUBBABLE_STATUSES } from "./settled.js";
// Imported for the one case that walks the whole leak path: Brevo's own 400,
// through its own classifier, into the column.
import { classifyBrevoOutcome } from "./brevo.js";

// The env vars are read when store.js loads, so they are set before the import.
// The values are throwaway: nothing here connects to anything.
const db = vi.hoisted(() => {
  process.env.AUTH_DB_HOST = "db.test";
  process.env.AUTH_DB_NAME = "crm_test";
  process.env.AUTH_DB_USER = "crm_test";
  process.env.AUTH_DB_PASSWORD = "test-only";
  const state = {
    calls: [],
    // mysql2 resolves [result, fields]; store.js destructures the first element.
    respond: () => [{ affectedRows: 1, insertId: 1 }],
  };
  const pool = {
    query: async (sql, params) => {
      state.calls.push({ sql, params });
      return state.respond(sql, params);
    },
  };
  // The options are kept because one of them matters: the claim reads
  // affectedRows, which counts matched rows only while FOUND_ROWS is on.
  return { state, pool };
});

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: (options) => {
      db.state.poolOptions = options;
      return db.pool;
    },
  },
}));

const FIELDS = {
  stage: "registered",
  crmClientId: "88214",
  firstName: "Ali",
  middleName: "Hassan",
  lastName: "Khan",
  email: "ali.khan@example.com",
  phone: "+971507192185",
  recordType: "client",
  marketingConsent: true,
  source: "SVG",
  entity: "SVG Ltd",
  isIb: false,
  language: "en",
  utmSource: "meta",
  utmMedium: "cpc",
  utmCampaign: "zero-spread",
  referer: "https://skylinkscapital.com/en/",
  fullLink: "https://skylinkscapital.com/en/?fbclid=ABC",
  fxboUniqueId: "d3f1-aa",
};

const at = (params, column) => params[INSERT_COLUMNS.indexOf(column)];
// received_at is stamped at call time, so two builds differ by milliseconds. Every
// other parameter is compared exactly.
const withoutClock = (params) => params.map((p, i) => (INSERT_COLUMNS[i] === "received_at" ? null : p));
const duplicateKeyError = () => Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });

let ddlCalls = [];

beforeAll(async () => {
  await initCrmSignupStore();
  ddlCalls = db.state.calls.splice(0);
});

beforeEach(() => {
  db.state.calls.length = 0;
  db.state.respond = () => [{ affectedRows: 1, insertId: 1 }];
});

describe("initCrmSignupStore", () => {
  it("creates the table from the schema text", () => {
    expect(ddlCalls[0].sql).toBe(SIGNUP_EVENTS_SCHEMA);
  });

  it("adds each later column, and the retention index, behind its own information_schema check", () => {
    // The table has never been deployed, so a new install gets all three from the
    // CREATE above and the guards find them present. A table someone created
    // while testing predates them: a missing scrubbed_at leaves the scrub nowhere
    // to record itself, and a missing is_lead_raw leaves CUTOVER step 5 nothing
    // to read. The fake pool reports no count, so every guard opens here.
    //
    // Each ALTER must sit immediately behind its own check, with the thing it
    // looks for as the parameter -- a check that asked about a different column
    // would pass a bare "an ALTER ran" assertion.
    let i = 1;
    for (const [column, statement] of SIGNUP_EVENTS_ADDED_COLUMNS) {
      expect(ddlCalls[i].sql, column).toMatch(/information_schema\.COLUMNS/i);
      expect(ddlCalls[i].sql, column).toMatch(/COLUMN_NAME = \?/);
      expect(ddlCalls[i].params, column).toEqual([column]);
      expect(ddlCalls[i + 1].sql, column).toBe(statement);
      i += 2;
    }
    expect(ddlCalls[i].sql).toMatch(/information_schema\.STATISTICS/i);
    expect(ddlCalls[i].params).toEqual(["idx_signup_events_retention"]);
    expect(ddlCalls[i + 1].sql).toBe(
      "ALTER TABLE signup_events ADD KEY idx_signup_events_retention (scrubbed_at, received_at)"
    );
    expect(ddlCalls).toHaveLength(i + 2);
  });

  it("adds nothing when information_schema says all three are already there", async () => {
    // The other half of the guard. `ALTER TABLE ... ADD COLUMN` on a column that
    // exists is an error, and an error at startup takes the store, the sweeper and
    // every webhook with it. A fresh module instance, because the real one has
    // already initialised.
    vi.resetModules();
    db.state.calls.length = 0;
    db.state.respond = (sql) =>
      /information_schema/i.test(sql) ? [[{ cnt: 1 }]] : [{ affectedRows: 1, insertId: 1 }];
    const fresh = await import("./store.js");
    await fresh.initCrmSignupStore();
    const sql = db.state.calls.map((c) => c.sql);
    expect(sql.filter((s) => /ALTER TABLE/i.test(s))).toEqual([]);
    // Still asked, once per column plus once for the index.
    expect(sql.filter((s) => /information_schema/i.test(s))).toHaveLength(SIGNUP_EVENTS_ADDED_COLUMNS.length + 1);
  });
});

describe("insertSignupEvent", () => {
  it("runs one plain INSERT with the builder's parameters, and reports the new id", async () => {
    db.state.respond = () => [{ affectedRows: 1, insertId: 42 }];
    const derived = { fbc: "fb.1.1673035686000.ABC" };
    const result = await insertSignupEvent(FIELDS, derived, "{}");
    expect(db.state.calls).toHaveLength(1);
    expect(db.state.calls[0].sql).toMatch(/^\s*INSERT INTO signup_events \(/);
    expect(db.state.calls[0].sql).not.toMatch(/ON DUPLICATE/i);
    expect(withoutClock(db.state.calls[0].params)).toEqual(withoutClock(buildInsertParams(FIELDS, derived, "{}")));
    expect(at(db.state.calls[0].params, "received_at")).toBeInstanceOf(Date);
    expect(result).toEqual({ inserted: true, id: 42 });
  });

  it("reports a duplicate as not inserted, with a genuine null id", async () => {
    db.state.respond = () => {
      throw duplicateKeyError();
    };
    const result = await insertSignupEvent(FIELDS, {}, "{}");
    expect(result).toEqual({ inserted: false, id: null });
    expect(result.id).toBeNull();
  });

  it("rethrows any other database error rather than reporting a duplicate", async () => {
    db.state.respond = () => {
      throw Object.assign(new Error("Data too long"), { code: "ER_DATA_TOO_LONG" });
    };
    await expect(insertSignupEvent(FIELDS, {}, "{}")).rejects.toThrow("Data too long");
  });

  it("stores an invalid payload's statuses in that same single statement", async () => {
    await insertSignupEvent(FIELDS, {}, "{}", "missing required fields: email");
    expect(db.state.calls).toHaveLength(1);
    const { params } = db.state.calls[0];
    for (const action of ["meta", "whatsapp", "brevo"]) {
      expect(at(params, `${action}_status`), action).toBe("invalid");
    }
    expect(at(params, "brevo_detail")).toBe("missing required fields: email");
  });

  it("names the columns in INSERT_COLUMNS order, with one placeholder and one parameter for each", async () => {
    // Columns and values are matched by position. A sorted column list would store
    // every value in the wrong column with no error at all.
    await insertSignupEvent(FIELDS, {}, "{}");
    const { sql, params } = db.state.calls[0];
    const match = sql.match(/INSERT INTO signup_events \(([^)]*)\)\s*VALUES \(([^)]*)\)/);
    expect(match, sql).not.toBeNull();
    const [, columns, placeholders] = match;
    expect(columns.split(",").map((c) => c.trim())).toEqual(INSERT_COLUMNS);
    expect(placeholders.split(",").map((p) => p.trim())).toEqual(INSERT_COLUMNS.map(() => "?"));
    expect(params).toHaveLength(INSERT_COLUMNS.length);
  });

  it("refuses an over-width client id before any statement runs, rather than cutting it", async () => {
    await expect(insertSignupEvent({ ...FIELDS, crmClientId: "9".repeat(256) }, {}, "{}")).rejects.toThrow(
      /crm_client_id is 256 characters/
    );
    expect(db.state.calls).toHaveLength(0);
  });

  it("counts characters, not UTF-16 units, so 255 emoji are accepted as a 255-character id", async () => {
    // 255 emoji are 510 UTF-16 units but 255 characters: the column takes them.
    await insertSignupEvent({ ...FIELDS, crmClientId: "😀".repeat(255) }, {}, "{}");
    expect(db.state.calls).toHaveLength(1);
  });

  it("refuses an over-width stage too, since it is the other half of the dedupe key", async () => {
    await expect(insertSignupEvent({ ...FIELDS, stage: "s".repeat(33) }, {}, "{}")).rejects.toThrow(
      /stage is 33 characters/
    );
    expect(db.state.calls).toHaveLength(0);
  });

  it("marks both refusals with a code, so a caller can tell them from a transient failure", async () => {
    // A retry of one of these fails identically, which is not true of anything else
    // this function throws. The handler answers 200 for this code and 503 for the rest.
    expect(typeof UNSTORABLE_KEY_CODE).toBe("string");
    expect(UNSTORABLE_KEY_CODE).not.toBe("");
    for (const overWidth of [{ crmClientId: "9".repeat(256) }, { stage: "s".repeat(33) }]) {
      await expect(insertSignupEvent({ ...FIELDS, ...overWidth }, {}, "{}")).rejects.toMatchObject({
        code: UNSTORABLE_KEY_CODE,
      });
    }
    expect(db.state.calls).toHaveLength(0);
  });

  it("leaves an ordinary database error with its own code, never the unstorable one", async () => {
    db.state.respond = () => {
      throw Object.assign(new Error("Lock wait timeout"), { code: "ER_LOCK_WAIT_TIMEOUT" });
    };
    await expect(insertSignupEvent(FIELDS, {}, "{}")).rejects.toMatchObject({ code: "ER_LOCK_WAIT_TIMEOUT" });
  });

  it("reports a missing insert id as null, not undefined", async () => {
    db.state.respond = () => [{ affectedRows: 1 }];
    const result = await insertSignupEvent(FIELDS, {}, "{}");
    expect(result.id).toBeNull();
  });
});

describe("findExistingFbc", () => {
  it("takes the earliest click on file, breaking a one-second tie by id", async () => {
    db.state.respond = () => [[{ fbc: "fb.1.1.EARLIEST" }]];
    expect(await findExistingFbc(88214)).toBe("fb.1.1.EARLIEST");
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/ORDER BY received_at ASC, id ASC\s+LIMIT 1/);
    expect(params).toEqual(["88214"]);
  });

  it("returns empty when no click is on file, and never queries for the word undefined", async () => {
    db.state.respond = () => [[]];
    expect(await findExistingFbc(undefined)).toBe("");
    expect(db.state.calls[0].params).toEqual([""]);
  });
});

describe("claimDueEvents", () => {
  it("selects due rows by three independent clauses, each on its own status and clock", async () => {
    db.state.respond = () => [[]];
    const now = new Date("2026-10-13T10:00:00Z");
    await claimDueEvents(25, now);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /meta_status\s+IN \('pending','retrying'\)\s+AND \(meta_next_attempt_at\s+IS NULL\s+OR meta_next_attempt_at\s+<= \?\)/
    );
    expect(sql).toMatch(
      /whatsapp_status\s+IN \('pending','retrying'\)\s+AND \(whatsapp_next_attempt_at\s+IS NULL\s+OR whatsapp_next_attempt_at\s+<= \?\)/
    );
    expect(sql).toMatch(
      /brevo_status\s+IN \('pending','retrying'\)\s+AND \(brevo_next_attempt_at\s+IS NULL\s+OR brevo_next_attempt_at\s+<= \?\)/
    );
    expect(params).toEqual([now, now, now, 25]);
  });

  it("defaults a zero limit to 25", async () => {
    db.state.respond = () => [[]];
    await claimDueEvents(0, new Date(0));
    expect(db.state.calls[0].params.at(-1)).toBe(25);
  });
});

describe("the three action writers", () => {
  const next = new Date("2026-10-13T11:00:00Z");

  it("updateMetaStatus writes only the meta columns", async () => {
    await updateMetaStatus(7, { status: "retrying", detail: "boom", attempts: 2, nextAttemptAt: next });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET meta_status = \?, meta_detail = \?, meta_attempts = \?, meta_next_attempt_at = \?\s+WHERE id = \?/
    );
    expect(sql).not.toMatch(/whatsapp|brevo/);
    expect(params).toEqual(["retrying", "boom", 2, next, 7]);
  });

  it("updateWhatsappStatus writes only the whatsapp columns, and never the frozen request id", async () => {
    await updateWhatsappStatus(7, { status: "sent", messageId: "msg-1", detail: "ok", attempts: 1, nextAttemptAt: null });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET whatsapp_status = \?, whatsapp_message_id = \?, whatsapp_detail = \?,\s*whatsapp_attempts = \?, whatsapp_next_attempt_at = \?\s+WHERE id = \?/
    );
    expect(sql).not.toMatch(/whatsapp_request_id|meta_|brevo_/);
    expect(params).toEqual(["sent", "msg-1", "ok", 1, null, 7]);
  });

  it("updateBrevoStatus writes only the brevo columns", async () => {
    await updateBrevoStatus(7, { status: "sent", detail: "", attempts: 0, nextAttemptAt: null });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET brevo_status = \?, brevo_detail = \?, brevo_attempts = \?, brevo_next_attempt_at = \?\s+WHERE id = \?/
    );
    expect(sql).not.toMatch(/meta_|whatsapp/);
    expect(params).toEqual(["sent", null, 0, null, 7]);
  });

  it("updateMetaStatus defaults a missing attempt count to 0, and a missing detail and clock to NULL", async () => {
    await updateMetaStatus(7, { status: "retrying" });
    expect(db.state.calls[0].params).toEqual(["retrying", null, 0, null, 7]);
    await updateMetaStatus(7, { status: "retrying", detail: "", attempts: 1, nextAttemptAt: undefined });
    expect(db.state.calls[1].params).toEqual(["retrying", null, 1, null, 7]);
  });

  it("updateWhatsappStatus defaults a missing attempt count to 0, and a missing detail and clock to NULL", async () => {
    await updateWhatsappStatus(7, { status: "failed" });
    expect(db.state.calls[0].params).toEqual(["failed", null, null, 0, null, 7]);
    await updateWhatsappStatus(7, { status: "failed", detail: "", attempts: 2 });
    expect(db.state.calls[1].params).toEqual(["failed", null, null, 2, null, 7]);
  });

  it("updateBrevoStatus defaults a missing attempt count to 0, and a missing detail and clock to NULL", async () => {
    await updateBrevoStatus(7, { status: "failed" });
    expect(db.state.calls[0].params).toEqual(["failed", null, 0, null, 7]);
  });

  it("records a failed send with no message id as NULL, not the word undefined", async () => {
    // A send that timed out has no provider id. The row must still record the failure.
    for (const messageId of [undefined, null]) {
      await updateWhatsappStatus(7, { status: "failed", messageId, detail: "timeout", attempts: 1, nextAttemptAt: next });
      const { params } = db.state.calls.at(-1);
      expect(params[0]).toBe("failed");
      expect(params[1]).toBeNull();
    }
  });
});

describe("a detail is masked on the way into its column", () => {
  // Spec section 13 covers the stored *_detail columns as well as the logs, and
  // this column is read straight into the admin table by stats.js toTableRow.
  // The text is the provider's own message, and a provider quotes back what we
  // sent it: Brevo is the one whose request body carries the raw email at top
  // level, and the one that writes its message into a detail.
  const WRITERS = [
    ["meta", updateMetaStatus, 1],
    ["whatsapp", updateWhatsappStatus, 2],
    ["brevo", updateBrevoStatus, 1],
  ];

  for (const [action, write, detailAt] of WRITERS) {
    it(`${action} masks an address and a phone number in the detail it stores`, async () => {
      await write(7, { status: "rejected", detail: "http 400 for ali.khan@example.com / +971507192185" });
      const stored = String(db.state.calls[0].params[detailAt]);
      expect(stored).not.toContain("ali.khan@example.com");
      expect(stored).not.toContain("971507192185");
      expect(stored).toContain("a***@example.com");
      // The reason itself still has to be readable, or the column is worthless.
      expect(stored).toContain("http 400");
    });
  }

  it("masks Brevo's own 400, which echoes the address we submitted", async () => {
    // The end of the leak path: brevo.js joins body.message into the detail
    // verbatim, and the existing no-leak test cannot see it because its fixtures
    // are safe strings ("INVALID", "http 400").
    const outcome = classifyBrevoOutcome({
      httpStatus: 400,
      body: { code: "duplicate_parameter", message: "Contact already exist with email ali.khan@example.com" },
    });
    expect(outcome.detail, "the classifier is not the place this is masked").toContain("ali.khan@example.com");

    await updateBrevoStatus(7, { status: outcome.status, detail: outcome.detail, attempts: 1, nextAttemptAt: null });
    expect(String(db.state.calls[0].params[1])).not.toContain("ali.khan@example.com");
  });

  it("masks a run of eight digits or more, and leaves a shorter one alone", async () => {
    // Shorter runs are HTTP statuses, attempt counts, Brevo codes and Graph error
    // subcodes -- the diagnostic value of the column. Eight is already an account
    // number, and a local number with no country code.
    await updateMetaStatus(7, { status: "failed", detail: "subcode 2804003 id 12345678" });
    const stored = String(db.state.calls[0].params[1]);
    expect(stored).toContain("2804003");
    expect(stored).not.toContain("12345678");
  });

  it("masks before cutting to 500, so a cut cannot leave half an address whole", async () => {
    const detail = `${"x".repeat(480)} ali.khan@example.com`;
    expect(detail.length).toBeGreaterThan(500);
    await updateBrevoStatus(7, { status: "rejected", detail });
    const stored = String(db.state.calls[0].params[1]);
    expect(stored.length).toBeLessThanOrEqual(500);
    expect(stored).not.toContain("ali.khan");
    // Masking shortens the text, so the whole masked address fits where the raw
    // one would have been cut through its local part.
    expect(stored.endsWith("a***@example.com")).toBe(true);
  });

  it("stores a detail that is empty once masked as NULL, not as an empty string", async () => {
    await updateMetaStatus(7, { status: "sent", detail: "" });
    expect(db.state.calls[0].params[1]).toBeNull();
  });
});

describe("a claiming write", () => {
  // The pre-send write IS the claim on the row. claimDueEvents takes no lock and
  // an overlapped IIS recycle runs two workers, so dropping either half of this
  // predicate puts a second WhatsApp welcome back on the table. Each half is
  // pinned per writer, because they are three separate statements.
  const claimAt = new Date("2026-10-13T12:00:00Z");
  const WRITERS = [
    ["meta", updateMetaStatus],
    ["whatsapp", updateWhatsappStatus],
    ["brevo", updateBrevoStatus],
  ];

  for (const [action, write] of WRITERS) {
    it(`${action} claims only a row still unsent, whose clock has come due`, async () => {
      await write(7, { status: "retrying", detail: "x", attempts: 1, nextAttemptAt: claimAt }, claimAt);
      const { sql, params } = db.state.calls[0];
      expect(sql).toMatch(new RegExp(`WHERE id = \\?\\s+AND ${action}_status IN \\('pending','retrying'\\)`));
      expect(sql).toMatch(
        new RegExp(`AND \\(${action}_next_attempt_at IS NULL OR ${action}_next_attempt_at <= \\?\\)`)
      );
      // The claim moment binds last, after the row id.
      expect(params.at(-2)).toBe(7);
      expect(params.at(-1)).toBe(claimAt);
    });

    it(`${action} reports the rows it matched, so a worker can tell a lost claim from a won one`, async () => {
      db.state.respond = () => [{ affectedRows: 1 }];
      expect(await write(7, { status: "retrying" }, claimAt)).toBe(1);
      db.state.respond = () => [{ affectedRows: 0 }];
      expect(await write(7, { status: "retrying" }, claimAt)).toBe(0);
    });

    it(`${action} takes no claim when it records an outcome, so a final attempt's still lands`, async () => {
      // The claim on the last attempt stores `failed`, which the predicate does
      // not match. Holding the write that records what the provider said to the
      // same predicate would read a third-attempt send as failed for ever.
      await write(7, { status: "sent", detail: "ok", attempts: 3, nextAttemptAt: null });
      const { sql, params } = db.state.calls[0];
      expect(sql).toMatch(/WHERE id = \?$/);
      expect(sql).not.toContain("IN ('pending','retrying')");
      expect(params.at(-1)).toBe(7);
    });
  }

  it("counts a row it matched but did not change as claimed, as CLIENT_FOUND_ROWS reports it", async () => {
    // mysql2 connects with CLIENT_FOUND_ROWS, so affectedRows counts the rows
    // MATCHED. A claim that rewrites an identical status and count changes
    // nothing and is still won; reading changedRows would abandon it.
    db.state.respond = () => [{ affectedRows: 1, changedRows: 0 }];
    expect(await updateMetaStatus(7, { status: "retrying" }, claimAt)).toBe(1);
  });

  it("does not build the pool with FOUND_ROWS turned off", async () => {
    // This exact flag already produced one defect on this branch (insertSignupEvent's
    // docstring records it). Off, every unchanged claim would read as lost and
    // nothing would ever be sent.
    expect(db.state.poolOptions, "createPool was not called with options").toBeTruthy();
    expect(String(db.state.poolOptions.flags ?? "")).not.toMatch(/FOUND_ROWS/i);
  });

  it("reads a result with no count at all as unknown rather than lost", async () => {
    db.state.respond = () => [{}];
    expect(await updateBrevoStatus(7, { status: "retrying" }, claimAt)).toBeNull();
  });
});

describe("whatsapp_message_id at its width boundary", () => {
  // The provider's id is written after a send has already happened. An UPDATE that
  // throws here leaves the row due, so the next sweep sends the welcome again.
  // Over-width therefore writes NULL and warns; it never fails the write.
  afterEach(() => vi.restoreAllMocks());

  it("keeps a message id of exactly its column width, with no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "m".repeat(64);
    await updateWhatsappStatus(7, { status: "sent", messageId: id, detail: "ok", attempts: 1, nextAttemptAt: null });
    expect(db.state.calls[0].params[1]).toBe(id);
    expect(warn).not.toHaveBeenCalled();
  });

  it("writes NULL, still records the send as sent, and warns for a message id one over", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await updateWhatsappStatus(7, { status: "sent", messageId: "m".repeat(65), detail: "ok", attempts: 1, nextAttemptAt: null });
    const { params } = db.state.calls[0];
    expect(params[0]).toBe("sent");
    expect(params[1]).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toMatch(/\bwhatsapp_message_id\b/);
    expect(message).toMatch(/\b65\b/);
  });
});

describe("listEventsSince", () => {
  it("selects newest first, capped, from the cutoff", async () => {
    const since = new Date("2026-09-13T00:00:00Z");
    await listEventsSince(since);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/WHERE received_at >= \?\s+ORDER BY received_at DESC\s+LIMIT \?/);
    expect(params).toEqual([since, 2000]);
  });

  it("reads scrubbed_at, so the tab can tell a scrubbed row from one that never had the value", async () => {
    // Almost every row the tab shows is scrubbed, and a masked empty email looks
    // exactly like a scrubbed one. Without this column the page shows three blank
    // columns and an operator concludes the feed is broken.
    await listEventsSince(new Date("2026-09-13T00:00:00Z"));
    expect(db.state.calls[0].sql).toMatch(/\bscrubbed_at\b/);
  });
});

describe("scrubSignupEvent", () => {
  const SCRUBBED = new Date("2026-10-14T12:01:00Z");

  it("nulls every column on the scrub list and nothing else, and stamps the moment", async () => {
    await scrubSignupEvent(7, SCRUBBED);
    const { sql, params } = db.state.calls[0];
    expect(db.state.calls).toHaveLength(1);
    for (const column of SCRUB_COLUMNS) {
      expect(sql, column).toMatch(new RegExp(`\\b${column} = NULL\\b`));
    }
    // Everything the row is kept for. Read off the statement rather than off the
    // list, so a column scrubbed by a hand-written SET that forgot the list fails.
    for (const column of [
      "crm_client_id",
      "fbc",
      "entity",
      "source",
      "language",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "record_type",
      "is_lead_raw",
      "marketing_consent",
      "is_ib",
      "fxbo_unique_id",
      "whatsapp_request_id",
      "received_at",
    ]) {
      expect(sql, column).not.toMatch(new RegExp(`\\b${column} = NULL\\b`));
    }
    expect(sql).toMatch(/SET .*scrubbed_at = \?/s);
    expect(params).toEqual([SCRUBBED, 7]);
  });

  it("is a no-op on a row already scrubbed, rather than moving its timestamp", async () => {
    // scrubbed_at is the audit trail: overwriting it would move the moment the
    // data actually went. It is also what keeps the settle path and the thirty-day
    // backstop from undoing each other's record.
    await scrubSignupEvent(7, SCRUBBED);
    expect(db.state.calls[0].sql).toMatch(/WHERE id = \?\s+AND scrubbed_at IS NULL/);

    db.state.respond = () => [{ affectedRows: 0 }];
    expect(await scrubSignupEvent(7, SCRUBBED)).toBe(0);
  });

  it("asks the row itself whether all three are scrubbable, rather than trusting the caller", async () => {
    // The worker decides whether to TRY from its own in-memory copy of the row,
    // and an overlapped IIS recycle gives two workers a copy each with one claim
    // in it -- so neither copy ever shows all three settled. Decided from the copy
    // alone, the scrub then happened in neither worker and the row held its name,
    // email and phone for the full thirty days, in exactly the case the policy
    // asks to reduce to a minute. The predicate belongs in the statement, where
    // the row read is the one the table holds.
    await scrubSignupEvent(7, SCRUBBED);
    const { sql, params } = db.state.calls[0];
    for (const action of ["meta", "whatsapp", "brevo"]) {
        expect(sql, action).toContain(`AND ${action}_status IN ('sent','skipped')`);
    }
    // Unlike a claiming write there is no claim moment to bind: this takes
    // nothing away from another worker, so a second attempt is a no-op rather
    // than a loss, and both workers may make one.
    expect(params).toEqual([SCRUBBED, 7]);
  });

  it("names every scrubbable status, so the statement and the worker cannot come to disagree", async () => {
    // Both are built from SCRUBBABLE_STATUSES. A value in one and not the other
    // would be silent in the worst direction: the worker attempts a scrub the
    // statement refuses, and the row keeps its client data for thirty days with
    // nothing anywhere saying so.
    await scrubSignupEvent(7, SCRUBBED);
    const { sql } = db.state.calls[0];
    for (const action of ["meta", "whatsapp", "brevo"]) {
      const list = sql.split(`${action}_status IN (`)[1].split(")")[0].split(",");
      expect(list, action).toEqual(SCRUBBABLE_STATUSES.map((status) => `'${status}'`));
    }
  });

  it("keeps a row whose send failed, refused or was never valid: scrubbing it is what destroyed the resend", async () => {
    // The gap this closes (2026-10-14, user's call). Built from SETTLED instead,
    // the three error statuses are in the clause, and a row whose Brevo send
    // failed because BREVO_LIST_ID was wrong is scrubbed a minute later -- so the
    // name, email and phone the resend needs are gone for good, and the only
    // trace is a `failed` nobody can act on. The thirty-day backstop is what
    // bounds the data this keeps instead.
    //
    // The other direction of the same mistake is in worker.js, where the step
    // skip reads SETTLED: narrowed there, a refused action would be claimed again
    // and the client would get a second WhatsApp welcome.
    await scrubSignupEvent(7, SCRUBBED);
    const { sql } = db.state.calls[0];
    for (const status of ["rejected", "failed", "invalid"]) {
      expect(sql, status).not.toContain(`'${status}'`);
    }
    // And the wide list in full, in case a future edit pastes it back in here.
    expect(sql).not.toContain(SETTLED_STATUSES.map((status) => `'${status}'`).join(","));
  });

  it("reports how many rows it matched, so a caller can tell scrubbed-now from scrubbed-already", async () => {
    db.state.respond = () => [{ affectedRows: 1 }];
    expect(await scrubSignupEvent(7, SCRUBBED)).toBe(1);
    db.state.respond = () => [{}];
    expect(await scrubSignupEvent(7, SCRUBBED)).toBeNull();
  });
});

describe("deleteInvalidSignupEvents", () => {
  it("deletes only rows where all three statuses are invalid, past the cutoff", async () => {
    const before = new Date("2026-10-07T12:00:00Z");
    const removed = await deleteInvalidSignupEvents(before);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /^\s*DELETE FROM signup_events\s+WHERE meta_status = 'invalid'\s+AND whatsapp_status = 'invalid'\s+AND brevo_status = 'invalid'\s+AND received_at < \?\s*$/
    );
    expect(params).toEqual([before]);
    expect(removed).toBe(1);
  });

  it("requires all three statuses, so a row that sent anything is never deleted", async () => {
    // `invalid` is written to all three in the insert itself, so all three is what
    // identifies these rows. One `invalid` status beside two real ones is a
    // different animal, and deleting it would destroy a record of a real send.
    const { sql } = (await deleteInvalidSignupEvents(new Date()), db.state.calls[0]);
    expect(sql).not.toMatch(/\bOR\b/);
    for (const column of ["meta_status", "whatsapp_status", "brevo_status"]) {
      expect(sql, column).toMatch(new RegExp(`${column} = 'invalid'`));
    }
  });
});

describe("scrubStaleSignupEvents", () => {
  const ACTIONS = ["meta", "whatsapp", "brevo"];
  // The pass is four statements: one per destination, settling what the scrub is
  // about to make unsendable, and then the scrub itself as the last of them.
  const scrubCall = () => db.state.calls.at(-1);
  const settleCall = (action) => db.state.calls.find(({ sql }) => sql.includes(`${action}_status = `));

  it("scrubs every unscrubbed row past the cutoff, whatever its statuses say", async () => {
    const before = new Date("2026-09-14T12:00:00Z");
    const at = new Date("2026-10-14T12:00:00Z");
    const scrubbed = await scrubStaleSignupEvents(before, at);
    const { sql, params } = scrubCall();
    for (const column of SCRUB_COLUMNS) {
      expect(sql, column).toMatch(new RegExp(`\\b${column} = NULL\\b`));
    }
    // No status clause in the scrub itself: the rows this is for are precisely
    // the ones whose statuses never settled. Which is why the statuses are
    // settled by the statements before it rather than by a clause here.
    expect(sql).toMatch(/WHERE scrubbed_at IS NULL AND received_at < \?/);
    expect(sql).not.toMatch(/_status/);
    expect(params).toEqual([at, before]);
    expect(scrubbed).toBe(1);
  });

  it("sets the same columns as the single-row scrub, because both are built from one list", async () => {
    await scrubStaleSignupEvents(new Date(), new Date());
    const bulk = scrubCall().sql;
    db.state.calls.length = 0;
    await scrubSignupEvent(7, new Date());
    const one = db.state.calls[0].sql;
    const setList = (sql) => sql.slice(sql.indexOf("SET"), sql.indexOf("WHERE")).trim();
    expect(setList(bulk)).toBe(setList(one));
  });

  it("settles whatever it is about to leave unsendable, as failed, over the same rows", async () => {
    // A row this scrubs still reads `pending`, and the send guard refuses it for
    // ever while nothing writes a status saying so. `pending` is also the single
    // signal that means the dispatch worker is dead, so one row stuck at it for
    // ever makes the one number an operator would check unusable.
    const before = new Date("2026-09-14T12:00:00Z");
    await scrubStaleSignupEvents(before, new Date("2026-10-14T12:00:00Z"));
    for (const action of ACTIONS) {
      const { sql, params } = settleCall(action);
      expect(sql, action).toContain(`SET ${action}_status = 'failed', ${action}_detail = ?`);
      expect(sql, action).toMatch(/WHERE scrubbed_at IS NULL\s+AND received_at < \?/);
      expect(params[1], action).toEqual(before);
    }
  });

  it("says in the detail that the send was never attempted, not that it was refused", async () => {
    // What someone reading the tab has to be able to tell apart: a destination
    // that was never reached because the data it needed is gone, as against one
    // that was reached and turned down. `failed` on its own cannot say which.
    await scrubStaleSignupEvents(new Date(), new Date());
    for (const action of ACTIONS) {
      const { params } = settleCall(action);
      expect(params[0], action).toMatch(/not attempted/i);
      expect(params[0], action).toMatch(/scrubbed/i);
    }
  });

  it("never writes skipped, which would claim a decision nobody made", async () => {
    // `skipped` is a deliberate decision not to send -- no key, or a stage the
    // website pixel owns -- and it reads on the tab as a normal, intended, final
    // outcome. Nothing decided this one. `failed` is terminal, and the
    // vocabulary has nothing better.
    await scrubStaleSignupEvents(new Date(), new Date());
    for (const { sql } of db.state.calls) {
      expect(sql).not.toMatch(/_status = '(?!failed')/);
    }
  });

  it("touches no destination that had already settled, neither its status nor its detail", async () => {
    // An existing `sent` stays `sent`, and the detail beside it stays the
    // provider's own word. Each statement names one destination and skips the
    // rows where that one is settled, so a settled destination is never in the
    // SET list of a statement whose rows include it.
    await scrubStaleSignupEvents(new Date(), new Date());
    for (const { sql } of db.state.calls) {
      const setList = sql.slice(0, sql.indexOf("WHERE"));
      for (const [, action] of setList.matchAll(/(meta|whatsapp|brevo)_(?:status|detail) = /g)) {
        expect(sql, action).toContain(`AND ${action}_status NOT IN ('sent','skipped','rejected','failed','invalid')`);
      }
    }
  });

  it("settles only what is still unsent, by the wide list, so a real refusal is never overwritten", async () => {
    // These statements are built from SETTLED and not from the scrub's narrower
    // SCRUBBABLE, and the two are not interchangeable here. Narrowed, each
    // statement would also match the destinations that were refused or failed and
    // overwrite them -- status and detail both -- with its own `failed` and "not
    // attempted". The record of a provider's refusal would become the record of a
    // scrub, which is the one thing the tab needs to be able to tell apart.
    await scrubStaleSignupEvents(new Date(), new Date());
    for (const action of ACTIONS) {
      const { sql } = settleCall(action);
      for (const status of SETTLED_STATUSES) {
        expect(sql, `${action}/${status}`).toContain(`'${status}'`);
      }
    }
  });

  it("settles before it scrubs, so a pass that dies half way is finished by the next one", async () => {
    // The other order leaves a scrubbed row holding `pending` statuses and
    // nothing that ever selects it again: `scrubbed_at IS NULL` is the only
    // handle either half has, and the scrub is what removes it. This way a pass
    // that dies between the two leaves the row unscrubbed, and the next hour
    // finishes both.
    await scrubStaleSignupEvents(new Date(), new Date());
    const statements = db.state.calls.map(({ sql }) => sql);
    const scrubAt = statements.findIndex((sql) => sql.includes("first_name = NULL"));
    expect(scrubAt).toBe(statements.length - 1);
    for (const action of ACTIONS) {
      expect(statements.indexOf(settleCall(action).sql), action).toBeLessThan(scrubAt);
    }
  });

  it("reports the rows the scrub matched, not the rows a settle statement did", async () => {
    // The sweep prints this as "N unscrubbed rows scrubbed", and the settle
    // statements match a different, smaller set: only the rows that still had an
    // unsettled destination in them.
    db.state.respond = (sql) => [{ affectedRows: sql.includes("first_name = NULL") ? 2 : 9 }];
    expect(await scrubStaleSignupEvents(new Date(), new Date())).toBe(2);
  });
});

describe("countEventsSince", () => {
  it("selects the stage, the three statuses and the count, grouped over the window, with no cap", async () => {
    const groups = [{ stage: "lead", meta_status: "sent", whatsapp_status: "skipped", brevo_status: "sent", n: 3 }];
    db.state.respond = () => [groups];
    const since = new Date("2026-09-13T00:00:00Z");
    const result = await countEventsSince(since);
    const { sql, params } = db.state.calls[0];
    // The whole statement, select list included. The fold reads the count as `n`, so
    // renaming the alias would make the funnel count groups instead of events.
    expect(sql).toMatch(
      /^\s*SELECT stage, meta_status, whatsapp_status, brevo_status, COUNT\(\*\) AS n\s+FROM signup_events\s+WHERE received_at >= \?\s+GROUP BY stage, meta_status, whatsapp_status, brevo_status\s*$/
    );
    expect(params).toEqual([since]);
    expect(result).toEqual(groups);
  });
});

describe("latestEventReceivedAt", () => {
  it("selects the newest received_at from the whole table, with no window", async () => {
    const at = new Date("2026-10-12T06:00:00Z");
    db.state.respond = () => [[{ latest: at }]];
    const result = await latestEventReceivedAt();
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/^\s*SELECT MAX\(received_at\) AS latest\s+FROM signup_events\s*$/);
    expect(params).toEqual([]);
    expect(result).toEqual(at);
  });

  it("returns null for an empty table", async () => {
    db.state.respond = () => [[{ latest: null }]];
    expect(await latestEventReceivedAt()).toBeNull();
  });
});

describe("latestReceivedAtByStage", () => {
  it("selects each stage with its newest received_at, grouped by stage over the whole table", async () => {
    const rows = [{ stage: "registered", latest: new Date("2026-10-13T11:00:00Z") }];
    db.state.respond = () => [rows];
    const result = await latestReceivedAtByStage();
    const { sql, params } = db.state.calls[0];
    // The alias is what the aggregator reads as `latest`, so it is pinned with the rest.
    expect(sql).toMatch(/^\s*SELECT stage, MAX\(received_at\) AS latest\s+FROM signup_events\s+GROUP BY stage\s*$/);
    expect(params).toEqual([]);
    expect(result).toEqual(rows);
  });
});
