/**
 * The Meta click identifier.
 *
 * The CRM derives its own ClickID by pulling `fbclid` out of the landing URL it
 * was given as `full_link`. We get the same `full_link` as a webhook parameter,
 * so we derive the same thing without a REST call.
 *
 * Everything here fails quietly by design -- an organic signup has no fbclid,
 * and that is normal. What must NOT be quiet is a malformed result, so the
 * wrapping is tested rather than trusted: Meta accepts a bare fbclid and simply
 * never matches it.
 */

/** Meta's prefix and subdomain-index, both fixed for our use. */
const FBC_PREFIX = "fb";
const FBC_SUBDOMAIN_INDEX = "1";

export function extractFbclid(fullLink) {
  const raw = String(fullLink ?? "").trim();
  if (!raw) return "";

  const q = raw.indexOf("?");
  const query = q >= 0 ? raw.slice(q + 1) : raw;

  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) !== "fbclid") continue;
    const value = pair.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      // A malformed escape sequence is still a click id; keep it as-is rather
      // than discarding the only attribution we have.
      return value;
    }
  }
  return "";
}

/** `fb.1.<timestamp_ms>.<fbclid>` -- milliseconds, not seconds. */
export function buildFbc(fbclid, timestampMs) {
  const id = String(fbclid ?? "").trim();
  if (!id) return "";
  return `${FBC_PREFIX}.${FBC_SUBDOMAIN_INDEX}.${Number(timestampMs)}.${id}`;
}

export function deriveFbc(fullLink, timestampMs) {
  return buildFbc(extractFbclid(fullLink), timestampMs);
}
