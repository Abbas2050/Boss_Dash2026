/**
 * Daily Wallet Report Scheduler
 * Node.js equivalent of OtherProject/backofficetool/cron/wallet_daily_report.php
 * Runs at 08:00 UTC every day, fetches all PSP balances and sends email + Telegram.
 */

import cron from 'node-cron';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { checkAllBalances } from './walletMonitor.js';
import { sendDailyEmailReport, sendDailyTelegramReport } from './notifier.js';

const TRACKED_WIDGET_IDS = [
  'bitpace',
  'letknowpay',
  'ownbit',
  'ownbitnew',
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
  ownbitnew: 'OwnBit New',
  heropayment: 'HeroPayment',
  googlesheets_match2pay: 'Match2Pay',
  googlesheets_deusxpay: 'DeusXpay',
  googlesheets_openpayed: 'OpenPayed',
  googlesheets_goldsouq: 'Gold Souq',
  googlesheets_fab: 'FAB Bank',
  googlesheets_mbme: 'MBME',
};

const DEFAULT_STATE_FILE = path.join(process.cwd(), 'storage', 'wallet_report_state.json');
const FALLBACK_STATE_FILE = path.join(os.tmpdir(), 'boss_dash_wallet_report_state.json');
let notifyQueue = Promise.resolve();

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

// Holdings are amounts of a currency, not dollars, so they cannot share
// roundMoney(). LetKnow Pay holds 0.00288773 ETH; rounded to cents that is
// 0.00, which is also what 0.00388773 ETH rounds to, and every crypto balance
// in the system would compare equal to every other. Eight places is what the
// PSPs themselves publish and is finer than any deposit we would want to miss.
const roundHolding = (value) => Number(Number(value || 0).toFixed(8));

