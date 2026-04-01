// src/lib/api.ts

export interface TransactionRequest {
  createdAt?: { begin: string; end: string };
  processedAt?: { begin: string; end: string };
  statuses?: string[];
  customFields?: Record<string, string>;
  fromUserId?: number;
  transactionTypes?: string[];
  segment?: { limit: number; offset: number };
}

export interface UserRequest {
  created?: { begin: string; end: string };
  clientType?: string;
  clientTypes?: string[];
  customFields?: Record<string, string | { value: string }>;
  verified?: boolean;
  lead?: boolean;
  segment?: { limit: number; offset: number };
}

export interface User {
  id: number;
  managerId: number | null;
  country: string;
  city: string | null;
  firstName: string;
  lastName: string;
  middleName: string | null;
  email: string;
  secondaryEmail: string | null;
  referrer: string | null;
  phone: string;
}

export interface RangeFilter {
  lt?: number;
  gt?: number;
  lte?: number;
  gte?: number;
  eq?: number;
}

export interface AccountRequest {
  createdAt?: { begin: string; end: string };
  customFields?: Record<string, string | { value: string }>;
  userId?: number | null;
  userIds?: number[];
  login?: string | number | null;
  serverId?: number | null;
  balance?: RangeFilter;
  credit?: RangeFilter;
  equity?: RangeFilter;
  margin?: RangeFilter;
  orders?: Array<{ field: string; direction: 'ASC' | 'DESC' }>;
  segment?: { limit: number; offset: number };
  companyId?: number | null;
}

export interface Account {
  id: number;
  userId: number;
  login: string;
  name: string;
  currency: string;
  balance: number;
  credit: number;
  equity?: number;
  margin?: number;
  createdAt: string;
  group: string;
}

export interface AccountUpdateResponse {
  login: string;
  serverId: number;
  userId: number;
  createdAt: string;
  groupName: string;
  currency: string;
  isEnabled: number;
  leverage: number;
  balance: number;
  credit: number;
  equity: number;
  margin: number;
  customFields: any;
  managerId: number;
  accountTypeId: number;
  tradingStatus: string;
  companyId: number;
  tags: any;
  isReadOnly: number;
}

export interface LeverageUpdateRequest {
  serverId: number;
  login: string;
  leverage: number;
}

export interface LeverageUpdateResult {
  success: boolean;
  serverId: number;
  login: string;
  newLeverage?: number;
  error?: string;
}

export interface TradeRequest {
  openDate?: { begin: string; end: string };
  closeDate?: { begin: string; end: string };
  ticketType?: string[];
}

export interface Trade {
  userId: number;
  login: string;
  closeDate: string | null;
  openDate: string;
  ticket: string;
  ticketType: string;
  volume: number;
  currency: string;
  pl: number;
  symbol: string;
  openPrice: string;
  closePrice: string;
}

export interface Transaction {
  id: number;
  fromUserId: number;
  type: string;
  processedAmount: number;
  processedCurrency: string;
  status: string;
  processedAt: string;
  comment?: string;
  platformComment?: string;
  // ... add more fields as needed
}

export async function fetchTransactions(body: TransactionRequest): Promise<Transaction[]> {
  const baseUrl = '/rest/transactions';
  const url = `${baseUrl}?version=${import.meta.env.VITE_API_VERSION}`;
  const token = import.meta.env.VITE_API_TOKEN;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API error ${res.status}: ${text || 'no body'}`);
    }

    const data = await res.json();
    return data;
  } catch (err: any) {
    throw err;
  }
}

export async function fetchAllTransactions(body: Omit<TransactionRequest, 'segment'>): Promise<Transaction[]> {
  const PAGE = 1000;
  const all: Transaction[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchTransactions({ ...body, segment: { limit: PAGE, offset } }).catch(() => [] as Transaction[]);
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

export async function fetchUsers(body: UserRequest): Promise<User[]> {
  const baseUrl = '/rest/users';
  const url = `${baseUrl}?version=${import.meta.env.VITE_API_VERSION}`;
  const token = import.meta.env.VITE_API_TOKEN;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Users API error ${res.status}: ${text || 'no body'}`);
    }

    const data = await res.json();
    return data;
  } catch (err: any) {
    throw err;
  }
}

export async function fetchAllUsers(body: Omit<UserRequest, 'segment'>): Promise<User[]> {
  const PAGE = 1000;
  const all: User[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchUsers({ ...body, segment: { limit: PAGE, offset } }).catch(() => [] as User[]);
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

export async function fetchAccounts(body: AccountRequest): Promise<Account[]> {
  const baseUrl = '/rest/accounts';
  const url = `${baseUrl}?version=${import.meta.env.VITE_API_VERSION}`;
  const token = import.meta.env.VITE_API_TOKEN;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Accounts API error ${res.status}: ${text || 'no body'}`);
    }

    const data = await res.json();
    return data;
  } catch (err: any) {
    throw err;
  }
}

export async function fetchTrades(body: TradeRequest): Promise<Trade[]> {
  const baseUrl = '/rest/trades';
  const url = `${baseUrl}?version=${import.meta.env.VITE_API_VERSION}`;
  const token = import.meta.env.VITE_API_TOKEN;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Trades API error ${res.status}: ${text || 'no body'}`);
    }

    const data = await res.json();
    return data;
  } catch (err: any) {
    throw err;
  }
}

/**
 * Update account leverage
 * PUT /rest/accounts/{serverId}-{login}
 */
export async function updateAccountLeverage(
  request: LeverageUpdateRequest
): Promise<AccountUpdateResponse> {
  const baseUrl = '/rest/accounts';
  const accountId = `${request.serverId}-${request.login}`;
  const url = `${baseUrl}/${accountId}?version=${import.meta.env.VITE_API_VERSION}`;
  const token = import.meta.env.VITE_API_TOKEN;

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ leverage: request.leverage }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Update leverage error ${res.status}: ${text || 'no body'}`);
    }

    const data = await res.json();
    return data;
  } catch (err: any) {
    throw err;
  }
}

/**
 * Batch update leverage for multiple accounts
 */
export async function batchUpdateLeverage(
  requests: LeverageUpdateRequest[]
): Promise<LeverageUpdateResult[]> {
  const results: LeverageUpdateResult[] = [];

  for (const request of requests) {
    try {
      const response = await updateAccountLeverage(request);
      results.push({
        success: true,
        serverId: request.serverId,
        login: request.login,
        newLeverage: response.leverage,
      });
    } catch (error: any) {
      results.push({
        success: false,
        serverId: request.serverId,
        login: request.login,
        error: error?.message || 'Unknown error',
      });
    }
  }

  return results;
}
