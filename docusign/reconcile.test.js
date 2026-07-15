import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./store.js", () => ({
  initDocusignStore: vi.fn(),
  findByEnvelopeId: vi.fn(),
  markEnvelopeStatus: vi.fn(),
}));
vi.mock("./crmUpload.js", () => ({
  uploadSignedDocument: vi.fn(),
}));
vi.mock("./client.js", () => ({
  listStatusChanges: vi.fn(),
}));

import { findByEnvelopeId, markEnvelopeStatus } from "./store.js";
import { uploadSignedDocument } from "./crmUpload.js";
import { onEnvelopeStatus } from "./reconcile.js";

describe("onEnvelopeStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats a superseded row as terminal: no markEnvelopeStatus, no upload", async () => {
    const supersededRow = { envelope_id: "env-1", status: "superseded" };
    findByEnvelopeId.mockResolvedValue(supersededRow);

    const result = await onEnvelopeStatus("env-1", "sent");

    expect(result).toBe(supersededRow);
    expect(markEnvelopeStatus).not.toHaveBeenCalled();
    expect(uploadSignedDocument).not.toHaveBeenCalled();
  });

  it("is case-insensitive when detecting superseded", async () => {
    const supersededRow = { envelope_id: "env-1", status: "SUPERSEDED" };
    findByEnvelopeId.mockResolvedValue(supersededRow);

    await onEnvelopeStatus("env-1", "sent");

    expect(markEnvelopeStatus).not.toHaveBeenCalled();
    expect(uploadSignedDocument).not.toHaveBeenCalled();
  });

  it("marks status and uploads the document when a normal sent row completes", async () => {
    findByEnvelopeId.mockResolvedValue({ envelope_id: "env-1", status: "sent" });
    markEnvelopeStatus.mockResolvedValue({ envelope_id: "env-1", status: "completed" });
    uploadSignedDocument.mockResolvedValue({ ok: true });

    await onEnvelopeStatus("env-1", "completed");

    expect(markEnvelopeStatus).toHaveBeenCalledWith("env-1", "completed");
    expect(uploadSignedDocument).toHaveBeenCalledTimes(1);
    expect(uploadSignedDocument).toHaveBeenCalledWith("env-1");
  });

  it("marks status but does not upload when a normal row transitions to sent", async () => {
    findByEnvelopeId.mockResolvedValue({ envelope_id: "env-1", status: "created" });
    markEnvelopeStatus.mockResolvedValue({ envelope_id: "env-1", status: "sent" });

    await onEnvelopeStatus("env-1", "sent");

    expect(markEnvelopeStatus).toHaveBeenCalledWith("env-1", "sent");
    expect(uploadSignedDocument).not.toHaveBeenCalled();
  });

  it("proceeds as today when the row is not found", async () => {
    findByEnvelopeId.mockResolvedValue(null);
    markEnvelopeStatus.mockResolvedValue({ envelope_id: "env-2", status: "sent" });

    await onEnvelopeStatus("env-2", "sent");

    expect(markEnvelopeStatus).toHaveBeenCalledWith("env-2", "sent");
    expect(uploadSignedDocument).not.toHaveBeenCalled();
  });
});
