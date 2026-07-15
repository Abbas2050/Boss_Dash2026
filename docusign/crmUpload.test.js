import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./crm.js", () => ({
  createCrmDocument: vi.fn(),
  fetchCrmUserByEmail: vi.fn(),
  fetchCrmUserById: vi.fn(),
}));
vi.mock("./client.js", () => ({
  downloadCombinedDocument: vi.fn(),
}));
vi.mock("./store.js", () => ({
  findByEnvelopeId: vi.fn(),
  markCrmUploadStatus: vi.fn(),
}));

import { createCrmDocument, fetchCrmUserByEmail, fetchCrmUserById } from "./crm.js";
import { downloadCombinedDocument } from "./client.js";
import { findByEnvelopeId, markCrmUploadStatus } from "./store.js";
import { buildDocumentPayload, uploadSignedDocument } from "./crmUpload.js";

describe("buildDocumentPayload", () => {
  const base = {
    crmUserId: 10002,
    configId: 73,
    applicationId: "3892",
    envelopeId: "env-abc",
    pdfBase64: "JVBERi0xLjQK",
  };

  it("builds the exact FXBO payload shape", () => {
    expect(buildDocumentPayload(base)).toEqual({
      user: 10002,
      config: 73,
      status: "approved",
      isUploadedByClient: false,
      description: "DocuSign signed agreement (envelope env-abc, application 3892)",
      data: { file: [{ file: "JVBERi0xLjQK", name: "signed-agreement-3892.pdf" }] },
    });
  });

  it("coerces user and config to numbers", () => {
    const p = buildDocumentPayload({ ...base, crmUserId: "10002", configId: "73" });
    expect(p.user).toBe(10002);
    expect(p.config).toBe(73);
  });

  it("never includes expiresAt (config 73 has no expiration)", () => {
    expect(buildDocumentPayload(base)).not.toHaveProperty("expiresAt");
  });
});

describe("uploadSignedDocument", () => {
  const envelopeId = "env-1";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DOCUSIGN_CRM_DOC_CONFIG_ID = "73";
    downloadCombinedDocument.mockResolvedValue(Buffer.from("pdf-bytes"));
    markCrmUploadStatus.mockResolvedValue(undefined);
  });

  it("regression: uploads to the user resolved from the signer's email, even when crm_user_id is a different, stale id", async () => {
    findByEnvelopeId.mockResolvedValue({
      envelope_id: envelopeId,
      application_id: "3889",
      applicant_email: "smitdatta2000@gmail.com",
      crm_user_id: 10000,
      crm_upload_status: null,
    });
    fetchCrmUserByEmail.mockResolvedValue({
      id: 10614,
      firstName: "SMIT",
      lastName: "Datta",
      email: "smitdatta2000@gmail.com",
    });

    const result = await uploadSignedDocument(envelopeId);

    expect(fetchCrmUserByEmail).toHaveBeenCalledWith("smitdatta2000@gmail.com");
    expect(fetchCrmUserById).not.toHaveBeenCalled();
    expect(createCrmDocument).toHaveBeenCalledWith(expect.objectContaining({ user: 10614 }));
    expect(markCrmUploadStatus).toHaveBeenCalledWith(envelopeId, "uploaded", null);
    expect(result).toEqual({ ok: true });
  });

  it("fails as crm_user_unresolved when the email lookup finds nothing and crm_user_id's email does not match the signer", async () => {
    findByEnvelopeId.mockResolvedValue({
      envelope_id: envelopeId,
      application_id: "3889",
      applicant_email: "smitdatta2000@gmail.com",
      crm_user_id: 10000,
      crm_upload_status: null,
    });
    fetchCrmUserByEmail.mockResolvedValue(null);
    fetchCrmUserById.mockResolvedValue({
      id: 10000,
      firstName: "Daniel",
      lastName: "Taki",
      email: "daniel.taki@example.com",
    });

    const result = await uploadSignedDocument(envelopeId);

    expect(createCrmDocument).not.toHaveBeenCalled();
    expect(markCrmUploadStatus).toHaveBeenCalledWith(envelopeId, "failed", "crm_user_unresolved");
    expect(result).toEqual({ ok: false, reason: "crm_user_unresolved" });
  });

  it("uploads with crm_user_id when the email lookup finds nothing but crm_user_id's email matches the signer", async () => {
    findByEnvelopeId.mockResolvedValue({
      envelope_id: envelopeId,
      application_id: "3889",
      applicant_email: "smitdatta2000@gmail.com",
      crm_user_id: 10614,
      crm_upload_status: null,
    });
    fetchCrmUserByEmail.mockResolvedValue(null);
    fetchCrmUserById.mockResolvedValue({
      id: 10614,
      firstName: "SMIT",
      lastName: "Datta",
      email: "smitdatta2000@gmail.com",
    });

    const result = await uploadSignedDocument(envelopeId);

    expect(createCrmDocument).toHaveBeenCalledWith(expect.objectContaining({ user: 10614 }));
    expect(markCrmUploadStatus).toHaveBeenCalledWith(envelopeId, "uploaded", null);
    expect(result).toEqual({ ok: true });
  });
});
