// @vitest-environment node
//
// Brevo takes a fixed set of attributes, every one of which had to be created
// in the account before it could be sent (done 2026-10-09). Posting an
// attribute Brevo does not know returns 400, which this design treats as
// permanent -- so a typo here means the contact silently never lands.
import { describe, it, expect, vi } from "vitest";
import { describeSendTimeout, stalledBodyResponse } from "./sendTimeout.contract.js";
import {
  decideBrevoSkip,
  buildBrevoContact,
  classifyBrevoOutcome,
  upsertBrevoContact,
} from "./brevo.js";

// The two booleans are set in opposite polarity to each other, so a swapped or
// hardcoded boolean cannot produce the same output as the right one. The
// opposite pair is exercised again in its own case below.
const FIELDS = {
  stage: "registered",
  crmClientId: "88214",
  firstName: "Ali",
  middleName: "Hassan",
  lastName: "Khan",
  email: "ali.khan@example.com",
  phone: "+971507192185",
  recordType: "client",
  marketingConsent: false,
  source: "SVG",
  entity: "SVG Ltd",
  isIb: true,
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

  it("treats every blank or missing key as unconfigured", () => {
    for (const apiKey of ["", "   ", undefined, null]) {
      expect(decideBrevoSkip({ stage: "registered", apiKey }), String(apiKey)).toEqual({
        reason: "brevo not configured",
      });
    }
  });

  it("reports an unconfigured key ahead of the stage", () => {
    expect(decideBrevoSkip({ stage: "lead", apiKey: "" })).toEqual({ reason: "brevo not configured" });
  });

  it("does not gate on marketing consent", () => {
    // Decided 2026-10-09 and reaffirmed 2026-10-12: everyone lands in Brevo
    // with consent recorded as OPT_IN, and campaigns segment on it.
    expect(decideBrevoSkip({ stage: "registered", apiKey: "k", marketingConsent: false })).toBeNull();
  });
});

describe("buildBrevoContact", () => {
  it("builds an idempotent upsert into the configured list", () => {
    const contact = buildBrevoContact({ ...FIELDS, email: "  Ali.Khan@Example.COM " }, { listId: "19" });
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
      OPT_IN: false,
      ENTITY: "SVG Ltd",
      FORM_NAME: "SVG",
      LANGUAGE: "en",
      IS_IB: true,
      UTM_SOURCE: "meta",
      UTM_MEDIUM: "cpc",
      UTM_CAMPAIGN: "zero-spread-ind-2",
      REFERER: "https://skylinkscapital.com/en/",
    });
  });

  it("carries each boolean from its own field, in the opposite pair too", () => {
    const { attributes } = buildBrevoContact(
      { ...FIELDS, marketingConsent: true, isIb: false },
      { listId: "19" }
    );
    expect(attributes.OPT_IN).toBe(true);
    expect(attributes.IS_IB).toBe(false);
  });

  it("carries both booleans as true together: a consenting introducing broker", () => {
    // The fourth combination, and a realistic production state. Each boolean
    // must stand on its own field rather than be derived from the other.
    const { attributes } = buildBrevoContact(
      { ...FIELDS, marketingConsent: true, isIb: true },
      { listId: "19" }
    );
    expect(attributes.OPT_IN).toBe(true);
    expect(attributes.IS_IB).toBe(true);
  });

  it("never sends the phone, and never sends an attribute Brevo lacks", () => {
    const contact = buildBrevoContact(FIELDS, { listId: "19" });
    const { attributes } = contact;
    expect(JSON.stringify(contact)).not.toContain("971507192185");
    // Insertion order means nothing to Brevo, so compare the keys as a set.
    expect(Object.keys(contact).sort()).toEqual(["email", "updateEnabled", "attributes", "listIds"].sort());
    expect(attributes.PHONE).toBeUndefined();
    expect(attributes.SMS).toBeUndefined();
    expect(attributes.MARKETING_CONSENT).toBeUndefined(); // consent rides on OPT_IN
    expect(attributes.CRM_CLIENT_ID).toBeUndefined(); // the id rides on EXT_ID
    expect(attributes.FULL_LINK).toBeUndefined();
  });

  it("omits empty text attributes but always sends the booleans", () => {
    const { attributes } = buildBrevoContact(
      { ...FIELDS, middleName: "", entity: "", utmMedium: "", marketingConsent: false, isIb: false },
      { listId: "19" }
    );
    expect("MIDDLE_NAME" in attributes).toBe(false);
    expect("ENTITY" in attributes).toBe(false);
    expect("UTM_MEDIUM" in attributes).toBe(false);
    // A false boolean is a real value, not an absent one.
    expect(attributes.OPT_IN).toBe(false);
    expect(attributes.IS_IB).toBe(false);
  });

  it("omits a missing or null text field rather than sending the word for it", () => {
    const { attributes } = buildBrevoContact(
      { ...FIELDS, middleName: undefined, utmMedium: null },
      { listId: "19" }
    );
    expect("MIDDLE_NAME" in attributes).toBe(false);
    expect("UTM_MEDIUM" in attributes).toBe(false);
  });

  it("omits listIds entirely when no list is configured", () => {
    expect("listIds" in buildBrevoContact(FIELDS, { listId: "" })).toBe(false);
  });
});

