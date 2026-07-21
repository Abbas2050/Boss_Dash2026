import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./store.js", () => ({
  findByApplicationId: vi.fn(),
  findOutstandingEnvelopeForEmail: vi.fn(),
  upsertEnvelopeMap: vi.fn(),
}));
vi.mock("./client.js", () => ({
  createEnvelopeFromTemplate: vi.fn(),
}));
vi.mock("./crm.js", () => ({
  fetchCrmApplicationsByType: vi.fn(),
  fetchCrmUserById: vi.fn(),
}));

import { findByApplicationId, findOutstandingEnvelopeForEmail, upsertEnvelopeMap } from "./store.js";
import { createEnvelopeFromTemplate } from "./client.js";
import { fetchCrmApplicationsByType, fetchCrmUserById } from "./crm.js";
import { processApprovedApplications } from "./sync.js";

const APPROVED_APPLICATION = { id: "3892", status: "approved", userId: 10614 };
const CRM_USER = { id: 10614, firstName: "SMIT", lastName: "Datta", email: "smitdatta2000@gmail.com" };

describe("processApprovedApplications duplicate guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DOCUSIGN_TEMPLATE_ID = "template-123";

    fetchCrmApplicationsByType.mockResolvedValue([APPROVED_APPLICATION]);
    fetchCrmUserById.mockResolvedValue(CRM_USER);
    findByApplicationId.mockResolvedValue(null);
    upsertEnvelopeMap.mockResolvedValue({});
  });

  it("skips sending when the client already has an outstanding envelope", async () => {
    findOutstandingEnvelopeForEmail.mockResolvedValue({
      envelope_id: "env-old",
      application_id: "1000",
      status: "sent",
      applicant_email: "smitdatta2000@gmail.com",
    });

    const summary = await processApprovedApplications({});

    expect(createEnvelopeFromTemplate).not.toHaveBeenCalled();
    expect(summary.skippedOutstanding).toBe(1);
    expect(summary.sent).toBe(0);
  });

  it("sends when there is no outstanding envelope for the client", async () => {
    findOutstandingEnvelopeForEmail.mockResolvedValue(null);
    createEnvelopeFromTemplate.mockResolvedValue({ envelopeId: "env-new", status: "sent" });

    const summary = await processApprovedApplications({});

    expect(createEnvelopeFromTemplate).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(1);
    expect(summary.skippedOutstanding).toBe(0);
  });
});
