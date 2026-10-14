// @vitest-environment node
//
// The schema text and the parameter builder are tested here, because both encode
// decisions a later edit could quietly undo: the composite key that makes a
// redelivery a no-op while still allowing five rows per client, and the
// per-action retry columns. The SQL statements themselves run against a fake
// pool in store.sql.test.js; no real MySQL server is involved in either file.
import { describe, it, expect, vi, afterEach } from "vitest";
import { SIGNUP_EVENTS_SCHEMA, INSERT_COLUMNS, SCRUB_COLUMNS, buildInsertParams } from "./store.js";

// The DDL body split on top-level commas. A comma inside parentheses belongs to
// a type or a key, not to the list, so depth is tracked.
function ddlSegments() {
  const body = SIGNUP_EVENTS_SCHEMA.slice(
    SIGNUP_EVENTS_SCHEMA.indexOf("(") + 1,
    SIGNUP_EVENTS_SCHEMA.lastIndexOf(")")
  );
  const segments = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      segments.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

const definitionOf = (column) => ddlSegments().find((segment) => segment.startsWith(`${column} `));
const widthOf = (column) => Number(definitionOf(column).match(/VARCHAR\((\d+)\)/)[1]);

// The text columns buildInsertParams cuts, with the field that feeds each one.
const CUT_COLUMNS = [
  ["record_type", "recordType"],
  ["is_lead_raw", "isLeadRaw"],
  ["fxbo_unique_id", "fxboUniqueId"],
  ["first_name", "firstName"],
  ["middle_name", "middleName"],
  ["last_name", "lastName"],
  ["email", "email"],
  ["phone", "phone"],
  ["entity", "entity"],
  ["source", "source"],
  ["language", "language"],
  ["utm_source", "utmSource"],
  ["utm_medium", "utmMedium"],
  ["utm_campaign", "utmCampaign"],
  ["referer", "referer"],
  ["full_link", "fullLink"],
];

// A column is a name, a type, then only the modifiers this table uses. Anything
// else after the type (two definitions run together by a missing comma) fails.
const COLUMN_DEFINITION =
  /^[a-z_]+ (BIGINT UNSIGNED|BIGINT|INT|TINYINT\(1\)|VARCHAR\(\d+\)|TEXT|LONGTEXT|DATETIME)( NOT NULL| NULL| DEFAULT ('[^']*'|\d+|CURRENT_TIMESTAMP)| AUTO_INCREMENT| ON UPDATE CURRENT_TIMESTAMP)*$/;
const KEY_DEFINITION = /^(PRIMARY KEY \(\w+\)|(UNIQUE )?KEY \w+ \(\w+(, \w+)*\))$/;

describe("signup_events schema", () => {
  it("is unique on client AND stage, not client alone", () => {
    // A client legitimately has five rows, one per funnel stage. Unique on
    // crm_client_id alone would silently drop four of them.
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/UNIQUE KEY\s+\w+\s+\(crm_client_id,\s*stage\)/i);
    expect(SIGNUP_EVENTS_SCHEMA).not.toMatch(/UNIQUE KEY\s+\w+\s+\(crm_client_id\)/i);
  });

  it("gives each of the four actions its own counter and clock", () => {
    for (const column of [
      "meta_attempts",
      "meta_next_attempt_at",
      "whatsapp_attempts",
      "whatsapp_next_attempt_at",
      "brevo_attempts",
      "brevo_next_attempt_at",
      "openai_attempts",
      "openai_next_attempt_at",
    ]) {
      expect(SIGNUP_EVENTS_SCHEMA, column).toContain(column);
    }
  });

  it("gives the fourth destination exactly the shape of the other three", () => {
    // Not merely present: the same types and the same defaults. A status column
    // that is nullable, or one without the 'pending' default, holds NULL on a row
    // the claim and the scrub both read a word from -- and NULL is in no status
    // list at all, so such a row is never claimed and never scrubbed.
    expect(definitionOf("openai_status")).toBe(definitionOf("brevo_status").replace(/^brevo_/, "openai_"));
    expect(definitionOf("openai_detail")).toBe(definitionOf("brevo_detail").replace(/^brevo_/, "openai_"));
    expect(definitionOf("openai_attempts")).toBe(definitionOf("brevo_attempts").replace(/^brevo_/, "openai_"));
    expect(definitionOf("openai_next_attempt_at")).toBe(
      definitionOf("brevo_next_attempt_at").replace(/^brevo_/, "openai_")
    );
  });

  it("stores the click id, so it can be frozen across stages", () => {
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/\bfbc\b/);
  });

  it("stores OpenAI's click id too, in its own column, so it can be frozen the same way", () => {
    // `oppref` arrives inside full_link, which is scrubbed about a minute after
    // signup, and the first deposit is a different row weeks later whose own
    // full_link is empty. OpenAI's Conversions API does not capture it, so this
    // column is the only copy of the ad click there will ever be.
    expect(definitionOf("oppref")).toBe("oppref VARCHAR(512) NULL");
  });

  it("stores the WhatsApp request id, so a retry cannot send a second welcome", () => {
    // A send times out after 10s, and a timeout does not mean the message was
    // not delivered. A retry carrying a NEW messageId would be a second
    // welcome to the client, so the id is frozen on the row like the fbc.
    expect(SIGNUP_EVENTS_SCHEMA).toContain("whatsapp_request_id");
  });

  it("stores the raw payload", () => {
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/raw_payload\s+LONGTEXT/i);
  });

  it("stores the is_lead literal, which is the one thing raw_payload was kept for", () => {
    // raw_payload is scrubbed with the rest of the client data, so the literal
    // FXBO renders into %client_is_lead% needs a column of its own. Without it
    // CUTOVER step 5 has nothing to read, and a literal missing from
    // CLIENT_LITERALS means every client is read as a lead and nobody gets a
    // WhatsApp message.
    expect(definitionOf("is_lead_raw")).toBe("is_lead_raw VARCHAR(32) NULL");
  });

  it("records when a row was scrubbed, so the scrub is auditable and the backstop has an index", () => {
    // Nullable on purpose: NULL is "never scrubbed", which is what the backstop
    // selects on and what the settings tab reads to tell a scrubbed row apart
    // from one that never carried the value.
    expect(definitionOf("scrubbed_at")).toBe("scrubbed_at DATETIME NULL");
  });

  it("indexes the two columns the retention passes filter on, scrubbed_at first", () => {
    // scrubbed_at leads because it is the selective half: rows scrub within a
    // minute, so the unscrubbed set stays a handful while "older than thirty
    // days" grows to cover nearly the whole table.
    expect(ddlSegments()).toContain("KEY idx_signup_events_retention (scrubbed_at, received_at)");
  });

  it("defaults every action status to pending", () => {
    for (const column of ["meta_status", "whatsapp_status", "brevo_status", "openai_status"]) {
      expect(SIGNUP_EVENTS_SCHEMA, column).toMatch(
        new RegExp(`${column}[^,]*DEFAULT 'pending'`, "i")
      );
    }
  });

  it("names every insert column as a real column of the table", () => {
    // INSERT_COLUMNS and the schema are two lists that must agree. A mismatch
    // fails the first live webhook on an unknown column, and a bare toContain
    // would pass `whatsapp_request_idx` for `whatsapp_request_id`.
    for (const column of INSERT_COLUMNS) {
      expect(SIGNUP_EVENTS_SCHEMA, column).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
    }
  });

  it("never lets an empty payload write NULL into a NOT NULL column", () => {
    // A NOT NULL column that an organic lead leaves null (no Meta click, so no
    // fbc) would reject every such signup. The route turns that into a 200, so
    // FXBO never retries it and the event is lost.
    const params = buildInsertParams({}, {}, null);
    expect(params).toContain(null);
    INSERT_COLUMNS.forEach((column, i) => {
      if (params[i] === null) expect(definitionOf(column), column).not.toMatch(/NOT NULL/);
    });
  });

  it("requires every NOT NULL column without a default to be an insert column", () => {
    const required = ddlSegments()
      .filter((s) => /NOT NULL/.test(s) && !/DEFAULT/.test(s) && !s.startsWith("id "))
      .map((s) => s.split(" ")[0]);
    expect(required.length).toBeGreaterThan(0);
    for (const column of required) {
      expect(INSERT_COLUMNS, column).toContain(column);
    }
  });

  it("splits into well-formed column and key definitions, so a missing comma fails here", () => {
    const segments = ddlSegments();
    expect(segments.length).toBeGreaterThan(20);
    for (const segment of segments) {
      expect(COLUMN_DEFINITION.test(segment) || KEY_DEFINITION.test(segment), segment).toBe(true);
    }
    expect(segments).toContain("PRIMARY KEY (id)");
  });

  it("pins the three frozen id columns to the widths their values need", () => {
    // fbc is a Meta click id and needs room; oppref is opaque and passed to
    // OpenAI unmodified, so it is given more; the WhatsApp request id is a UUID.
    expect(definitionOf("fbc")).toBe("fbc VARCHAR(255) NULL");
    expect(definitionOf("oppref")).toBe("oppref VARCHAR(512) NULL");
    expect(definitionOf("whatsapp_request_id")).toBe("whatsapp_request_id VARCHAR(64) NULL");
  });
});

