// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildLeadPayload, createLead, findLeadByEmail, parseTags } from "./fxbo.js";

const lead = (over = {}) => ({
  metaLeadId: "1", createdTime: "", firstName: "Dogan", lastName: "Gungor",
  email: "d_gungor43@hotmail.com", phone: "+905332360123", country: "TR",
  leadSource: "Partners-IB-Turkey",
  utmParams: "utm_source=facebook&utm_medium=paid_social&utm_campaign=Partners-IB",
  campaignName: "Partners-IB", adsetName: "Partners-IB-Turkey", adName: "Ad2",
  skip: null, ...over,
});

const sheet = (over = {}) => ({
  id: 2, label: "Meta – Turkey", ib: false, sendLeadSource: false,
  managerId: null, language: "en", status: null, tags: null, ...over,
});

describe("buildLeadPayload", () => {
  it("sends exactly the eleven fields the design names", () => {
    expect(buildLeadPayload(lead(), sheet())).toEqual({
      lead: true,
      ib: false,
      firstName: "Dogan",
      lastName: "Gungor",
      email: "d_gungor43@hotmail.com",
      phone: "+905332360123",
      country: "TR",
      language: "en",
      utmParams: "utm_source=facebook&utm_medium=paid_social&utm_campaign=Partners-IB",
      sendWelcomeEmail: false,
      acceptedDocuments: false,
    });
  });

  // The whole point of "omitted, not sent empty": an empty string where FXBO
  // has a default is how the default gets overwritten with nothing.
  it("omits the four unset fields rather than sending them empty", () => {
    const payload = buildLeadPayload(lead(), sheet());
    expect(payload).not.toHaveProperty("managerId");
    expect(payload).not.toHaveProperty("referrer");
    expect(payload).not.toHaveProperty("tags");
    expect(payload).not.toHaveProperty("status");
  });

  it("adds each one only when the sheet sets it", () => {
    const payload = buildLeadPayload(lead(), sheet({
      ib: true, sendLeadSource: true, managerId: 20, status: "new", tags: "IB, Meta",
    }));
    expect(payload.ib).toBe(true);
    expect(payload.referrer).toBe("Partners-IB-Turkey");
    expect(payload.managerId).toBe(20);
    expect(payload.status).toBe("new");
    expect(payload.tags).toEqual(["IB", "Meta"]);
  });

  it("omits what the lead itself does not have", () => {
    const payload = buildLeadPayload(lead({ email: "", country: null, lastName: "", utmParams: null }), sheet());
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("country");
    expect(payload).not.toHaveProperty("lastName");
    expect(payload).not.toHaveProperty("utmParams");
    expect(payload.phone).toBe("+905332360123");
  });

  // A sheet with the switch on but a row with no ad set, campaign or form.
  it("omits referrer when the switch is on but there is no source", () => {
    const payload = buildLeadPayload(lead({ leadSource: null }), sheet({ sendLeadSource: true }));
    expect(payload).not.toHaveProperty("referrer");
  });
});

describe("parseTags", () => {
  it("splits, trims and drops the blanks", () => {
    expect(parseTags("IB, Meta ,, ")).toEqual(["IB", "Meta"]);
    expect(parseTags(null)).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("findLeadByEmail", () => {
  it("answers the match the CRM found", async () => {
    const fetchCrmUserByEmail = vi.fn(async () => ({ id: 14613, email: "a@b.com" }));
    await expect(findLeadByEmail("a@b.com", { fetchCrmUserByEmail })).resolves.toEqual({ id: 14613 });
  });

  it("answers null when nobody has that address", async () => {
    const fetchCrmUserByEmail = vi.fn(async () => null);
    await expect(findLeadByEmail("a@b.com", { fetchCrmUserByEmail })).resolves.toBeNull();
  });

  // A lookup that throws must not be read as "nobody has it" -- that would
  // create a duplicate every time the CRM hiccuped.
  it("lets a failed lookup throw", async () => {
    const fetchCrmUserByEmail = vi.fn(async () => { throw new Error("CRM users lookup failed (503)"); });
    await expect(findLeadByEmail("a@b.com", { fetchCrmUserByEmail })).rejects.toThrow(/503/);
  });
});

describe("createLead", () => {
  const deps = (fetchImpl) => ({
    fetch: fetchImpl,
    getCrmBaseUrl: () => "https://portal.example.com/rest",
    authHeaders: () => ({ Authorization: "Bearer x", "Content-Type": "application/json" }),
    versionQuery: () => "version=1.0.0",
  });

  it("posts to /users/new and reads the new id back", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ id: 14620 }]) }));
    const result = await createLead({ lead: true }, deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://portal.example.com/rest/users/new?version=1.0.0",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ lead: true }) }),
    );
    expect(result).toEqual({ ok: true, status: 200, userId: 14620, detail: null });
  });

  it("accepts a bare object as well as an array", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 7 }) }));
    await expect(createLead({}, deps(fetchImpl))).resolves.toMatchObject({ ok: true, userId: 7 });
  });

  // The CRM's own wording, because "the CRM refused this" and "we have not
  // tried yet" must never look alike in the tab.
  it("carries the CRM's refusal back verbatim", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, text: async () => '{"error":"email already used"}' }));
    const result = await createLead({}, deps(fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(result.detail).toContain("email already used");
  });

  it("reports a success whose body it could not parse", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => "OK" }));
    await expect(createLead({}, deps(fetchImpl))).resolves.toEqual({ ok: true, status: 200, userId: null, detail: null });
  });
});
