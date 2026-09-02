import { describe, it, expect } from "vitest";
import { redactText, deepRedact, buildSecretList } from "./redactSecrets.js";

// The /api/wallet/psp-debug route (server.js) echoes back a PSP's raw
// response body and any thrown error message verbatim, which is exactly how
// a credential could leak: a provider's own error text sometimes echoes back
// part of what you sent it (e.g. "signature mismatch for key <the key>"),
// and our own thrown Errors interpolate the HTTP body. These tests plant a
// credential exactly where that could happen and prove it never reaches the
// output.

describe("redactText", () => {
  it("removes a known secret value planted in an error string", () => {
    const secrets = buildSecretList({ LETKNOWPAY_API_KEY: "sk_live_super_secret_123" });
    const message = "LetKnow Pay API error: signature mismatch for key sk_live_super_secret_123";
    const redacted = redactText(message, secrets);
    expect(redacted).not.toContain("sk_live_super_secret_123");
    expect(redacted).toContain("[REDACTED]");
  });

  it("removes an Authorization Bearer token even with no matching configured secret", () => {
    const message = "Bitpace balance HTTP 401: Authorization: Bearer abcDEF123.token-value_here";
    const redacted = redactText(message, []);
    expect(redacted).not.toMatch(/Bearer\s+abcDEF123/);
    expect(redacted).toContain("Bearer [REDACTED]");
  });

  it("removes a long hex HMAC signature even with no matching configured secret", () => {
    const signature = "a1b2c3d4e5f6".repeat(6); // 72 hex chars, shaped like an HMAC-SHA256/512 signature
    const message = `LetKnow Pay request rejected, C-Request-Signature was ${signature}`;
    const redacted = redactText(message, []);
    expect(redacted).not.toContain(signature);
  });

  it("leaves ordinary error text alone", () => {
    const message = "LetKnow Pay API error: shop temporarily unavailable, HTTP 503";
    expect(redactText(message, [])).toBe(message);
  });
});

describe("deepRedact", () => {
  it("scrubs a secret nested anywhere inside an object/array raw response body", () => {
    const secrets = buildSecretList({ BITPACE_MERCHANT_CODE: "topSecretShopId" });
    const raw = {
      balances: { USDTTRC20: "0.006487" },
      debug: {
        shopId: "topSecretShopId",
        notes: ["request failed, shop was topSecretShopId"],
      },
    };
    const redacted = deepRedact(raw, secrets);
    expect(JSON.stringify(redacted)).not.toContain("topSecretShopId");
    // Non-secret data must survive redaction untouched.
    expect(redacted.balances.USDTTRC20).toBe("0.006487");
  });
});

describe("buildSecretList", () => {
  it("reads from the given env object, not the real process.env, and drops empty values", () => {
    const list = buildSecretList({
      LETKNOWPAY_API_KEY: "k1",
      LETKNOWPAY_SHOP_ID: "",
      BITPACE_MERCHANT_CODE: undefined,
      BITPACE_API_PASS: "p1",
    });
    expect(list).toEqual(["k1", "p1"]);
  });
});
