import { describe, expect, it } from "vitest";
import { bucketEnvelopes } from "./router.js";

const row = (status) => ({ status, application_id: "1", applicant_email: "a@b.c" });

describe("bucketEnvelopes", () => {
  it("buckets completed statuses", () => {
    const r = bucketEnvelopes([row("completed"), row("signed")]);
    expect(r.completed).toHaveLength(2);
    expect(r.pending).toHaveLength(0);
  });
  it("buckets in-flight statuses as pending", () => {
    const r = bucketEnvelopes([row("sent"), row("created"), row("pending")]);
    expect(r.pending).toHaveLength(3);
  });
  it("surfaces declined/voided/expired as needsAttention", () => {
    const r = bucketEnvelopes([row("declined"), row("voided"), row("expired")]);
    expect(r.needsAttention).toHaveLength(3);
    expect(r.pending).toHaveLength(0);
    expect(r.completed).toHaveLength(0);
  });
  it("excludes superseded rows from every bucket", () => {
    const r = bucketEnvelopes([row("superseded")]);
    expect(r.pending).toHaveLength(0);
    expect(r.completed).toHaveLength(0);
    expect(r.needsAttention).toHaveLength(0);
  });
});