async function resolveWritableStateFile(preferredStateFile) {
  const candidates = [preferredStateFile, FALLBACK_STATE_FILE].filter(Boolean);
  let lastError = null;

  for (const stateFile of candidates) {
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      const fd = await fs.open(stateFile, 'a');
      await fd.close();
      if (stateFile !== preferredStateFile) {
        console.warn(`[WalletScheduler] State file not writable: ${preferredStateFile}. Using fallback: ${stateFile}`);
      }
      return stateFile;
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('No writable state file path available');
}

function toWidgetMap(report) {
  const widgetsArray = Array.isArray(report?.data?.widgets) ? report.data.widgets : [];
  const widgets = {};
  for (const w of widgetsArray) {
    if (w?.id) widgets[w.id] = w;
  }
  return widgets;
}

// What a provider actually holds, as it reports it: a currency name against an
// amount of that currency. Returns null when there is no breakdown to compare.
//
// The six Google Sheets rows publish `currencies: {}` because a sheet cell is a
// dollar figure with no composition, and a provider whose API call failed
// publishes `{}` too. Both must keep comparing dollars: a Gold Souq edit is a
// deliberate human action and is precisely what the alert exists for.
//
// Keys are sorted so two polls that list the same holdings in a different order
// still stringify identically, and so the snapshot hash does not churn.
function extractHoldings(widget) {
  const currencies = widget?.currencies;
  if (!currencies || typeof currencies !== 'object' || Array.isArray(currencies)) return null;
  const names = Object.keys(currencies).sort();
  if (!names.length) return null;

  const holdings = {};
  for (const name of names) {
    const raw = currencies[name];
    const amount = Number(raw);
    // Bitpace can report a holding it could not parse as the literal "n/a".
    // Keeping the raw text means an amount that later becomes a number still
    // reads as a change rather than as two unknowns comparing equal.
    holdings[name] = Number.isFinite(amount) ? roundHolding(amount) : String(raw);
  }
  return holdings;
}

export function extractSnapshot(report) {
  const widgets = toWidgetMap(report);
  const widgetBalances = {};
  const widgetHoldings = {};
  for (const id of TRACKED_WIDGET_IDS) {
    widgetBalances[id] = roundMoney(widgets[id]?.balance);
    widgetHoldings[id] = extractHoldings(widgets[id]);
  }
  return {
    // The USD figures stay exactly as they were. The email's before/after
    // deltas are built from them and must keep showing real dollar movement;
    // holdings are an addition alongside, not a replacement.
    total_balance: roundMoney(report?.data?.total_balance),
    widgets: widgetBalances,
    holdings: widgetHoldings,
  };
}

// A saved snapshot written before holdings existed cannot answer "did the
// holding change?", so comparing against it would name providers nobody
// touched. Callers re-baseline instead of guessing.
export function snapshotRecordsHoldings(snapshot) {
  return !!snapshot
    && typeof snapshot === 'object'
    && !!snapshot.holdings
    && typeof snapshot.holdings === 'object'
    && !Array.isArray(snapshot.holdings);
}

function holdingsKey(holdings) {
  return JSON.stringify(Object.keys(holdings).sort().map((name) => [name, holdings[name]]));
}

export function snapshotHash(snapshot) {
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

export function buildChangeItems(previousSnapshot, currentSnapshot) {
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

export function filterIgnoredChangeItems(changeItems) {
  // Identify any PSP (non-total) item that dropped to exactly 0 (API failure)
  // or recovered from exactly 0 (API recovery). Both are treated as noise.
  const noiseItems = changeItems.filter((item) => {
    if (!item?.key || item.key === 'total_balance') return false;
    const before = roundMoney(item.before);
    const after = roundMoney(item.after);
    const isApiFail = after === 0 && before > 0;
    const isApiRecovery = before === 0 && after > 0;
    return isApiFail || isApiRecovery;
  });

  if (noiseItems.length === 0) return changeItems;

  // Sum of deltas for all noise PSPs
  const noiseDeltaSum = roundMoney(noiseItems.reduce((sum, item) => sum + (item.delta ?? 0), 0));

  return changeItems.filter((item) => {
    // Drop any noise PSP item
    if (noiseItems.some((n) => n.key === item?.key)) return false;
    // Drop total_balance if its change is fully explained by the noise PSPs
    if (item?.key === 'total_balance' && roundMoney(item.delta) === noiseDeltaSum) return false;
    return true;
  });
}

// The second noise class. A row whose dollar value moved while the holding
// behind it sat still has not seen money move -- the price did.
//
// Only Bitpace and LetKnow Pay can do this, because only they mark holdings to
// market. LetKnow Pay holds 0.00288773 ETH; a $17 move in ETH, routine inside
// one five-minute poll, shifts the row by $0.05 and clears the one-cent
// comparison. The same lookup failing drops the row by the whole $6.81, which
// is why no dollar threshold could sort this out: the two symptoms of one cause
// sit on opposite sides of any line you could draw.
function isPriceOnlyChange(item, previousSnapshot, currentSnapshot) {
  if (!item?.key || item.key === 'total_balance') return false;

  // A drop to exactly zero, or a recovery from it, is the API-failure class and
  // filterIgnoredChangeItems() owns it. Declining it here keeps that filter's
  // behaviour exactly what production has today.
  const before = roundMoney(item.before);
  const after = roundMoney(item.after);
  if (before === 0 || after === 0) return false;

  const previousHoldings = previousSnapshot?.holdings?.[item.key];
  const currentHoldings = currentSnapshot?.holdings?.[item.key];
  if (!previousHoldings || !currentHoldings) return false;

  return holdingsKey(previousHoldings) === holdingsKey(currentHoldings);
}

// Both noise classes at one seam, so `total_balance` is settled once against
// everything that was dropped rather than twice against half of it.
//
// The API-failure set is read back out of filterIgnoredChangeItems() rather
// than re-derived here. That filter stays the sole author of what counts as
// API noise, and can go on changing without this function needing to agree
// with it.
export function filterNoisyChangeItems(changeItems, previousSnapshot, currentSnapshot) {
  const afterApiNoise = filterIgnoredChangeItems(changeItems);
  const apiNoise = changeItems.filter(
    (item) => item?.key !== 'total_balance' && !afterApiNoise.includes(item),
  );
  const priceNoise = afterApiNoise.filter(
    (item) => isPriceOnlyChange(item, previousSnapshot, currentSnapshot),
  );

  const noiseItems = [...apiNoise, ...priceNoise];
  if (noiseItems.length === 0) return changeItems;

  const noiseKeys = new Set(noiseItems.map((item) => item.key));
  const noiseDeltaSum = roundMoney(noiseItems.reduce((sum, item) => sum + (item.delta ?? 0), 0));

  return changeItems.filter((item) => {
    // Keep the total only while some part of its movement is still unaccounted
    // for by the rows that were dropped.
    if (item?.key === 'total_balance') return roundMoney(item.delta) !== noiseDeltaSum;
    return !noiseKeys.has(item.key);
  });
}

// The whole send decision, as a pure function of the two snapshots, so it can
// be tested without a state file or a mail server.
export function decideChangeItems(previousSnapshot, currentSnapshot) {
  if (!snapshotRecordsHoldings(previousSnapshot) || !snapshotRecordsHoldings(currentSnapshot)) {
    return { rebaseline: true, changeItems: [] };
  }

  const changeItems = buildChangeItems(previousSnapshot, currentSnapshot);
  return {
    rebaseline: false,
    changeItems: filterNoisyChangeItems(changeItems, previousSnapshot, currentSnapshot),
  };
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
      lastNotifiedHash: parsed?.lastNotifiedHash || null,
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
      lastNotifiedHash: null,
      lastSnapshotHash: null,
      lastSnapshot: null,
      updatedAt: null,
    };
  }
}

export function sanitizeState(state) {
  const next = state || {
    channels: {
      email: { lastSentHash: null },
      telegram: { lastSentHash: null },
    },
    lastNotifiedHash: null,
    lastSnapshotHash: null,
    lastSnapshot: null,
    updatedAt: null,
  };

  const fallbackHash = typeof next.lastSnapshotHash === 'string' ? next.lastSnapshotHash : null;
  const looksLikeSnapshotHash = (value) => typeof value === 'string' && value.includes('"total_balance"') && value.includes('"widgets"');

  if (!looksLikeSnapshotHash(next.channels?.email?.lastSentHash)) {
    next.channels.email.lastSentHash = fallbackHash;
  }
  if (!looksLikeSnapshotHash(next.channels?.telegram?.lastSentHash)) {
    next.channels.telegram.lastSentHash = fallbackHash;
  }
  if (typeof next.lastNotifiedHash !== 'string' || !looksLikeSnapshotHash(next.lastNotifiedHash)) {
    next.lastNotifiedHash = fallbackHash;
  }

  return next;
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
  let emailReason = '';
  let telegramReason = '';

  if (sendEmail) {
    try {
      const emailResult = await sendDailyEmailReport(
        ctx.widgets,
        ctx.total,
        date,
        ctx.bankReceivable,
        ctx.cryptoReceivable,
        ctx.netAllCurrent,
        ctx.netAfterExpected,
        { ...ctx.extras, changeItems },
      );
      emailOk = !!emailResult?.ok;
      emailReason = emailResult?.reason || '';
    } catch (e) {
      console.error('[WalletScheduler] Email send failed:', e.message);
      emailReason = e?.message || String(e);
    }
  }

  if (sendTelegram) {
    try {
      const telegramResult = await sendDailyTelegramReport(
        ctx.widgets,
        ctx.total,
        date,
        ctx.bankReceivable,
        ctx.cryptoReceivable,
        ctx.netAllCurrent,
        ctx.netAfterExpected,
        { ...ctx.extras, changeItems },
      );
      telegramOk = !!telegramResult?.ok;
      telegramReason = telegramResult?.reason || '';
    } catch (e) {
      console.error('[WalletScheduler] Telegram send failed:', e.message);
      telegramReason = e?.message || String(e);
    }
  }

  return { emailOk, telegramOk, emailReason, telegramReason };
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

/**
 * Called with an already-fetched report every time balances are loaded.
 * Sends email + Telegram only when Total Combined balance changes.
 * Fire-and-forget safe — never throws.
 */
export async function notifyIfTotalChanged(report) {
  // Serialize notify decisions to avoid concurrent requests sending duplicate emails/telegram.
  // Home dashboard can trigger multiple /api/closing-balance-report calls in parallel.
  notifyQueue = notifyQueue
    .catch(() => undefined)
    .then(async () => {
      const preferredStateFile = process.env.WALLET_REPORT_STATE_FILE || DEFAULT_STATE_FILE;
      const stateFile = await resolveWritableStateFile(preferredStateFile);
      const date = new Date().toISOString().split('T')[0];
      return _runNotifyLogic(report, stateFile, date);
    });

  return notifyQueue;
}

async function runOnChangeWalletReport() {
  const preferredStateFile = process.env.WALLET_REPORT_STATE_FILE || DEFAULT_STATE_FILE;
  const stateFile = await resolveWritableStateFile(preferredStateFile);
  const date = new Date().toISOString().split('T')[0];

  let report;
  try {
    report = await checkAllBalances();
  } catch (e) {
    console.error('[WalletScheduler] checkAllBalances failed:', e.message);
    return;
  }

  return _runNotifyLogic(report, stateFile, date);
}

async function _runNotifyLogic(report, stateFile, date) {
  const snapshot = extractSnapshot(report);
  const hash = snapshotHash(snapshot);
  const state = sanitizeState(await loadState(stateFile));

  const isFirstRun = !state.channels.email.lastSentHash && !state.channels.telegram.lastSentHash;
  const sendOnFirstRun = process.env.WALLET_REPORT_SEND_ON_FIRST_RUN === 'true';

  if (isFirstRun && !sendOnFirstRun) {
    state.channels.email.lastSentHash = hash;
    state.channels.telegram.lastSentHash = hash;
    state.lastSnapshotHash = hash;
    state.lastSnapshot = snapshot;
    await saveState(stateFile, state);
    console.log('[WalletScheduler] On-change baseline initialized (no notifications sent on first run).');
    return { ok: true, status: 'baseline-initialized', hash, reason: 'first-run-no-send' };
  }

  const needsEmail = state.channels.email.lastSentHash !== hash;
  const needsTelegram = state.channels.telegram.lastSentHash !== hash;

  if (!needsEmail && !needsTelegram) {
    state.lastSnapshotHash = hash;
    state.lastSnapshot = snapshot;
    await saveState(stateFile, state);
    return { ok: true, status: 'no-change', hash, reason: 'snapshot-unchanged' };
  }

  console.log('[WalletScheduler] Balance change detected, sending notifications...', {
    email: needsEmail,
    telegram: needsTelegram,
  });

  const { rebaseline, changeItems: effectiveChangeItems } = decideChangeItems(state.lastSnapshot, snapshot);

  // The live state file predates holdings. Comparing across that boundary
  // cannot prove anything is price-only, so the first poll after deploy would
  // email a change list naming providers nobody touched. Re-baselining costs at
  // most one missed alert inside the restart window; the alternative is a
  // guaranteed spurious email on every restart.
  if (rebaseline) {
    state.channels.email.lastSentHash = hash;
    state.channels.telegram.lastSentHash = hash;
    state.lastSnapshotHash = hash;
    state.lastSnapshot = snapshot;
    await saveState(stateFile, state);
    console.log('[WalletScheduler] Saved snapshot predates holdings tracking — re-baselined without notifying.');
    return { ok: true, status: 'baseline-initialized', hash, reason: 'snapshot-shape-migrated' };
  }

  if (!effectiveChangeItems.length) {
    state.channels.email.lastSentHash = hash;
    state.channels.telegram.lastSentHash = hash;
    state.lastSnapshotHash = hash;
    state.lastSnapshot = snapshot;
    await saveState(stateFile, state);
    console.log('[WalletScheduler] Change detected but ignored by rules (no notifications sent).');
    return { ok: true, status: 'ignored', hash, reason: 'change-filtered', changeItems: [] };
  }

  // Only notify when the Total Combined balance actually changed — individual PSP movements alone are not enough.
  const totalCombinedChanged = effectiveChangeItems.some((item) => item.key === 'total_balance');
  if (!totalCombinedChanged) {
    state.channels.email.lastSentHash = hash;
    state.channels.telegram.lastSentHash = hash;
    state.lastNotifiedHash = hash;
    state.lastSnapshotHash = hash;
    state.lastSnapshot = snapshot;
    await saveState(stateFile, state);
    console.log('[WalletScheduler] PSP balances changed but Total Combined unchanged — skipping notifications.');
    return {
      ok: true,
      status: 'skipped',
      hash,
      reason: 'total-combined-unchanged',
      changeItems: effectiveChangeItems,
    };
  }

  state.lastSnapshotHash = hash;
  state.lastSnapshot = snapshot;
  await saveState(stateFile, state);

  const sendResult = await sendWalletReport(report, date, {
    changeItems: effectiveChangeItems,
    sendEmail: needsEmail,
    sendTelegram: needsTelegram,
  });

  if (needsEmail && sendResult.emailOk) {
    state.channels.email.lastSentHash = hash;
  }
  if (needsTelegram && sendResult.telegramOk) {
    state.channels.telegram.lastSentHash = hash;
  }

  if (sendResult.emailOk || sendResult.telegramOk) {
    state.lastNotifiedHash = hash;
  }

  await saveState(stateFile, state);

  return {
    ok: sendResult.emailOk || sendResult.telegramOk,
    status: sendResult.emailOk && sendResult.telegramOk ? 'sent-both' : (sendResult.emailOk || sendResult.telegramOk ? 'sent-partial' : 'send-failed'),
    hash,
    reason: sendResult.emailOk || sendResult.telegramOk ? 'sent' : 'all-channels-failed',
    channels: {
      email: { requested: needsEmail, ok: sendResult.emailOk, reason: sendResult.emailReason || '' },
      telegram: { requested: needsTelegram, ok: sendResult.telegramOk, reason: sendResult.telegramReason || '' },
    },
    changeItems: effectiveChangeItems,
  };
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
