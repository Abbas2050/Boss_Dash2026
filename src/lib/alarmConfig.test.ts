import { beforeEach, describe, expect, it } from "vitest";
import { isMutedOnThisDevice, setMutedOnThisDevice, shouldRing, DEFAULT_ALARM_CONFIG } from "./alarmConfig";

describe("shouldRing", () => {
  const base = { enabled: true, recipientUserIds: ["7"], durationSec: 10 };
  it("rings for a recipient when enabled and not muted", () => {
    expect(shouldRing(base, "7", false)).toBe(true);
  });
  it("does not ring for a non-recipient", () => {
    expect(shouldRing(base, "8", false)).toBe(false);
  });
  it("does not ring when disabled", () => {
    expect(shouldRing({ ...base, enabled: false }, "7", false)).toBe(false);
  });
  it("does not ring when muted on this device", () => {
    expect(shouldRing(base, "7", true)).toBe(false);
  });
  it("does not ring with no user id", () => {
    expect(shouldRing(base, null, false)).toBe(false);
  });
});

describe("device mute preference", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to not muted", () => {
    expect(isMutedOnThisDevice()).toBe(false);
  });
  it("persists mute state", () => {
    setMutedOnThisDevice(true);
    expect(isMutedOnThisDevice()).toBe(true);
    setMutedOnThisDevice(false);
    expect(isMutedOnThisDevice()).toBe(false);
  });
});

describe("defaults", () => {
  it("exposes the documented defaults", () => {
    expect(DEFAULT_ALARM_CONFIG).toEqual({ enabled: true, recipientUserIds: [], durationSec: 10 });
  });
});
