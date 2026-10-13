// @vitest-environment node
//
// One timeout for all three outbound senders, so it is decided in one place and
// pinned here once. Each sender's own test file proves that its fetch receives
// the signal; this file proves what the signal is.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_SEND_TIMEOUT_MS,
  SEND_TIMEOUT_ENV,
  resolveSendTimeoutMs,
  sendTimeoutSignal,
} from "./sendTimeout.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the shared constants", () => {
  it("defaults to ten seconds, overridden by CRM_SEND_TIMEOUT_MS", () => {
    expect(DEFAULT_SEND_TIMEOUT_MS).toBe(10000);
    expect(SEND_TIMEOUT_ENV).toBe("CRM_SEND_TIMEOUT_MS");
  });
});

describe("resolveSendTimeoutMs", () => {
  it("uses the default when the variable is not set", () => {
    expect(resolveSendTimeoutMs({})).toBe(10000);
  });

  it("honours a whole number of milliseconds, whitespace and all", () => {
    expect(resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: "2500" })).toBe(2500);
    expect(resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: "  2500 " })).toBe(2500);
    expect(resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: "1" })).toBe(1);
    expect(resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: "1e3" })).toBe(1000);
  });

  it("accepts the largest delay a Node timer can hold, and nothing above it", () => {
    expect(resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: "2147483647" })).toBe(2147483647);
    for (const raw of ["2147483648", "4294967295", "99999999999"]) {
      expect(resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: raw }), raw).toBe(10000);
    }
  });

  it("falls back to the default for a value that is not a usable timeout", () => {
    // Several of these make AbortSignal.timeout throw, and 0 would abort every
    // send before it began. None may reach it.
    for (const raw of ["", "  ", "abc", "10s", "0", "-5", "1.5", "NaN", "Infinity"]) {
      expect(resolveSendTimeoutMs({ CRM_SEND_TIMEOUT_MS: raw }), JSON.stringify(raw)).toBe(10000);
    }
  });

  it("reads process.env when called, not when imported", () => {
    vi.stubEnv("CRM_SEND_TIMEOUT_MS", "1234");
    expect(resolveSendTimeoutMs()).toBe(1234);
    vi.stubEnv("CRM_SEND_TIMEOUT_MS", undefined);
    expect(resolveSendTimeoutMs()).toBe(10000);
  });
});

describe("sendTimeoutSignal", () => {
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

  it("never throws, whatever the variable holds", () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    for (const raw of ["-1", "1.5", "abc", "99999999999", "0"]) {
      expect(() => sendTimeoutSignal({ CRM_SEND_TIMEOUT_MS: raw }), raw).not.toThrow();
      expect(timeout).toHaveBeenLastCalledWith(DEFAULT_SEND_TIMEOUT_MS);
    }
  });

  it("is a new signal on every call, since an expired one stays expired", () => {
    expect(sendTimeoutSignal({})).not.toBe(sendTimeoutSignal({}));
  });

  it("fires with a TimeoutError once the time is up", async () => {
    const signal = sendTimeoutSignal({ CRM_SEND_TIMEOUT_MS: "15" });
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason.name).toBe("TimeoutError");
  });
});
