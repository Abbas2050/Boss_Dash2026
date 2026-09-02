/**
 * Scrubs credential material out of arbitrary text or JSON before it is
 * allowed anywhere near an HTTP response body.
 *
 * Why this exists: the /api/wallet/psp-debug route (server.js) echoes back a
 * PSP's raw response body, plus whatever error message its client threw, so
 * a human can see exactly what LetKnow Pay / Bitpace actually returned. Some
 * providers' error responses echo back part of what you sent them (to help
 * you debug a bad signature), and our own thrown Errors sometimes interpolate
 * the HTTP status/body verbatim -- so a naive passthrough could leak an API
 * key, shop id, HMAC signature, merchant code, or Authorization header value.
 * This is the one place that scrubbing happens, so every caller gets the
 * same guarantee instead of each hand-rolling its own redaction.
 */

// Literal secret values pulled from configured env vars: the fastest, most
// precise redaction, and it works even for secrets that don't happen to
// match the pattern-based checks below. `env` is injectable so tests can
// plant a fake credential without touching real process.env.
export function buildSecretList(env = process.env) {
  return [
    env.LETKNOWPAY_API_KEY,
    env.LETKNOWPAY_SHOP_ID,
    env.BITPACE_MERCHANT_CODE,
    env.BITPACE_API_PASS,
    // The trading backend's key (wallet/backendToken.js exchanges it for a
    // Bearer). Its exchange errors quote the token endpoint's response body
    // verbatim, and a gateway that rejects a credential frequently echoes the
    // credential back in the complaint.
    env.BACKEND_API_KEY,
  ].filter((v) => typeof v === 'string' && v.length > 0);
}

function redactKnownSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

// Does this look like credential MATERIAL, as opposed to an ordinary English
// word that happens to follow "Bearer" in someone's error prose?
//
// This distinction is load-bearing. The backend's own rejection reads "Bearer
// token missing, expired, or revoked", and a blanket rule on everything after
// "Bearer " rewrote it to "Bearer [REDACTED] missing, expired, or revoked."
// -- redacting the WORD "token" out of THEIR message and destroying the only
// diagnostic the operator had. We redact secret values, not vocabulary.
//
// Two cheap signals separate the two, and a real token passes both: minted
// access tokens here are opaque hex or JWTs, so they are long, and they carry
// digits, dots, dashes or underscores. A word of prose is short, or is pure
// letters, or both. Anything that slips past is still caught by the literal
// scrub of buildSecretList() and by the 32+ hex rule below.
function looksLikeCredentialMaterial(value) {
  if (value.length < 12) return false; // "token", "credentials", "auth"
  if (/^[A-Za-z]+$/.test(value)) return false; // "authentication", "authorization"
  return true;
}

// Pattern-based backstop for credential shapes even when the concrete value
// isn't known ahead of time -- e.g. an HMAC signature computed per-request
// (never sitting in its own env var) or a key rotated after this process
// started, so it is no longer in buildSecretList().
function redactKnownPatterns(text) {
  return text
    .replace(/Bearer\s+([A-Za-z0-9._-]+)/gi, (match, value) =>
      looksLikeCredentialMaterial(value) ? 'Bearer [REDACTED]' : match,
    )
    // A bare 32+ char hex run is what both an API key and an HMAC-SHA256/512
    // signature look like on the wire; there is nothing else in a PSP
    // balance response that legitimately looks like this.
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED]')
    // The value sitting next to a credential-shaped key name, in either JSON
    // ("access_token":"abc") or form (client_secret=abc) form. A minted OAuth
    // token is the case that needs this: it is not in any env var, so
    // buildSecretList cannot know it, and it usually looks nothing like hex.
    // wallet/backendToken.js quotes the token endpoint's own error body back
    // to the operator, and a gateway complaining about a credential very often
    // echoes that credential in the complaint.
    .replace(
      /((?:access_token|refresh_token|id_token|client_secret|api[_-]?key|token|secret|password)\\?"?\s*[:=]\s*\\?"?)([^"'\s,&}\\]+)/gi,
      '$1[REDACTED]',
    );
}

// Literal-value scrubbing only, with none of the pattern rules. For text we
// have COMPOSED ourselves out of already-redacted parts, where the pattern
// rules would do damage: wallet/backendToken.js names each credential shape it
// tried ("form api_key: HTTP 400 ..."), and the credential-key pattern above
// reads that label as a key/value pair and eats the status -- destroying the
// very diagnosis the message exists to carry. The parts are pattern-redacted
// individually; this is the belt-and-braces pass over the whole.
export function redactSecretValues(text, secrets = buildSecretList()) {
  return redactKnownSecrets(String(text ?? ''), secrets);
}

export function redactText(text, secrets = buildSecretList()) {
  const str = String(text ?? '');
  return redactKnownPatterns(redactKnownSecrets(str, secrets));
}

// Walks an arbitrary JSON-shaped value (object/array/primitive) and applies
// redactText() to every string found, so a whole raw provider response body
// -- not just a hand-written error message -- gets the same treatment.
export function deepRedact(value, secrets = buildSecretList()) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, secrets);
    return out;
  }
  return value;
}
