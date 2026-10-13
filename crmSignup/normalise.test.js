// @vitest-environment node
//
// The payload decisions that are easy to get wrong and expensive when wrong.
// Nothing here touches the network or a database.
import { describe, it, expect } from "vitest";
import {
  STAGES,
  isStage,
  PHONE_RE,
  isFalsyLiteral,
  deriveRecordType,
  deriveMiddleName,
  maskEmail,
  maskPhone,
  normaliseEvent,
} from "./normalise.js";

describe("stages", () => {
  it("knows exactly the five funnel stages", () => {
    expect(STAGES).toEqual(["lead", "registered", "verified", "live_account", "first_deposit"]);
  });

  it("rejects anything else, including near misses", () => {
    // The stage is typed by hand into each FXBO rule, so a typo is a real
    // failure mode and must not quietly create a sixth kind of row.
    expect(isStage("registered")).toBe(true);
    expect(isStage("Registered")).toBe(false);
    expect(isStage("register")).toBe(false);
    expect(isStage("")).toBe(false);
    expect(isStage(undefined)).toBe(false);
  });
});

describe("phone validation", () => {
  it("accepts both ends of the permitted length range", () => {
    expect(PHONE_RE.test("+12345678")).toBe(true);
    expect(PHONE_RE.test("+123456789012345")).toBe(true);
    expect(PHONE_RE.test("+971507192185")).toBe(true);
  });

  it("rejects one digit either side, a leading zero, and spacing", () => {
    expect(PHONE_RE.test("+1234567")).toBe(false);
    expect(PHONE_RE.test("+1234567890123456")).toBe(false);
    expect(PHONE_RE.test("+0123456789")).toBe(false);
    expect(PHONE_RE.test("971507192185")).toBe(false);
    expect(PHONE_RE.test("+971 50 719 2185")).toBe(false);
  });
});

describe("record type", () => {
  it("reads the recognised falsy literals as a client", () => {
    for (const v of ["0", "false", "FALSE", "no", "N", "off"]) {
      expect(deriveRecordType(v), v).toBe("client");
    }
  });

  it("reads absent, empty and unrecognised as a lead", () => {
    // A client who misses a welcome message is a support ticket; a lead who
    // gets a login link for an account that does not exist is a complaint.
    expect(deriveRecordType(undefined)).toBe("lead");
    expect(deriveRecordType("")).toBe("lead");
    expect(deriveRecordType("maybe")).toBe("lead");
    expect(deriveRecordType("1")).toBe("lead");
  });

  it("does not read null or undefined as a client", () => {
    // Both are falsy for consent and IB flags, where absent means no. For the
    // record type they mean unknown: a template variable that failed to render
    // arrives as one of these strings, and unknown resolves to lead.
    for (const v of ["null", "undefined"]) {
      expect(deriveRecordType(v), v).toBe("lead");
    }
  });
});

describe("isFalsyLiteral", () => {
  it("treats empty as falsy for ordinary flags", () => {
    expect(isFalsyLiteral("")).toBe(true);
    expect(isFalsyLiteral(undefined)).toBe(true);
    expect(isFalsyLiteral("1")).toBe(false);
  });

  it("still treats null and undefined as falsy, unlike the record type", () => {
    expect(isFalsyLiteral("null")).toBe(true);
    expect(isFalsyLiteral("undefined")).toBe(true);
  });
});

describe("middle name derivation", () => {
  it("takes what sits between a matching first and last name", () => {
    expect(deriveMiddleName("Ali Hassan Khan", "Ali", "Khan")).toBe("Hassan");
    expect(deriveMiddleName("Mohammed Ali Hassan Khan", "Mohammed", "Khan")).toBe("Ali Hassan");
  });

  it("returns empty when there is no middle to take", () => {
    expect(deriveMiddleName("Ali Khan", "Ali", "Khan")).toBe("");
    expect(deriveMiddleName("", "Ali", "Khan")).toBe("");
  });

  it("returns empty rather than guessing when the ends do not match", () => {
    expect(deriveMiddleName("John Smith Jones", "Bob", "Jones")).toBe("");
    expect(deriveMiddleName("John Smith Jones", "John", "Brown")).toBe("");
  });

  it("is not confused by case or extra spacing", () => {
    expect(deriveMiddleName("  ali   hassan   khan ", "Ali", "KHAN")).toBe("hassan");
  });
});

describe("masking", () => {
  it("never leaves the full address or number in the output", () => {
    expect(maskEmail("abbas.rahman@skylinkscapital.com")).not.toContain("abbas.rahman");
    expect(maskPhone("+971507192185")).not.toContain("7192185");
  });

  it("keeps enough to identify a record by eye", () => {
    expect(maskEmail("abbas@skylinkscapital.com")).toBe("a***@skylinkscapital.com");
    expect(maskPhone("+971507192185")).toBe("+971***85");
  });

  it("handles empty and malformed input without throwing", () => {
    expect(maskEmail("")).toBe("");
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskPhone("")).toBe("");
    expect(maskPhone("+123")).toBe("***");
  });
});

describe("normaliseEvent", () => {
  const RAW = {
    stage: "registered",
    client_id: "88214",
    first_name: "Ali",
    last_name: "Khan",
    full_name: "Ali Hassan Khan",
    email: "  Ali.Khan@Example.COM ",
    phone: "+971507192185",
    is_lead: "0",
    marketing_consent: "1",
    source: "SVG",
    entity: "SVG Ltd",
    is_ib: "0",
    language: "en",
    utm_source: "meta",
    utm_medium: "cpc",
    utm_campaign: "zero-spread-ind-2",
    referer: "https://skylinkscapital.com/en/",
    full_link: "https://skylinkscapital.com/en/?utm_source=meta&fbclid=IwY2xjawUsILdI",
    unique_id: "d3f1-aa",
  };

  it("maps a complete payload", () => {
    const { valid, missing, fields } = normaliseEvent(RAW);
    expect(valid).toBe(true);
    expect(missing).toEqual([]);
    expect(fields).toEqual({
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
      utmCampaign: "zero-spread-ind-2",
      referer: "https://skylinkscapital.com/en/",
      fullLink: "https://skylinkscapital.com/en/?utm_source=meta&fbclid=IwY2xjawUsILdI",
      fxboUniqueId: "d3f1-aa",
    });
  });

  it("names every missing required field", () => {
    const { valid, missing } = normaliseEvent({ ...RAW, client_id: "", email: "  " });
    expect(valid).toBe(false);
    expect(missing).toEqual(["crmClientId", "email"]);
  });

  it("treats an unknown or absent stage as a missing required field", () => {
    expect(normaliseEvent({ ...RAW, stage: "typo" }).missing).toEqual(["stage"]);
    expect(normaliseEvent({ ...RAW, stage: undefined }).missing).toEqual(["stage"]);
  });

  it("does not treat a missing phone as invalid", () => {
    // A bad phone is a WhatsApp skip, not a bad event.
    const { valid, fields } = normaliseEvent({ ...RAW, phone: "" });
    expect(valid).toBe(true);
    expect(fields.phone).toBe("");
  });

  it("defaults absent flags to false and never throws on an empty body", () => {
    const { valid, missing, fields } = normaliseEvent({});
    expect(valid).toBe(false);
    expect(missing).toEqual(["stage", "crmClientId", "firstName", "email"]);
    expect(fields.marketingConsent).toBe(false);
    expect(fields.isIb).toBe(false);
    expect(fields.recordType).toBe("lead");
  });
});
