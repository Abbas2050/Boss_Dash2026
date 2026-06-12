import { beforeEach, describe, expect, it } from "vitest";
import { isSoundEnabled, setSoundEnabled } from "./alertSound";

describe("sound preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to enabled when no preference is stored", () => {
    expect(isSoundEnabled()).toBe(true);
  });

  it("respects an explicit disable", () => {
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
  });

  it("persists enabled state", () => {
    setSoundEnabled(true);
    expect(isSoundEnabled()).toBe(true);
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
  });
});
