// MT5 API Client
import type {
  MT5User,
  MT5Account,
  MT5Trade,
  MT5Position,
  MT5DailyReport,
  MT5AccountState,
  MT5ApiResponse,
  MT5UsersRequest,
  MT5TradesRequest,
} from './mt5Types';

// Base URL for MT5 API - update this to match your PHP backend location
const MT5_API_BASE = import.meta.env.DEV 
  ? '/api/mt5' 
  : (import.meta.env.VITE_MT5_API_URL || 'https://yourdomain.com/mt5_api.php');

/**
 * Test MT5 connection
 */
export async function pingMT5(): Promise<MT5ApiResponse<{ message: string }>> {
  try {
    const response = await fetch(`${MT5_API_BASE}?endpoint=ping`);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get single MT5 user by login
 */
export async function getMT5User(login: number): Promise<MT5ApiResponse<MT5User>> {
  try {
    const response = await fetch(`${MT5_API_BASE}?endpoint=user&login=${login}`);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get multiple MT5 users by logins
 */
export async function getMT5Users(request: MT5UsersRequest): Promise<MT5ApiResponse<MT5User[]>> {
  try {
    const loginsParam = encodeURIComponent(JSON.stringify(request.logins));
    const response = await fetch(`${MT5_API_BASE}?endpoint=users&logins=${loginsParam}`);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 account details
 */
export async function getMT5Account(login: number): Promise<MT5ApiResponse<MT5Account>> {
  try {
    const response = await fetch(`${MT5_API_BASE}?endpoint=account&login=${login}`);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 trades for a login
 */
export async function getMT5Trades(request: MT5TradesRequest): Promise<MT5ApiResponse<MT5Trade[]>> {
  try {
    let url = `${MT5_API_BASE}?endpoint=trades&login=${request.login}`;
    
    if (request.from) {
      url += `&from=${request.from}`;
    }
    if (request.to) {
      url += `&to=${request.to}`;
    }
    
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 deals batch by logins
 */
export async function getMT5DealsBatch(request: { logins?: number[]; groups?: string[]; from?: number; to?: number; fields?: string[] }): Promise<MT5ApiResponse<MT5Trade[]>> {
  try {
    let url = `${MT5_API_BASE}?endpoint=deals-batch`;
    if (request.groups && request.groups.length > 0) {
      const groupsParam = encodeURIComponent(JSON.stringify(request.groups));
      url += `&groups=${groupsParam}`;
    } else if (request.logins && request.logins.length > 0) {
      const loginsParam = encodeURIComponent(JSON.stringify(request.logins));
      url += `&logins=${loginsParam}`;
    }
    if (request.from) {
      url += `&from=${request.from}`;
    }
    if (request.to) {
      url += `&to=${request.to}`;
    }
    if (request.fields && request.fields.length > 0) {
      const fieldsParam = encodeURIComponent(JSON.stringify(request.fields));
      url += `&fields=${fieldsParam}`;
    }
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 deals total by login
 */
export async function getMT5DealsTotal(request: { login: number; from?: number; to?: number }): Promise<MT5ApiResponse<{ Total: number }>> {
  try {
    let url = `${MT5_API_BASE}?endpoint=deal-total&login=${request.login}`;
    if (request.from) {
      url += `&from=${request.from}`;
    }
    if (request.to) {
      url += `&to=${request.to}`;
    }
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 positions batch by logins
 */
export async function getMT5PositionsBatch(request: { logins?: number[]; groups?: string[]; fields?: string[] }): Promise<MT5ApiResponse<MT5Position[]>> {
  try {
    let url = `${MT5_API_BASE}?endpoint=positions-batch`;
    if (request.groups && request.groups.length > 0) {
      const groupsParam = encodeURIComponent(JSON.stringify(request.groups));
      url += `&groups=${groupsParam}`;
    } else if (request.logins && request.logins.length > 0) {
      const loginsParam = encodeURIComponent(JSON.stringify(request.logins));
      url += `&logins=${loginsParam}`;
    }
    if (request.fields && request.fields.length > 0) {
      const fieldsParam = encodeURIComponent(JSON.stringify(request.fields));
      url += `&fields=${fieldsParam}`;
    }
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 positions total by login
 */
export async function getMT5PositionsTotal(request: { login: number }): Promise<MT5ApiResponse<{ Total: number }>> {
  try {
    const url = `${MT5_API_BASE}?endpoint=position-total&login=${request.login}`;
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 daily reports batch by logins
 */
export async function getMT5DailyReportsBatch(request: { logins?: number[]; groups?: string[]; from: number; to: number; fields?: string[] }): Promise<MT5ApiResponse<MT5DailyReport[]>> {
  try {
    let url = `${MT5_API_BASE}?endpoint=daily-batch&from=${request.from}&to=${request.to}`;
    if (request.groups && request.groups.length > 0) {
      const groupsParam = encodeURIComponent(JSON.stringify(request.groups));
      url += `&groups=${groupsParam}`;
    } else if (request.logins && request.logins.length > 0) {
      const loginsParam = encodeURIComponent(JSON.stringify(request.logins));
      url += `&logins=${loginsParam}`;
    }
    if (request.fields && request.fields.length > 0) {
      const fieldsParam = encodeURIComponent(JSON.stringify(request.fields));
      url += `&fields=${fieldsParam}`;
    }
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 trading account states batch by logins or groups
 */
export async function getMT5AccountsBatch(request: { logins?: number[]; groups?: string[]; fields?: string[] }): Promise<MT5ApiResponse<MT5AccountState[]>> {
  try {
    let url = `${MT5_API_BASE}?endpoint=accounts-batch`;
    if (request.groups && request.groups.length > 0) {
      const groupsParam = encodeURIComponent(JSON.stringify(request.groups));
      url += `&groups=${groupsParam}`;
    } else if (request.logins && request.logins.length > 0) {
      const loginsParam = encodeURIComponent(JSON.stringify(request.logins));
      url += `&logins=${loginsParam}`;
    }
    if (request.fields && request.fields.length > 0) {
      const fieldsParam = encodeURIComponent(JSON.stringify(request.fields));
      url += `&fields=${fieldsParam}`;
    }
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get MT5 user logins by groups
 */
export async function getMT5UserLogins(request: { groups: string[] }): Promise<MT5ApiResponse<number[]>> {
  try {
    let url = `${MT5_API_BASE}?endpoint=user-logins`;
    if (request.groups && request.groups.length > 0) {
      const groupsParam = encodeURIComponent(JSON.stringify(request.groups));
      url += `&groups=${groupsParam}`;
    }
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Batch fetch multiple users with their accounts
 */
export async function getMT5UsersWithAccounts(
  logins: number[]
): Promise<MT5ApiResponse<Array<{ user: MT5User; account: MT5Account }>>> {
  try {
    const usersResponse = await getMT5Users({ logins });
    
    if (!usersResponse.success || !usersResponse.data) {
      return usersResponse as any;
    }
    
    // Fetch accounts for each user
    const usersWithAccounts = await Promise.all(
      usersResponse.data.map(async (user) => {
        const accountResponse = await getMT5Account(user.Login);
        return {
          user,
          account: accountResponse.data || ({} as MT5Account),
        };
      })
    );
    
    return {
      success: true,
      data: usersWithAccounts,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
