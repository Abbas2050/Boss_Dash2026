/**
 * Daily Wallet Report Scheduler
 * Node.js equivalent of OtherProject/backofficetool/cron/wallet_daily_report.php
 * Runs at 08:00 UTC every day, fetches all PSP balances and sends email + Telegram.
 */

import cron from 'node-cron';
import path from 'path';
import { promises as fs } from 'fs';
import { checkAllBalances } from './walletMonitor.js';
import { sendDailyEmailReport, sendDailyTelegramReport } from './notifier.js';

const TRACKED_WIDGET_IDS = [
  'bitpace',
  'letknowpay',
  'ownbit',
  'heropayment',
  'googlesheets_match2pay',
  'googlesheets_deusxpay',
  'googlesheets_openpayed',
  'googlesheets_goldsouq',
  'googlesheets_fab',
  'googlesheets_mbme',
];

const TRACKED_WIDGET_LABELS = {
  bitpace: 'Bitpace',
  letknowpay: 'LetKnow Pay',
  ownbit: 'OwnBit',
  heropayment: 'HeroPayment',
  googlesheets_match2pay: 'Match2Pay',
  googlesheets_deusxpay: 'DeusXpay',
  googlesheets_openpayed: 'OpenPayed',
  googlesheets_goldsouq: 'Gold Souq',
  googlesheets_fab: 'FAB Bank',
  googlesheets_mbme: 'MBME',
};

const DEFAULT_STATE_FILE = path.join(process.cwd(), 'storage', 'wallet_report_state.json');

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

function toWidgetMap(report) {
  const widgetsArray = Array.isArray(report?.data?.widgets) ? report.data.widgets : [];
  const widgets = {};
  for (const w of widgetsArray) {
    if (w?.id) widgets[w.id] = w;
  }
  return widgets;
}

function extractSnapshot(report) {
  const widgets = toWidgetMap(report);
  const widgetBalances = {};
  for (const id of TRACKED_WIDGET_IDS) {
    widgetBalances[id] = roundMoney(widgets[id]?.balance);
  }
  return {
    total_balance: roundMoney(report?.data?.total_balance),
    widgets: widgetBalances,
  };
}

function snapshotHash(snapshot) {
  return JSON.stringify(snapshot);
}

function buildSendContext(report) {
  const d = report?.data || {};
  const widgets = toWidgetMap(report);
  return {
    widgets,
    total: Number(d.total_balance || 0),
    bankReceivable: Number(d.bank_receivable || 0),
    cryptoReceivable: Number(d.crypto_receivable || 0),
    netAllCurrent: Number(d.net_all_current_balance || 0),
    netAfterExpected: Number(d.net_balance_after_expected_funds || 0),
    extras: {
      toBeDepositedIntoLPsK20: Number(d.to_be_deposited_into_lps_k20 || 0),
      toBeDepositedIntoLPsK21: Number(d.to_be_deposited_into_lps_k21 || 0),
      differenceBetweenActualAndExpected: Number(d.difference_between_actual_and_expected || 0),
    },
  };
}

function buildChangeItems(previousSnapshot, currentSnapshot) {
  const changes = [];
  const prevTotal = roundMoney(previousSnapshot?.total_balance);
  const currTotal = roundMoney(currentSnapshot?.total_balance);
  if (prevTotal !== currTotal) {
    changes.push({
      key: 'total_balance',
      label: 'Total Combined',
      before: prevTotal,
      after: currTotal,
      delta: roundMoney(currTotal - prevTotal),
    });
  }

  for (const id of TRACKED_WIDGET_IDS) {
    const before = roundMoney(previousSnapshot?.widgets?.[id]);
    const after = roundMoney(currentSnapshot?.widgets?.[id]);
    if (before === after) continue;
    changes.push({
      key: id,
      label: TRACKED_WIDGET_LABELS[id] || id,
      before,
      after,
      delta: roundMoney(after - before),
    });
  }

  return changes;
}

async function loadState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      channels: {
        email: { lastSentHash: parsed?.channels?.email?.lastSentHash || null },
        telegram: { lastSentHash: parsed?.channels?.telegram?.lastSentHash || null },
      },
      lastSnapshotHash: parsed?.lastSnapshotHash || null,
      lastSnapshot: parsed?.lastSnapshot || null,
      updatedAt: parsed?.updatedAt || null,
    };
  } catch {
    return {
      channels: {
        email: { lastSentHash: null },
        telegram: { lastSentHash: null },
      },
      lastSnapshotHash: null,
      lastSnapshot: null,
      updatedAt: null,
    };
  }
}

async function saveState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

