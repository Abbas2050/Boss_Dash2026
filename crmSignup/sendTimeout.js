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

// The window an operator's value is held to. Either end defeats the purpose:
// below a second a send aborts before TLS completes, and since an abort is
// retryable every row burns its whole retry budget and fails (CRM_SEND_TIMEOUT_MS=30,
// seconds typed as milliseconds). Above two minutes a stall again holds the
// sweep for hours. The ceiling also keeps the value inside what a Node timer
// can hold: AbortSignal.timeout throws on a fraction or NaN, and fires after
// 1 ms above 2^31 - 1.
export const MIN_SEND_TIMEOUT_MS = 1000;
export const MAX_SEND_TIMEOUT_MS = 120000;

// A value is reported once, not per call: this runs on every single send.
const reported = new Set();

function reportOnce(raw, problem, used) {
  const key = String(raw);
  if (reported.has(key)) return;
  reported.add(key);
  // A warning, never a throw: the senders are documented as never throwing. The
  // iisnode stdout log is where configuration surfaces on this host.
  console.warn(`[crm-events] ${SEND_TIMEOUT_ENV}=${JSON.stringify(key)} ${problem}; using ${used} ms`);
}

/**
 * Milliseconds, from the env var, held to [MIN_SEND_TIMEOUT_MS, MAX_SEND_TIMEOUT_MS].
 *
 * A number outside the window is clamped to the nearest edge, so an operator who
 * writes 500 gets "short" and one who writes 10000000 gets "long", both safely.
 * Something that is not a positive number at all (30s, abc, 0, -5) cannot be
 * read as either, so it falls back to the default. Unset or blank is simply the
 * default, silently. Every other ignored or clamped value is warned about.
 */
export function resolveSendTimeoutMs(env = process.env) {
  const raw = env[SEND_TIMEOUT_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_SEND_TIMEOUT_MS;

  const n = Number(raw);
  if (!(n > 0)) {
    reportOnce(raw, "is not a positive number of milliseconds", `the default ${DEFAULT_SEND_TIMEOUT_MS}`);
    return DEFAULT_SEND_TIMEOUT_MS;
  }

  // AbortSignal.timeout refuses a fraction, so 2500.7 is 2500.
  const ms = Math.trunc(n);
  if (ms < MIN_SEND_TIMEOUT_MS) {
    reportOnce(raw, `is below the ${MIN_SEND_TIMEOUT_MS} ms minimum`, MIN_SEND_TIMEOUT_MS);
    return MIN_SEND_TIMEOUT_MS;
  }
  if (ms > MAX_SEND_TIMEOUT_MS) {
    reportOnce(raw, `is above the ${MAX_SEND_TIMEOUT_MS} ms maximum`, MAX_SEND_TIMEOUT_MS);
    return MAX_SEND_TIMEOUT_MS;
  }
  return ms;
}

/** A fresh signal per send: a signal that has expired stays expired. */
export function sendTimeoutSignal(env = process.env) {
  return AbortSignal.timeout(resolveSendTimeoutMs(env));
}
