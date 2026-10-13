// @vitest-environment node
//
// Brevo takes a fixed set of attributes, every one of which had to be created
// in the account before it could be sent (done 2026-10-09). Posting an
// attribute Brevo does not know returns 400, which this design treats as
// permanent -- so a typo here means the contact silently never lands.
import { describe, it, expect, vi } from "vitest";
import {
  decideBrevoSkip,
  buildBrevoContact,
  classifyBrevoOutcome,
  upsertBrevoContact,
} from "./brevo.js";

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
  utmCampaign: "zero-spread-ind-2",
  referer: "https://skylinkscapital.com/en/",
  fullLink: "https://skylinkscapital.com/en/?fbclid=ABC",
  fxboUniqueId: "d3f1-aa",
};

describe("skip decisions", () => {
  it("runs only at registration", () => {
    expect(decideBrevoSkip({ stage: "registered", apiKey: "k" })).toBeNull();
    for (const stage of ["lead", "verified", "live_account", "first_deposit"]) {
      expect(decideBrevoSkip({ stage, apiKey: "k" }), stage).toEqual({
        reason: "stage not applicable",
      });
    }
  });

  it("skips silently when no key is configured", () => {
    expect(decideBrevoSkip({ stage: "registered", apiKey: "" })).toEqual({
      reason: "brevo not configured",
    });
  });

  it("does not gate on marketing consent", () => {
    // Decided 2026-10-09 and reaffirmed 2026-10-12: everyone lands in Brevo
    // with consent recorded as OPT_IN, and campaigns segment on it.
    expect(decideBrevoSkip({ stage: "registered", apiKey: "k", marketingConsent: false })).toBeNull();
  });
});

describe("buildBrevoContact", () => {
  it("builds an idempotent upsert into the configured list", () => {
    const contact = buildBrevoContact(FIELDS, { listId: "19" });
    expect(contact.email).toBe("ali.khan@example.com");
    expect(contact.updateEnabled).toBe(true);
    expect(contact.listIds).toEqual([19]);
  });

  it("maps every attribute to the id that exists in Brevo", () => {
    expect(buildBrevoContact(FIELDS, { listId: "19" }).attributes).toEqual({
      FIRSTNAME: "Ali",
      LASTNAME: "Khan",
      MIDDLE_NAME: "Hassan",
      EXT_ID: "88214",
      OPT_IN: true,
      ENTITY: "SVG Ltd",
      FORM_NAME: "SVG",
      LANGUAGE: "en",
      IS_IB: false,
      UTM_SOURCE: "meta",
      UTM_MEDIUM: "cpc",
      UTM_CAMPAIGN: "zero-spread-ind-2",
      REFERER: "https://skylinkscapital.com/en/",
    });
  });

  it("never sends the phone, and never sends an attribute Brevo lacks", () => {
    const { attributes } = buildBrevoContact(FIELDS, { listId: "19" });
    expect(JSON.stringify(attributes)).not.toContain("971507192185");
    expect(attributes.PHONE).toBeUndefined();
    expect(attributes.SMS).toBeUndefined();
    expect(attributes.COUNTRY).toBeUndefined();
    expect(attributes.IS_TEST).toBeUndefined();
    expect(attributes.MARKETING_CONSENT).toBeUndefined(); // consent rides on OPT_IN
    expect(attributes.CRM_CLIENT_ID).toBeUndefined(); // the id rides on EXT_ID
    expect(attributes.FULL_LINK).toBeUndefined();
  });

  it("omits empty text attributes but always sends the booleans", () => {
    const { attributes } = buildBrevoContact(
      { ...FIELDS, middleName: "", entity: "", utmMedium: "", marketingConsent: false },
      { listId: "19" }
    );
    expect("MIDDLE_NAME" in attributes).toBe(false);
    expect("ENTITY" in attributes).toBe(false);
    expect("UTM_MEDIUM" in attributes).toBe(false);
    // A false boolean is a real value, not an absent one.
    expect(attributes.OPT_IN).toBe(false);
    expect(attributes.IS_IB).toBe(false);
  });

  it("omits listIds entirely when no list is configured", () => {
    expect("listIds" in buildBrevoContact(FIELDS, { listId: "" })).toBe(false);
  });
});

describe("classifyBrevoOutcome", () => {
  it("treats 201 created and 204 updated as sent", () => {
    expect(classifyBrevoOutcome({ httpStatus: 201, body: { id: 5 } }).status).toBe("sent");
    expect(classifyBrevoOutcome({ httpStatus: 204, body: null }).status).toBe("sent");
  });

  it("retries transport errors, 429 and 5xx", () => {
    expect(classifyBrevoOutcome({ transportError: new Error("ETIMEDOUT") }).retryable).toBe(true);
    for (const httpStatus of [429, 500, 502, 503]) {
      expect(classifyBrevoOutcome({ httpStatus, body: {} }).retryable, String(httpStatus)).toBe(true);
    }
  });

  it("treats every other 4xx as permanent and keeps Brevo's own code", () => {
    const r = classifyBrevoOutcome({
      httpStatus: 400,
      body: { code: "invalid_parameter", message: "Attribute ENTITY does not exist" },
    });
    expect(r.retryable).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("invalid_parameter");
  });

  it("reports transport errors, 429 and 5xx as failed, never as sent", () => {
    expect(classifyBrevoOutcome({ transportError: new Error("ETIMEDOUT") }).status).toBe("failed");
    for (const httpStatus of [429, 500, 502, 503]) {
      expect(classifyBrevoOutcome({ httpStatus, body: {} }).status, String(httpStatus)).toBe("failed");
    }
  });

  it("never counts a response that is not 2xx as sent", () => {
    // Anything the classifier does not recognise must fail closed.
    for (const httpStatus of [302, 304, 0, undefined]) {
      expect(classifyBrevoOutcome({ httpStatus, body: {} }).status, String(httpStatus)).toBe("failed");
    }
  });

  it("treats every other 4xx as permanent, not only 400", () => {
    for (const httpStatus of [401, 403, 404, 409, 422]) {
      const r = classifyBrevoOutcome({ httpStatus, body: {} });
      expect(r.retryable, String(httpStatus)).toBe(false);
      expect(r.status, String(httpStatus)).toBe("failed");
    }
  });
});

describe("upsertBrevoContact", () => {
  it("authenticates with the api-key header", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }) }));
    await upsertBrevoContact({ fetchImpl, apiKey: "brevo-key", contact: { email: "a@b.c" } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/contacts");
    expect(init.headers["api-key"]).toBe("brevo-key");
  });

  it("turns a thrown fetch into a retryable outcome rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    expect((await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} })).retryable).toBe(true);
  });

  it("treats a 204 with no body as success", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no content");
      },
    }));
    expect((await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} })).status).toBe("sent");
  });

  it("posts the contact as JSON to the contacts endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }) }));
    const contact = { email: "ali.khan@example.com", updateEnabled: true, attributes: { EXT_ID: "88214" } };
    await upsertBrevoContact({ fetchImpl, apiKey: "k", contact });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(contact);
  });

  it("treats a thrown falsy value as a retryable transport failure", async () => {
    for (const thrown of [undefined, null, 0, "", false]) {
      const fetchImpl = vi.fn(async () => {
        throw thrown;
      });
      const r = await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} });
      expect(r.status, String(thrown)).toBe("failed");
      expect(r.retryable, String(thrown)).toBe(true);
    }
  });
});
