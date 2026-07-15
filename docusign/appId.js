/**
 * FXBO sends applicationId inconsistently: sometimes "3892", sometimes a full
 * HTML anchor like '<a href="...">3892</a>', and once a literal header row.
 * The raw string was used as the idempotency key, so the same application was
 * stored twice and the client received two envelopes. Always normalize first.
 *
 * Rules mirror migrateAppIds.js's decideRowActions so the runtime path and
 * the one-off migration never disagree on what a given raw id becomes:
 *  1. Pure digit-run ("3892")            -> return as-is.
 *  2. Contains an HTML tag               -> strip tags, return the first
 *     digit-run, or "" if none.
 *  3. No HTML, has a digit, not a pure
 *     digit-run (e.g. "APP-TEST-001")    -> opaque id, return trimmed input
 *     UNCHANGED — never mangled into a substring of digits.
 *  4. No HTML, no digits at all          -> junk, return "".
 */
export function normalizeApplicationId(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return "";

  if (/^\d+$/.test(input)) return input;

  if (/<[^>]+>/.test(input)) {
    const text = input.replace(/<[^>]*>/g, " ").trim();
    const match = text.match(/\d+/);
    return match ? match[0] : "";
  }

  if (/\d/.test(input)) return input;

  return "";
}
