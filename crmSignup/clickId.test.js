// @vitest-environment node
//
// The click identifiers Meta, OpenAI and Google match on. Every mistake in this
// file degrades matching SILENTLY -- Meta accepts a malformed fbc and simply
// fails to match it, with no error anywhere, and a missing oppref or gclid is
// indistinguishable from an organic signup.
import { describe, it, expect } from "vitest";
import { extractFbclid, extractOppref, extractGclid, buildFbc, deriveFbc } from "./clickId.js";

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

describe("extractOppref", () => {
  it("pulls oppref out of a landing URL", () => {
    expect(
      extractOppref("https://skylinkscapital.com/en/?utm_source=chatgpt&oppref=abc123XYZ")
    ).toBe("abc123XYZ");
  });

  it("finds it wherever it sits in the query string", () => {
    expect(extractOppref("https://x.com/p?oppref=ABC")).toBe("ABC");
    expect(extractOppref("https://x.com/p?a=1&oppref=ABC&b=2")).toBe("ABC");
  });

  it("returns empty when there is none, rather than guessing", () => {
    // An organic signup has no oppref, and that is normal, not an error.
    expect(extractOppref("https://skylinkscapital.com/en/")).toBe("");
    expect(extractOppref("https://x.com/p?utm_source=google")).toBe("");
    expect(extractOppref("")).toBe("");
    expect(extractOppref(undefined)).toBe("");
  });

  it("does not take fbclid for an oppref, or the other way round", () => {
    // The two arrive in the same string and are never the same value. Reading
    // one as the other would attribute every ChatGPT conversion to a Meta click
    // id OpenAI can never match, with nothing erroring.
    expect(extractOppref("https://x.com/p?fbclid=META")).toBe("");
    expect(extractFbclid("https://x.com/p?oppref=OPENAI")).toBe("");
    const both = "https://x.com/p?fbclid=META&oppref=OPENAI";
    expect(extractOppref(both)).toBe("OPENAI");
    expect(extractFbclid(both)).toBe("META");
  });

  it("does not match a parameter that merely ends in oppref", () => {
    // A prefix match would read `my_oppref` or `xoppref` as ours.
    expect(extractOppref("https://x.com/p?my_oppref=ABC")).toBe("");
    expect(extractOppref("https://x.com/p?opprefx=ABC")).toBe("");
  });

  it("does not throw on a value that is not a URL at all", () => {
    // full_link is whatever the CRM stored; it is not guaranteed well-formed.
    expect(() => extractOppref("not a url")).not.toThrow();
    expect(extractOppref("not a url")).toBe("");
  });

  it("still finds it in a string that is only a query fragment", () => {
    expect(extractOppref("?oppref=ABC")).toBe("ABC");
  });

  it("decodes a percent-encoded value", () => {
    expect(extractOppref("https://x.com/p?oppref=A%2BB")).toBe("A+B");
  });

  it("ignores a fragment after the query", () => {
    expect(extractOppref("https://x.com/p?oppref=ABC#frag")).toBe("ABC");
    // The fragment starts before the query, so the query is not in the part the
    // server sees. The fragment must be cut before the query is searched for.
    expect(extractOppref("https://x.com/p#a?oppref=ABC")).toBe("");
  });

  it("keeps a malformed escape as-is rather than throwing", () => {
    expect(() => extractOppref("https://x.com/p?oppref=%E0%A4%A")).not.toThrow();
    expect(extractOppref("https://x.com/p?oppref=%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("returns the value raw, with no wrapper of any kind", () => {
    // Unlike fbc there is no fb.1.<ms>. prefix and no timestamp. Anything added
    // here is a value OpenAI never matches.
    expect(extractOppref("https://x.com/p?oppref=ABC")).toBe("ABC");
  });
});

describe("extractGclid", () => {
  it("pulls gclid out of a landing URL", () => {
    // Auto-tagging appends it, which is why no website change was needed: the
    // value is already in the full_link FXBO hands us.
    expect(
      extractGclid("https://skylinkscapital.com/en/?utm_source=google&gclid=Cj0KCQiAx6WgBhCX")
    ).toBe("Cj0KCQiAx6WgBhCX");
  });

  it("finds it wherever it sits in the query string", () => {
    expect(extractGclid("https://x.com/p?gclid=ABC")).toBe("ABC");
    expect(extractGclid("https://x.com/p?a=1&gclid=ABC&b=2")).toBe("ABC");
  });

  it("returns empty when there is none, rather than guessing", () => {
    // The commonest case of the three, and the one with the sharpest
    // consequence: Google attributes on the gclid alone, so a conversion
    // without one is not weakly matched, it is unattributable.
    expect(extractGclid("https://skylinkscapital.com/en/")).toBe("");
    expect(extractGclid("https://x.com/p?utm_source=google")).toBe("");
    expect(extractGclid("")).toBe("");
    expect(extractGclid(undefined)).toBe("");
  });

  it("takes none of the other two click ids for a gclid, or the other way round", () => {
    // All three arrive in the same string and are never the same value. Reading
    // one as another would upload every Google conversion against a click id
    // Google has never seen, and Google answers CLICK_NOT_FOUND -- which its own
    // documentation says to treat as a warning, so the mistake would hide inside
    // the one error we are told not to alarm at.
    expect(extractGclid("https://x.com/p?fbclid=META&oppref=OPENAI")).toBe("");
    const all = "https://x.com/p?fbclid=META&oppref=OPENAI&gclid=GOOGLE";
    expect(extractGclid(all)).toBe("GOOGLE");
    expect(extractOppref(all)).toBe("OPENAI");
    expect(extractFbclid(all)).toBe("META");
  });

  it("does not match a parameter that merely contains gclid", () => {
    // `gclsrc` and `wbraid` travel beside it in a real auto-tagged URL, and
    // `gbraid` is a different identifier for the same purpose that this
    // deliberately does not read: the upload would have to put it in its own
    // field, not in `gclid`.
    expect(extractGclid("https://x.com/p?my_gclid=ABC")).toBe("");
    expect(extractGclid("https://x.com/p?gclidx=ABC")).toBe("");
    expect(extractGclid("https://x.com/p?gclsrc=aw.ds&gbraid=BRAID")).toBe("");
  });

  it("does not throw on a value that is not a URL at all", () => {
    expect(() => extractGclid("not a url")).not.toThrow();
    expect(extractGclid("not a url")).toBe("");
  });

  it("still finds it in a string that is only a query fragment", () => {
    expect(extractGclid("?gclid=ABC")).toBe("ABC");
  });

  it("decodes a percent-encoded value", () => {
    expect(extractGclid("https://x.com/p?gclid=A%2BB")).toBe("A+B");
  });

  it("ignores a fragment after the query", () => {
    expect(extractGclid("https://x.com/p?gclid=ABC#frag")).toBe("ABC");
    expect(extractGclid("https://x.com/p#a?gclid=ABC")).toBe("");
  });

  it("keeps a malformed escape as-is rather than throwing", () => {
    expect(() => extractGclid("https://x.com/p?gclid=%E0%A4%A")).not.toThrow();
    expect(extractGclid("https://x.com/p?gclid=%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("returns the value raw, with no wrapper of any kind", () => {
    // Like oppref and unlike fbc: no prefix, no timestamp. A gclid is an opaque
    // token, and anything added to it is a token Google never matches.
    expect(extractGclid("https://x.com/p?gclid=ABC")).toBe("ABC");
  });

  it("keeps a real auto-tagged gclid whole, dots, dashes and underscores included", () => {
    // Google's own tokens carry `-`, `_` and `.`, and they are long. A parser
    // that stopped at any of them would hand back a prefix -- which uploads,
    // is accepted, and attributes to nothing.
    const real = "EAIaIQobChMI8r-Hh.9_7wIVFRwrCh2KQA1cEAAYASAAEgJ_5_D_BwE";
    expect(extractGclid(`https://skylinkscapital.com/en/?gclid=${real}&gclsrc=aw.ds`)).toBe(real);
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
