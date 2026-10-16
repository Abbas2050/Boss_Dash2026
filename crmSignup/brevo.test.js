// @vitest-environment node
//
// Brevo takes a fixed set of attributes, every one of which had to be created
// in the account before it could be sent (done 2026-10-09). Posting an
// attribute Brevo does not know returns 400, which this design treats as
// permanent -- so a typo here means the contact silently never lands.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { describeSendTimeout, stalledBodyResponse } from "./sendTimeout.contract.js";
import {
  decideBrevoSkip,
  decideBrevoListIdFailure,
  isUsableBrevoListId,
  UNUSABLE_LIST_ID_DETAIL,
  buildBrevoContact,
  classifyBrevoOutcome,
  readBrevoContactId,
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

  // Added 2026-10-14, user's call: until then every `registered` event became a
  // contact, lead or client. The gate's DIRECTION is the part to read twice.
  describe("clients only, by a positive lead test", () => {
    it("skips a payload that positively says lead, with the reason WhatsApp used to give", () => {
      for (const isLeadRaw of ["1", "true", "TRUE", "yes", "Y", "on", "  1  "]) {
        expect(decideBrevoSkip({ stage: "registered", apiKey: "k", isLeadRaw }), isLeadRaw).toEqual({
          reason: "lead, not client",
        });
      }
    });

    it("adds the contact when the literal is absent, empty or unrecognised", () => {
      // The asymmetry, and the reason this is not `recordType !== "client"`.
      // deriveRecordType reads every one of these as "lead", so that predicate
      // would turn one unrecognised %client_is_lead% -- a new FXBO version, a
      // renamed field, a placeholder that stopped rendering -- into a silently
      // empty Brevo list, with nothing erroring. A lead wrongly added is one
      // unwanted contact, segmentable on OPT_IN; a client wrongly left out is
      // reach nobody can see was lost. CUTOVER step 5 exists because the literal
      // cannot be known until the first live signup, so this must not depend on
      // having guessed it.
      for (const isLeadRaw of [undefined, null, "", "   ", "maybe", "2", "lead", "null", "undefined"]) {
        expect(decideBrevoSkip({ stage: "registered", apiKey: "k", isLeadRaw }), String(isLeadRaw)).toBeNull();
      }
    });

    it("adds a client, by the literals that say client", () => {
      for (const isLeadRaw of ["0", "false", "no", "n", "off"]) {
        expect(decideBrevoSkip({ stage: "registered", apiKey: "k", isLeadRaw }), isLeadRaw).toBeNull();
      }
    });

    it("reports the configuration and the stage ahead of the lead, in that order", () => {
      // An unset key is our problem and must never be recorded as a fact about
      // this person; the stage is a fact about the event rather than the person.
      expect(decideBrevoSkip({ stage: "registered", apiKey: "", isLeadRaw: "1" })).toEqual({
        reason: "brevo not configured",
      });
      expect(decideBrevoSkip({ stage: "verified", apiKey: "k", isLeadRaw: "1" })).toEqual({
        reason: "stage not applicable",
      });
    });
  });
});

