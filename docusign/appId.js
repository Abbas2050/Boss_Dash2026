/**
 * FXBO sends applicationId inconsistently: sometimes "3892", sometimes a full
 * HTML anchor like '<a href="...">3892</a>', and once a literal header row.
 * The raw string was used as the idempotency key, so the same application was
 * stored twice and the client received two envelopes. Always normalize first.
 */
export function normalizeApplicationId(raw) {
  const text = String(raw ?? "").replace(/<[^>]*>/g, " ").trim();
  if (!text) return "";
  const match = text.match(/\d+/);
  return match ? match[0] : "";
}
