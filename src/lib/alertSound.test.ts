import { beforeEach, describe, expect, it } from "vitest";
import { isSoundEnabled, setSoundEnabled } from "./alertSound";

describe("sound preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to disabled", () => {
    expect(isSoundEnabled()).toBe(false);
  });

  it("persists enabled state", () => {
    setSoundEnabled(true);
    expect(isSoundEnabled()).toBe(true);
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
  });
});
