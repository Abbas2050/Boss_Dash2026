import { buildReportRecipientsView } from "./reportRecipientsView.js";
import { deepRedact } from "../wallet/redactSecrets.js";

/**
 * GET /api/reports/schedule -- who receives the nine scheduled reports.
 *
 * WHY THE ADMIN GATE LIVES INSIDE THE HANDLER rather than as a middleware
 * named at registration, the way the neighbouring test-send routes do it:
 * importing server.js starts a real listener and a database pool as a side
 * effect of module load, so a test cannot reach a gate that only exists there.
 * Keeping the check here means the refusal is testable without booting the
 * app, and `canManage` is injectable for exactly that. server.js still mounts
 * this behind authRequired, so an anonymous caller never reaches the gate at
 * all.
 *
 * WHY IT IS REDACTED: everything here is named explicitly -- recipient
 * addresses, cron expressions, timezones, enabled flags -- so nothing should
 * ever carry credential material. deepRedact is the repo's one scrubber and is
 * applied anyway, because "should" is not a guarantee: a mistyped .env line
 * can put anything into any variable, and the cost of the pass is nil.
 */
export function makeReportScheduleHandler({ canManage, env = process.env } = {}) {
  if (typeof canManage !== "function") {
    // Fail at wiring time, not at request time. A handler constructed without
    // a gate would answer everyone, and the first person to notice would be
    // whoever was not supposed to see the list.
    throw new Error("makeReportScheduleHandler requires a canManage function");
  }
  return (req, res) => {
    if (!canManage(req.auth)) return res.status(403).json({ error: "forbidden" });
    res.json(deepRedact(buildReportRecipientsView(env)));
  };
}
