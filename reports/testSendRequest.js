// Request parsing for the on-demand report test-send routes in server.js, plus
// the handler those routes share.
//
// WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE server.js: importing server.js
// opens a real TCP listener and a DB pool as a side effect of module load (see
// the unconditional `server.listen(...)` near the bottom of that file), so a
// test cannot import it. Anything that needs a unit test has to live out here.
// This module has no side effects on import -- the same reasoning that put
// parseTestPeriod.js in its own file.
//
// WHY IT ALSO OWNS THE HANDLER: the rules worth testing are not just "is this
// cadence spelled correctly" but "a bad cadence must not reach the runner" and
// "a body without recipients must not send". Those are only observable at the
// handler, so the handler is built here and server.js registers it.
import { CADENCES } from "./reportShared.js";
import { parseTestPeriod } from "./parseTestPeriod.js";

export const VALID_CADENCES = Object.keys(CADENCES);

// Recipients for an on-demand report test send: accepts either an array or a
// comma-separated string in the request body.
export function parseTestRecipients(body) {
  const rawList = Array.isArray(body?.recipients)
    ? body.recipients
    : String(body?.recipients || "").split(",");
  return rawList.map((e) => String(e).trim()).filter(Boolean);
}

/**
 * The optional `cadence` on a test-send request.
 *
 * Returns {} when the caller did not ask for one -- the run function then picks
 * its own default, which is the behaviour every caller had before this existed.
 * Returns { cadence } for a recognised value, { error } otherwise.
 *
 * An unrecognised cadence is an ERROR AND NEVER A FALLBACK. Quietly building a
 * weekly report for an operator who typed "day" is worse than refusing: they
 * walk away believing they checked the daily send when they checked nothing of
 * the sort, and the first real look at the daily is the one their recipients
 * get.
 *
 * An empty or whitespace-only string counts as omitted, not as an error: that
 * is what an unset <select> posts, and it expresses no choice to contradict.
 */
export function parseTestCadence(body) {
  const raw = body?.cadence;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") {
    return { error: `cadence must be one of ${VALID_CADENCES.join(", ")}; received ${JSON.stringify(raw)}` };
  }
  const cadence = raw.trim().toLowerCase();
  if (!cadence) return {};
  if (!VALID_CADENCES.includes(cadence)) {
    return { error: `unknown cadence "${raw}"; must be one of ${VALID_CADENCES.join(", ")}` };
  }
  return { cadence };
}

/**
 * Builds the express handler for one report's test-send route.
 *
 * `run` is the report's own run function, called with exactly the argument
 * object the schedulers pass it. `fixedCadence` is for the two monthly backfill
 * routes, whose cadence is part of the route rather than the body.
 * `allowPeriod` opts a route into the caller-chosen from/to window.
 *
 * PERIOD AND CADENCE ARE MUTUALLY EXCLUSIVE, AND THE REFUSAL IS EXPLICIT. A
 * route with a fixed cadence rejects a body cadence rather than ignoring it or
 * honouring it; a cadence route rejects a from/to sent alongside a cadence.
 * Either combination is an operator asking for two different periods in one
 * request, and there is no answer to that which does not mislead someone.
 *
 * There is NO env fallback for recipients anywhere in here, deliberately: if a
 * test send could fall back to SLIPPAGE_ALERT_RECIPIENTS, a green test would
 * imply the scheduled run has somewhere to go when it may have nowhere.
 */
/**
 * Fans one cadence-aware route out across a FAMILY OF SEPARATE RUN FUNCTIONS.
 *
 * The two dealing reports take `cadence` as an argument, so a single run
 * function covers all three cadences and this is not needed for them. The
 * Business Summary family is not built that way: its daily, weekly and monthly
 * sends are three different modules producing three different emails
 * (runDailyDigest, runWeeklyBusinessSummary, runMonthlyReview), and none of the
 * three accepts a `cadence` argument at all -- see reports/schedulers.js, where
 * each is registered as its own scheduled job. There is no single runner to
 * pass a cadence to, so the cadence is resolved to a runner HERE rather than
 * pretending the family has the shape the dealing reports have.
 *
 * `cadence` is consumed, not forwarded: the three runners would ignore it, and
 * dropping it keeps "what reached the runner" an exact assertion in tests.
 *
 * The default matters as much as the mapping. With no cadence in the body this
 * must call the weekly runner with recipients and nothing else, because that is
 * literally what /api/reports/summary-weekly/test did before it accepted a
 * cadence at all.
 */
export function makeCadenceRunner(runners, { defaultCadence = "weekly" } = {}) {
  return function runForCadence({ cadence = defaultCadence, ...rest } = {}) {
    const run = runners[cadence];
    if (!run) throw new Error(`no runner registered for cadence "${cadence}"`);
    return run(rest);
  };
}

export function makeReportTestSendHandler({ run, cadence: fixedCadence, allowPeriod = false }) {
  return async function reportTestSendHandler(req, res) {
    const recipients = parseTestRecipients(req.body);
    if (!recipients.length) return res.status(400).json({ error: "recipient_required" });

    const args = { recipients };

    const bodyCadence = parseTestCadence(req.body);

    if (fixedCadence) {
      // An empty-string cadence expresses no choice (see parseTestCadence), so
      // only a value the caller actually meant -- valid or not -- is a refusal.
      if (bodyCadence.cadence || bodyCadence.error) {
        return res.status(400).json({
          error: "cadence_not_allowed",
          message: `this route always sends the ${fixedCadence} report; use the cadence-aware test route to pick another cadence`,
        });
      }
      args.cadence = fixedCadence;
    } else {
      if (bodyCadence.error) return res.status(400).json({ error: "bad_cadence", message: bodyCadence.error });
      if (bodyCadence.cadence) {
        if (req.body?.from !== undefined || req.body?.to !== undefined) {
          return res.status(400).json({
            error: "cadence_period_conflict",
            message: "send either a cadence or a from/to period, not both",
          });
        }
        args.cadence = bodyCadence.cadence;
      }
    }

    if (allowPeriod) {
      const period = parseTestPeriod(req.body);
      if (period.error) return res.status(400).json({ error: "bad_period", message: period.error });
      Object.assign(args, period);
    }

    try {
      res.json(await run(args));
    } catch (e) {
      res.status(502).json({ ok: false, error: "send_failed", message: e?.message || String(e) });
    }
  };
}
