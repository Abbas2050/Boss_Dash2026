import { describe, expect, it } from "vitest";
import { buildDocumentPayload } from "./crmUpload.js";

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
