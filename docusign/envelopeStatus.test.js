import { describe, expect, it } from "vitest";
import { isOutstandingStatus, OUTSTANDING_STATUSES } from "./envelopeStatus.js";

describe("isOutstandingStatus", () => {
  it.each(["created", "sent", "delivered"])("returns true for %s", (status) => {
    expect(isOutstandingStatus(status)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isOutstandingStatus("Sent")).toBe(true);
    expect(isOutstandingStatus("DELIVERED")).toBe(true);
    expect(isOutstandingStatus("CrEaTeD")).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(isOutstandingStatus("  sent  ")).toBe(true);
    expect(isOutstandingStatus("\tdelivered\n")).toBe(true);
  });

  it.each(["completed", "signed", "expired", "voided", "declined", "superseded"])(
    "returns false for %s",
    (status) => {
      expect(isOutstandingStatus(status)).toBe(false);
    }
  );

  it("returns false for empty, null, and undefined", () => {
    expect(isOutstandingStatus("")).toBe(false);
    expect(isOutstandingStatus(null)).toBe(false);
    expect(isOutstandingStatus(undefined)).toBe(false);
  });

  it("exposes the OUTSTANDING_STATUSES set", () => {
    expect(OUTSTANDING_STATUSES.has("created")).toBe(true);
    expect(OUTSTANDING_STATUSES.has("sent")).toBe(true);
    expect(OUTSTANDING_STATUSES.has("delivered")).toBe(true);
    expect(OUTSTANDING_STATUSES.has("completed")).toBe(false);
  });
});
