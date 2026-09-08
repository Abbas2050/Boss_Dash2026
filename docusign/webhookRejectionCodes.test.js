import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./store.js", () => ({
  findByApplicationId: vi.fn(),
  findByEnvelopeId: vi.fn(),
  findOutstandingEnvelopeForEmail: vi.fn(),
  initDocusignStore: vi.fn(),
  listEnvelopeMaps: vi.fn(),
  listWebhookLog: vi.fn(),
  recordWebhookCall: vi.fn(),
  upsertEnvelopeMap: vi.fn(),
}));
vi.mock("./client.js", () => ({
  createEnvelopeFromTemplate: vi.fn(),
}));
vi.mock("./crm.js", () => ({
  fetchCrmApplicationApplicantById: vi.fn(),
  fetchCrmApplicationsByType: vi.fn(),
  fetchCrmUserById: vi.fn(),
}));
vi.mock("./reconcile.js", () => ({
  onEnvelopeStatus: vi.fn(),
}));

import express from "express";
import { createEnvelopeFromTemplate } from "./client.js";
import { findByApplicationId, findOutstandingEnvelopeForEmail, recordWebhookCall, upsertEnvelopeMap } from "./store.js";
import router from "./router.js";

/**
 * Driven over real HTTP rather than by calling a helper, because the claim under
 * test is about the ENDPOINT: the same request must be refused, must create
 * nothing and must send nothing, and only the reported code may differ.
 */
let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/docusign", router);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/docusign`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const post = async (body) => {
  const res = await fetch(`${baseUrl}/webhooks/fxbo/application-approved`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

const loggedEntry = () => recordWebhookCall.mock.calls.at(-1)?.[0];

describe("FXBO application-approved rejection codes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DOCUSIGN_FXBO_WEBHOOK_BEARER;
    findByApplicationId.mockResolvedValue(null);
    findOutstandingEnvelopeForEmail.mockResolvedValue(null);
    createEnvelopeFromTemplate.mockResolvedValue({ envelopeId: "env-new", status: "sent" });
    upsertEnvelopeMap.mockImplementation(async (row) => ({ ...row, id: 1 }));
  });

  it("reports the exact production Test webhook payload as placeholder_not_substituted, creating and sending nothing", async () => {
    const { status, json } = await post({
      applicationId: "Application ID + Link",
      email: "Client Email",
      name: "Client Full Name",
      docType: "approve-form",
    });

    // Same refusal as before: same status, nothing created, nothing sent.
    expect(status).toBe(400);
    expect(json.ok).toBe(false);
    expect(createEnvelopeFromTemplate).not.toHaveBeenCalled();
    expect(upsertEnvelopeMap).not.toHaveBeenCalled();

    // Only the diagnosis changed.
    expect(json.error).toBe("placeholder_not_substituted");
    expect(json.message).toContain("applicationId");
    expect(json.message).toContain("placeholder label");
    expect(json.placeholderFields).toContain("email");
    expect(loggedEntry()).toMatchObject({
      outcome: "rejected",
      httpStatus: 400,
      error: "placeholder_not_substituted",
      applicationId: "Application ID + Link",
    });
  });

  it("still reports a genuinely malformed id as applicationId_invalid", async () => {
    const { status, json } = await post({ applicationId: "not-an-id-at-all", email: "smit@example.com", name: "SMIT Datta" });

    expect(status).toBe(400);
    expect(json.error).toBe("applicationId_invalid");
    expect(json.message).toBeUndefined();
    expect(createEnvelopeFromTemplate).not.toHaveBeenCalled();
    expect(loggedEntry()).toMatchObject({ error: "applicationId_invalid" });
  });

  it("still reports a missing id as applicationId_required", async () => {
    const { status, json } = await post({ email: "smit@example.com", name: "SMIT Datta" });
    expect(status).toBe(400);
    expect(json.error).toBe("applicationId_required");
  });

  // Regression guard for the path that actually works.
  it("sends as before for a real numeric application id", async () => {
    const { status, json } = await post({ applicationId: "4168", email: "smit@example.com", name: "SMIT Datta" });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, applicationId: "4168", envelopeId: "env-new" });
    expect(createEnvelopeFromTemplate).toHaveBeenCalledTimes(1);
    expect(createEnvelopeFromTemplate).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "4168" }));
    expect(loggedEntry()).toMatchObject({ outcome: "sent", error: null, applicationId: "4168" });
  });

  it("sends as before for an id delivered as an FXBO HTML anchor", async () => {
    const { status, json } = await post({
      applicationId: '<a href="https://portal.skylinkscapital.com/crm/applications/3892/view/">3892</a>',
      email: "smit@example.com",
      name: "SMIT Datta",
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, applicationId: "3892" });
    expect(createEnvelopeFromTemplate).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "3892" }));
  });
});
