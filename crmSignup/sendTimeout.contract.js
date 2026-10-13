// The timeout behaviour every outbound sender must share, written once.
//
// Not a test file itself (vitest only collects *.test.js): meta.test.js,
// whatsapp.test.js and brevo.test.js each call describeSendTimeout() with their
// own sender, so the three can no longer drift apart on a fixture they copied.
import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_SEND_TIMEOUT_MS, SEND_TIMEOUT_ENV } from "./sendTimeout.js";

/** What an aborted fetch, or a body read cut off by the signal, really throws. */
export const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** A response whose headers arrived but whose body then stalled until the timeout. */
export const stalledBodyResponse = (status) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    throw timeoutError();
  },
});

/**
 * @param label  the sender's name, for the describe title
 * @param ok     () => a vi.fn fetch that answers the way a healthy provider does
 * @param send   (fetchImpl) => the sender under test, called with that fetch
 */
export function describeSendTimeout(label, { ok, send }) {
  describe(`${label} timeout`, () => {
    // Node's fetch has no timeout of its own, so without a signal a stalled
    // connection would hold the worker's sweep for hours.
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it("bounds the request with the shared default timeout", async () => {
      vi.stubEnv(SEND_TIMEOUT_ENV, undefined);
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const fetchImpl = ok();
      await send(fetchImpl);
      const [, init] = fetchImpl.mock.calls[0];
      expect(timeout).toHaveBeenCalledWith(DEFAULT_SEND_TIMEOUT_MS);
      expect(init.signal).toBe(timeout.mock.results[0].value);
      expect(init.signal.aborted).toBe(false);
    });

    it("takes its duration from CRM_SEND_TIMEOUT_MS, not from a number of its own", async () => {
      vi.stubEnv(SEND_TIMEOUT_ENV, "1234");
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const fetchImpl = ok();
      await send(fetchImpl);
      expect(timeout).toHaveBeenCalledWith(1234);
      expect(fetchImpl.mock.calls[0][1].signal).toBe(timeout.mock.results[0].value);
    });

    it("gives every send its own signal, so one expiry cannot abort the next", async () => {
      const fetchImpl = ok();
      await send(fetchImpl);
      await send(fetchImpl);
      const [first, second] = fetchImpl.mock.calls.map(([, init]) => init.signal);
      expect(first).toBeInstanceOf(AbortSignal);
      expect(second).toBeInstanceOf(AbortSignal);
      expect(second).not.toBe(first);
    });

    it("abandons a stalled request and reports a retryable transport failure, not an exception", async () => {
      // The configured duration is floored at a second, so the clock is shortened
      // here instead: a real signal from the real AbortSignal.timeout, one ms long.
      const real = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(1));
      let reason;
      const stalled = vi.fn(
        (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => {
                reason = init.signal.reason;
                reject(reason);
              },
              { once: true }
            );
          })
      );
      const r = await send(stalled);
      // What fetch really throws on an abort: a DOMException named TimeoutError.
      expect(reason).toBeInstanceOf(DOMException);
      expect(reason.name).toBe("TimeoutError");
      expect(r.status).toBe("failed");
      expect(r.retryable).toBe(true);
      expect(r.detail).toMatch(/^transport: /);
    });
  });
}
