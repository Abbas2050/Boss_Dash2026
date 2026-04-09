export interface WalletWidgetEntry {
  id: string;
  name: string;
  balance: number;
  currencies?: Record<string, unknown> | string[];
  status?: string;
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
  };
  error?: string;
}

export async function fetchWalletBalances(): Promise<WalletBalancesResponse | null> {
  try {
    const response = await fetch('/api/closing-balance-report');
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