describe("classifyBrevoOutcome", () => {
  it("treats 201 created and 204 updated as sent, and never as retryable", () => {
    const created = classifyBrevoOutcome({ httpStatus: 201, body: { id: 5 } });
    const updated = classifyBrevoOutcome({ httpStatus: 204, body: null });
    expect(created.status).toBe("sent");
    expect(updated.status).toBe("sent");
    expect(created.retryable).toBe(false);
    expect(updated.retryable).toBe(false);
  });

  it("retries transport errors, 429 and 5xx", () => {
    expect(classifyBrevoOutcome({ transportError: new Error("ETIMEDOUT") }).retryable).toBe(true);
    for (const httpStatus of [429, 500, 502, 503]) {
      expect(classifyBrevoOutcome({ httpStatus, body: {} }).retryable, String(httpStatus)).toBe(true);
    }
  });

  it("retries a 408 Request Timeout, which is transient by definition", () => {
    expect(classifyBrevoOutcome({ httpStatus: 408, body: {} })).toEqual({
      status: "failed",
      retryable: true,
      detail: "http 408",
    });
  });

  it("retries 408 alone among the 4xx, so its neighbours stay permanent", () => {
    // Guards the rule from widening into a range such as >= 408.
    for (const httpStatus of [400, 401, 403, 404, 405, 407, 409, 410, 422]) {
      const r = classifyBrevoOutcome({ httpStatus, body: {} });
      expect(r.retryable, String(httpStatus)).toBe(false);
      expect(r.status, String(httpStatus)).toBe("failed");
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

  it("posts the contact as JSON to the contacts endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }) }));
    const contact = { email: "ali.khan@example.com", updateEnabled: true, attributes: { EXT_ID: "88214" } };
    await upsertBrevoContact({ fetchImpl, apiKey: "k", contact });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(contact);
  });

  it("carries Brevo's own code and message into the detail of a rejection", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ code: "invalid_parameter", message: "Attribute ENTITY does not exist" }),
    }));
    const r = await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} });
    expect(r.detail).toBe("http 400 invalid_parameter: Attribute ENTITY does not exist");
    expect(r.retryable).toBe(false);
  });

  it("turns a thrown fetch into a retryable outcome rather than an exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    expect((await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} })).retryable).toBe(true);
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
});

describeSendTimeout("upsertBrevoContact", {
  ok: () => vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }) })),
  send: (fetchImpl) => upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} }),
});

describe("upsertBrevoContact when the response body times out", () => {
  // The timeout signal bounds reading the body as well as the headers, so a stall
  // after the status line ends in json() rejecting with a TimeoutError. The
  // sender swallows that like any unreadable body, and the outcome falls out of
  // the status alone. Pinned per sender because the three differ on purpose.
  const send = (fetchImpl) => upsertBrevoContact({ fetchImpl, apiKey: "k", contact: {} });

  it("counts a 2xx whose body timed out as sent: the status already says the upsert worked", async () => {
    // The upsert is idempotent and nothing in the body is needed, so there is
    // nothing to retry.
    const r = await send(vi.fn(async () => stalledBodyResponse(201)));
    expect(r).toEqual({ status: "sent", retryable: false, detail: "http 201" });
  });

  it("still retries a 5xx whose body timed out, since the status decides", async () => {
    const r = await send(vi.fn(async () => stalledBodyResponse(503)));
    expect(r).toEqual({ status: "failed", retryable: true, detail: "http 503" });
  });
});
