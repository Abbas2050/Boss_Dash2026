// @vitest-environment node
//
// One rule, three senders. The three classifiers each carried their own copy of
// `408 || 429 || >= 500`, and the copies had already drifted once on this
// branch: 408 was retried by WhatsApp, permanent in Brevo and unhandled in
// Meta. This file holds the rule and the fact that nobody re-implements it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { isTransientHttpStatus } from "./transientHttp.js";

describe("isTransientHttpStatus", () => {
  it("retries a Request Timeout, a rate limit and every 5xx", () => {
    for (const code of [408, 429, 500, 502, 503, 504, 599]) {
      expect(isTransientHttpStatus(code), String(code)).toBe(true);
    }
  });

  it("leaves every other 4xx permanent, so the rule cannot widen into a range", () => {
    // A rule written as `>= 408` would quietly retry a bad key for ever.
    for (const code of [400, 401, 402, 403, 404, 405, 406, 407, 409, 410, 422, 451]) {
      expect(isTransientHttpStatus(code), String(code)).toBe(false);
    }
  });

  it("does not retry a success, a redirect, or a status it cannot read", () => {
    // 0 is a response we never understood. By the time a classifier asks, its
    // own transport branch has already had its say.
    for (const code of [200, 201, 204, 301, 302, 304, 0, -1, undefined, null, "", NaN, "abc", {}]) {
      expect(isTransientHttpStatus(code), String(code)).toBe(false);
    }
  });

  it("reads a status that arrives as text by its value", () => {
    expect(isTransientHttpStatus("503")).toBe(true);
    expect(isTransientHttpStatus("400")).toBe(false);
  });
});

describe("the three senders share it", () => {
  // Each classifier keeps its own success semantics on purpose (spec section 8):
  // Meta needs events_received, a DoubleTick 2xx only means the request was
  // accepted. What counts as transient is not one of those differences.
  for (const sender of ["meta.js", "whatsapp.js", "brevo.js"]) {
    it(`${sender} calls it rather than keeping its own copy`, () => {
      const source = readFileSync(path.resolve("crmSignup", sender), "utf8");
      expect(source).toContain('import { isTransientHttpStatus } from "./transientHttp.js";');
      expect(source).toMatch(/isTransientHttpStatus\(/);
      // No re-implementation anywhere in the file, comments included.
      expect(source).not.toMatch(/429/);
      expect(source).not.toMatch(/>=\s*500/);
      expect(source).not.toMatch(/408/);
    });
  }
});
