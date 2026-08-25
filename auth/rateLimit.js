/**
 * A minimal in-memory per-IP rate limiter.
 *
 * Deliberately not a dependency: the repo already carries 30 advisories and
 * this is twenty lines. The trade-off is that counts are per process, so a
 * multi-worker host divides the effective limit by the worker count. That is
 * acceptable for slowing password guessing; it is not a general quota system.
 */
export function createRateLimiter({ windowMs, max, now = Date.now } = {}) {
  const hits = new Map();

  const clientIp = (req) =>
    String(req.ip || req.socket?.remoteAddress || "unknown");

  // Sweep on write rather than on a timer, so an idle process holds nothing.
  const sweep = (t) => {
    for (const [key, entry] of hits) {
      if (t - entry.start >= windowMs) hits.delete(key);
    }
  };

  const limiter = (req, res, next) => {
    const t = now();
    if (hits.size > 500) sweep(t);

    const key = clientIp(req);
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return next();
    }
    if (entry.count < max) {
      entry.count += 1;
      return next();
    }
    const retryAfter = Math.max(1, Math.ceil((entry.start + windowMs - t) / 1000));
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).json({ error: "too_many_requests", retryAfterSeconds: retryAfter });
  };

  limiter.size = () => hits.size;
  return limiter;
}
