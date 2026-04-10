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

  const sourceResults = await Promise.all([
    (async () => {
      try {
        const result = await new BitpaceClient().getBalance();
        return {
          entries: [['bitpace', { name: 'Bitpace', balance: result.balance, currencies: result.currencies, status: 'ok', checked_at: now() }]],
          totalDelta: result.balance,
        };
      } catch (e) {
        const message = e?.message || String(e);
        console.error('[WalletMonitor] Bitpace error:', message);
        return {
          entries: [['bitpace', { name: 'Bitpace', balance: 0, currencies: {}, status: 'error', error: message, checked_at: now() }]],
          totalDelta: 0,
        };
      }
    })(),
    (async () => {
      try {
        const result = await new LetKnowPayClient().getBalance();
        return {
          entries: [['letknowpay', { name: 'LetKnow Pay', balance: result.balance, currencies: result.currencies, status: 'ok', checked_at: now() }]],
          totalDelta: result.balance,
        };
      } catch (e) {
        const message = e?.message || String(e);
        console.error('[WalletMonitor] LetKnow Pay error:', message);
        return {
          entries: [['letknowpay', { name: 'LetKnow Pay', balance: 0, currencies: {}, status: 'error', error: message, checked_at: now() }]],
          totalDelta: 0,
        };
      }
    })(),
    (async () => {
      try {
        const result = await new OwnBitClient().getBalance();
        return {
          entries: [['ownbit', { name: 'OwnBit', balance: result.balance, currencies: result.currencies, status: 'ok', checked_at: now() }]],
          totalDelta: result.balance,
        };
      } catch (e) {
        const message = e?.message || String(e);
        console.error('[WalletMonitor] OwnBit error:', message);
        return {
          entries: [['ownbit', { name: 'OwnBit', balance: 0, currencies: {}, status: 'error', error: message, checked_at: now() }]],
          totalDelta: 0,
        };
      }
    })(),
    (async () => {
      try {
        const result = await new HeroPaymentClient().getBalance();
        return {
          entries: [['heropayment', { name: 'HeroPayment', balance: result.balance, currencies: result.currencies, status: 'ok', checked_at: now() }]],
          totalDelta: result.balance,
        };
      } catch (e) {
        const message = e?.message || String(e);
        console.error('[WalletMonitor] HeroPayment error:', message);
        return {
          entries: [['heropayment', { name: 'HeroPayment', balance: 0, currencies: {}, status: 'error', error: message, checked_at: now() }]],
          totalDelta: 0,
        };
      }
    })(),
    (async () => {
      try {
        const gs = await new GoogleSheetsClient().getBalance();
        const sheetUsed = gs.sheetUsed;
        return {
          entries: [
            ['googlesheets_match2pay', { name: 'Match2Pay', balance: gs.match2pay, currencies: {}, status: 'ok', checked_at: now(), sheet_used: sheetUsed }],
            ['googlesheets_deusxpay', { name: 'DeusXpay', balance: gs.deusXpay, currencies: {}, status: 'ok', checked_at: now(), sheet_used: sheetUsed }],
            ['googlesheets_openpayed', { name: 'OpenPayed', balance: gs.openPayed, currencies: {}, status: 'ok', checked_at: now(), sheet_used: sheetUsed }],
            ['googlesheets_goldsouq', { name: 'Gold Souq', balance: gs.goldSouq, currencies: {}, status: 'ok', checked_at: now(), sheet_used: sheetUsed }],
            ['googlesheets_fab', {
              name: 'FAB Bank',
              balance: gs.fabTotal,
              currencies: { 'FAB AED': gs.fabAed, 'FAB USD': gs.fabUsd },
              status: 'ok',
              checked_at: now(),
              sheet_used: sheetUsed,
            }],
            ['googlesheets_mbme', { name: 'MBME', balance: gs.mbme, currencies: {}, status: 'ok', checked_at: now(), sheet_used: sheetUsed }],
          ],
          totalDelta: gs.match2pay + gs.deusXpay + gs.openPayed + gs.goldSouq + gs.fabTotal + gs.mbme,
          extra: {
            bankReceivable: gs.bankReceivable,
            cryptoReceivable: gs.cryptoReceivable,
            toBeDepositedIntoLPsK20: gs.toBeDepositedIntoLPsK20,
            toBeDepositedIntoLPsK21: gs.toBeDepositedIntoLPsK21,
            differenceBetweenActualAndExpected: gs.differenceBetweenActualAndExpected,
            netAllCurrentBalance: gs.netAllCurrentBalance,
            netBalanceAfterExpectedFunds: gs.netBalanceAfterExpectedFunds,
          },
        };
      } catch (e) {
        const message = e?.message || String(e);
        console.error('[WalletMonitor] Google Sheets error:', message);
        const names = {
          googlesheets_match2pay: 'Match2Pay',
          googlesheets_deusxpay: 'DeusXpay',
          googlesheets_openpayed: 'OpenPayed',
          googlesheets_goldsouq: 'Gold Souq',
          googlesheets_fab: 'FAB Bank',
          googlesheets_mbme: 'MBME',
        };
        const entries = Object.entries(names).map(([id, name]) => [
          id,
          { name, balance: 0, currencies: {}, status: 'error', error: message, checked_at: now() },
        ]);
        return { entries, totalDelta: 0 };
      }
    })(),
  ]);

  for (const sourceResult of sourceResults) {
    for (const [id, widget] of sourceResult.entries) {
      widgets[id] = widget;
    }

    total += Number(sourceResult.totalDelta || 0);

    if (sourceResult.extra) {
      bankReceivable = Number(sourceResult.extra.bankReceivable || 0);
      cryptoReceivable = Number(sourceResult.extra.cryptoReceivable || 0);
      toBeDepositedIntoLPsK20 = Number(sourceResult.extra.toBeDepositedIntoLPsK20 || 0);
      toBeDepositedIntoLPsK21 = Number(sourceResult.extra.toBeDepositedIntoLPsK21 || 0);
      differenceBetweenActualAndExpected = Number(sourceResult.extra.differenceBetweenActualAndExpected || 0);
      netAllCurrentBalance = Number(sourceResult.extra.netAllCurrentBalance || 0);
      netBalanceAfterExpectedFunds = Number(sourceResult.extra.netBalanceAfterExpectedFunds || 0);
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
