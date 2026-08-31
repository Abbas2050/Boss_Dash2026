// Parses the optional `from`/`to` period for the monthly backfill test routes
// (POST /api/reports/slippage-monthly/test and /dealmatch-monthly/test).
//
// Pulled into its own module (rather than staying a private function inside
// server.js) so it can be unit tested directly: server.js opens a real TCP
// listener and DB pool as soon as it is imported (see the unconditional
// `server.listen(...)` call near the bottom of the file), so importing it
// from a test file is not safe. This module has no side effects on import.
//
// `from` and `to` are YYYY-MM-DD. Omit them for the previous full month.
export function parseTestPeriod(body) {
  const { from, to } = body || {};
  if (!from && !to) return {};
  const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  if (!valid(from) || !valid(to)) return { error: 'from and to must both be YYYY-MM-DD' };
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T23:59:59Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { error: 'from or to is not a real date' };
  }
  if (fromDate > toDate) return { error: 'from is after to' };
  return { fromDate, toDate };
}