// This table stores statistics, not client records. FXBO is the system of record
// for who a client is; this one only has to say whether client 48217 got their
// welcome and to recognise FXBO's redeliveries. The client data is here only
// because the endpoint answers FXBO immediately and sends afterwards, so the
// phone and the email have to survive from receipt until all three destinations
// settle, retries included -- and after that nothing needs them.
describe("the scrub list", () => {
  it("is exactly the client's own fields", () => {
    // Pinned as a whole list rather than checked member by member, so neither a
    // column dropped from it nor one added to it can pass. Both directions
    // matter: a dropped one keeps client data for ever, and an added one deletes
    // a statistic the table exists for.
    expect(SCRUB_COLUMNS).toEqual([
      "first_name",
      "middle_name",
      "last_name",
      "email",
      "phone",
      "full_link",
      "referer",
      "raw_payload",
    ]);
  });

  it("never scrubs either frozen click id", () => {
    // Both are captured at signup and reused weeks later for the first-deposit
    // conversion. Scrubbing one would send every later conversion to that
    // platform with no ad attached -- and both platforms would accept all of
    // them without complaint, which is the whole hazard: there is no error to
    // notice, only a funnel that stops attributing.
    //
    // `oppref` has no second source at all. Meta's is rebuildable from a
    // full_link in principle; OpenAI documents that their Conversions API does
    // not capture theirs, and the deposit row's own full_link is empty.
    expect(SCRUB_COLUMNS).not.toContain("fbc");
    expect(SCRUB_COLUMNS).not.toContain("oppref");
  });

  it("never scrubs the dedupe key", () => {
    // Without crm_client_id, FXBO's redelivery of a stage no longer collides on
    // (crm_client_id, stage): it inserts a second row and sends a second welcome.
    expect(SCRUB_COLUMNS).not.toContain("crm_client_id");
    expect(SCRUB_COLUMNS).not.toContain("stage");
  });

  it("never scrubs the statistics the table exists for", () => {
    // Segmentation, not identity. These are the figures the settings tab counts
    // and the only record of where a client came from; FXBO cannot be asked for
    // them per funnel stage after the fact.
    for (const column of [
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
      "scrubbed_at",
    ]) {
      expect(SCRUB_COLUMNS, column).not.toContain(column);
    }
  });

  it("names only columns of the table, every one of them nullable", () => {
    // A scrub of a NOT NULL column would fail the UPDATE and leave the row
    // holding everything, which is the failure that looks like nothing happening.
    for (const column of SCRUB_COLUMNS) {
      expect(definitionOf(column), column).toBeDefined();
      expect(definitionOf(column), column).not.toMatch(/NOT NULL/);
    }
  });

  it("covers every column of the table that holds the client's own data", () => {
    // The other direction of the first test, read off the schema rather than a
    // literal list: a new client-data column added to the table and not to the
    // scrub list would keep that data for ever, and nothing else here would say so.
    const CLIENT_DATA = [
      "first_name",
      "middle_name",
      "last_name",
      "email",
      "phone",
      "full_link",
      "referer",
      "raw_payload",
    ];
    for (const column of CLIENT_DATA) {
      expect(SIGNUP_EVENTS_SCHEMA, column).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
      expect(SCRUB_COLUMNS, column).toContain(column);
    }
  });
});

