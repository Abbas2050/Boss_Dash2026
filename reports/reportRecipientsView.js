import { REPORT_SCHEDULES } from "./schedulers.js";
import { parseRecipients } from "./reportShared.js";

/**
 * A read-only picture of what the nine scheduled reports will actually do.
 *
 * WHY THIS EXISTS: the only way to answer "is Talat getting all of these?" was
 * to open the server's .env. Worse, the answer is not a simple grep, because
 * resolveRecipients() takes the FIRST non-empty variable in a report's chain
 * and stops -- it does not merge. A chain like
 * ["DAILY_DIGEST_RECIPIENTS", "SUMMARY_ALERT_RECIPIENTS"] means that adding an
 * address to the shared SUMMARY_ALERT_RECIPIENTS does NOTHING for the daily
 * digest as long as DAILY_DIGEST_RECIPIENTS carries anything at all. An
 * operator who does not know that edits the wrong line and believes they are
 * done. So this view reports every candidate variable with its standing --
 * which one won and which are shadowed by it -- rather than just the winning
 * address list.
 *
 * WHY IT DERIVES FROM REPORT_SCHEDULES: that table is the single source of
 * truth for what is scheduled. A second hand-written list of the nine reports
 * would be one more thing to forget when a tenth is added, and the panel would
 * then quietly under-report the very thing it exists to show.
 *
 * WHAT IT MUST NOT DO: emit any env value other than the recipient lists, cron
 * expressions, timezones and enabled flags named in REPORT_SCHEDULES. It reads
 * `env` by explicit variable name only -- never enumerates it -- so a secret
 * sitting in the same file cannot travel with the answer.
 *
 * `env` is injectable so tests can describe a whole .env without touching the
 * real process.env.
 */

// The scheduler's own default; startReportScheduler's defaultTimezone
// parameter. Repeated here rather than exported from there because taking it
// out of a function signature would change that function's shape for a
// read-only viewer's benefit.
export const DEFAULT_TIMEZONE = "Asia/Dubai";

// Labels are "<Report><Cadence>" -- "DealMatchDaily", "BusinessMonthly". Split
// them so the panel can group and sort without a second lookup table.
const LABEL_RE = /^(.*?)(Daily|Weekly|Monthly)$/;

const REPORT_TITLES = {
  DealMatch: "Deal Match",
  Slippage: "Slippage",
  Business: "Business Summary",
};

function splitLabel(label) {
  const m = LABEL_RE.exec(String(label));
  if (!m) return { report: String(label), cadence: "" };
  return { report: REPORT_TITLES[m[1]] || m[1], cadence: m[2].toLowerCase() };
}

// Mirrors startReportScheduler: anything but a literal "false" is enabled, and
// an unset variable means enabled. Written out rather than imported because
// startReportScheduler performs the check as a side effect of registering a
// live cron job, which a read-only view must not do.
function isEnabled(env, enabledVar) {
  return String(env[enabledVar] || "true").toLowerCase() !== "false";
}

// Same resolution startReportScheduler performs for cron and timezone: the env
// override if it carries anything, otherwise the coded default. `source` is
// reported so the panel can name the .env line to edit instead of leaving the
// operator to guess whether what they see is an override or a default.
function resolveSetting(env, varName, fallback) {
  const raw = env[varName];
  const overridden = typeof raw === "string" && raw.trim() !== "";
  return {
    var: varName,
    value: overridden ? String(raw) : fallback,
    default: fallback,
    source: overridden ? "env" : "default",
  };
}

/**
 * The candidate chain for one report, in declaration order, with exactly one
 * winner marked.
 *
 * Status is deliberately three-valued rather than a boolean: "unset" (nothing
 * in the variable) and "overridden" (a real list that is being ignored) are
 * completely different situations for an operator. The second is the one that
 * wastes an afternoon.
 */
export function describeRecipientChain(recipientVars, env) {
  let winnerFound = false;
  return recipientVars.map((name) => {
    const recipients = parseRecipients(env[name] || "");
    const populated = recipients.length > 0;
    const active = populated && !winnerFound;
    if (active) winnerFound = true;
    return {
      var: name,
      recipients,
      status: !populated ? "unset" : active ? "active" : "overridden",
    };
  });
}

export function buildReportRecipientsView(env = process.env) {
  const reports = REPORT_SCHEDULES.map((config) => {
    const { report, cadence } = splitLabel(config.label);
    const chain = describeRecipientChain(config.recipientVars, env);
    const active = chain.find((entry) => entry.status === "active") || null;
    const enabled = isEnabled(env, config.enabledVar);
    const recipients = active ? active.recipients : [];

    return {
      label: config.label,
      report,
      cadence,
      enabled,
      enabledVar: config.enabledVar,
      cron: resolveSetting(env, config.cronVar, config.defaultCron),
      timezone: resolveSetting(env, config.timezoneVar, DEFAULT_TIMEZONE),
      recipientChain: chain,
      activeVar: active ? active.var : null,
      recipients,
      // The failure this panel was built to surface. A report with nothing to
      // send to does not error and does not warn on schedule -- it logs one
      // line at 7am and sends nothing. Disabled reports are excluded: an
      // operator who switched one off is not surprised that it is silent.
      willNotSend: enabled && recipients.length === 0,
    };
  });

  return {
    reports,
    // Counted here rather than in the UI so the panel's headline figure cannot
    // disagree with the list beneath it.
    total: reports.length,
    willNotSendCount: reports.filter((r) => r.willNotSend).length,
    // Said in the payload, not only in the markup, because the reason there is
    // no save button has to survive someone reading this over the API.
    readOnlyNote:
      "Read-only. Recipients, cron expressions and timezones live in the server's .env and take effect on restart, so they are changed by an operator on the server rather than from this dashboard.",
  };
}
