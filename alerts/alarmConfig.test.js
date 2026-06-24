import { describe, expect, it } from "vitest";
import { normalizeAlarmConfig } from "./alarmConfig.js";

describe("normalizeAlarmConfig", () => {
  it("fills defaults from an empty object", () => {
    expect(normalizeAlarmConfig({})).toEqual({ enabled: true, recipientUserIds: [], durationSec: 10 });
  });
  it("clamps durationSec to 1..60 and rounds", () => {
    expect(normalizeAlarmConfig({ durationSec: 0 }).durationSec).toBe(1);
    expect(normalizeAlarmConfig({ durationSec: 999 }).durationSec).toBe(60);
    expect(normalizeAlarmConfig({ durationSec: 12.7 }).durationSec).toBe(13);
    expect(normalizeAlarmConfig({ durationSec: "abc" }).durationSec).toBe(10);
  });
  it("coerces recipientUserIds to a string array and drops blanks", () => {
    expect(normalizeAlarmConfig({ recipientUserIds: [1, "2", "", null] }).recipientUserIds).toEqual(["1", "2"]);
    expect(normalizeAlarmConfig({ recipientUserIds: "nope" }).recipientUserIds).toEqual([]);
  });
  it("keeps a boolean enabled, defaults non-boolean to true", () => {
    expect(normalizeAlarmConfig({ enabled: false }).enabled).toBe(false);
    expect(normalizeAlarmConfig({ enabled: "yes" }).enabled).toBe(true);
  });
});
