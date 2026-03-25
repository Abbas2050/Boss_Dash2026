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
    net_all_current_balance?: number;
    net_balance_after_expected_funds?: number;
  };
  error?: string;
}

export async function fetchWalletBalances(): Promise<WalletBalancesResponse | null> {
  const walletUrl = (import.meta as any).env?.VITE_WALLET_URL;
  const token = (import.meta as any).env?.VITE_WALLET_TOKEN;
  if (!walletUrl || !token) return null;

  try {
    const url = walletUrl.includes('?')
      ? `${walletUrl}&token=${encodeURIComponent(token)}`
      : `${walletUrl}?token=${encodeURIComponent(token)}`;
    const response = await fetch(url);
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
