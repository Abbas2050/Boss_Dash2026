import { describe, expect, it } from "vitest";
import { buildWebhookLogEntry, summariseWebhookHealth } from "./webhookLog.js";

describe("buildWebhookLogEntry", () => {
  it("builds a sent entry with a null error", () => {
    const e = buildWebhookLogEntry({
      outcome: "sent",
      httpStatus: 200,
      applicationId: "3963",
      applicantEmail: "A@B.com",
      envelopeId: "env-1",
      payload: { applicationId: "3963" },
    });
    expect(e.outcome).toBe("sent");
    expect(e.httpStatus).toBe(200);
    expect(e.error).toBeNull();
    expect(e.applicationId).toBe("3963");
    expect(e.applicantEmail).toBe("a@b.com");
    expect(e.envelopeId).toBe("env-1");
    expect(JSON.parse(e.payload)).toEqual({ applicationId: "3963" });
  });

  it("records the reason code for a rejected entry", () => {
    const e = buildWebhookLogEntry({
      outcome: "rejected",
      httpStatus: 400,
      error: "applicationId_invalid",
      applicationId: "Application ID + Link",
      payload: {},
    });
    expect(e.outcome).toBe("rejected");
    expect(e.error).toBe("applicationId_invalid");
    // the raw, unusable id is still recorded so it can be diagnosed later
    expect(e.applicationId).toBe("Application ID + Link");
    expect(e.envelopeId).toBeNull();
  });

  it("records the reason code for a skipped entry", () => {
    const e = buildWebhookLogEntry({
      outcome: "skipped",
      httpStatus: 200,
      error: "client_has_outstanding_envelope",
      applicationId: "3963",
      payload: {},
    });
    expect(e.outcome).toBe("skipped");
    expect(e.error).toBe("client_has_outstanding_envelope");
  });

  it("truncates the payload to 2000 characters", () => {
    const e = buildWebhookLogEntry({
      outcome: "rejected",
      httpStatus: 400,
      error: "x",
      payload: { big: "y".repeat(5000) },
    });
    expect(e.payload.length).toBe(2000);
  });

  it("tolerates a payload that cannot be serialised", () => {
    const circular = {};
    circular.self = circular;
    const e = buildWebhookLogEntry({ outcome: "rejected", httpStatus: 400, error: "x", payload: circular });
    expect(typeof e.payload).toBe("string");
  });

  it("nulls missing optional fields and truncates over-long ids", () => {
    const e = buildWebhookLogEntry({ outcome: "rejected", httpStatus: 401, error: "unauthorized_webhook" });
    expect(e.applicationId).toBeNull();
    expect(e.applicantEmail).toBeNull();
    expect(e.envelopeId).toBeNull();
    const long = buildWebhookLogEntry({ outcome: "sent", httpStatus: 200, applicationId: "z".repeat(400) });
    expect(long.applicationId.length).toBe(255);
  });
});

describe("summariseWebhookHealth", () => {
  const now = new Date("2026-07-21T18:00:00Z");
  const row = (iso, outcome = "sent", error = null) => ({ received_at: iso, outcome, error });

  it("reports stale with no rows at all", () => {
    const s = summariseWebhookHealth([], now);
    expect(s.lastReceivedAt).toBeNull();
    expect(s.stale).toBe(true);
    expect(s.rejected7d).toBe(0);
  });

  it("is healthy when the last webhook was 2 hours ago", () => {
    const s = summariseWebhookHealth([row("2026-07-21T16:00:00Z")], now);
    expect(s.stale).toBe(false);
    expect(Math.round(s.ageHours)).toBe(2);
    expect(s.lastOutcome).toBe("sent");
  });

  it("is stale at 73 hours and healthy at 71", () => {
    expect(summariseWebhookHealth([row("2026-07-18T17:00:00Z")], now).stale).toBe(true);
    expect(summariseWebhookHealth([row("2026-07-18T19:00:00Z")], now).stale).toBe(false);
  });

  it("counts rejections inside the 7-day window only", () => {
    const s = summariseWebhookHealth(
      [
        row("2026-07-21T17:00:00Z", "rejected", "applicationId_invalid"),
        row("2026-07-20T10:00:00Z", "rejected", "signer_email_required"),
        row("2026-07-01T10:00:00Z", "rejected", "applicationId_invalid"), // outside window
        row("2026-07-20T09:00:00Z", "sent"),
      ],
      now
    );
    expect(s.rejected7d).toBe(2);
  });

  it("uses the newest row regardless of input order", () => {
    const s = summariseWebhookHealth(
      [row("2026-07-19T10:00:00Z", "rejected", "x"), row("2026-07-21T17:00:00Z", "sent")],
      now
    );
    expect(s.lastOutcome).toBe("sent");
  });

  it("ignores rows with an unparseable timestamp", () => {
    const s = summariseWebhookHealth([row("not-a-date"), row("2026-07-21T17:00:00Z")], now);
    expect(s.lastOutcome).toBe("sent");
    expect(s.stale).toBe(false);
  });
});
