import { describe, expect, it } from "vitest";
import { diffBreaches, nextConnState } from "./alertLogic.js";

describe("diffBreaches", () => {
  const COOLDOWN = 600000; // 10 min

  it("flags a first-time breach and records the time", () => {
    const { newlyBreached, nextActive } = diffBreaches(new Map(), [{ login: 101 }], 1000, COOLDOWN);
    expect(newlyBreached.map((r) => r.login)).toEqual([101]);
    expect(nextActive.get("101")).toBe(1000);
  });

  it("suppresses a repeat breach within the cooldown", () => {
    const active = new Map([["101", 1000]]);
    const { newlyBreached, nextActive } = diffBreaches(active, [{ login: 101 }], 1000 + 60000, COOLDOWN);
    expect(newlyBreached).toEqual([]);
    expect(nextActive.get("101")).toBe(1000);
  });

  it("re-fires a breach after the cooldown elapses", () => {
    const active = new Map([["101", 1000]]);
    const { newlyBreached, nextActive } = diffBreaches(active, [{ login: 101 }], 1000 + COOLDOWN, COOLDOWN);
    expect(newlyBreached.map((r) => r.login)).toEqual([101]);
    expect(nextActive.get("101")).toBe(1000 + COOLDOWN);
  });

  it("re-arms a login that is no longer breached (drops from active)", () => {
    const active = new Map([["101", 1000]]);
    const { newlyBreached, nextActive } = diffBreaches(active, [], 2000, COOLDOWN);
    expect(newlyBreached).toEqual([]);
    expect(nextActive.has("101")).toBe(false);
  });

  it("ignores rows without a login", () => {
    const { newlyBreached, nextActive } = diffBreaches(new Map(), [{ login: "" }, { login: 5 }], 1, COOLDOWN);
    expect(newlyBreached.map((r) => r.login)).toEqual([5]);
    expect(nextActive.size).toBe(1);
  });
});

describe("nextConnState", () => {
  it("up + closed => down with down-email", () => {
    expect(nextConnState("up", "closed")).toEqual({ state: "down", action: "down-email" });
  });
  it("down + closed => stays down, no action", () => {
    expect(nextConnState("down", "closed")).toEqual({ state: "down", action: null });
  });
  it("down + connected => up with recovered-email", () => {
    expect(nextConnState("down", "connected")).toEqual({ state: "up", action: "recovered-email" });
  });
  it("up + connected => stays up, no action", () => {
    expect(nextConnState("up", "connected")).toEqual({ state: "up", action: null });
  });
});
