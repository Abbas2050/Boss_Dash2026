/**
 * Daily Wallet Report Scheduler
 * Node.js equivalent of OtherProject/backofficetool/cron/wallet_daily_report.php
 * Runs at 08:00 UTC every day, fetches all PSP balances and sends email + Telegram.
 */

import cron from 'node-cron';
import { checkAllBalances } from './walletMonitor.js';
import { sendDailyEmailReport, sendDailyTelegramReport } from './notifier.js';

async function runDailyWalletReport() {
  const date = new Date().toISOString().split('T')[0];
  console.log(`[WalletScheduler] Running daily wallet report for ${date}`);

  let report;
  try {
    report = await checkAllBalances();
  } catch (e) {
    console.error('[WalletScheduler] checkAllBalances failed:', e.message);
    return;
  }

  const { widgets: widgetsArray, total_balance: total, bank_receivable, crypto_receivable, net_all_current_balance, net_balance_after_expected_funds } = report.data;
  const {
    to_be_deposited_into_lps_k20,
    to_be_deposited_into_lps_k21,
    difference_between_actual_and_expected,
  } = report.data;

  // Convert widgets array to keyed map for notifier
  const widgets = {};
  for (const w of widgetsArray) widgets[w.id] = w;

  // Send email
  try {
    await sendDailyEmailReport(
      widgets, total, date,
      bank_receivable, crypto_receivable,
      net_all_current_balance, net_balance_after_expected_funds,
      {
        toBeDepositedIntoLPsK20: to_be_deposited_into_lps_k20,
        toBeDepositedIntoLPsK21: to_be_deposited_into_lps_k21,
        differenceBetweenActualAndExpected: difference_between_actual_and_expected,
      },
    );
  } catch (e) {
    console.error('[WalletScheduler] Email send failed:', e.message);
  }

  // Send Telegram
  try {
    await sendDailyTelegramReport(
      widgets, total, date,
      bank_receivable, crypto_receivable,
      net_all_current_balance, net_balance_after_expected_funds,
      {
        toBeDepositedIntoLPsK20: to_be_deposited_into_lps_k20,
        toBeDepositedIntoLPsK21: to_be_deposited_into_lps_k21,
        differenceBetweenActualAndExpected: difference_between_actual_and_expected,
      },
    );
  } catch (e) {
    console.error('[WalletScheduler] Telegram send failed:', e.message);
  }
}

/**
 * Start the daily wallet report scheduler.
 * Schedule: 08:00 UTC daily (equivalent to PHP cron `0 8 * * *`)
 *
 * Set WALLET_REPORT_CRON env var to override the schedule expression.
 * Set WALLET_REPORT_RUN_ON_START=true to fire immediately on server start (useful for testing).
 */
export function startDailyWalletReportScheduler() {
  const schedule = process.env.WALLET_REPORT_CRON || '0 8 * * *';

  if (!cron.validate(schedule)) {
    console.error(`[WalletScheduler] Invalid cron expression: "${schedule}"`);
    return;
  }

  cron.schedule(schedule, () => {
    runDailyWalletReport().catch((e) => console.error('[WalletScheduler] Unhandled error:', e));
  }, { timezone: 'UTC' });

  console.log(`[WalletScheduler] Daily wallet report scheduled: "${schedule}" (UTC)`);

  // Fire immediately on start if requested (for testing / first-run)
  if (process.env.WALLET_REPORT_RUN_ON_START === 'true') {
    console.log('[WalletScheduler] WALLET_REPORT_RUN_ON_START=true — running now...');
    runDailyWalletReport().catch((e) => console.error('[WalletScheduler] Unhandled error:', e));
  }
}
