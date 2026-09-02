// /api/closing-balance-report sits behind requireSession (server.js denies
// every /api and /rest route by default), so this fetch needs the session
// bearer or it 401s the moment the deny-by-default gate is live.
import { authHeaders } from "@/lib/auth";

export interface WalletWidgetEntry {
  id: string;
  name: string;
  balance: number;
  currencies?: Record<string, unknown> | string[];
  status?: string;
  // wallet/pspClients.js + wallet/walletMonitor.js: holdings the provider
  // reports in a non-USD currency with no exchange rate attached, that we
  // could not price either -- an unlisted ticker, or a rate lookup that
  // failed. `balance` deliberately excludes these. Carried through so the UI
  // can name what a figure leaves out instead of just disagreeing with the
  // provider silently.
  unvalued?: { currency: string; amount: number }[];
  // wallet/cryptoRates.js: holdings the provider gave no price for that we
  // priced ourselves from Binance spot, carrying the rate used. `balance`
  // INCLUDES these, which is exactly why the rate travels with them -- the row
  // has to be able to say the price is ours, not the provider's, so a few
  // cents of disagreement with their screen reads as two rate sources rather
  // than as an error.
  valued?: { currency: string; amount: number; rate: number; usd: number }[];
}

export interface WalletBalancesResponse {
  ok: boolean;
  timestamp?: string;
  data?: {
    widgets: WalletWidgetEntry[];
    total_balance?: number;
    bank_receivable?: number;
    crypto_receivable?: number;
    to_be_deposited_into_lps_k20?: number;
    to_be_deposited_into_lps_k21?: number;
    difference_between_actual_and_expected?: number;
    net_all_current_balance?: number;
    net_balance_after_expected_funds?: number;
    // Returned by walletMonitor.js and already read by both dashboards; it was
    // simply missing from this type.
    credit_by_lps?: number;
    // Google Sheets field keys whose cell could not be parsed into a number.
    // The widget balances still carry a 0 for these so the closing-balance
    // tiles are untouched; anything that must not add a zero that was never a
    // balance reads this instead. Optional because an older backend build will
    // not send it.
    unreadableSheetFields?: string[];
  };
  error?: string;
}

export async function fetchWalletBalances(): Promise<WalletBalancesResponse | null> {
  try {
    const response = await fetch(`/api/closing-balance-report?_ts=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        ...authHeaders(),
      },
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const json = (await response.json()) as WalletBalancesResponse;
    if (json && json.ok && json.data?.widgets) {
      return json;
    }
    return { ok: false, error: 'Invalid response' };
  } catch {
    // ignore
  }

  return { ok: false, error: 'Network error' };
}
