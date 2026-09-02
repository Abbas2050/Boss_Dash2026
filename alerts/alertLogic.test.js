import { describe, expect, it } from "vitest";
import { classifyHubFailure, diffBreaches, nextConnState, shouldRenotify } from "./alertLogic.js";

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

describe("classifyHubFailure", () => {
  const withStatus = (status) => Object.assign(new Error(`Status code '${status}'`), { statusCode: status });

  it("calls 401 and 403 an auth failure", () => {
    expect(classifyHubFailure(withStatus(401))).toBe("auth");
    expect(classifyHubFailure(withStatus(403))).toBe("auth");
  });
  it("calls any other answered status unreachable", () => {
    expect(classifyHubFailure(withStatus(500))).toBe("unreachable");
    expect(classifyHubFailure(withStatus(404))).toBe("unreachable");
  });
  it("calls a transport failure with no status unreachable", () => {
    expect(classifyHubFailure(new Error("connect ECONNREFUSED"))).toBe("unreachable");
    expect(classifyHubFailure(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe("unreachable");
    expect(classifyHubFailure(undefined)).toBe("unreachable");
  });
  it("treats a refused token exchange as an auth failure", () => {
    // wallet/backendToken.js throws this when client_credentials is rejected:
    // the backend is up, our credentials are not accepted.
    const e = new Error("Could not obtain a backend token");
    e.name = "BackendTokenError";
    expect(classifyHubFailure(e)).toBe("auth");
  });
  it("reads the status out of the message when the property was lost", () => {
    expect(classifyHubFailure(new Error("Unauthorized: Status code '401'"))).toBe("auth");
  });
});

describe("shouldRenotify", () => {
  const HOUR = 3600000;
  it("is false before the interval elapses and true at or after it", () => {
    expect(shouldRenotify(1000, 1000 + HOUR - 1, HOUR)).toBe(false);
    expect(shouldRenotify(1000, 1000 + HOUR, HOUR)).toBe(true);
  });
  it("is false when nothing has been notified yet", () => {
    expect(shouldRenotify(null, 10 * HOUR, HOUR)).toBe(false);
  });
  it("is false for a non-positive or unusable interval", () => {
    expect(shouldRenotify(1000, 10 * HOUR, 0)).toBe(false);
    expect(shouldRenotify(1000, 10 * HOUR, -1)).toBe(false);
    expect(shouldRenotify(1000, 10 * HOUR, NaN)).toBe(false);
  });
});
