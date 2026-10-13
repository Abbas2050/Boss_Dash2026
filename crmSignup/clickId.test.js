// @vitest-environment node
//
// The click identifier Meta matches on. Every mistake in this file degrades
// matching SILENTLY -- Meta accepts a malformed fbc and simply fails to match
// it, with no error anywhere.
import { describe, it, expect } from "vitest";
import { extractFbclid, buildFbc, deriveFbc } from "./clickId.js";

describe("extractFbclid", () => {
  it("pulls fbclid out of a landing URL", () => {
    expect(
      extractFbclid("https://skylinkscapital.com/en/?utm_source=meta&fbclid=IwY2xjawUsILdI")
    ).toBe("IwY2xjawUsILdI");
  });

  it("finds it wherever it sits in the query string", () => {
    expect(extractFbclid("https://x.com/p?fbclid=ABC")).toBe("ABC");
    expect(extractFbclid("https://x.com/p?a=1&fbclid=ABC&b=2")).toBe("ABC");
  });

  it("returns empty when there is none, rather than guessing", () => {
    expect(extractFbclid("https://skylinkscapital.com/en/")).toBe("");
    expect(extractFbclid("https://x.com/p?utm_source=google")).toBe("");
    expect(extractFbclid("")).toBe("");
    expect(extractFbclid(undefined)).toBe("");
  });

  it("does not throw on a value that is not a URL at all", () => {
    // full_link is whatever the CRM stored; it is not guaranteed well-formed.
    expect(() => extractFbclid("not a url")).not.toThrow();
    expect(extractFbclid("not a url")).toBe("");
  });

  it("still finds it in a string that is only a query fragment", () => {
    expect(extractFbclid("?fbclid=ABC")).toBe("ABC");
  });

  it("decodes a percent-encoded value", () => {
    expect(extractFbclid("https://x.com/p?fbclid=A%2BB")).toBe("A+B");
  });

  it("ignores a fragment after the query", () => {
    // A fragment is never part of the query and is never sent to the server.
    // Keeping it would put "#frag" inside the click id, a value Meta never matches.
    expect(extractFbclid("https://x.com/p?fbclid=ABC#frag")).toBe("ABC");
    // The fragment starts before the query, so the query is not in the part the
    // server sees. The fragment must be cut before the query is searched for.
    expect(extractFbclid("https://x.com/p#a?fbclid=ABC")).toBe("");
  });

  it("keeps a malformed escape as-is rather than throwing", () => {
    // The trailing %A is not a complete escape, so decodeURIComponent throws.
    // The raw value is still the only attribution we have.
    expect(() => extractFbclid("https://x.com/p?fbclid=%E0%A4%A")).not.toThrow();
    expect(extractFbclid("https://x.com/p?fbclid=%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("buildFbc", () => {
  it("wraps the id in Meta's four-part form", () => {
    // fb.1.<timestamp_ms>.<fbclid>. Sending the bare fbclid is accepted and
    // silently unmatched, which is the whole hazard.
    expect(buildFbc("IwY2xjawUsILdI", 1673035686000)).toBe("fb.1.1673035686000.IwY2xjawUsILdI");
  });

  it("returns empty when there is no click id to wrap", () => {
    expect(buildFbc("", 1673035686000)).toBe("");
    expect(buildFbc(undefined, 1673035686000)).toBe("");
  });

  it("uses milliseconds, not seconds", () => {
    const fbc = buildFbc("ABC", 1673035686000);
    expect(fbc.split(".")[2]).toBe("1673035686000");
    expect(fbc.split(".")[2]).not.toBe("1673035686");
  });

  it("returns empty when the timestamp is not a usable millisecond time", () => {
    // Without this, a missing time becomes "fb.1.NaN.ABC": well-formed-looking
    // and never matched. Losing the attribution is the honest outcome.
    expect(buildFbc("ABC", undefined)).toBe("");
    expect(buildFbc("ABC", NaN)).toBe("");
    expect(buildFbc("ABC", null)).toBe("");
    expect(buildFbc("ABC", 0)).toBe("");
    expect(buildFbc("ABC", 1673035686000.5)).toBe("");
    expect(buildFbc("ABC", -5)).toBe("");
  });
});

describe("deriveFbc", () => {
  it("is extraction and wrapping in one step", () => {
    expect(deriveFbc("https://x.com/p?fbclid=ABC", 1673035686000)).toBe("fb.1.1673035686000.ABC");
  });

  it("is empty when the landing URL carried no click", () => {
    // Organic signups have no fbclid, and that is normal, not an error.
    expect(deriveFbc("https://x.com/p", 1673035686000)).toBe("");
  });
});
