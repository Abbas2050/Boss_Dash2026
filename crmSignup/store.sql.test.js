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
  findExistingClickIds,
  insertSignupEvent,
  UNSTORABLE_KEY_CODE,
  claimDueEvents,
  updateMetaStatus,
  updateWhatsappStatus,
  updateBrevoStatus,
  updateOpenaiStatus,
  updateGoogleStatus,
  listEventsSince,
  countEventsSince,
  latestEventReceivedAt,
  latestReceivedAtByStage,
  SCRUB_COLUMNS,
  SIGNUP_EVENTS_ADDED_COLUMNS,
  scrubSignupEvent,
  deleteInvalidSignupEvents,
  scrubStaleSignupEvents,
  recordWhatsappDelivery,
  requeueFailedSends,
  countResendableSends,
  DESTINATIONS,
} from "./store.js";
// The two vocabularies the worker and these statements are built from, imported
// so a test can prove each statement names every value in the one it belongs to
// -- and none of the values in the other. The scrub is built from SCRUBBABLE
// ("this row is safe to forget"); the backstop's settle statements are built
// from SETTLED ("do not attempt this action again").
import { SETTLED_STATUSES, SCRUBBABLE_STATUSES, REQUEUEABLE_STATUSES } from "./settled.js";
// OpenAI's window, imported for the same reason the statements import it: the
// resend's promise and the send's own skip decision have to be one rule, and a
// test that restated the bound here would agree with a drifted statement.
import { OPENAI_MAX_EVENT_AGE_MS, OPENAI_MAX_EVENT_SKEW_MS } from "./openai.js";
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

  it("adds each later column, and each index, behind its own information_schema check", () => {
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
    // Both indexes, each behind its own check. The second one is not a
    // performance nicety: recordWhatsappDelivery matches a row by
    // whatsapp_request_id and nothing else -- that lookup IS the security model
    // of an endpoint with no shared secret, so it cannot be narrowed with
    // another column, and there are several status updates per message.
    for (const [index, columns] of [
      ["idx_signup_events_retention", "(scrubbed_at, received_at)"],
      ["idx_signup_events_whatsapp_request", "(whatsapp_request_id)"],
    ]) {
      expect(ddlCalls[i].sql, index).toMatch(/information_schema\.STATISTICS/i);
      expect(ddlCalls[i].params, index).toEqual([index]);
      expect(ddlCalls[i + 1].sql, index).toBe(`ALTER TABLE signup_events ADD KEY ${index} ${columns}`);
      i += 2;
    }
    expect(ddlCalls).toHaveLength(i);
  });

  it("holds google_request_id in both the CREATE and the guarded ALTERs", async () => {
    // **The column that is the difference between one conversion and two.** The
    // Data Manager API answers 200 for "accepted for asynchronous processing"
    // and nothing more; the real outcome is retrieved by this id up to 24 hours
    // later, so the Google step has two phases and this column is what tells
    // them apart. A table that predates it -- which every existing one does --
    // would read every awaiting row as never ingested and ingest it again.
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/google_request_id VARCHAR\(512\) NULL/);
    const added = SIGNUP_EVENTS_ADDED_COLUMNS.find(([column]) => column === "google_request_id");
    expect(added, "a new column with no guarded ALTER never reaches an existing table").toBeTruthy();
    expect(added[1]).toContain("ADD COLUMN google_request_id VARCHAR(512) NULL");
    // NULL-able with no default, unlike the four status columns beside it:
    // nothing reads it in a status predicate, and NULL is the honest value for
    // "nothing has been ingested for this row".
    expect(added[1]).not.toMatch(/DEFAULT/);
    // 512 and not 64: Google documents the id only as "auto-generated" and
    // states no shape or maximum, so the width is set where an opaque token
    // cannot plausibly reach rather than where today's ids happen to sit.
    expect(SIGNUP_EVENTS_SCHEMA).not.toMatch(/google_request_id VARCHAR\(64\)/);
  });

  it("does not insert google_request_id, because an insert cannot know one", async () => {
    // Written by whoever learns the fact, like `brevo_contact_id`: the webhook
    // that inserts the row has ingested nothing.
    expect(INSERT_COLUMNS).not.toContain("google_request_id");
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
    // Still asked, once per column plus once per index.
    expect(sql.filter((s) => /information_schema/i.test(s))).toHaveLength(SIGNUP_EVENTS_ADDED_COLUMNS.length + 2);
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
    for (const action of DESTINATIONS) {
      expect(at(params, `${action}_status`), action).toBe("invalid");
    }
    expect(at(params, "brevo_detail")).toBe("missing required fields: email");
    expect(at(params, "openai_detail")).toBe("missing required fields: email");
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

describe("findExistingClickIds", () => {
  it("takes the earliest click of each kind on file, breaking a one-second tie by id", async () => {
    db.state.respond = () => [
      [{ fbc: "fb.1.1.EARLIEST", oppref: "oppref-EARLIEST", gclid: "gclid-EARLIEST" }],
    ];
    expect(await findExistingClickIds(88214)).toEqual({
      fbc: "fb.1.1.EARLIEST",
      oppref: "oppref-EARLIEST",
      gclid: "gclid-EARLIEST",
    });
    const { sql, params } = db.state.calls[0];
    expect(sql.match(/ORDER BY received_at ASC, id ASC\s+LIMIT 1/g)).toHaveLength(3);
    expect(params).toEqual(["88214", "88214", "88214"]);
  });

  it("asks for each column in its own subquery, because the three need not sit on one row", async () => {
    // A client can reach the funnel from a Meta click, come back through a
    // ChatGPT one and arrive a third time from Search, so the earliest row
    // carrying an `fbclid` need not be the row carrying an `oppref` or a
    // `gclid`. "The first non-empty value stored for this client" is a question
    // per column; one row's three columns would answer a different question and
    // silently drop whichever identifier was not on that row.
    db.state.respond = () => [[{ fbc: "", oppref: "", gclid: "" }]];
    await findExistingClickIds(88214);
    const { sql } = db.state.calls[0];
    expect(sql).toMatch(/\(SELECT fbc FROM signup_events[\s\S]*fbc IS NOT NULL AND fbc <> ''/);
    expect(sql).toMatch(/\(SELECT oppref FROM signup_events[\s\S]*oppref IS NOT NULL AND oppref <> ''/);
    expect(sql).toMatch(/\(SELECT gclid FROM signup_events[\s\S]*gclid IS NOT NULL AND gclid <> ''/);
  });

  it("is one statement, so the webhook that is answering FXBO makes one round trip", async () => {
    db.state.respond = () => [[{ fbc: null, oppref: null, gclid: null }]];
    await findExistingClickIds(88214);
    expect(db.state.calls).toHaveLength(1);
  });

  it("returns empty strings when no click is on file, and never queries for the word undefined", async () => {
    // All three NULL is the common case: most signups are organic.
    db.state.respond = () => [[{ fbc: null, oppref: null, gclid: null }]];
    expect(await findExistingClickIds(undefined)).toEqual({ fbc: "", oppref: "", gclid: "" });
    expect(db.state.calls[0].params).toEqual(["", "", ""]);
  });

  it("returns empty strings for an empty result set as well as for NULLs", async () => {
    db.state.respond = () => [[]];
    expect(await findExistingClickIds(88214)).toEqual({ fbc: "", oppref: "", gclid: "" });
  });

  it("hands back one id when only the others are on file", async () => {
    db.state.respond = () => [[{ fbc: null, oppref: "oppref-ONLY", gclid: null }]];
    expect(await findExistingClickIds(88214)).toEqual({ fbc: "", oppref: "oppref-ONLY", gclid: "" });
  });

  it("hands back the gclid alone for a client who arrived from Search and nowhere else", async () => {
    // The commonest shape of all for this one, once Google Ads is live: a
    // gclid and nothing beside it. Pinned because it is the id with no
    // fallback -- Meta and OpenAI still match on the hashed email and phone
    // without theirs, and Google's conversion simply does not exist.
    db.state.respond = () => [[{ fbc: null, oppref: null, gclid: "Cj0KCQiA-only" }]];
    expect(await findExistingClickIds(88214)).toEqual({ fbc: "", oppref: "", gclid: "Cj0KCQiA-only" });
  });
});

describe("claimDueEvents", () => {
  it("selects due rows by one independent clause per destination, each on its own status and clock", async () => {
    // **A destination missing from here never sends at all, and says nothing.**
    // No row is ever claimed for it, so no step ever runs, so no status is ever
    // written: the column reads `pending` for ever and the only sign is a
    // counter nobody has reason to look at yet. Each clause is pinned on its own
    // because each has its own two columns.
    db.state.respond = () => [[]];
    const now = new Date("2026-10-13T10:00:00Z");
    await claimDueEvents(25, now);
    const { sql, params } = db.state.calls[0];
    for (const action of DESTINATIONS) {
      expect(sql, action).toMatch(
        new RegExp(
          `${action}_status\\s+IN \\('pending','retrying'\\)\\s+AND \\(${action}_next_attempt_at\\s+IS NULL\\s+OR ${action}_next_attempt_at\\s+<= \\?\\)`
        )
      );
    }
    // One clock bound per destination, then the limit. A clause added without
    // its parameter would silently read the next destination's clock.
    expect(params).toEqual([...DESTINATIONS.map(() => now), 25]);
  });

  it("names openai among them, so ChatGPT Ads is claimed rather than silently never sent", async () => {
    // The literal, not only the list: dropping `openai` from DESTINATIONS and
    // from the statement together would otherwise agree with itself.
    db.state.respond = () => [[]];
    await claimDueEvents(25, new Date("2026-10-13T10:00:00Z"));
    expect(DESTINATIONS).toContain("openai");
    expect(db.state.calls[0].sql).toContain("openai_status   IN ('pending','retrying')");
  });

  it("names google among them, so an offline conversion is claimed rather than never uploaded", async () => {
    // The literal, not only the list: a row whose only due action is the Google
    // upload would never be selected at all, and its status would read
    // `pending` for the rest of the table's life -- which is the one counter
    // that means the dispatch worker is dead.
    db.state.respond = () => [[]];
    await claimDueEvents(25, new Date("2026-10-13T10:00:00Z"));
    expect(DESTINATIONS).toContain("google");
    expect(db.state.calls[0].sql).toContain("google_status   IN ('pending','retrying')");
    // One `now` per destination, and the limit last.
    expect(db.state.calls[0].params).toHaveLength(DESTINATIONS.length + 1);
  });

  it("defaults a zero limit to 25", async () => {
    db.state.respond = () => [[]];
    await claimDueEvents(0, new Date(0));
    expect(db.state.calls[0].params.at(-1)).toBe(25);
  });
});

describe("the five action writers", () => {
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

  it("updateBrevoStatus writes only the brevo columns, the contact id among them", async () => {
    await updateBrevoStatus(7, { status: "sent", detail: "", contactId: "4821", attempts: 0, nextAttemptAt: null });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET brevo_status = \?, brevo_detail = \?,\s*brevo_contact_id = COALESCE\(\?, brevo_contact_id\),\s*brevo_attempts = \?, brevo_next_attempt_at = \?\s+WHERE id = \?/
    );
    expect(sql).not.toMatch(/meta_|whatsapp/);
    expect(params).toEqual(["sent", null, "4821", 0, null, 7]);
  });

  it("updateBrevoStatus never erases a contact id it was not given", async () => {
    // COALESCE, not a plain assignment, and the reason is this writer running
    // twice per send: the pre-send claim writes `retrying` with no id -- it
    // cannot have one, the request has not gone out -- and the outcome writes
    // the id after. Written plainly, a later claim (a resend, a sweep that found
    // the row due again) would null the proof of a contact that exists, and
    // nothing would put it back: Brevo mints an id only when it CREATES, so the
    // second call updates and returns none.
    await updateBrevoStatus(7, { status: "retrying", detail: "in flight", attempts: 1 });
    const { sql, params } = db.state.calls[0];
    expect(sql).toContain("brevo_contact_id = COALESCE(?, brevo_contact_id)");
    expect(params[2]).toBeNull();
  });

  it("updateGoogleStatus writes only the google columns, the request id among them", async () => {
    // Nothing of Google's is written outside these five: the conversion's
    // identity is its `transactionId`, derived from the row, and `gclid` is
    // frozen at insert. A writer that touched another destination's column would
    // settle a send that never happened.
    await updateGoogleStatus(7, {
      status: "retrying",
      detail: "accepted",
      requestId: "dm-request-1",
      attempts: 0,
      nextAttemptAt: next,
    });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET google_status = \?, google_detail = \?,\s*google_request_id = COALESCE\(\?, google_request_id\),\s*google_attempts = \?, google_next_attempt_at = \?\s+WHERE id = \?/
    );
    for (const other of ["meta", "whatsapp", "brevo", "openai"]) {
      expect(sql, other).not.toContain(`${other}_status`);
    }
    expect(sql).not.toContain("gclid");
    expect(params).toEqual(["retrying", "accepted", "dm-request-1", 0, next, 7]);
  });

  it("updateGoogleStatus NEVER erases the request id it was not given", async () => {
    // **COALESCE, and here it is load-bearing rather than defensive.** This
    // writer runs at least three times for one conversion: the pre-send claim
    // (which cannot have an id yet), the ingest's outcome (which supplies it),
    // and then the claim and outcome of every poll that follows -- all of which
    // pass none. Written plainly, the first poll's own claim would null the id it
    // is about to poll with, and the next sweep, seeing an empty column, would
    // INGEST THE CONVERSION A SECOND TIME.
    for (const write of [
      { status: "retrying", detail: "send started; outcome not recorded", attempts: 1 },
      { status: "retrying", detail: "still processing", attempts: 2, requestId: undefined },
      { status: "sent", detail: "SUCCESS", attempts: 3, requestId: null },
    ]) {
      await updateGoogleStatus(7, write);
      const { sql, params } = db.state.calls.at(-1);
      expect(sql, JSON.stringify(write)).toContain("google_request_id = COALESCE(?, google_request_id)");
      expect(params[2], JSON.stringify(write)).toBeNull();
    }
  });

  it("CUTS an over-width request id rather than nulling it, unlike every other id here", async () => {
    // The opposite of the rule `fbc` and `whatsapp_message_id` follow, because
    // the consequences are opposite. A cut id makes the next poll ask about a
    // request Google does not know, which settles `rejected` saying so: visible,
    // and ONE conversion. A NULL would make the next sweep read the row as never
    // ingested and ingest it again, which is TWO.
    const over = "x".repeat(600);
    await updateGoogleStatus(7, { status: "retrying", detail: "accepted", requestId: over, attempts: 0 });
    const { params } = db.state.calls.at(-1);
    expect(params[2]).not.toBeNull();
    expect(params[2]).toHaveLength(512);
    expect(over.startsWith(params[2])).toBe(true);
  });

  it("updateOpenaiStatus writes only the openai columns", async () => {
    await updateOpenaiStatus(7, { status: "sent", detail: "http 200", attempts: 1, nextAttemptAt: null });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET openai_status = \?, openai_detail = \?, openai_attempts = \?, openai_next_attempt_at = \?\s+WHERE id = \?/
    );
    expect(sql).not.toMatch(/meta_|whatsapp|brevo/);
    // And never the frozen click id: `oppref` is written once, at insert, and a
    // send has nothing to add to it.
    expect(sql).not.toMatch(/oppref/);
    expect(params).toEqual(["sent", "http 200", 1, null, 7]);
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

  it("updateBrevoStatus defaults a missing attempt count to 0, and a missing detail, id and clock to NULL", async () => {
    await updateBrevoStatus(7, { status: "failed" });
    expect(db.state.calls[0].params).toEqual(["failed", null, null, 0, null, 7]);
  });

  it("updateOpenaiStatus defaults a missing attempt count to 0, and a missing detail and clock to NULL", async () => {
    await updateOpenaiStatus(7, { status: "failed" });
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
    ["openai", updateOpenaiStatus, 1],
    ["google", updateGoogleStatus, 1],
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
    ["openai", updateOpenaiStatus],
    ["google", updateGoogleStatus],
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

// The one statement an unauthenticated caller can reach. Everything about it is
// a security property, not a convenience, so each clause has its own test: the
// endpoint behind it carries no shared secret (verified 2026-10-16: DoubleTick's
// webhook has none to send), and what stands in for one is this WHERE clause
// matching a frozen UUID v4.
describe("recordWhatsappDelivery", () => {
  const AT = new Date("2026-10-16T09:05:00Z");
  const ID = "6d0c7f2e-0d3a-4a6f-9b3e-1f2c3d4e5f60";

  it("matches the frozen request id, and nothing else", async () => {
    await recordWhatsappDelivery(ID, { status: "DELIVERED", at: AT, detail: null });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/WHERE whatsapp_request_id = \?/);
    expect(params.at(-1)).toBe(ID);
    // Not by row id, not by phone, not by client id. The frozen UUID is the
    // capability: an endpoint with no secret can reach exactly the row whose id
    // the caller already knows, and nothing lets it widen that to a set.
    expect(sql).not.toMatch(/WHERE id = |crm_client_id|phone|email/);
  });

  it("writes the three delivery columns and no others", async () => {
    await recordWhatsappDelivery(ID, { status: "DELIVERED", at: AT, detail: null });
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET whatsapp_delivery_status = \?, whatsapp_delivery_at = \?, whatsapp_delivery_detail = \?/
    );
    expect(params).toEqual(["DELIVERED", AT, null, ID]);
  });

  it("never writes a status, an attempt count or a clock the worker reads", async () => {
    // This is the whole of why the endpoint is safe without a secret. The claim,
    // the scrub precondition, the backstop and the resend all read
    // `whatsapp_status`; a guessed id that could write it could make the worker
    // send a second welcome, or make a row scrubbable before its send happened.
    await recordWhatsappDelivery(ID, { status: "DELIVERED", at: AT, detail: null });
    const { sql } = db.state.calls[0];
    for (const column of [
      "whatsapp_status",
      "whatsapp_attempts",
      "whatsapp_next_attempt_at",
      "whatsapp_message_id",
      "meta_status",
      "brevo_status",
      "openai_status",
      "scrubbed_at",
    ]) {
      expect(sql, column).not.toMatch(new RegExp(`\b${column}\s*=`));
    }
  });

  it("writes no client column, and cannot: the statement names none", async () => {
    await recordWhatsappDelivery(ID, { status: "DELIVERED", at: AT, detail: null });
    const { sql } = db.state.calls[0];
    for (const column of SCRUB_COLUMNS) {
      expect(sql, column).not.toMatch(new RegExp(`\b${column}\b`));
    }
  });

  it("does not require an unscrubbed row, unlike every other write here", async () => {
    // A delivery report arrives minutes after the send, and the settle path
    // scrubs about a minute after signup -- so `scrubbed_at IS NULL` would throw
    // away nearly every report we ever get. It is sound because none of the
    // three columns is client data: a status word, an instant, and a provider
    // message that goes through the same masking as every other detail.
    await recordWhatsappDelivery(ID, { status: "DELIVERED", at: AT, detail: null });
    expect(db.state.calls[0].sql).not.toMatch(/scrubbed_at/);
  });

  it("stores the status verbatim, because the read string is undocumented", async () => {
    // Case is preserved and nothing is mapped to a word of ours. An unexpected
    // value has to reach the tab as itself; folding it into an "unknown" bucket
    // here would hide the one delivery that reveals what WhatsApp's read receipt
    // is actually called.
    await recordWhatsappDelivery(ID, { status: "SeenByRecipient", at: AT, detail: null });
    expect(db.state.calls[0].params[0]).toBe("SeenByRecipient");
  });

  it("cuts a status to its column rather than failing the write", async () => {
    // MySQL would reject the whole row for an over-width value, which would
    // throw away a real report over a value nobody will ever act on.
    await recordWhatsappDelivery(ID, { status: "S".repeat(40), at: AT, detail: null });
    expect(db.state.calls[0].params[0]).toHaveLength(32);
  });

  it("masks the provider's failure message on the way in", async () => {
    // DoubleTick's failMessage is their own text and a provider quotes back what
    // we sent it, so this column is subject to spec section 13 exactly as the
    // other *_detail columns are -- and the tab prints it.
    await recordWhatsappDelivery(ID, { status: "FAILED", at: AT, detail: "971507192185 is not on WhatsApp" });
    const detail = String(db.state.calls[0].params[2]);
    expect(detail).not.toContain("971507192185");
    expect(detail).toContain("***");
  });

  it("runs no statement at all for an empty id", async () => {
    // A bodyless or malformed webhook must not get as far as asking, and `= ''`
    // would otherwise be a predicate over every row whose id was stored NULL.
    for (const id of [undefined, null, ""]) {
      expect(await recordWhatsappDelivery(id, { status: "DELIVERED", at: AT }), String(id)).toBe(0);
    }
    expect(db.state.calls).toHaveLength(0);
  });

  it("still asks about an id of zero-as-text, which is a value and not an absence", async () => {
    // Whether DoubleTick's own ids are numeric is the unverified half of the
    // design, so a short numeric id has to reach the statement. Only an empty
    // one is nothing to ask about.
    await recordWhatsappDelivery("0", { status: "DELIVERED", at: AT });
    expect(db.state.calls[0].params.at(-1)).toBe("0");
  });

  it("reports how many rows matched, so zero can be acted on", async () => {
    // Zero is the answer to an open question, not an error: DoubleTick does not
    // document whether `messageId` on this event is the id we supplied or one
    // they generate, so a status matching no row is the evidence that it is
    // theirs. The route logs it.
    db.state.respond = () => [{ affectedRows: 0 }];
    expect(await recordWhatsappDelivery(ID, { status: "DELIVERED", at: AT })).toBe(0);
    db.state.respond = () => [{ affectedRows: 1 }];
    expect(await recordWhatsappDelivery(ID, { status: "DELIVERED", at: AT })).toBe(1);
  });

  it("writes NULL for a missing instant rather than the word undefined", async () => {
    await recordWhatsappDelivery(ID, { status: "DELIVERED" });
    expect(db.state.calls[0].params[1]).toBeNull();
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

  it("reads every destination's status, detail and attempts, all five of them", async () => {
    // A destination missing from this select list sends perfectly and then
    // reports as though it did not exist: `toTableRow` reads `undefined` for its
    // status, so its column is empty on every row of the one page built to
    // reveal a broken pipeline. Nothing else would notice -- the sends, the
    // retries and the scrub all read their own columns by name.
    await listEventsSince(new Date("2026-09-13T00:00:00Z"));
    const { sql } = db.state.calls[0];
    for (const action of DESTINATIONS) {
      for (const suffix of ["status", "detail", "attempts"]) {
        expect(sql, `${action}_${suffix}`).toMatch(new RegExp(`\\b${action}_${suffix}\\b`));
      }
    }
  });

  it("reads the delivery proof, which exists only to be looked at", async () => {
    // These four are the whole of Part 1 and Part 2. Nothing sends from them,
    // retries on them or scrubs them, so a column missing from this select list
    // is a column whose entire purpose is gone -- silently. The tab falls back
    // to "ENQUEUED" and "http 201", which is the reading this work replaced.
    await listEventsSince(new Date("2026-09-13T00:00:00Z"));
    const { sql } = db.state.calls[0];
    for (const column of [
      "whatsapp_delivery_status",
      "whatsapp_delivery_at",
      "whatsapp_delivery_detail",
      "brevo_contact_id",
    ]) {
      expect(sql, column).toMatch(new RegExp(`\\b${column}\\b`));
    }
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
      // The delivery proof, 2026-10-16, and its surviving is load-bearing.
      //
      // `brevo_contact_id` names a row in Brevo, not a person, and it is the
      // only positive evidence this table holds that the contact exists. The
      // question "did client 48217's contact really get created" is asked days
      // later, and Brevo mints an id only when it CREATES, so a scrubbed one
      // can never be re-read. Proof alive for a minute is no proof.
      //
      // The three whatsapp_delivery_* columns are usually written AFTER the
      // scrub: DoubleTick's webhook is minutes behind a send that settles in
      // about one. Scrubbing them would null a column that is about to be
      // written again, and leave the tab unable to say whether anything landed.
      "brevo_contact_id",
      "whatsapp_delivery_status",
      "whatsapp_delivery_at",
      "whatsapp_delivery_detail",
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

  it("asks the row itself whether every destination is scrubbable, rather than trusting the caller", async () => {
    // The worker decides whether to TRY from its own in-memory copy of the row,
    // and an overlapped IIS recycle gives two workers a copy each with one claim
    // in it -- so neither copy ever shows all three settled. Decided from the copy
    // alone, the scrub then happened in neither worker and the row held its name,
    // email and phone for the full thirty days, in exactly the case the policy
    // asks to reduce to a minute. The predicate belongs in the statement, where
    // the row read is the one the table holds.
    await scrubSignupEvent(7, SCRUBBED);
    const { sql, params } = db.state.calls[0];
    for (const action of DESTINATIONS) {
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
    for (const action of DESTINATIONS) {
      const list = sql.split(`${action}_status IN (`)[1].split(")")[0].split(",");
      expect(list, action).toEqual(SCRUBBABLE_STATUSES.map((status) => `'${status}'`));
    }
  });

  it("requires openai too, so no row is scrubbed while ChatGPT Ads is still pending", async () => {
    // **The failure this one exists for destroys data for ever.** The OpenAI
    // send reads the email and the phone off the row; a precondition missing it
    // scrubs the row the moment the other three settle -- about a minute after
    // signup -- while `openai_status` is still `pending`. The row is then
    // claimed on every sweep, refused by the send guard, and the conversion can
    // never be sent by anything. The literal is named here as well as the list
    // because dropping it from both at once would agree with itself.
    await scrubSignupEvent(7, SCRUBBED);
    expect(DESTINATIONS).toContain("openai");
    expect(db.state.calls[0].sql).toContain("AND openai_status IN ('sent','skipped')");
  });

  it("requires google too, so no row is scrubbed while the ingest is still pending", async () => {
    // The send guard refuses a scrubbed row for ever, so a row scrubbed while
    // the Google ingest was still pending would hold `pending` until the table
    // is dropped -- and `gclid` surviving the scrub does not help, because
    // nothing would ever claim the row again.
    await scrubSignupEvent(7, SCRUBBED);
    expect(DESTINATIONS).toContain("google");
    expect(db.state.calls[0].sql).toContain("AND google_status IN ('sent','skipped')");
  });

  it("will not take a row whose conversion is still awaiting Google's confirmation", async () => {
    // **The second phase's whole protection, and it needed no new code.** A
    // conversion accepted by `events:ingest` and not yet confirmed holds
    // `retrying`, which is in SCRUBBABLE_STATUSES exactly as little as `pending`
    // is -- so this predicate already refuses the row. That is most of the
    // reason the confirmation phase holds `retrying` rather than a sixth word,
    // which settled.js refuses and which would have to be added to the claim,
    // this predicate, the backstop and the resend.
    //
    // It costs something: the scrub, which normally runs about a minute after
    // signup, waits up to 24 hours on the rows Google is still processing. That
    // is written down in worker.js beside the decision.
    await scrubSignupEvent(7, SCRUBBED);
    const { sql } = db.state.calls[0];
    expect(SCRUBBABLE_STATUSES).not.toContain("retrying");
    expect(sql).not.toContain("'retrying'");
  });

  it("never nulls google_request_id, which is the handle the poll needs", async () => {
    // Not client data -- it names one request of ours to Google, not a person --
    // and the poll needs nothing else off the row. Scrubbed, a row awaiting
    // confirmation would read as never ingested and be INGESTED AGAIN. It cannot
    // happen today, because the predicate above refuses such a row; this is the
    // floor under that, for whoever widens SCRUB_COLUMNS next.
    await scrubSignupEvent(7, SCRUBBED);
    expect(SCRUB_COLUMNS).not.toContain("google_request_id");
    expect(db.state.calls[0].sql).not.toMatch(/\bgoogle_request_id = NULL\b/);
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
  it("deletes only rows where every status is invalid, past the cutoff", async () => {
    const before = new Date("2026-10-07T12:00:00Z");
    const removed = await deleteInvalidSignupEvents(before);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /^\s*DELETE FROM signup_events\s+WHERE meta_status = 'invalid'\s+AND whatsapp_status = 'invalid'\s+AND brevo_status = 'invalid'\s+AND openai_status = 'invalid'\s+AND google_status = 'invalid'\s+AND received_at < \?\s*$/
    );
    expect(params).toEqual([before]);
    expect(removed).toBe(1);
  });

  it("requires every destination's status, so a row that sent anything is never deleted", async () => {
    // `invalid` is written to every destination in the insert itself, so all of
    // them is what identifies these rows. One `invalid` status beside three real
    // ones is a different animal, and deleting it would destroy a record of a
    // real send.
    //
    // The other direction is why a destination may not be missing from here: the
    // condition is a conjunction, so a destination named in the insert's invalid
    // writes but absent from this statement is simply unchecked -- and one
    // missing from the insert while named here can never be satisfied, so no
    // invalid row would be deleted again and CUTOVER step 5's rows would pile up
    // for ever with their raw_payload.
    const { sql } = (await deleteInvalidSignupEvents(new Date()), db.state.calls[0]);
    expect(sql).not.toMatch(/\bOR\b/);
    for (const action of DESTINATIONS) {
      expect(sql, action).toMatch(new RegExp(`${action}_status = 'invalid'`));
    }
    expect(DESTINATIONS).toContain("openai");
    expect(sql).toContain("openai_status = 'invalid'");
  });

  it("names google too, so the condition stays satisfiable for an FXBO test press", async () => {
    // The condition asks for every destination at once. A destination absent
    // from it is a column that can hold anything; one present here but absent
    // from the INSERT's invalid writes would make it unsatisfiable, and no
    // invalid row would ever be deleted again.
    await deleteInvalidSignupEvents(new Date("2026-10-07T12:00:00Z"));
    const { sql } = db.state.calls[0];
    expect(DESTINATIONS).toContain("google");
    expect(sql).toContain("google_status = 'invalid'");
  });
});

describe("scrubStaleSignupEvents", () => {
  const ACTIONS = DESTINATIONS;
  // The pass is one statement per destination, settling what the scrub is about
  // to make unsendable, and then the scrub itself as the last of them.
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
      const written = new RegExp(`(${DESTINATIONS.join("|")})_(?:status|detail) = `, "g");
      for (const [, action] of setList.matchAll(written)) {
        expect(sql, action).toContain(`AND ${action}_status NOT IN ('sent','skipped','rejected','failed','invalid')`);
      }
    }
  });

  it("settles openai too, so a backstop-scrubbed row cannot read pending for ever", async () => {
    // **The counter this protects is the only signal that the worker is dead.**
    // The backstop takes the client data the OpenAI send needs, and the send
    // guard then refuses the row for ever while nothing writes a status saying
    // so: `openai_status` stays `pending` for the rest of the table's life, and
    // one permanently stuck row makes "pending is piling up" unreadable. The
    // literal and the list, for the usual reason.
    const before = new Date("2026-09-14T12:00:00Z");
    await scrubStaleSignupEvents(before, new Date("2026-10-14T12:00:00Z"));
    expect(DESTINATIONS).toContain("openai");
    const settled = settleCall("openai");
    expect(settled, "no statement settles openai").toBeTruthy();
    expect(settled.sql).toContain("SET openai_status = 'failed', openai_detail = ?");
    expect(settled.params[1]).toEqual(before);
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

describe("requeueFailedSends", () => {
  // The instant the resend is judged against, and the two edges of OpenAI's
  // window as the statements must bind them. Built from the exported constants,
  // never from a 7 typed here: a test carrying its own copy of the bound would
  // agree with a statement that had drifted from the skip decision.
  const RESEND_AT = new Date("2026-10-14T12:00:00Z");
  const OLDEST_SENDABLE = new Date(RESEND_AT.getTime() - OPENAI_MAX_EVENT_AGE_MS);
  const NEWEST_SENDABLE = new Date(RESEND_AT.getTime() + OPENAI_MAX_EVENT_SKEW_MS);

  it("puts one destination's failures back to pending, with the attempt count and the clock reset", async () => {
    // The three things the resend is: claimable again, a fresh budget, and due
    // now. Each is pinned on its own, because each has its own failure -- a
    // status with no reset is a row that fails on its first attempt, and a reset
    // with a clock still set is a row that waits out a five-minute delay the
    // operator did not ask for.
    db.state.respond = () => [{ affectedRows: 12 }];
    const requeued = await requeueFailedSends("brevo");
    const { sql, params } = db.state.calls[0];
    expect(db.state.calls).toHaveLength(1);
    expect(sql).toMatch(
      /^\s*UPDATE signup_events\s+SET brevo_status = 'pending', brevo_attempts = 0, brevo_next_attempt_at = NULL\s+WHERE scrubbed_at IS NULL\s+AND brevo_status IN \('failed','rejected'\)\s*$/
    );
    // Nothing is bound: the statement names its destination's columns and its
    // statuses, and the destination is refused before it reaches the SQL.
    expect(params).toEqual([]);
    expect(requeued).toBe(12);
  });

  it("writes only its own destination's three columns, never a sibling's", async () => {
    // One control per destination, and the point of that is that fixing
    // BREVO_LIST_ID does not re-send anybody's WhatsApp welcome.
    for (const action of DESTINATIONS) {
      db.state.calls.length = 0;
      await requeueFailedSends(action);
      const { sql } = db.state.calls[0];
      for (const other of DESTINATIONS) {
        if (other === action) continue;
        expect(sql, `${action} touched ${other}`).not.toMatch(new RegExp(`\\b${other}_`));
      }
    }
  });

  it("refuses to requeue a scrubbed row, which would never settle again", async () => {
    // A scrubbed row has no client data left. The send guard in worker.js refuses
    // it, writes nothing, and claimDueEvents keeps handing it back: `pending` for
    // the rest of the table's life. That is the one counter that means "the
    // dispatch worker is dead", and one permanently stuck row makes it unusable
    // -- the reason the thirty-day backstop settles what it scrubs.
    await requeueFailedSends("meta");
    expect(db.state.calls[0].sql).toMatch(/WHERE scrubbed_at IS NULL/);
  });

  it("names every requeueable status and neither of the two that must not be resent", async () => {
    // `failed` and `rejected`, built from REQUEUEABLE_STATUSES so the statement
    // and the reader that counts for the button cannot come to disagree.
    // `rejected` is in deliberately: Brevo's 400 for an attribute that does not
    // exist yet succeeds once the attribute is created, and the operator is
    // clicking because they fixed something.
    await requeueFailedSends("whatsapp");
    const { sql } = db.state.calls[0];
    const list = sql.split("whatsapp_status IN (")[1].split(")")[0].split(",");
    expect(list).toEqual(REQUEUEABLE_STATUSES.map((status) => `'${status}'`));
    // The literal too, not only the imported list: dropping `rejected` from both
    // at once would otherwise agree with itself.
    expect(sql).toContain("IN ('failed','rejected')");
  });

  it("can never touch a sent or a skipped row, whatever else is in the list", async () => {
    // The direction that costs a client a second WhatsApp welcome, which is the
    // one message with nothing deduplicating it. A `skipped` row is a deliberate
    // decision not to send, and re-deciding it in bulk is not this button's job.
    for (const action of DESTINATIONS) {
      db.state.calls.length = 0;
      await requeueFailedSends(action);
      // The selection half only: `pending` is of course in the SET list, which
      // is the whole idea.
      const selected = db.state.calls[0].sql.split("WHERE")[1];
      for (const status of ["sent", "skipped", "invalid", "pending", "retrying"]) {
        expect(selected, `${action}/${status}`).not.toContain(`'${status}'`);
      }
    }
  });

  it("resets the attempt count, so the resend has its retries rather than one shot", async () => {
    // planRetry reads the stored count. Left at 3 of 3, the pre-send write that
    // claims the row stores `failed` with no clock BEFORE the request goes out:
    // the tab shows a terminal failure while the request is in the air, and a
    // transient 503 ends the resend instead of retrying it five minutes later.
    await requeueFailedSends("meta");
    expect(db.state.calls[0].sql).toMatch(/\bmeta_attempts = 0\b/);
    expect(db.state.calls[0].sql).toMatch(/\bmeta_next_attempt_at = NULL\b/);
  });

  it("leaves the frozen whatsapp_request_id alone, and the detail that says why the row is here", async () => {
    // The id is frozen per row for the resend's sake, not in spite of it. If
    // DoubleTick honours a repeated messageId, reusing it means a message that
    // genuinely never arrived still goes out (DoubleTick never saw that id) while
    // one that did arrive is deduplicated -- both of which are what we want. A
    // fresh id would guarantee the duplicate.
    await requeueFailedSends("whatsapp");
    const { sql } = db.state.calls[0];
    expect(sql).not.toMatch(/whatsapp_request_id/);
    expect(sql).not.toMatch(/whatsapp_message_id/);
    expect(sql).not.toMatch(/whatsapp_detail/);
  });

  it("CLEARS google_request_id, so the resend ingests rather than re-polling a dead request", async () => {
    // **The one column this statement clears beyond the three, and the only
    // destination with an extra.** The Google step reads that column to decide
    // which of its two phases it is in: an id means a conversion is awaiting
    // Google's answer, so poll; no id means nothing has been ingested, so
    // ingest. Every row this statement can reach is `failed` or `rejected`, so
    // any id it still holds belongs to a request Google has already answered or
    // never will -- left in place, the resend would spend its whole 25-poll
    // budget re-asking about that dead request and never ingest anything.
    db.state.respond = () => [{ affectedRows: 3 }];
    expect(await requeueFailedSends("google", RESEND_AT)).toBe(3);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(
      /SET google_status = 'pending', google_attempts = 0, google_next_attempt_at = NULL, google_request_id = NULL/
    );
    expect(sql).toMatch(/AND google_status IN \('failed','rejected'\)/);
    // Google has no window of its own: the 90-day limit is on the CLICK, which
    // is not an instant this table holds.
    expect(sql).not.toMatch(/received_at/);
    expect(params).toEqual([]);
  });

  it("clears no request id for the other four, whose statements are untouched", async () => {
    // The extra SET is Google's alone. A `${action}_request_id` appearing in
    // another destination's statement would be a column name that does not
    // exist, and the statement would fail outright for every resend.
    for (const action of DESTINATIONS.filter((a) => a !== "google")) {
      db.state.calls.length = 0;
      await requeueFailedSends(action, RESEND_AT);
      expect(db.state.calls[0].sql, action).not.toMatch(/_request_id = NULL/);
    }
  });

  it("accepts openai, so a fixed key or pixel id can clear the ChatGPT Ads backlog", async () => {
    db.state.respond = () => [{ affectedRows: 4 }];
    expect(await requeueFailedSends("openai", RESEND_AT)).toBe(4);
    const { sql } = db.state.calls[0];
    expect(sql).toMatch(/SET openai_status = 'pending', openai_attempts = 0, openai_next_attempt_at = NULL/);
    expect(sql).toMatch(/AND openai_status IN \('failed','rejected'\)/);
  });

  it("will not requeue an openai row OpenAI could no longer accept, by their own window", async () => {
    // `timestamp_ms` comes from `received_at`, and OpenAI refuses anything
    // outside the last 7 days. Re-stamping it with today's time is not available
    // -- the row's whole purpose is to say when the conversion happened -- so
    // such a row is unsendable whatever anybody fixes. Requeueing it would spend
    // a claim to reach a step that can only skip it, and would replace the
    // record of the real failure with a skip; it stays `failed`, holding the
    // reason it failed for.
    //
    // The bounds are bound, not written into the SQL text: `received_at` is
    // written by Node, so comparing it against the database's own NOW() would
    // judge one clock's timestamps by another's.
    await requeueFailedSends("openai", RESEND_AT);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/AND \(received_at >= \? AND received_at <= \?\)/);
    expect(params).toEqual([OLDEST_SENDABLE, NEWEST_SENDABLE]);
  });

  it("leaves the other three statements with no window and nothing bound at all", async () => {
    // Meta, WhatsApp and Brevo take an event of any age, so the window must not
    // reach them: a Brevo failure from last month is still perfectly resendable
    // once BREVO_LIST_ID is fixed, and a window here would quietly refuse it.
    for (const action of DESTINATIONS.filter((a) => a !== "openai")) {
      db.state.calls.length = 0;
      await requeueFailedSends(action, RESEND_AT);
      const { sql, params } = db.state.calls[0];
      expect(sql, action).not.toMatch(/received_at/);
      expect(params, action).toEqual([]);
    }
  });

  it("refuses an unknown destination before any statement runs, rather than building a column name from it", async () => {
    // The destination is interpolated into column names. The route 400s an
    // unknown one; this is the floor under that, for whatever calls the store
    // next.
    for (const bad of ["", "mailchimp", "meta_status", undefined, null, "META"]) {
      await expect(requeueFailedSends(bad), JSON.stringify(bad)).rejects.toThrow(/unknown CRM events destination/);
    }
    expect(db.state.calls).toHaveLength(0);
  });

  it("reports a driver that gave no count as null rather than as nothing requeued", async () => {
    db.state.respond = () => [{}];
    expect(await requeueFailedSends("brevo")).toBeNull();
  });
});

describe("countResendableSends", () => {
  const COUNTED_AT = new Date("2026-10-14T12:00:00Z");
  const OLDEST_SENDABLE = new Date(COUNTED_AT.getTime() - OPENAI_MAX_EVENT_AGE_MS);
  const NEWEST_SENDABLE = new Date(COUNTED_AT.getTime() + OPENAI_MAX_EVENT_SKEW_MS);
  const WINDOW = "received_at >= ? AND received_at <= ?";

  const counts = (over = {}) => [
    [
      {
        meta_resendable: 1,
        meta_scrubbed: 2,
        whatsapp_resendable: 3,
        whatsapp_scrubbed: 4,
        brevo_resendable: 5,
        brevo_scrubbed: 6,
        openai_resendable: 7,
        openai_scrubbed: 8,
        openai_expired: 9,
        google_resendable: 10,
        google_scrubbed: 11,
        ...over,
      },
    ],
  ];

  it("counts, per destination, what the requeue would match and what it no longer can", async () => {
    // Every number different, so a column read into the wrong destination cannot
    // hide behind an equal neighbour. `expired` is zero for the four
    // destinations that have no window, and a real number for the one that does.
    db.state.respond = () => counts();
    expect(await countResendableSends(COUNTED_AT)).toEqual({
      meta: { resendable: 1, scrubbed: 2, expired: 0 },
      whatsapp: { resendable: 3, scrubbed: 4, expired: 0 },
      brevo: { resendable: 5, scrubbed: 6, expired: 0 },
      openai: { resendable: 7, scrubbed: 8, expired: 9 },
      // Google has no window of its own: its conversion actions bound the
      // CLICK's age, which is not an instant this table holds, so `expired` is
      // the literal zero sendableWindow produces for every destination but one.
      google: { resendable: 10, scrubbed: 11, expired: 0 },
    });
  });

  it("asks for every half in one statement, over the whole table and not the tab's period", async () => {
    // One statement, so the numbers are one snapshot and add up: "12 resendable,
    // 28 already scrubbed" has to account for the 40 failures an operator can
    // see on the destination card. And no period clause, because the resend is
    // not scoped to a period either -- the counters on the tab are, which is
    // exactly why they cannot answer this.
    //
    // The only `received_at` in it is OpenAI's own window, which is not a period
    // at all but their refusal to accept an old event; the four parameters are
    // its two edges, once for the resendable half and once for the expired one.
    db.state.respond = () => counts();
    await countResendableSends(COUNTED_AT);
    expect(db.state.calls).toHaveLength(1);
    const { sql, params } = db.state.calls[0];
    expect(sql).toMatch(/FROM signup_events\s*$/);
    expect(sql.match(/received_at/g)).toHaveLength(4);
    expect(params).toEqual([OLDEST_SENDABLE, NEWEST_SENDABLE, OLDEST_SENDABLE, NEWEST_SENDABLE]);
  });

  it("counts a scrubbed row as not resendable, by the same predicate the requeue uses", async () => {
    // A button that promises 40 and delivers 12 is worse than no button. The
    // resendable half must therefore read `scrubbed_at IS NULL`, exactly as the
    // UPDATE does, and the other two halves are what explain the shortfall.
    db.state.respond = () => counts();
    await countResendableSends(COUNTED_AT);
    const { sql } = db.state.calls[0];
    for (const action of DESTINATIONS) {
      const window = action === "openai" ? ` AND (${WINDOW})` : "";
      expect(sql, action).toContain(
        `COUNT(CASE WHEN ${action}_status IN ('failed','rejected') AND scrubbed_at IS NULL${window} THEN 1 END) AS ${action}_resendable`
      );
      expect(sql, action).toContain(
        `COUNT(CASE WHEN ${action}_status IN ('failed','rejected') AND scrubbed_at IS NOT NULL THEN 1 END) AS ${action}_scrubbed`
      );
    }
  });

  it("never promises an openai row older than OpenAI's window, which no resend could send", async () => {
    // **The failure this one exists for is a button offering forty and
    // delivering none** (spec 7a). The count and the UPDATE are built from one
    // clause, so the promise cannot drift from what the statement will match,
    // and both are built from the constants decideOpenaiSkip tests against, so
    // neither can drift from what the step will actually attempt.
    db.state.respond = () => counts();
    await countResendableSends(COUNTED_AT);
    const { sql } = db.state.calls[0];
    expect(sql).toContain(
      `COUNT(CASE WHEN openai_status IN ('failed','rejected') AND scrubbed_at IS NULL AND (${WINDOW}) THEN 1 END) AS openai_resendable`
    );
  });

  it("accounts for the shortfall the window causes, as a third number rather than a gap", async () => {
    // Scrubbed is no longer the whole of why a failure cannot be resent, so a
    // card showing 40 failures, 12 resendable and 2 scrubbed would leave 26
    // unexplained. `expired` is exactly the complement of the resendable half
    // within the unscrubbed failures, so the three add up to what the operator
    // is looking at.
    db.state.respond = () => counts();
    await countResendableSends(COUNTED_AT);
    const { sql } = db.state.calls[0];
    expect(sql).toContain(
      `COUNT(CASE WHEN openai_status IN ('failed','rejected') AND scrubbed_at IS NULL AND NOT (${WINDOW}) THEN 1 END) AS openai_expired`
    );
    // A literal zero for the destinations that cannot expire a failure, not a
    // missing column: the card prints this number, and `undefined` prints as
    // "undefined".
    for (const action of DESTINATIONS.filter((a) => a !== "openai")) {
      expect(sql, action).toContain(`0 AS ${action}_expired`);
    }
  });

  it("counts the same statuses the requeue requeues, and no others", async () => {
    db.state.respond = () => counts();
    await countResendableSends();
    const { sql } = db.state.calls[0];
    for (const [, list] of sql.matchAll(/_status IN \(([^)]*)\)/g)) {
      expect(list.split(",")).toEqual(REQUEUEABLE_STATUSES.map((status) => `'${status}'`));
    }
    for (const status of ["sent", "skipped", "invalid", "pending", "retrying"]) {
      expect(sql, status).not.toContain(`'${status}'`);
    }
  });

  it("reads a string count as a number, and an empty result as zeroes", async () => {
    // The page disables its control on a zero and prints the number beside it:
    // "0" is truthy and "12" is not a number.
    db.state.respond = () => counts({ meta_resendable: "7" });
    expect((await countResendableSends()).meta).toEqual({ resendable: 7, scrubbed: 2, expired: 0 });

    db.state.respond = () => [[]];
    expect(await countResendableSends()).toEqual({
      meta: { resendable: 0, scrubbed: 0, expired: 0 },
      whatsapp: { resendable: 0, scrubbed: 0, expired: 0 },
      brevo: { resendable: 0, scrubbed: 0, expired: 0 },
      openai: { resendable: 0, scrubbed: 0, expired: 0 },
      google: { resendable: 0, scrubbed: 0, expired: 0 },
    });
  });
});

describe("countEventsSince", () => {
  it("selects the stage, all five statuses and the count, grouped over the window, with no cap", async () => {
    const groups = [
      {
        stage: "lead",
        meta_status: "sent",
        whatsapp_status: "skipped",
        brevo_status: "sent",
        openai_status: "sent",
        google_status: "skipped",
        n: 3,
      },
    ];
    db.state.respond = () => [groups];
    const since = new Date("2026-09-13T00:00:00Z");
    const result = await countEventsSince(since);
    const { sql, params } = db.state.calls[0];
    // The whole statement, select list included. The fold reads the count as `n`, so
    // renaming the alias would make the funnel count groups instead of events.
    expect(sql).toMatch(
      /^\s*SELECT stage, meta_status, whatsapp_status, brevo_status, openai_status, google_status, COUNT\(\*\) AS n\s+FROM signup_events\s+WHERE received_at >= \?\s+GROUP BY stage, meta_status, whatsapp_status, brevo_status, openai_status, google_status\s*$/
    );
    expect(params).toEqual([since]);
    expect(result).toEqual(groups);
  });

  it("groups by every status it selects, so no column is one arbitrary row's value", async () => {
    // The two halves have to be the same list. A status selected and not grouped
    // is one row of the group standing for all of it, which is not a count of
    // anything; a status in neither reports zero for a destination that is
    // sending. Asserted per destination as well as by the statement above, so
    // the reason a missing one fails is readable.
    await countEventsSince(new Date("2026-09-13T00:00:00Z"));
    const { sql } = db.state.calls[0];
    const [selectList, groupList] = [sql.slice(0, sql.indexOf("FROM")), sql.slice(sql.indexOf("GROUP BY"))];
    for (const action of DESTINATIONS) {
      expect(selectList, `${action}_status is not selected`).toMatch(new RegExp(`\\b${action}_status\\b`));
      expect(groupList, `${action}_status is not grouped`).toMatch(new RegExp(`\\b${action}_status\\b`));
    }
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