async function sendWalletReport(report, date, options = {}) {
  const ctx = buildSendContext(report);
  const changeItems = Array.isArray(options.changeItems) ? options.changeItems : [];
  const sendEmail = options.sendEmail !== false;
  const sendTelegram = options.sendTelegram !== false;

  let emailOk = false;
  let telegramOk = false;

  if (sendEmail) {
    try {
      emailOk = await sendDailyEmailReport(
        ctx.widgets,
        ctx.total,
        date,
        ctx.bankReceivable,
        ctx.cryptoReceivable,
        ctx.netAllCurrent,
        ctx.netAfterExpected,
        { ...ctx.extras, changeItems },
      );
    } catch (e) {
      console.error('[WalletScheduler] Email send failed:', e.message);
    }
  }

  if (sendTelegram) {
    try {
      telegramOk = await sendDailyTelegramReport(
        ctx.widgets,
        ctx.total,
        date,
        ctx.bankReceivable,
        ctx.cryptoReceivable,
        ctx.netAllCurrent,
        ctx.netAfterExpected,
        { ...ctx.extras, changeItems },
      );
    } catch (e) {
      console.error('[WalletScheduler] Telegram send failed:', e.message);
    }
  }

  return { emailOk, telegramOk };
}

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

  await sendWalletReport(report, date);
}

async function runOnChangeWalletReport() {
  const stateFile = process.env.WALLET_REPORT_STATE_FILE || DEFAULT_STATE_FILE;
  const date = new Date().toISOString().split('T')[0];

  let report;
  try {
    report = await checkAllBalances();
  } catch (e) {
    console.error('[WalletScheduler] checkAllBalances failed:', e.message);
    return;
  }

  const snapshot = extractSnapshot(report);
  const hash = snapshotHash(snapshot);
  const state = await loadState(stateFile);

  const isFirstRun = !state.channels.email.lastSentHash && !state.channels.telegram.lastSentHash;
  const sendOnFirstRun = process.env.WALLET_REPORT_SEND_ON_FIRST_RUN === 'true';

  if (isFirstRun && !sendOnFirstRun) {
    state.channels.email.lastSentHash = hash;
    state.channels.telegram.lastSentHash = hash;
    state.lastSnapshotHash = hash;
    state.lastSnapshot = snapshot;
    await saveState(stateFile, state);
    console.log('[WalletScheduler] On-change baseline initialized (no notifications sent on first run).');
    return;
  }

  const needsEmail = state.channels.email.lastSentHash !== hash;
  const needsTelegram = state.channels.telegram.lastSentHash !== hash;

  if (!needsEmail && !needsTelegram) {
    state.lastSnapshotHash = hash;
    state.lastSnapshot = snapshot;
    await saveState(stateFile, state);
    return;
  }

  console.log('[WalletScheduler] Balance change detected, sending notifications...', {
    email: needsEmail,
    telegram: needsTelegram,
  });

  const changeItems = buildChangeItems(state.lastSnapshot, snapshot);

  const sendResult = await sendWalletReport(report, date, {
    changeItems,
    sendEmail: needsEmail,
    sendTelegram: needsTelegram,
  });

  if (needsEmail && sendResult.emailOk) {
    state.channels.email.lastSentHash = hash;
  }
  if (needsTelegram && sendResult.telegramOk) {
    state.channels.telegram.lastSentHash = hash;
  }

  state.lastSnapshotHash = hash;
  state.lastSnapshot = snapshot;
  await saveState(stateFile, state);
}

/**
 * Start the daily wallet report scheduler.
 * Schedule: 08:00 UTC daily (equivalent to PHP cron `0 8 * * *`)
 *
 * Set WALLET_REPORT_CRON env var to override the schedule expression.
 * Set WALLET_REPORT_RUN_ON_START=true to fire immediately on server start (useful for testing).
 */
export function startDailyWalletReportScheduler() {
  const mode = (process.env.WALLET_REPORT_MODE || 'daily').toLowerCase();
  const schedule = mode === 'on-change'
    ? (process.env.WALLET_REPORT_ON_CHANGE_CRON || '*/5 * * * *')
    : (process.env.WALLET_REPORT_CRON || '0 8 * * *');

  if (!cron.validate(schedule)) {
    console.error(`[WalletScheduler] Invalid cron expression: "${schedule}"`);
    return;
  }

  cron.schedule(schedule, () => {
    const runner = mode === 'on-change' ? runOnChangeWalletReport : runDailyWalletReport;
    runner().catch((e) => console.error('[WalletScheduler] Unhandled error:', e));
  }, { timezone: 'UTC' });

  if (mode === 'on-change') {
    console.log(`[WalletScheduler] On-change wallet report scheduled: "${schedule}" (UTC)`);
  } else {
    console.log(`[WalletScheduler] Daily wallet report scheduled: "${schedule}" (UTC)`);
  }

  // Fire immediately on start if requested (for testing / first-run)
  if (process.env.WALLET_REPORT_RUN_ON_START === 'true') {
    console.log('[WalletScheduler] WALLET_REPORT_RUN_ON_START=true — running now...');
    const runner = mode === 'on-change' ? runOnChangeWalletReport : runDailyWalletReport;
    runner().catch((e) => console.error('[WalletScheduler] Unhandled error:', e));
  }
}
