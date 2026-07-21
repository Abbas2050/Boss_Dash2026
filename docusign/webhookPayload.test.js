import { describe, expect, it } from "vitest";
import { describeWebhookPayload } from "./router.js";

const req = (body, contentType = "application/json") => ({
  headers: { "content-type": contentType },
  body,
  query: {},
});

describe("describeWebhookPayload", () => {
  it("flags a placeholder that arrived as its own description text", () => {
    const body = { applicationId: "Application ID + Link", userId: 10614, email: "a@b.com" };
    const d = describeWebhookPayload(req(body), body);
    expect(d.fields.applicationId.looksUnresolved).toBe(true);
    // the others resolved fine — this is the discriminator
    expect(d.fields.userId.looksUnresolved).toBe(false);
    expect(d.fields.email.looksUnresolved).toBe(false);
  });

  it("flags an unsubstituted %placeholder% token", () => {
    const body = { applicationId: "%application_id%" };
    const d = describeWebhookPayload(req(body), body);
    expect(d.fields.applicationId.looksUnresolved).toBe(true);
  });

  it("flags an unsubstituted {{placeholder}} token", () => {
    const body = { docType: "{{approve-form}}" };
    const d = describeWebhookPayload(req(body), body);
    expect(d.fields.docType.looksUnresolved).toBe(true);
  });

  it("marks empty values as empty and not unresolved", () => {
    const body = { applicationId: "   " };
    const d = describeWebhookPayload(req(body), body);
    expect(d.fields.applicationId.empty).toBe(true);
    expect(d.fields.applicationId.looksUnresolved).toBe(false);
  });

  it("does not flag genuine values", () => {
    const body = {
      applicationId: '<a href="https://portal.skylinkscapital.com/crm/applications/3892/view/">3892</a>',
      name: "SMIT Datta",
      roleName: "Client",
    };
    const d = describeWebhookPayload(req(body), body);
    expect(d.fields.applicationId.looksUnresolved).toBe(false);
    expect(d.fields.name.looksUnresolved).toBe(false);
    expect(d.fields.roleName.looksUnresolved).toBe(false);
  });

  it("reports content type and which keys came from body vs query", () => {
    const r = {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { applicationId: "1" },
      query: { extra: "2" },
    };
    const d = describeWebhookPayload(r, { ...r.query, ...r.body });
    expect(d.contentType).toBe("application/x-www-form-urlencoded");
    expect(d.bodyKeys).toEqual(["applicationId"]);
    expect(d.queryKeys).toEqual(["extra"]);
  });

  it("truncates long values and summarises objects", () => {
    const body = { big: "x".repeat(400), nested: { a: 1 } };
    const d = describeWebhookPayload(req(body), body);
    expect(d.fields.big.value.length).toBe(160);
    expect(d.fields.nested.type).toBe("object");
  });
});
