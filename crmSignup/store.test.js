// @vitest-environment node
//
// The schema text and the parameter builder are tested here, because both encode
// decisions a later edit could quietly undo: the composite key that makes a
// redelivery a no-op while still allowing five rows per client, and the
// per-action retry columns. The SQL statements themselves run against a fake
// pool in store.sql.test.js; no real MySQL server is involved in either file.
import { describe, it, expect, vi, afterEach } from "vitest";
import { SIGNUP_EVENTS_SCHEMA, INSERT_COLUMNS, buildInsertParams } from "./store.js";

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

// A column is a name, a type, then only the modifiers this table uses. Anything
// else after the type (two definitions run together by a missing comma) fails.
const COLUMN_DEFINITION =
  /^[a-z_]+ (BIGINT UNSIGNED|BIGINT|INT|TINYINT\(1\)|VARCHAR\(\d+\)|TEXT|LONGTEXT|DATETIME)( NOT NULL| NULL| DEFAULT ('[^']*'|\d+|CURRENT_TIMESTAMP)| AUTO_INCREMENT| ON UPDATE CURRENT_TIMESTAMP)*$/;
const KEY_DEFINITION = /^(PRIMARY KEY \(\w+\)|UNIQUE KEY \w+ \(\w+(, \w+)*\))$/;

describe("signup_events schema", () => {
  it("is unique on client AND stage, not client alone", () => {
    // A client legitimately has five rows, one per funnel stage. Unique on
    // crm_client_id alone would silently drop four of them.
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/UNIQUE KEY\s+\w+\s+\(crm_client_id,\s*stage\)/i);
    expect(SIGNUP_EVENTS_SCHEMA).not.toMatch(/UNIQUE KEY\s+\w+\s+\(crm_client_id\)/i);
  });

  it("gives each of the three actions its own counter and clock", () => {
    for (const column of [
      "meta_attempts",
      "meta_next_attempt_at",
      "whatsapp_attempts",
      "whatsapp_next_attempt_at",
      "brevo_attempts",
      "brevo_next_attempt_at",
    ]) {
      expect(SIGNUP_EVENTS_SCHEMA, column).toContain(column);
    }
  });

  it("stores the click id, so it can be frozen across stages", () => {
    expect(SIGNUP_EVENTS_SCHEMA).toMatch(/\bfbc\b/);
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

  it("defaults all three action statuses to pending", () => {
    for (const column of ["meta_status", "whatsapp_status", "brevo_status"]) {
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

  it("pins the two frozen id columns to the widths their values need", () => {
    // fbc is a Meta click id and needs room; the WhatsApp request id is a UUID.
    expect(definitionOf("fbc")).toBe("fbc VARCHAR(255) NULL");
    expect(definitionOf("whatsapp_request_id")).toBe("whatsapp_request_id VARCHAR(64) NULL");
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
      { fbc: "fb.1.1673035686000.ABC", whatsappRequestId: "11111111-2222-4333-8444-555555555555" },
      "{}"
    );
    expect(at(params, "fbc")).toBe("fb.1.1673035686000.ABC");
    expect(at(params, "whatsapp_request_id")).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("writes NULL, not a string, when an id is absent", () => {
    // `String(undefined)` would write the literal text "undefined", which
    // findExistingFbc would later hand back as a perfectly good click id.
    const params = buildInsertParams(FIELDS, {}, "{}");
    expect(at(params, "fbc")).toBeNull();
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
      { fbc: "fb.1.1673035686000.ABC", whatsappRequestId: "11111111-2222-4333-8444-555555555555" },
      "{}"
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
      whatsapp_request_id: "11111111-2222-4333-8444-555555555555",
      meta_status: "pending",
      meta_detail: null,
      whatsapp_status: "pending",
      whatsapp_detail: null,
      brevo_status: "pending",
      brevo_detail: null,
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
    const params = buildInsertParams(FIELDS, { fbc: "", whatsappRequestId: "" }, "{}");
    expect(at(params, "fbc")).toBeNull();
    expect(at(params, "whatsapp_request_id")).toBeNull();
  });

  it("writes NULL, not an empty string, for an empty text field", () => {
    // The empty-id test above covers the identifiers. Every other text field
    // reaches the row through the same str() path, and an empty one is absent,
    // not a stored "".
    const params = buildInsertParams({ email: "", utmSource: "", fullLink: "" }, {}, "{}");
    expect(at(params, "email")).toBeNull();
    expect(at(params, "utm_source")).toBeNull();
    expect(at(params, "full_link")).toBeNull();
  });

  it("never writes the word undefined for an empty payload", () => {
    // Dropping any of these defaults would write the literal text "undefined"
    // into a row, the class of bug this module exists to stop.
    const params = buildInsertParams({}, {}, null);
    expect(at(params, "crm_client_id")).toBe("");
    expect(at(params, "stage")).toBe("");
    expect(at(params, "record_type")).toBe("lead");
  });

  it("cuts a value to its column width rather than letting MySQL reject the row", () => {
    // normalise.js does not bound these lengths. ER_DATA_TOO_LONG would surface as
    // a 200 with the event lost, so FXBO would never retry it. These two are
    // diagnostic, so a cut still says where the signup came from. Identifiers are
    // not cut at all; see the boundary tests below.
    const params = buildInsertParams({ fullLink: "x".repeat(2000), referer: "y".repeat(600) }, {}, "{}");
    expect(at(params, "full_link")).toHaveLength(1024);
    expect(at(params, "referer")).toHaveLength(512);
  });

  // An identifier is never cut. A truncated click id is a wrong click id that still
  // looks like attribution; a truncated request id is not the one a retry would
  // replay. Over-width writes NULL and warns, and the event itself is still kept.
  describe("identifiers at their width boundary", () => {
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

    it("keeps a request id of exactly its column width, with no warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const id = "1".repeat(64);
      const params = buildInsertParams(FIELDS, { whatsappRequestId: id }, "{}");
      expect(at(params, "whatsapp_request_id")).toBe(id);
      expect(warn).not.toHaveBeenCalled();
    });

    it("writes NULL, and warns with the column and length, for a request id one over", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const params = buildInsertParams(FIELDS, { whatsappRequestId: "1".repeat(65) }, "{}");
      expect(at(params, "whatsapp_request_id")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toMatch(/\bwhatsapp_request_id\b/);
      expect(message).toMatch(/\b65\b/);
      expect(at(params, "crm_client_id")).toBe("88214");
    });
  });

  it("writes all three actions as invalid, with the reason, when given one", () => {
    const params = buildInsertParams(FIELDS, {}, "{}", "missing required fields: email");
    for (const action of ["meta", "whatsapp", "brevo"]) {
      expect(at(params, `${action}_status`), action).toBe("invalid");
      expect(at(params, `${action}_detail`), action).toBe("missing required fields: email");
    }
  });
});
