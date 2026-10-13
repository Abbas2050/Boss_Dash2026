// @vitest-environment node
//
// One timeout for all three outbound senders, so it is decided in one place and
// pinned here once. Each sender's own test file proves that its fetch receives
// the signal (see sendTimeout.contract.js); this file proves what the signal is.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_SEND_TIMEOUT_MS,
  MIN_SEND_TIMEOUT_MS,
  MAX_SEND_TIMEOUT_MS,
  SEND_TIMEOUT_ENV,
  resolveSendTimeoutMs,
  sendTimeoutSignal,
} from "./sendTimeout.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const resolve = (raw) => resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: raw });

describe("the shared constants", () => {
  it("defaults to ten seconds, overridden by CRM_SEND_TIMEOUT_MS", () => {
    expect(DEFAULT_SEND_TIMEOUT_MS).toBe(10000);
    expect(SEND_TIMEOUT_ENV).toBe("CRM_SEND_TIMEOUT_MS");
  });

  it("holds the configured value to a window of one second to two minutes", () => {
    expect(MIN_SEND_TIMEOUT_MS).toBe(1000);
    expect(MAX_SEND_TIMEOUT_MS).toBe(120000);
  });
});

describe("resolveSendTimeoutMs", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("uses the default when the variable is not set", () => {
    expect(resolveSendTimeoutMs({})).toBe(10000);
  });

  it("honours a value inside the window, whitespace and fractions aside", () => {
    expect(resolve("2500")).toBe(2500);
    expect(resolve("  2500 ")).toBe(2500);
    expect(resolve("1.5e4")).toBe(15000);
    // AbortSignal.timeout throws on a fraction, so it is cut to a whole number.
    expect(resolve("2500.7")).toBe(2500);
  });

  it("honours both edges of the window exactly", () => {
    expect(resolve("1000")).toBe(1000);
    expect(resolve("120000")).toBe(120000);
  });

  it("raises a value below the window to its floor, not to the default", () => {
    // 30 is seconds typed as milliseconds; honoured, every send would abort
    // before TLS completes and every row would burn its whole retry budget.
    for (const raw of ["30", "500", "999", "1", "1.5", "0.5"]) {
      expect(resolve(raw), raw).toBe(1000);
    }
  });

  it("lowers a value above the window to its ceiling, not to the default", () => {
    // 10000000 ms is 2.8 hours: the stall this timeout exists to prevent.
    for (const raw of ["120001", "10000000", "2147483648", "4294967296", "99999999999", "Infinity"]) {
      expect(resolve(raw), raw).toBe(120000);
    }
  });

  it("falls back to the default for a value that cannot be read as a duration", () => {
    for (const raw of ["abc", "10s", "30s", "0", "-5", "-0", "NaN"]) {
      expect(resolve(raw), raw).toBe(10000);
    }
  });

  it("treats an empty or blank value as unset", () => {
    for (const raw of ["", "  ", undefined, null]) {
      expect(resolve(raw), String(raw)).toBe(10000);
    }
  });

  it("reads process.env when called, not when imported", () => {
    vi.stubEnv("CRM_SEND_TIMEOUT_MS", "1234");
    expect(resolveSendTimeoutMs()).toBe(1234);
    vi.stubEnv("CRM_SEND_TIMEOUT_MS", undefined);
    expect(resolveSendTimeoutMs()).toBe(10000);
  });
});

describe("the warning for a value that was ignored or clamped", () => {
  let warn;
  let mod;

  beforeEach(async () => {
    // A fresh module each time, because "already warned" is module state.
    vi.resetModules();
    mod = await import("./sendTimeout.js");
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const raise = (raw) => mod.resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: raw });

  it("names the value given and the floor it was raised to", () => {
    raise("30");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("CRM_SEND_TIMEOUT_MS");
    expect(warn.mock.calls[0][0]).toContain('"30"');
    expect(warn.mock.calls[0][0]).toContain("minimum");
    expect(warn.mock.calls[0][0]).toContain("using 1000 ms");
  });

  it("names the value given and the ceiling it was lowered to", () => {
    raise("10000000");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"10000000"');
    expect(warn.mock.calls[0][0]).toContain("maximum");
    expect(warn.mock.calls[0][0]).toContain("using 120000 ms");
  });

  it("names the value given and the default it fell back to", () => {
    raise("30s");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"30s"');
    expect(warn.mock.calls[0][0]).toContain("not a positive number");
    expect(warn.mock.calls[0][0]).toContain("using the default 10000 ms");
  });

  it("warns for zero and a negative, which fall back to the default", () => {
    raise("0");
    raise("-5");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("says nothing about a value that was honoured as written", () => {
    for (const raw of ["1000", "2500", "120000", "2500.7"]) raise(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  it("says nothing when the variable is unset or blank", () => {
    for (const raw of [undefined, null, "", "   "]) raise(raw);
    expect(mod.resolveSendTimeoutMs({})).toBe(10000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per distinct value, not once per call", () => {
    for (let i = 0; i < 5; i++) raise("30");
    expect(warn).toHaveBeenCalledTimes(1);

    // A different value is a new fact; the first one is still not repeated.
    raise("40");
    expect(warn).toHaveBeenCalledTimes(2);
    raise("30");
    raise("40");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("warns once per value through sendTimeoutSignal too, since that is what every send calls", () => {
    for (let i = 0; i < 3; i++) mod.sendTimeoutSignal({ CRM_SEND_TIMEOUT_MS: "30" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never throws, whatever the variable holds", () => {
    for (const raw of ["30", "10000000", "30s", "0", "-5", "NaN", "Infinity", "1.5", "abc"]) {
      expect(() => mod.sendTimeoutSignal({ CRM_SEND_TIMEOUT_MS: raw }), raw).not.toThrow();
    }
  });
});

describe("sendTimeoutSignal", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns a signal that has not fired", () => {
    const signal = sendTimeoutSignal({});
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("asks AbortSignal.timeout for the resolved duration", () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const signal = sendTimeoutSignal({ CRM_SEND_TIMEOUT_MS: "4321" });
    expect(timeout).toHaveBeenCalledWith(4321);
    expect(signal).toBe(timeout.mock.results[0].value);
    sendTimeoutSignal({});
    expect(timeout).toHaveBeenLastCalledWith(DEFAULT_SEND_TIMEOUT_MS);
  });

  it("hands AbortSignal.timeout the clamped value, never the raw one", () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    sendTimeoutSignal({ CRM_SEND_TIMEOUT_MS: "30" });
    expect(timeout).toHaveBeenLastCalledWith(1000);
    sendTimeoutSignal({ CRM_SEND_TIMEOUT_MS: "10000000" });
    expect(timeout).toHaveBeenLastCalledWith(120000);
    sendTimeoutSignal({ CRM_SEND_TIMEOUT_MS: "30s" });
    expect(timeout).toHaveBeenLastCalledWith(10000);
  });

  it("is a new signal on every call, since an expired one stays expired", () => {
    expect(sendTimeoutSignal({})).not.toBe(sendTimeoutSignal({}));
  });

  it("fires with a TimeoutError once the time is up", async () => {
    // The shortest configurable time is a second, so shorten the clock itself.
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(15));
    const signal = sendTimeoutSignal({});
    await new Promise((resolveFired) => signal.addEventListener("abort", resolveFired, { once: true }));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason.name).toBe("TimeoutError");
  });
});
