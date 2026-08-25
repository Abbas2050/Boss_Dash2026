// @vitest-environment node
//
// auth/rateLimit.js (an IP-only, success-counting middleware stacked on top
// of the login route) was removed. It caused three problems: blocked
// requests short-circuited before auth.login.rate_limited was ever logged,
// so an operator had no visibility; an office sharing one NAT IP could be
// locked out by ordinary morning logins; and the two limiters returned
// different 429 shapes on one endpoint.
//
// The replacement folds a per-IP cap into the existing per-(ip,email)
// limiter in auth/router.js, so there is exactly one 429 shape and one
// audit event, and the IP cap -- like the email cap -- counts failures
// only, never successes.
import { describe, it, expect, beforeEach } from "vitest";
import {
  isRateLimited,
  isIpRateLimited,
  noteFailedLogin,
  clearFailedLogin,
  resetLoginRateLimitState,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
} from "./router.js";

// Minimal fake request: only req.ip is read by the rate-limit helpers.
const reqFor = (ip) => ({ ip });

beforeEach(() => {
  resetLoginRateLimitState();
});

describe("login rate limiting", () => {
  it("trips the IP cap when many DIFFERENT emails fail from one IP", () => {
    const ip = "203.0.113.1";
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS; i += 1) {
      // A different email every time -- this is the enumeration/spray
      // pattern the per-email cap alone cannot bound, since each address
      // gets its own fresh budget.
      noteFailedLogin(reqFor(ip), `victim${i}@example.com`);
    }
    expect(isIpRateLimited(reqFor(ip))).toBe(true);
    // A brand-new email from the same IP is still blocked -- the cap is
    // IP-wide, not per address.
    expect(isRateLimited(reqFor(ip), "never-tried@example.com")).toBe(false);
    expect(isIpRateLimited(reqFor(ip))).toBe(true);
  });

  it("does not trip the IP cap one attempt short of the threshold", () => {
    const ip = "203.0.113.2";
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS - 1; i += 1) {
      noteFailedLogin(reqFor(ip), `user${i}@example.com`);
    }
    expect(isIpRateLimited(reqFor(ip))).toBe(false);
  });

  it("still trips the per-email cap at 8 failures against one address", () => {
    const ip = "198.51.100.1";
    const email = "target@example.com";
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i += 1) {
      noteFailedLogin(reqFor(ip), email);
      expect(isRateLimited(reqFor(ip), email)).toBe(false);
    }
    noteFailedLogin(reqFor(ip), email);
    expect(isRateLimited(reqFor(ip), email)).toBe(true);
    expect(LOGIN_MAX_ATTEMPTS).toBe(8);
  });

  it("a successful login does not consume either cap's budget", () => {
    const ip = "198.51.100.2";
    const email = "person@example.com";
    // Fail right up to (but not past) each threshold.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i += 1) noteFailedLogin(reqFor(ip), email);
    expect(isRateLimited(reqFor(ip), email)).toBe(false);

    // Success: the handler calls clearFailedLogin, not noteFailedLogin.
    clearFailedLogin(reqFor(ip), email);
    expect(isRateLimited(reqFor(ip), email)).toBe(false);

    // Budget is available again for a subsequent mistake, proving the
    // success reset the counter rather than merely leaving it unchanged.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i += 1) noteFailedLogin(reqFor(ip), email);
    expect(isRateLimited(reqFor(ip), email)).toBe(false);
  });

  it("a successful login for one email does not reset the IP-wide cap", () => {
    // Otherwise an attacker spraying many addresses from one IP could just
    // log in to one throwaway account they own to reset their own budget.
    const ip = "198.51.100.3";
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS; i += 1) {
      noteFailedLogin(reqFor(ip), `spray${i}@example.com`);
    }
    expect(isIpRateLimited(reqFor(ip))).toBe(true);
    clearFailedLogin(reqFor(ip), "spray0@example.com");
    expect(isIpRateLimited(reqFor(ip))).toBe(true);
  });

  it("both caps forget a caller after the window passes", () => {
    const ip = "198.51.100.4";
    const email = "windowed@example.com";
    let clock = 1_000_000;
    // Same email throughout, enough failures to trip both the per-email
    // cap (8) and the per-IP cap (40) at once.
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS; i += 1) noteFailedLogin(reqFor(ip), email, clock);
    expect(isRateLimited(reqFor(ip), email, clock)).toBe(true);
    expect(isIpRateLimited(reqFor(ip), clock)).toBe(true);

    // One millisecond short of the window: both caps still hold.
    clock += LOGIN_WINDOW_MS;
    expect(isRateLimited(reqFor(ip), email, clock)).toBe(true);
    expect(isIpRateLimited(reqFor(ip), clock)).toBe(true);

    // Past the window: both caps forget the caller.
    clock += 1;
    expect(isRateLimited(reqFor(ip), email, clock)).toBe(false);
    expect(isIpRateLimited(reqFor(ip), clock)).toBe(false);
  });

  it("two different IPs do not interfere with each other's IP cap", () => {
    const ipA = "192.0.2.10";
    const ipB = "192.0.2.20";
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS; i += 1) {
      noteFailedLogin(reqFor(ipA), `a${i}@example.com`);
    }
    expect(isIpRateLimited(reqFor(ipA))).toBe(true);
    expect(isIpRateLimited(reqFor(ipB))).toBe(false);

    // ipB needs its own full run to trip its own cap.
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS - 1; i += 1) {
      noteFailedLogin(reqFor(ipB), `b${i}@example.com`);
    }
    expect(isIpRateLimited(reqFor(ipB))).toBe(false);
    noteFailedLogin(reqFor(ipB), "last@example.com");
    expect(isIpRateLimited(reqFor(ipB))).toBe(true);
  });

  it("two different IPs do not interfere with each other's per-email cap", () => {
    const email = "shared-name@example.com";
    const ipA = "192.0.2.30";
    const ipB = "192.0.2.40";
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) noteFailedLogin(reqFor(ipA), email);
    expect(isRateLimited(reqFor(ipA), email)).toBe(true);
    // Same email, different IP: the per-email key includes the IP, so this
    // is a distinct budget.
    expect(isRateLimited(reqFor(ipB), email)).toBe(false);
  });

  it("documents the configured window", () => {
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});
