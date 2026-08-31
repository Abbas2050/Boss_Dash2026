// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseTestPeriod } from "./parseTestPeriod.js";

describe("parseTestPeriod", () => {
  it("returns {} when both from and to are absent, so the run function picks its own default period", () => {
    expect(parseTestPeriod({})).toEqual({});
    expect(parseTestPeriod(undefined)).toEqual({});
  });

  it("returns fromDate/toDate when both are valid YYYY-MM-DD dates", () => {
    const result = parseTestPeriod({ from: "2026-08-01", to: "2026-08-31" });
    expect(result.error).toBeUndefined();
    expect(result.fromDate).toBeInstanceOf(Date);
    expect(result.toDate).toBeInstanceOf(Date);
    expect(result.fromDate.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(result.toDate.toISOString()).toBe("2026-08-31T23:59:59.000Z");
  });

  it("rejects a caller who supplies only from and not to", () => {
    const result = parseTestPeriod({ from: "2026-08-01" });
    expect(result.error).toBeTruthy();
    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBeUndefined();
  });

  it("rejects a caller who supplies only to and not from", () => {
    const result = parseTestPeriod({ to: "2026-08-31" });
    expect(result.error).toBeTruthy();
    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBeUndefined();
  });

  it("rejects a malformed date string that fails the YYYY-MM-DD shape check", () => {
    const result = parseTestPeriod({ from: "08/01/2026", to: "2026-08-31" });
    expect(result.error).toBe("from and to must both be YYYY-MM-DD");
  });

  it("rejects a non-date string shaped like YYYY-MM-DD but not a real calendar date", () => {
    const result = parseTestPeriod({ from: "2026-13-99", to: "2026-08-31" });
    expect(result.error).toBe("from or to is not a real date");
  });

  it("rejects from after to", () => {
    const result = parseTestPeriod({ from: "2026-09-01", to: "2026-08-01" });
    expect(result.error).toBe("from is after to");
  });

  it("rejects 2026-02-30 (February has only 28 days in 2026)", () => {
    const result = parseTestPeriod({ from: "2026-02-30", to: "2026-03-01" });
    expect(result.error).toBe("from or to is not a real date");
  });

  it("rejects 2026-04-31 (April has only 30 days)", () => {
    const result = parseTestPeriod({ from: "2026-04-31", to: "2026-05-01" });
    expect(result.error).toBe("from or to is not a real date");
  });

  it("rejects 2027-02-29 (2027 is not a leap year)", () => {
    const result = parseTestPeriod({ from: "2027-02-29", to: "2027-03-01" });
    expect(result.error).toBe("from or to is not a real date");
  });

  it("accepts 2028-02-29 (2028 is a leap year)", () => {
    const result = parseTestPeriod({ from: "2028-02-29", to: "2028-03-01" });
    expect(result.error).toBeUndefined();
    expect(result.fromDate).toBeInstanceOf(Date);
    expect(result.toDate).toBeInstanceOf(Date);
  });

  it("accepts 2026-02-28 (valid February date)", () => {
    const result = parseTestPeriod({ from: "2026-02-28", to: "2026-03-01" });
    expect(result.error).toBeUndefined();
    expect(result.fromDate).toBeInstanceOf(Date);
  });

  it("accepts 2026-04-30 (valid April date)", () => {
    const result = parseTestPeriod({ from: "2026-04-30", to: "2026-05-01" });
    expect(result.error).toBeUndefined();
    expect(result.fromDate).toBeInstanceOf(Date);
  });

  it("accepts 2026-08-31 (valid August date)", () => {
    const result = parseTestPeriod({ from: "2026-08-31", to: "2026-09-01" });
    expect(result.error).toBeUndefined();
    expect(result.fromDate).toBeInstanceOf(Date);
  });
});
