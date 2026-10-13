/**
 * The one place that decides how long an outbound CRM send may take.
 *
 * Node's native fetch has no timeout, so a stalled connection waits forever.
 * The worker that drives the senders handles its rows one after another, so a
 * single hung send stalls every row behind it until the process recycles, which
 * on the IIS host can be hours. Each sender passes sendTimeoutSignal() to its
 * fetch. The abort arrives as a thrown DOMException named TimeoutError, which
 * each sender already classifies as a retryable transport failure.
 *
 * The duration is read from the environment at call time, not at import, so a
 * value loaded after this module is imported still counts.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 10000;
export const SEND_TIMEOUT_ENV = "CRM_SEND_TIMEOUT_MS";

// AbortSignal.timeout hands its delay to a Node timer, which holds a 32-bit
// signed integer: anything above this logs TimeoutOverflowWarning and fires
// after 1 ms. A bigger number is a misconfiguration, not a longer wait.
const MAX_SEND_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Milliseconds, from the env var when it holds a usable value, otherwise the
 * default. Usable means a whole number from 1 to 2^31 - 1: AbortSignal.timeout
 * itself throws on a fraction, a negative or NaN, and a 0 would abort every
 * send before it starts. A misconfigured value falls back to the default
 * rather than failing every send.
 */
export function resolveSendTimeoutMs(env = process.env) {
  const ms = Number(env[SEND_TIMEOUT_ENV]);
  return Number.isInteger(ms) && ms > 0 && ms <= MAX_SEND_TIMEOUT_MS ? ms : DEFAULT_SEND_TIMEOUT_MS;
}

/** A fresh signal per send: a signal that has expired stays expired. */
export function sendTimeoutSignal(env = process.env) {
  return AbortSignal.timeout(resolveSendTimeoutMs(env));
}
