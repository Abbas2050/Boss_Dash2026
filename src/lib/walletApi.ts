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
  // reports in a non-USD currency with no exchange rate attached. `balance`
  // deliberately excludes these -- pricing them here would mean this
  // dashboard picking its own exchange rate, which would then drift from the
  // provider's own screen at every refresh. Carried through so the UI can
  // name what a figure leaves out instead of just disagreeing with the
  // provider silently.
  unvalued?: { currency: string; amount: number }[];
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
