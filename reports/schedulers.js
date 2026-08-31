import { startReportScheduler } from "./reportShared.js";
import { runDailyDigest } from "./dailyDigest.js";
import { runMonthlyReview } from "./monthlyReview.js";
import { runWeeklyBusinessSummary, SUMMARY_RECIPIENT_VARS } from "./weeklyBusinessSummary.js";
import { runSlippageEmailReport, SLIPPAGE_RECIPIENT_VARS } from "./slippageWeeklyReport.js";
import { runDealMatchEmailReport, DEALMATCH_RECIPIENT_VARS } from "./dealMatchWeeklyReport.js";

// Every scheduled send in the system, in one table. This is the file to read to
// answer "what goes out, when".
//
// Ordering within a cadence is deliberate: Deal Match, then Slippage, then
// Business Summary. The Business Summary's At a Glance strip computes Total
// Revenue from DealMatch/Run, so it must never run before the report it
// summarises.
//
// Dailies use cron day-of-week 2-6, Tuesday to Saturday, each covering the
// previous day. That gives every trading day exactly one daily and fires
// nothing for a shut market.
//
// Monthlies sit AFTER the weeklies. At 10:00 the Business Summary monthly
// ("0 10 1 * *") and weekly ("0 10 * * 6") fired in the same minute whenever the
// 1st was a Saturday -- 1 August 2026 was one -- racing two 40-second
// DealMatch/Run calls.
//
// Design: docs/superpowers/specs/2026-09-01-nine-report-cadences-design.md
export const REPORT_SCHEDULES = [
  {
    label: "DealMatchDaily", defaultCron: "0 7 * * 2-6",
    enabledVar: "DAILY_DEALMATCH_ENABLED", cronVar: "DAILY_DEALMATCH_CRON",
    timezoneVar: "DAILY_DEALMATCH_TIMEZONE", runOnStartVar: "DAILY_DEALMATCH_RUN_ON_START",
    recipientVars: DEALMATCH_RECIPIENT_VARS.daily,
    run: () => runDealMatchEmailReport({ cadence: "daily" }),
  },
  {
    label: "SlippageDaily", defaultCron: "30 7 * * 2-6",
    enabledVar: "DAILY_SLIPPAGE_ENABLED", cronVar: "DAILY_SLIPPAGE_CRON",
    timezoneVar: "DAILY_SLIPPAGE_TIMEZONE", runOnStartVar: "DAILY_SLIPPAGE_RUN_ON_START",
    recipientVars: SLIPPAGE_RECIPIENT_VARS.daily,
    run: () => runSlippageEmailReport({ cadence: "daily" }),
  },
  {
    label: "BusinessDaily", defaultCron: "0 8 * * 2-6",
    enabledVar: "DAILY_DIGEST_ENABLED", cronVar: "DAILY_DIGEST_CRON",
    timezoneVar: "DAILY_DIGEST_TIMEZONE", runOnStartVar: "DAILY_DIGEST_RUN_ON_START",
    recipientVars: SUMMARY_RECIPIENT_VARS.daily,
    run: () => runDailyDigest(),
  },
  {
    label: "DealMatchWeekly", defaultCron: "0 9 * * 6",
    enabledVar: "WEEKLY_DEALMATCH_ENABLED", cronVar: "WEEKLY_DEALMATCH_CRON",
    timezoneVar: "WEEKLY_DEALMATCH_TIMEZONE", runOnStartVar: "WEEKLY_DEALMATCH_RUN_ON_START",
    recipientVars: DEALMATCH_RECIPIENT_VARS.weekly,
    run: () => runDealMatchEmailReport({ cadence: "weekly" }),
  },
  {
    label: "SlippageWeekly", defaultCron: "30 9 * * 6",
    enabledVar: "WEEKLY_SLIPPAGE_ENABLED", cronVar: "WEEKLY_SLIPPAGE_CRON",
    timezoneVar: "WEEKLY_SLIPPAGE_TIMEZONE", runOnStartVar: "WEEKLY_SLIPPAGE_RUN_ON_START",
    recipientVars: SLIPPAGE_RECIPIENT_VARS.weekly,
    run: () => runSlippageEmailReport({ cadence: "weekly" }),
  },
  {
    label: "BusinessWeekly", defaultCron: "0 10 * * 6",
    enabledVar: "WEEKLY_SUMMARY_ENABLED", cronVar: "WEEKLY_SUMMARY_CRON",
    timezoneVar: "WEEKLY_SUMMARY_TIMEZONE", runOnStartVar: "WEEKLY_SUMMARY_RUN_ON_START",
    recipientVars: SUMMARY_RECIPIENT_VARS.weekly,
    run: () => runWeeklyBusinessSummary(),
  },
  {
    label: "DealMatchMonthly", defaultCron: "0 11 1 * *",
    enabledVar: "MONTHLY_DEALMATCH_ENABLED", cronVar: "MONTHLY_DEALMATCH_CRON",
    timezoneVar: "MONTHLY_DEALMATCH_TIMEZONE", runOnStartVar: "MONTHLY_DEALMATCH_RUN_ON_START",
    recipientVars: DEALMATCH_RECIPIENT_VARS.monthly,
    run: () => runDealMatchEmailReport({ cadence: "monthly" }),
  },
  {
    label: "SlippageMonthly", defaultCron: "30 11 1 * *",
    enabledVar: "MONTHLY_SLIPPAGE_ENABLED", cronVar: "MONTHLY_SLIPPAGE_CRON",
    timezoneVar: "MONTHLY_SLIPPAGE_TIMEZONE", runOnStartVar: "MONTHLY_SLIPPAGE_RUN_ON_START",
    recipientVars: SLIPPAGE_RECIPIENT_VARS.monthly,
    run: () => runSlippageEmailReport({ cadence: "monthly" }),
  },
  {
    label: "BusinessMonthly", defaultCron: "0 12 1 * *",
    enabledVar: "MONTHLY_REVIEW_ENABLED", cronVar: "MONTHLY_REVIEW_CRON",
    timezoneVar: "MONTHLY_REVIEW_TIMEZONE", runOnStartVar: "MONTHLY_REVIEW_RUN_ON_START",
    recipientVars: SUMMARY_RECIPIENT_VARS.monthly,
    run: () => runMonthlyReview(),
  },
];

export function startAllReportSchedulers() {
  return REPORT_SCHEDULES.map((config) => ({
    label: config.label,
    ...startReportScheduler(config),
  }));
}
