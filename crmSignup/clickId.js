/**
 * The click identifiers that arrive inside the landing URL.
 *
 * The CRM derives its own ClickID by pulling `fbclid` out of the landing URL it
 * was given as `full_link`. We get the same `full_link` as a webhook parameter,
 * so we derive the same thing without a REST call. `oppref` is OpenAI's
 * equivalent, and arrives the same way in the same string.
 *
 * Everything here fails quietly by design -- an organic signup has neither, and
 * that is normal. What must NOT be quiet is a malformed result, so the wrapping
 * is tested rather than trusted: Meta accepts a bare fbclid and simply never
 * matches it.
 */

/** Meta's prefix and subdomain-index, both fixed for our use. */
const FBC_PREFIX = "fb";
const FBC_SUBDOMAIN_INDEX = "1";

/**
 * One query parameter out of whatever `full_link` happens to be.
 *
 * Shared by both click identifiers below, because none of the ways this goes
 * wrong belong to either platform: a fragment that hides a query string the
 * server never saw, a value that will not decode, a `full_link` that is not a
 * URL at all. One parser cannot drift from itself, and these cases are already
 * pinned by test for `fbclid`.
 */
function queryParam(fullLink, name) {
  const raw = String(fullLink ?? "").trim();
  if (!raw) return "";

  // A fragment is never part of the query and is never sent to the server, so
  // it is cut off before the query is looked at.
  const hash = raw.indexOf("#");
  const noFragment = hash >= 0 ? raw.slice(0, hash) : raw;

  const q = noFragment.indexOf("?");
  const query = q >= 0 ? noFragment.slice(q + 1) : noFragment;

  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) !== name) continue;
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

export function extractFbclid(fullLink) {
  return queryParam(fullLink, "fbclid");
}

/**
 * OpenAI's click identifier, and it lives here rather than in openai.js
 * because the parsing is not OpenAI's concern -- it is the landing URL's, and
 * it is the identical parse `fbclid` already needs.
 *
 * **OpenAI's Conversions API does not capture it**, so without it a conversion
 * cannot be attributed to the ad that produced it. It must be extracted at
 * first sight and frozen in its own column, for the two reasons `fbc` is:
 * `full_link` is scrubbed about a minute after signup, so parsing it on demand
 * would work for a client's first event and fail silently for every later one;
 * and the first deposit is a different row arriving weeks later, with its own
 * `full_link`, which will normally be empty because that visit is not an ad
 * click.
 *
 * Unlike `fbc` there is nothing to wrap: no `fb.1.<ms>.` prefix and no
 * timestamp, so the value itself is the whole of what is frozen, and there is
 * no buildOppref to get wrong.
 */
export function extractOppref(fullLink) {
  return queryParam(fullLink, "oppref");
}

/**
 * Google's click identifier, parsed here for the reason `oppref` is: the parse
 * belongs to the landing URL, not to the destination, and it is the identical
 * one `fbclid` already needs.
 *
 * Auto-tagging is what puts it there -- Google appends `gclid` to the landing
 * URL itself, which is why no website change was needed for any of this. It is
 * confirmed on for this account, so the value is already inside the `full_link`
 * FXBO hands us.
 *
 * **Without it a conversion cannot be attributed at all**, and that is sharper
 * here than for the other two: Meta and OpenAI both fall back to the hashed
 * email and phone, while the Data Manager ingest carries the gclid in
 * `adIdentifiers` and no `userData` at all -- the gclid IS the identity of the
 * click, with nothing behind it. So it is extracted at first sight and
 * frozen in its own column, for the two reasons `fbc` and `oppref` are:
 * `full_link` is scrubbed about a minute after signup, and the first deposit is
 * a different row arriving weeks later whose own `full_link` is normally empty
 * because that visit is not an ad click.
 *
 * Taken raw, like `oppref` and unlike `fbc`: there is no wrapper and no
 * timestamp around it, so the value itself is the whole of what is frozen.
 */
export function extractGclid(fullLink) {
  return queryParam(fullLink, "gclid");
}

/** `fb.1.<timestamp_ms>.<fbclid>` -- milliseconds, not seconds. */
export function buildFbc(fbclid, timestampMs) {
  const id = String(fbclid ?? "").trim();
  if (!id) return "";
  const ts = Number(timestampMs);
  // An absent or unusable time must not reach Meta as "NaN", "0" or a
  // fractional value: those look well-formed and are never matched.
  if (!Number.isInteger(ts) || ts <= 0) return "";
  return `${FBC_PREFIX}.${FBC_SUBDOMAIN_INDEX}.${ts}.${id}`;
}

export function deriveFbc(fullLink, timestampMs) {
  return buildFbc(extractFbclid(fullLink), timestampMs);
}
