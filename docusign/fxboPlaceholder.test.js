import { describe, expect, it } from "vitest";
import {
  describePlaceholderRejection,
  detectUnsubstitutedPlaceholder,
  FXBO_PLACEHOLDER_LABELS,
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

describe("FXBO_PLACEHOLDER_LABELS", () => {
  it("is a closed set, so widening it is a deliberate change", () => {
    // Appending a label is NOT harmless. More labels means more fields classify
    // as labels, which means more payloads reach the corroboration threshold: a
    // DocuSign payload with roleName "Entity" and otherwise real values would flip
    // from placeholder:false to placeholder:true, and DocuSign would report an
    // FXBO test press where it should report an invalid application id. That is
    // the distinction this module exists to keep. "Entity", "Referer", "Form Name"
    // and "Unique ID" are ordinary English words, so they are not here.
    //
    // A real Test press substitutes every parameter at once, so these are enough:
    // client_id arrives as "Client ID" and is corroborated by the name and email.
    expect(FXBO_PLACEHOLDER_LABELS).toEqual([
      "Application ID + Link",
      "Application Type",
      "Client ID",
      "Client ID + Link",
      "Client Full Name",
      "Client First Name",
      "Client Last Name",
      "Client Email",
      "Client Country",
      "Client Title (Mr/Mrs/Ms)",
      "Current Time",
    ]);
  });

  it("does not call an ordinary English word a label", () => {
    // The array above can be bypassed: a member added to LABEL_SET outside it, or a
    // hard-coded comparison inside isFxboPlaceholderLabel, would widen the set and
    // still pass an equality check on the array. These are the four words that
    // caused the flip, pinned by what the function answers.
    for (const word of ["Entity", "Referer", "Form Name", "Unique ID"]) {
      expect(isFxboPlaceholderLabel(word), word).toBe(false);
    }
  });

  it("keeps a lone label a lone label when another field is such a word", () => {
    // The regression itself. The key field is a label, and nothing real
    // corroborates it: "Entity" is a role name here, an ordinary value. Were it
    // counted as a label, DocuSign would report an FXBO test press where it should
    // report an invalid application id.
    const detection = detectUnsubstitutedPlaceholder(
      { applicationId: "Client ID", email: "real@x.com", name: "Real Person", roleName: "Entity" },
      "applicationId"
    );
    expect(detection.kind).toBe("label");
    expect(detection.corroborating).toEqual([]);
    expect(detection.placeholder).toBe(false);
  });
});
