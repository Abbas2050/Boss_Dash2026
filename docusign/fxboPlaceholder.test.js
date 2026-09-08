import { describe, expect, it } from "vitest";
import {
  describePlaceholderRejection,
  detectUnsubstitutedPlaceholder,
  isFxboPlaceholderLabel,
  isPlaceholderToken,
} from "./fxboPlaceholder.js";

// The exact body FXBO's "Test webhook" button on rule #36 posts: every parameter
// carries its label from the placeholder table instead of a value.
const TEST_WEBHOOK_PAYLOAD = {
  applicationId: "Application ID + Link",
  email: "Client Email",
  name: "Client Full Name",
  docType: "approve-form",
};

describe("isPlaceholderToken", () => {
  it("recognises the %token% and {{token}} forms", () => {
    expect(isPlaceholderToken("%application_id%")).toBe(true);
    expect(isPlaceholderToken("{{application_id}}")).toBe(true);
  });
  it("does not recognise ordinary values", () => {
    expect(isPlaceholderToken("4168")).toBe(false);
    expect(isPlaceholderToken("Application ID + Link")).toBe(false);
    expect(isPlaceholderToken("")).toBe(false);
    expect(isPlaceholderToken(null)).toBe(false);
  });
});

describe("isFxboPlaceholderLabel", () => {
  it("matches labels from FXBO's own placeholder table", () => {
    expect(isFxboPlaceholderLabel("Application ID + Link")).toBe(true);
    expect(isFxboPlaceholderLabel("Client Email")).toBe(true);
    expect(isFxboPlaceholderLabel("Client Title (Mr/Mrs/Ms)")).toBe(true);
  });
  it("tolerates case and repeated whitespace from an HTML copy-paste", () => {
    expect(isFxboPlaceholderLabel("  application id  +  link ")).toBe(true);
  });
  it("does not match anything outside the table", () => {
    expect(isFxboPlaceholderLabel("APP-TEST-001")).toBe(false);
    expect(isFxboPlaceholderLabel("Application ID")).toBe(false);
    expect(isFxboPlaceholderLabel("not-an-id")).toBe(false);
    expect(isFxboPlaceholderLabel("SMIT Datta")).toBe(false);
  });
});

describe("detectUnsubstitutedPlaceholder", () => {
  it("recognises the production Test webhook payload", () => {
    const d = detectUnsubstitutedPlaceholder(TEST_WEBHOOK_PAYLOAD, "applicationId");
    expect(d.placeholder).toBe(true);
    expect(d.kind).toBe("label");
  });

  // The corroborating signal, asserted directly: a test substitutes EVERY
  // parameter at once, so `email` arrives as "Client Email" — not an address.
  it("names the corroborating fields it found", () => {
    const d = detectUnsubstitutedPlaceholder(TEST_WEBHOOK_PAYLOAD, "applicationId");
    expect(d.corroborating.map((c) => c.field).sort()).toEqual(["email", "name"]);
    expect(d.corroborating.find((c) => c.field === "email")).toMatchObject({
      value: "Client Email",
      kind: "label",
    });
    expect(describePlaceholderRejection(d)).toContain("email");
  });

  it("a lone label with nothing corroborating it is NOT called a placeholder", () => {
    // This is the narrowness that matters: one field of English text is not
    // enough evidence to excuse a rule as a harmless test.
    const d = detectUnsubstitutedPlaceholder(
      { applicationId: "Application ID + Link", email: "client@example.com", name: "SMIT Datta" },
      "applicationId"
    );
    expect(d.kind).toBe("label");
    expect(d.corroborating).toEqual([]);
    expect(d.placeholder).toBe(false);
  });

  it("a raw %token% needs no corroboration — nothing real looks like that", () => {
    const d = detectUnsubstitutedPlaceholder({ applicationId: "%application_id%" }, "applicationId");
    expect(d.kind).toBe("token");
    expect(d.placeholder).toBe(true);
  });

  it("does not flag a genuinely malformed id", () => {
    for (const bad of ["not-an-id", "n/a", "???", "undefined", "Approved application"]) {
      expect(detectUnsubstitutedPlaceholder({ applicationId: bad, email: "a@b.com" }).placeholder).toBe(false);
    }
  });

  it("does not flag a real id, however it is shaped", () => {
    expect(detectUnsubstitutedPlaceholder({ applicationId: "4168" }).placeholder).toBe(false);
    expect(
      detectUnsubstitutedPlaceholder({
        applicationId: '<a href="https://portal.skylinkscapital.com/crm/applications/3892/view/">3892</a>',
      }).placeholder
    ).toBe(false);
  });

  it("ignores object-valued fields when looking for corroboration", () => {
    const d = detectUnsubstitutedPlaceholder(
      { applicationId: "Application ID + Link", user: { id: 10614 } },
      "applicationId"
    );
    expect(d.placeholder).toBe(false);
  });
});
