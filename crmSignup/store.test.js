// @vitest-environment node
//
// The MySQL wrapper itself is not unit-tested -- docusign/store.js sets that
// precedent, and a pool needs a database. What IS tested is the schema text and
// the parameter builder, because both encode decisions a later edit could
// quietly undo: the composite key that makes a redelivery a no-op while still
// allowing five rows per client, and the per-action retry columns.
import { describe, it, expect } from "vitest";
import { SIGNUP_EVENTS_SCHEMA, INSERT_COLUMNS, buildInsertParams } from "./store.js";

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
});
