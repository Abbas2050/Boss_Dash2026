import { describe, expect, it } from "vitest";
import { isOutstandingStatus } from "./envelopeStatus.js";

/**
 * The duplicate guard blocks a second envelope while the client still has an
 * unsigned one. The send path calls findOutstandingEnvelopeForEmail(), whose SQL
 * filters on exactly these statuses — so this is the contract that matters.
 */
describe("duplicate guard — which statuses block a re-send", () => {
  it("blocks while an envelope is still outstanding", () => {
    expect(isOutstandingStatus("created")).toBe(true);
    expect(isOutstandingStatus("sent")).toBe(true);
    expect(isOutstandingStatus("delivered")).toBe(true);
  });

  it("allows a re-send once the previous envelope is finished", () => {
    expect(isOutstandingStatus("completed")).toBe(false);
    expect(isOutstandingStatus("signed")).toBe(false);
    expect(isOutstandingStatus("expired")).toBe(false);
    expect(isOutstandingStatus("voided")).toBe(false);
    expect(isOutstandingStatus("declined")).toBe(false);
  });

  it("never blocks on a superseded or unknown status", () => {
    expect(isOutstandingStatus("superseded")).toBe(false);
    expect(isOutstandingStatus("")).toBe(false);
    expect(isOutstandingStatus(null)).toBe(false);
    expect(isOutstandingStatus(undefined)).toBe(false);
  });
});