// Until 2026-10-14 an unusable BREVO_LIST_ID failed OPEN: the contact was
// created, joined no list, and the row recorded `sent`. Nobody would have found
// out until they opened list 19 to run a campaign and found it short. It is a
// failure at send time now, and the request is not made.
describe("the list id", () => {
  const USABLE = ["19", 19, " 19 ", "42", 1];
  const UNUSABLE = [undefined, null, "", "   ", "nineteen", "19abc", "0", 0, "-1", -5, NaN, {}, [], "1,2"];

  it("accepts a positive number, however it arrives", () => {
    for (const listId of USABLE) expect(isUsableBrevoListId(listId), JSON.stringify(listId)).toBe(true);
  });

  it("refuses unset, blank, non-numeric and non-positive alike", () => {
    for (const listId of UNUSABLE) expect(isUsableBrevoListId(listId), JSON.stringify(listId)).toBe(false);
  });

  it("is one test, so the payload cannot decide differently from the gate", () => {
    // The gate and the payload builder disagreeing is exactly how a listless
    // contact got created: one of them said the id was fine and the other left
    // listIds out. Each usable id lands in the payload, and no unusable one does.
    for (const listId of USABLE) {
      expect(buildBrevoContact(FIELDS, { listId }).listIds, JSON.stringify(listId)).toEqual([Number(String(listId).trim())]);
    }
    for (const listId of UNUSABLE) {
      expect("listIds" in buildBrevoContact(FIELDS, { listId }), JSON.stringify(listId)).toBe(false);
    }
  });

  it("is not a reason to send when it is usable", () => {
    for (const listId of USABLE) expect(decideBrevoListIdFailure({ listId }), JSON.stringify(listId)).toBeNull();
    expect(decideBrevoListIdFailure({ listId: "19" })).toBeNull();
  });

  it("is a failure, not a rejection and not a skip, when it is not", () => {
    // `rejected` means the provider refused this event, and Brevo never saw this
    // one -- no request is made at all. `skipped` means a deliberate decision not
    // to send, and this is a misconfiguration, not a decision. `failed` is the
    // word the backstop already uses for a send that was never attempted, with
    // the detail carrying the difference.
    for (const listId of UNUSABLE) {
      expect(decideBrevoListIdFailure({ listId }), JSON.stringify(listId)).toEqual({
        status: "failed",
        retryable: false,
        detail: UNUSABLE_LIST_ID_DETAIL,
      });
    }
    expect(decideBrevoListIdFailure()).toMatchObject({ status: "failed" });
  });

  it("is terminal, so the same wrong variable is not read three times five minutes apart", () => {
    // A configuration error will not fix itself on a timer. Retryable, the row
    // would spend its budget on three identical non-attempts and reach `failed`
    // fifteen minutes later anyway.
    expect(decideBrevoListIdFailure({ listId: "" }).retryable).toBe(false);
  });

  it("names the variable in the detail and never the value", () => {
    // The commonest way this column goes wrong is a paste into the wrong line of
    // .env, and the line above it is BREVO_API_KEY -- echoing the value would
    // write the key into a column the settings tab prints.
    expect(UNUSABLE_LIST_ID_DETAIL).toContain("BREVO_LIST_ID");
    expect(UNUSABLE_LIST_ID_DETAIL).toMatch(/not sent/i);
    for (const listId of ["xkeysib-SECRET-KEY", "nineteen"]) {
      expect(decideBrevoListIdFailure({ listId }).detail, listId).not.toContain(listId);
    }
    expect(UNUSABLE_LIST_ID_DETAIL.length).toBeLessThanOrEqual(200);
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
      // Nothing was created, so there is no id to keep. Explicitly null on
      // every path, so the writer cannot read `undefined` off one of them.
      contactId: null,
    });
  });

  it("retries 408 alone among the 4xx, so its neighbours stay permanent", () => {
    // Guards the rule from widening into a range such as >= 408.
    for (const httpStatus of [400, 401, 403, 404, 405, 407, 409, 410, 422]) {
      const r = classifyBrevoOutcome({ httpStatus, body: {} });
      expect(r.retryable, String(httpStatus)).toBe(false);
      expect(r.status, String(httpStatus)).toBe("rejected");
    }
  });

  it("tells Brevo refusing the contact from us giving up on it", () => {
    // The 400 for an attribute Brevo does not know is the failure that makes a
    // contact silently never land (spec section 8). planRetry writes `failed`
    // for a retryable outcome whose budget is spent, so sharing that word would
    // put a dead attribute and a transport outage in the same counter.
    const refused = classifyBrevoOutcome({
      httpStatus: 400,
      body: { code: "invalid_parameter", message: "Attribute ENTITY does not exist" },
    });
    expect(refused.status).toBe("rejected");
    expect(refused.retryable).toBe(false);
    expect(classifyBrevoOutcome({ transportError: new Error("ETIMEDOUT") }).status).toBe("failed");
  });

  it("treats every other 4xx as permanent and keeps Brevo's own code", () => {
    const r = classifyBrevoOutcome({
      httpStatus: 400,
      body: { code: "invalid_parameter", message: "Attribute ENTITY does not exist" },
    });
    expect(r.retryable).toBe(false);
    expect(r.status).toBe("rejected");
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
      const r = classifyBrevoOutcome({ httpStatus, body: {} });
      expect(r.status, String(httpStatus)).toBe("rejected");
      expect(r.retryable, String(httpStatus)).toBe(false);
    }
  });

  it("treats every other 4xx as permanent, not only 400", () => {
    for (const httpStatus of [401, 403, 404, 409, 422]) {
      const r = classifyBrevoOutcome({ httpStatus, body: {} });
      expect(r.retryable, String(httpStatus)).toBe(false);
      expect(r.status, String(httpStatus)).toBe("rejected");
    }
  });
});

