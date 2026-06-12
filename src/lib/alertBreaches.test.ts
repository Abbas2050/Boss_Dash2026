import { describe, expect, it } from "vitest";
import { newBreaches } from "./alertBreaches";

describe("newBreaches", () => {
  it("reports a login that newly appears", () => {
    const { newLogins, nextLogins } = newBreaches(new Set<string>(), [{ login: 101 }]);
    expect(newLogins).toEqual(["101"]);
    expect(nextLogins.has("101")).toBe(true);
  });

  it("does not re-report a login already present", () => {
    const { newLogins } = newBreaches(new Set(["101"]), [{ login: 101 }]);
    expect(newLogins).toEqual([]);
  });

  it("drops logins no longer present", () => {
    const { nextLogins } = newBreaches(new Set(["101"]), []);
    expect(nextLogins.has("101")).toBe(false);
  });

  it("ignores blank logins", () => {
    const { newLogins } = newBreaches(new Set<string>(), [{ login: "" }, { login: 7 }]);
    expect(newLogins).toEqual(["7"]);
  });
});
