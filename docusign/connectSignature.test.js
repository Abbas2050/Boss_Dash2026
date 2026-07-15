import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { verifyConnectSignatureRaw } from "./router.js";

const SECRET = "test-secret";
const sign = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("base64");

describe("verifyConnectSignatureRaw", () => {
  it("passes when the signature matches the raw bytes", () => {
    const raw = Buffer.from('{"data":{"envelopeId":"abc"},"spacing": 1}');
    expect(verifyConnectSignatureRaw(raw, sign(raw), SECRET).ok).toBe(true);
  });
  it("fails when the body was altered", () => {
    const raw = Buffer.from('{"data":{"envelopeId":"abc"}}');
    const other = Buffer.from('{"data":{"envelopeId":"evil"}}');
    expect(verifyConnectSignatureRaw(other, sign(raw), SECRET).ok).toBe(false);
  });
  it("fails when the signature header is missing", () => {
    const raw = Buffer.from("{}");
    const r = verifyConnectSignatureRaw(raw, "", SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_signature_header");
  });
  it("passes through when no secret is configured (documented gap)", () => {
    const raw = Buffer.from("{}");
    const r = verifyConnectSignatureRaw(raw, "", "");
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("hmac_not_configured");
  });
  it("fails when raw body was not captured but a secret is set", () => {
    const r = verifyConnectSignatureRaw(undefined, "sig", SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("raw_body_unavailable");
  });
});
