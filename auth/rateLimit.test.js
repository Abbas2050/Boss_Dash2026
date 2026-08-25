// @vitest-environment node
//
// Login had no rate limit, so guessing a password against a known address was
// bounded only by bcrypt's cost.
import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rateLimit.js";

const mkRes = () => {
  const res = { statusCode: 0, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
};
const run = (limiter, ip) => {
  const res = mkRes();
  let passed = false;
  limiter({ ip, headers: {}, socket: { remoteAddress: ip } }, res, () => { passed = true; });
  return { res, passed };
};

describe("createRateLimiter", () => {
  it("allows requests up to the limit", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(run(limiter, "1.1.1.1").passed, `request ${i + 1} should pass`).toBe(true);
    }
  });

  it("refuses the one after with 429", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i += 1) run(limiter, "1.1.1.1");
    const { res, passed } = run(limiter, "1.1.1.1");
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeGreaterThan(0);
  });

  it("counts each IP separately", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    run(limiter, "1.1.1.1");
    expect(run(limiter, "1.1.1.1").passed).toBe(false);
    expect(run(limiter, "2.2.2.2").passed).toBe(true);
  });

  it("forgets a caller once the window passes", () => {
    let clock = 0;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => clock });
    expect(run(limiter, "1.1.1.1").passed).toBe(true);
    expect(run(limiter, "1.1.1.1").passed).toBe(false);
    clock += 60_001;
    expect(run(limiter, "1.1.1.1").passed).toBe(true);
  });

  // An unbounded map keyed by attacker-controlled IPs is itself a denial of
  // service.
  it("does not grow without bound", () => {
    let clock = 0;
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1, now: () => clock });
    for (let i = 0; i < 5_000; i += 1) {
      clock += 1;
      run(limiter, `10.0.${Math.floor(i / 255)}.${i % 255}`);
    }
    clock += 10_000;
    run(limiter, "9.9.9.9");
    expect(limiter.size()).toBeLessThan(1_000);
  });
});