describe("buildInsertParams", () => {
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
    isLeadRaw: "0",
  };

  it("converts booleans to the 1/0 MySQL stores", () => {
    const params = buildInsertParams(FIELDS, { fbc: "fb.1.1.ABC" }, "{}");
    expect(params).toContain(1); // marketingConsent
    expect(params).toContain(0); // isIb
    expect(params).not.toContain(true);
    expect(params).not.toContain(false);
  });

  // By column name, never by position: `fbc` and `whatsapp_request_id` are
  // adjacent, so `toContain` would pass just as happily with the two swapped —
  // and a UUID landing in `fbc` is the "quietly broken funnel" this module
  // exists to avoid.
  const at = (params, column) => params[INSERT_COLUMNS.indexOf(column)];
const RECEIVED = new Date("2026-10-13T10:00:00Z");

  it("puts every parameter in its own column", () => {
    const params = buildInsertParams(FIELDS, {}, "{}");
    expect(params).toHaveLength(INSERT_COLUMNS.length);
    expect(at(params, "crm_client_id")).toBe("88214");
    expect(at(params, "stage")).toBe("registered");
    expect(at(params, "email")).toBe("ali.khan@example.com");
    expect(at(params, "source")).toBe("SVG");
  });

  it("carries each frozen id in its own column", () => {
    const params = buildInsertParams(
      FIELDS,
      {
        fbc: "fb.1.1673035686000.ABC",
        oppref: "oppref-XYZ",
        whatsappRequestId: "11111111-2222-4333-8444-555555555555",
      },
      "{}"
    );
    expect(at(params, "fbc")).toBe("fb.1.1673035686000.ABC");
    expect(at(params, "oppref")).toBe("oppref-XYZ");
    expect(at(params, "whatsapp_request_id")).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("writes NULL, not a string, when an id is absent", () => {
    // `String(undefined)` would write the literal text "undefined", which
    // findExistingClickIds would later hand back as a perfectly good click id.
    const params = buildInsertParams(FIELDS, {}, "{}");
    expect(at(params, "fbc")).toBeNull();
    expect(at(params, "oppref")).toBeNull();
    expect(at(params, "whatsapp_request_id")).toBeNull();
  });

  it("serialises the raw payload as a string", () => {
    const params = buildInsertParams(FIELDS, {}, { a: 1 });
    expect(params[params.length - 1]).toBe('{"a":1}');
  });

  it("does not throw on an unserialisable payload", () => {
    const circular = {};
    circular.self = circular;
    expect(() => buildInsertParams(FIELDS, {}, circular)).not.toThrow();
  });

  it("pins every column to its own value, not just the four above", () => {
    // The tests above name only some columns. Every value here is distinct, so
    // swapping any two parameters (two names, two UTM fields, the two booleans)
    // moves a value and fails a line.
    const params = buildInsertParams(
      FIELDS,
      {
        fbc: "fb.1.1673035686000.ABC",
        oppref: "oppref-XYZ",
        whatsappRequestId: "11111111-2222-4333-8444-555555555555",
      },
      "{}",
      null,
      RECEIVED
    );
    const expected = {
      crm_client_id: "88214",
      stage: "registered",
      fxbo_unique_id: "d3f1-aa",
      first_name: "Ali",
      middle_name: "Hassan",
      last_name: "Khan",
      email: "ali.khan@example.com",
      phone: "+971507192185",
      record_type: "client",
      is_lead_raw: "0",
      marketing_consent: 1,
      is_ib: 0,
      entity: "SVG Ltd",
      source: "SVG",
      language: "en",
      utm_source: "meta",
      utm_medium: "cpc",
      utm_campaign: "zero-spread",
      referer: "https://skylinkscapital.com/en/",
      full_link: "https://skylinkscapital.com/en/?fbclid=ABC",
      fbc: "fb.1.1673035686000.ABC",
      oppref: "oppref-XYZ",
      whatsapp_request_id: "11111111-2222-4333-8444-555555555555",
      meta_status: "pending",
      meta_detail: null,
      whatsapp_status: "pending",
      whatsapp_detail: null,
      brevo_status: "pending",
      brevo_detail: null,
      openai_status: "pending",
      openai_detail: null,
      received_at: RECEIVED,
      raw_payload: "{}",
    };
    // The table must cover every column, so a new column cannot slip in unpinned.
    expect(Object.keys(expected).sort()).toEqual([...INSERT_COLUMNS].sort());
    for (const [column, value] of Object.entries(expected)) {
      expect(at(params, column), column).toBe(value);
    }
  });

  it("writes NULL for an empty id too, not only for an absent one", () => {
    // deriveFbc returns "" for every lead that carried no Meta click, so an
    // empty string is the common case here, not an edge case.
    const params = buildInsertParams(FIELDS, { fbc: "", oppref: "", whatsappRequestId: "" }, "{}");
    expect(at(params, "fbc")).toBeNull();
    expect(at(params, "oppref")).toBeNull();
    expect(at(params, "whatsapp_request_id")).toBeNull();
  });

  it("writes NULL, not an empty string, for an empty text field", () => {
    // The empty-id test above covers the identifiers. Every other text field
    // reaches the row through the same str() path, and an empty one is absent,
    // not a stored "".
    const params = buildInsertParams({ email: "", utmSource: null, fullLink: "" }, {}, "{}");
    expect(at(params, "email")).toBeNull();
    expect(at(params, "utm_source")).toBeNull();
    expect(at(params, "full_link")).toBeNull();
  });

  it("never writes the word undefined, or null as text, for an empty payload", () => {
    // Dropping any of these defaults would write the literal text "undefined"
    // into a row, the class of bug this module exists to stop. Checking the whole
    // row catches a default dropped from any text field, not just three of them.
    const params = buildInsertParams({}, {}, null);
    expect(params).not.toContain("undefined");
    expect(params).not.toContain("null");
    expect(at(params, "crm_client_id")).toBe("");
    expect(at(params, "stage")).toBe("");
    expect(at(params, "record_type")).toBe("lead");
  });

  it("cuts every text column to its own schema width, not a neighbour's", () => {
    // normalise.js does not bound these lengths. ER_DATA_TOO_LONG would surface as
    // a 200 with the event lost, so FXBO would never retry it. Each column is fed
    // one character over its own width and must come out exactly at it.
    for (const [column, key] of CUT_COLUMNS) {
      const params = buildInsertParams({ [key]: "x".repeat(widthOf(column) + 1) }, {}, "{}");
      expect(at(params, column), column).toHaveLength(widthOf(column));
    }
  });

  it("cuts by code point, so a surrogate pair is never split", () => {
    // Every other value in this file is ASCII, where a UTF-16 unit and a character
    // are the same thing. A cut that counts units would leave half a pair at the end.
    const params = buildInsertParams({ phone: "😀".repeat(33) }, {}, "{}");
    const phone = at(params, "phone");
    expect(Array.from(phone)).toHaveLength(32);
    expect(Array.from(phone).every((c) => c === "😀")).toBe(true);
  });

  it("never cuts the dedupe key: crm_client_id and stage reach the builder whole", () => {
    // Two values that cut to one would collide into one row, and findExistingFbc looks
    // the id up uncut. insertSignupEvent refuses an over-width key before any statement
    // runs (store.sql.test.js); the builder must not hide it first.
    const params = buildInsertParams({ crmClientId: "9".repeat(256), stage: "s".repeat(40) }, {}, "{}");
    expect(at(params, "crm_client_id")).toHaveLength(256);
    expect(at(params, "stage")).toHaveLength(40);
  });

  it("writes received_at from the Node clock, so one mysql2 conversion covers the write and the read", () => {
    // The column default is the database clock. Node writing it means the same process
    // clock and the same driver conversion apply on the way in and on the way out.
    expect(at(buildInsertParams(FIELDS, {}, "{}", null, RECEIVED), "received_at")).toBe(RECEIVED);
    const stamped = at(buildInsertParams(FIELDS, {}, "{}"), "received_at");
    expect(stamped).toBeInstanceOf(Date);
    expect(Math.abs(stamped.getTime() - Date.now())).toBeLessThan(5000);
  });

  it("writes NULL for a null click id or request id, not the word null", () => {
    const params = buildInsertParams(FIELDS, { fbc: null, oppref: null, whatsappRequestId: null }, "{}");
    expect(at(params, "fbc")).toBeNull();
    expect(at(params, "oppref")).toBeNull();
    expect(at(params, "whatsapp_request_id")).toBeNull();
  });

  // fbc is never cut: a truncated click id is attribution that silently never matches.
  // Over-width writes NULL and warns, and the event itself is still kept.
  describe("fbc at its width boundary", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps a click id of exactly its column width, with no warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fbc = "f".repeat(255);
      const params = buildInsertParams(FIELDS, { fbc }, "{}");
      expect(at(params, "fbc")).toBe(fbc);
      expect(warn).not.toHaveBeenCalled();
    });

    it("writes NULL, and warns with the column and length, for a click id one over", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const params = buildInsertParams(FIELDS, { fbc: "f".repeat(256) }, "{}");
      expect(at(params, "fbc")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toMatch(/\bfbc\b/);
      expect(message).toMatch(/\b256\b/);
      // The event is kept: losing attribution is recoverable, losing the signup is not.
      expect(at(params, "crm_client_id")).toBe("88214");
    });

  });

  // oppref is never cut either, and for the same reason: OpenAI passes it through
  // unmodified, so a cut value is a different click id that matches nothing.
  describe("oppref at its width boundary", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps a click id of exactly its column width, with no warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const oppref = "o".repeat(512);
      const params = buildInsertParams(FIELDS, { oppref }, "{}");
      expect(at(params, "oppref")).toBe(oppref);
      expect(warn).not.toHaveBeenCalled();
    });

    it("writes NULL, and warns with the column and length, for a click id one over", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const params = buildInsertParams(FIELDS, { oppref: "o".repeat(513) }, "{}");
      expect(at(params, "oppref")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toMatch(/\boppref\b/);
      expect(message).toMatch(/\b513\b/);
      // The event is kept: losing attribution is recoverable, losing the signup is not.
      expect(at(params, "crm_client_id")).toBe("88214");
    });
  });

  // whatsapp_request_id is cut, not NULLed. The worker reads it back from the row on
  // every attempt, so a NULL would mint a fresh id per attempt: the second welcome the
  // column exists to prevent. A cut value is replayed verbatim, so the freeze holds.
  describe("whatsapp_request_id at its width boundary", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps a request id of exactly its column width, with no warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const id = "1".repeat(64);
      const params = buildInsertParams(FIELDS, { whatsappRequestId: id }, "{}");
      expect(at(params, "whatsapp_request_id")).toBe(id);
      expect(warn).not.toHaveBeenCalled();
    });

    it("cuts a request id one over to its width, and never writes NULL for it", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const params = buildInsertParams(FIELDS, { whatsappRequestId: "1".repeat(65) }, "{}");
      expect(at(params, "whatsapp_request_id")).toBe("1".repeat(64));
      expect(warn).not.toHaveBeenCalled();
      expect(at(params, "crm_client_id")).toBe("88214");
    });
  });

  it("writes every action as invalid, with the reason, when given one", () => {
    // Every one of them, because the 7-day delete asks for all four at once: a
    // destination left `pending` here would make that condition unsatisfiable
    // and no invalid row would ever be deleted again.
    const params = buildInsertParams(FIELDS, {}, "{}", "missing required fields: email");
    for (const action of ["meta", "whatsapp", "brevo", "openai"]) {
      expect(at(params, `${action}_status`), action).toBe("invalid");
      expect(at(params, `${action}_detail`), action).toBe("missing required fields: email");
    }
  });
});