// The one thing in this exchange that is PROOF. `http 201` says the request was
// accepted; the contact id names a row in Brevo that somebody can open. Added
// 2026-10-16, because the settings tab was reporting "Brevo sent -- http 201"
// and the user's objection was fair: that is not evidence a contact exists.
describe("the contact id", () => {
  describe("readBrevoContactId", () => {
    it("reads the number Brevo returns, as a string", () => {
      // Stored and shown as text, never arithmetic. A JavaScript number would
      // lose precision on an id past 2^53, and nothing adds up ids.
      expect(readBrevoContactId({ id: 4821 })).toBe("4821");
    });

    it("takes a string id verbatim, because an identifier is not ours to reformat", () => {
      expect(readBrevoContactId({ id: "4821" })).toBe("4821");
      expect(readBrevoContactId({ id: "  4821  " })).toBe("4821");
    });

    it("refuses anything that is not an id, rather than coercing it", () => {
      // String({}) is "[object Object]" and String(true) is "true". Either would
      // be stored as the proof and printed on the tab as though it meant
      // something.
      for (const body of [undefined, null, {}, { id: null }, { id: "" }, { id: "  " }, { id: true }, { id: {} }, { id: [4821] }, { id: NaN }]) {
        expect(readBrevoContactId(body), JSON.stringify(body) ?? String(body)).toBeNull();
      }
    });
  });

  describe("classifyBrevoOutcome", () => {
    it("keeps the id a 2xx carried, and names it in the detail", () => {
      const r = classifyBrevoOutcome({ httpStatus: 201, body: { id: 4821 } });
      expect(r.status).toBe("sent");
      expect(r.contactId).toBe("4821");
      // NOT in the detail as well. The id has a column of its own and the tab
      // prints both, so repeating it would put the same six characters twice in
      // one cell. The detail's job on a success is the transport fact.
      expect(r.detail).toBe("http 201");
    });

    it("treats a 2xx with no id as a send, not a failure, and records what came back", () => {
      // `updateEnabled: true` makes this an upsert, and Brevo mints an id only
      // when it CREATES. A repeat registration updates the existing contact and
      // returns nothing -- the one case where the contact is certainly there. A
      // failure here would turn every returning client into a red row and a
      // resend offer.
      for (const body of [null, {}, { id: null }, { code: "ok" }]) {
        const r = classifyBrevoOutcome({ httpStatus: 204, body });
        expect(r.status, JSON.stringify(body)).toBe("sent");
        expect(r.retryable, JSON.stringify(body)).toBe(false);
        expect(r.contactId, JSON.stringify(body)).toBeNull();
        // Said, not left blank: an empty proof column has to be tellable from a
        // proof we failed to read.
        expect(r.detail, JSON.stringify(body)).toBe("http 204 no contact id (an update returns none)");
      }
    });

    it("never reads an id off a response that is not a 2xx", () => {
      // Brevo's 409 for a duplicate names the existing contact's id in its
      // message body. Reading one from a refusal would record proof of a
      // contact this call did not make, beside a `rejected` status.
      for (const httpStatus of [400, 409, 429, 500]) {
        expect(classifyBrevoOutcome({ httpStatus, body: { id: 4821 } }).contactId, String(httpStatus)).toBeNull();
      }
    });
  });

  describe("upsertBrevoContact", () => {
    it("carries the id out of the real response body", async () => {
      // The whole path: Brevo's own 201 shape, through the sender, to the
      // outcome the worker writes.
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 4821 }) }));
      const r = await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: { email: "a@b.c" } });
      expect(r).toEqual({
        status: "sent",
        retryable: false,
        detail: "http 201",
        contactId: "4821",
      });
    });

    it("is still a send when the 204 of an update carries no body at all", async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 204,
        json: async () => {
          throw new Error("Unexpected end of JSON input");
        },
      }));
      const r = await upsertBrevoContact({ fetchImpl, apiKey: "k", contact: { email: "a@b.c" } });
      expect(r.status).toBe("sent");
      expect(r.contactId).toBeNull();
    });
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
    // No id either, because the body never arrived -- and the detail says so
    // rather than leaving the proof column blank with nothing to explain it.
    expect(r).toEqual({
      status: "sent",
      retryable: false,
      detail: "http 201 no contact id (an update returns none)",
      contactId: null,
    });
  });

  it("still retries a 5xx whose body timed out, since the status decides", async () => {
    const r = await send(vi.fn(async () => stalledBodyResponse(503)));
    expect(r).toEqual({ status: "failed", retryable: true, detail: "http 503", contactId: null });
  });
});

