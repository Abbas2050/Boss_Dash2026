/**
 * Wallet Monitor - Node.js port of OtherProject/backofficetool/src/wallet_monitor.php
 * Orchestrates all PSP balance fetches and returns the unified widget response.
 */

import { BitpaceClient, LetKnowPayClient, OwnBitClient, HeroPaymentClient, GoogleSheetsClient } from './pspClients.js';

/**
 * Fetch all PSP balances and return the standard response shape:
 * {
 *   ok: true,
 *   data: {
 *     widgets: { [id]: { name, balance, currencies, status, checked_at, ...extra } },
 *     total,
 *     bank_receivable, crypto_receivable,
 *     net_all_current_balance, net_balance_after_expected_funds,
 *     generated_at,
 *   }
 * }
 */
export async function checkAllBalances() {
  const widgets = {};
  let total = 0;
  let bankReceivable = 0;
  let cryptoReceivable = 0;
  let toBeDepositedIntoLPsK20 = 0;
  let toBeDepositedIntoLPsK21 = 0;
  let differenceBetweenActualAndExpected = 0;
  let netAllCurrentBalance = 0;
  let netBalanceAfterExpectedFunds = 0;

  const now = () => new Date().toISOString();

  // ── Bitpace ──────────────────────────────────────────────
  try {
    const client = new BitpaceClient();
    const result = await client.getBalance();
    widgets.bitpace = { name: 'Bitpace', balance: result.balance, currencies: result.currencies, status: 'ok', checked_at: now() };
    total += result.balance;
  } catch (e) {
    console.error('[WalletMonitor] Bitpace error:', e.message);
    widgets.bitpace = { name: 'Bitpace', balance: 0, currencies: {}, status: 'error', error: e.message, checked_at: now() };
  }

  // ── LetKnow Pay ───────────────────────────────────────────
  try {
    const client = new LetKnowPayClient();
    const result = await client.getBalance();
    widgets.letknowpay = { name: 'LetKnow Pay', balance: result.balance, currencies: result.currencies, status: 'ok', checked_at: now() };
    total += result.balance;
  } catch (e) {
    console.error('[WalletMonitor] LetKnow Pay error:', e.message);
    widgets.letknowpay = { name: 'LetKnow Pay', balance: 0, currencies: {}, status: 'error', error: e.message, checked_at: now() };
  }

  // ── OwnBit / TRON ─────────────────────────────────────────
  try {
    const client = new OwnBitClient();
    const result = await client.getBalance();
    widgets.ownbit = { name: 'OwnBit', balance: result.balance, currencies: result.currencies, status: 'ok', checked_at: now() };
    total += result.balance;
  } catch (e) {
    console.error('[WalletMonitor] OwnBit error:', e.message);
    widgets.ownbit = { name: 'OwnBit', balance: 0, currencies: {}, status: 'error', error: e.message, checked_at: now() };
  }

  // ── HeroPayment ───────────────────────────────────────────
  try {
    const client = new HeroPaymentClient();
    const result = await client.getBalance();
    widgets.heropayment = { name: 'HeroPayment', balance: result.balance, currencies: result.currencies, status: 'ok', checked_at: now() };
    total += result.balance;
  } catch (e) {
    console.error('[WalletMonitor] HeroPayment error:', e.message);
    widgets.heropayment = { name: 'HeroPayment', balance: 0, currencies: {}, status: 'error', error: e.message, checked_at: now() };
  }

  // ── Google Sheets (4 widgets) ─────────────────────────────
  try {
    const client = new GoogleSheetsClient();
    const gs = await client.getBalance();
    const sheetUsed = gs.sheetUsed;

    widgets.googlesheets_match2pay = { name: 'Match2Pay', balance: gs.match2pay, currencies: {}, status: 'ok', checked_at: now(), sheet_used: sheetUsed };
    total += gs.match2pay;

    widgets.googlesheets_goldsouq = { name: 'Gold Souq', balance: gs.goldSouq, currencies: {}, status: 'ok', checked_at: now(), sheet_used: sheetUsed };
    total += gs.goldSouq;

    widgets.googlesheets_fab = {
      name: 'FAB Bank',
      balance: gs.fabTotal,
      currencies: { 'FAB AED': gs.fabAed, 'FAB USD': gs.fabUsd },
      status: 'ok',
      checked_at: now(),
      sheet_used: sheetUsed,
    };
    total += gs.fabTotal;

    widgets.googlesheets_mbme = { name: 'MBME', balance: gs.mbme, currencies: {}, status: 'ok', checked_at: now(), sheet_used: sheetUsed };
    total += gs.mbme;

    bankReceivable = gs.bankReceivable;
    cryptoReceivable = gs.cryptoReceivable;
    toBeDepositedIntoLPsK20 = gs.toBeDepositedIntoLPsK20;
    toBeDepositedIntoLPsK21 = gs.toBeDepositedIntoLPsK21;
    differenceBetweenActualAndExpected = gs.differenceBetweenActualAndExpected;
    netAllCurrentBalance = gs.netAllCurrentBalance;
    netBalanceAfterExpectedFunds = gs.netBalanceAfterExpectedFunds;
  } catch (e) {
    console.error('[WalletMonitor] Google Sheets error:', e.message);
    for (const id of ['googlesheets_match2pay', 'googlesheets_goldsouq', 'googlesheets_fab', 'googlesheets_mbme']) {
      const names = { googlesheets_match2pay: 'Match2Pay', googlesheets_goldsouq: 'Gold Souq', googlesheets_fab: 'FAB Bank', googlesheets_mbme: 'MBME' };
      widgets[id] = { name: names[id], balance: 0, currencies: {}, status: 'error', error: e.message, checked_at: now() };
    }
  }

  // Convert widget map to array (frontend expects array with id field)
  const widgetsArray = Object.entries(widgets).map(([id, w]) => ({ id, ...w }));

  const generatedAt = new Date();
  return {
    ok: true,
    timestamp: generatedAt.toISOString().replace('T', ' ').slice(0, 19),
    data: {
      widgets: widgetsArray,
      total_balance: total,
      bank_receivable: bankReceivable,
      crypto_receivable: cryptoReceivable,
      to_be_deposited_into_lps_k20: toBeDepositedIntoLPsK20,
      to_be_deposited_into_lps_k21: toBeDepositedIntoLPsK21,
      difference_between_actual_and_expected: differenceBetweenActualAndExpected,
      net_all_current_balance: netAllCurrentBalance,
      net_balance_after_expected_funds: netBalanceAfterExpectedFunds,
    },
  };
}