// The warning that catches a typo before a single signup arrives. Nothing else
// reads server.js for Brevo's configuration: without this line an unusable
// BREVO_LIST_ID is silent until the first registration fails, and the row that
// says so is in a settings tab nobody has open at deploy time.
describe("the boot-time warning in server.js", () => {
  const SERVER = readFileSync(path.resolve("server.js"), "utf8");
  const listen = SERVER.slice(SERVER.indexOf("server.listen(PORT"));
  const warning = listen.match(/if \(process\.env\.BREVO_API_KEY && !isUsableBrevoListId\(process\.env\.BREVO_LIST_ID\)\) \{([\s\S]*?)\n  \}/);

  it("warns when the key is set and the list id is not usable", () => {
    // Both halves of the condition are the test. Dropping the line, inverting it,
    // and warning on the key alone all pass every other test in this file.
    expect(warning, "no boot-time check of BREVO_LIST_ID in the listen callback").not.toBeNull();
    expect(warning[1]).toContain("console.error(");
  });

  it("warns only when the key is set, because with no key Brevo is off entirely", () => {
    // Unset BREVO_API_KEY and Brevo is skipped as "brevo not configured", so a
    // warning about its list would be noise on every boot of every install that
    // does not use it. The key is the first half of the condition, and it is read
    // for truthiness only -- never printed.
    expect(listen).toMatch(/if \(process\.env\.BREVO_API_KEY &&/);
    expect(warning[1]).not.toContain("BREVO_API_KEY}");
    expect(warning[1]).not.toMatch(/\$\{[^}]*BREVO_API_KEY/);
  });

  it("asks the same question the send asks, so the warning and the gate cannot disagree", () => {
    // A boot that says the list id is fine and a send that then fails on it would
    // be worse than no warning at all.
    expect(SERVER).toMatch(/import \{ isUsableBrevoListId \} from "\.\/crmSignup\/brevo\.js";/);
    expect(warning[1]).not.toMatch(/Number\(|parseInt\(/);
  });

  it("names the variable and what will happen, in one line someone skimming a log can act on", () => {
    expect(warning[1]).toContain("BREVO_LIST_ID");
    expect(warning[1]).toMatch(/unset, blank or not a positive number/);
    expect(warning[1]).toMatch(/recorded as failed/);
    expect(warning[1]).toMatch(/Set BREVO_LIST_ID in \.env/);
    expect(warning[1]).toContain("[crm-events]");
  });

  it("never prints a secret", () => {
    // The whole .env block around this line is keys.
    for (const secret of ["BREVO_API_KEY}", "META_CAPI_ACCESS_TOKEN", "WA_API_KEY", "CRM_WEBHOOK_SECRET"]) {
      expect(warning[1], secret).not.toContain(secret);
    }
  });
});
