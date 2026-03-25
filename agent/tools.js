import {
  autoResolveAndCallEndpoint,
  callAppEndpoint,
  getAccountDetails,
  getBonusMetrics,
  callSwaggerEndpoint,
  getContractSizes,
  getCoverageBySymbol,
  getCrmCashflow,
  getAccountsMetrics,
  getBackofficeMetrics,
  getCoverageMetrics,
  getDealingSummary,
  getHistoryAggregate,
  getHistoryDeals,
  getHistoryVolume,
  getLiveSnapshot,
  getLpAccounts,
  getLpEquitySummary,
  getLpMetrics,
  getLpPositions,
  getUserAccountsByEmail,
  listAppEndpoints,
  listSwaggerEndpoints,
  getMarketingMetrics,
  getSymbolMappings,
  getSwapMetrics,
  getTradingActivity,
} from "./metricsService.js";

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "auto_resolve_and_call_endpoint",
      description: "Automatically choose the best read-only endpoint for a natural-language question, call it, and return the result.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "User question to map to an endpoint" },
          query: { type: "object", description: "Optional query-string params" },
          pathParams: { type: "object", description: "Optional path params for templated paths" },
          body: { type: "object", description: "Optional body for portal-post endpoints" },
          confirmEndpointId: { type: "string", description: "Optional endpoint id chosen by the user for disambiguation" },
          skipConfirmation: { type: "boolean", description: "If true, do not ask endpoint confirmation for close-score matches" },
          limit: { type: "number", description: "Optional catalog scan limit" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_app_endpoints",
      description: "List the read-only app endpoints the agent can use across backend, portal, and wallet integrations.",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Optional endpoint tag/category" },
          search: { type: "string", description: "Free text endpoint search" },
          limit: { type: "number", description: "Max rows to return" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "call_app_endpoint",
      description: "Call a specific read-only endpoint from the app endpoint catalog by endpointId.",
      parameters: {
        type: "object",
        properties: {
          endpointId: { type: "string", description: "Endpoint identifier from list_app_endpoints" },
          query: { type: "object", description: "Query string parameters for swagger endpoints" },
          pathParams: { type: "object", description: "Path params for templated swagger endpoints" },
          body: { type: "object", description: "POST body for portal endpoints" },
        },
        required: ["endpointId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dealing_metrics",
      description: "Fetch Dealing KPIs like equity, credit, lots, and deal count.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
          group: { type: "string", description: "Account group, default *" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_coverage_metrics",
      description: "Fetch coverage and uncovered exposure metrics.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_symbol_coverage",
      description: "Fetch detailed coverage and uncovered exposure for a specific symbol.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Trading symbol, e.g. XAUUSD" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lp_metrics",
      description: "Fetch LP metrics such as equity, margin and free margin.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lp_positions",
      description: "Fetch active positions for a specific LP and aggregate them by symbol.",
      parameters: {
        type: "object",
        properties: {
          lpName: { type: "string", description: "LP name, e.g. ATFX" },
        },
        required: ["lpName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lp_equity_summary",
      description: "Fetch LP withdrawable equity, client withdrawable equity, and the difference.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_trading_activity",
      description: "Fetch trading activity and top traded symbols by lots and deal count for a date range.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
          group: { type: "string", description: "Account group, default *" },
          symbol: { type: "string", description: "Optional symbol filter" },
          limit: { type: "number", description: "Number of top rows to return" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_swap_metrics",
      description: "Fetch swap tracker metrics.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bonus_metrics",
      description: "Fetch bonus dashboard/status/PnL metrics for a date range.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_history_aggregate",
      description: "Fetch historical aggregate LP P/L and revenue-share metrics.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_history_deals",
      description: "Fetch detailed history deals for a specific login and date range.",
      parameters: {
        type: "object",
        properties: {
          login: { type: "number", description: "Trading login" },
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
        required: ["login"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_history_volume",
      description: "Fetch history volume totals and top rows for a date range.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account_details",
      description: "Fetch account and user details for a specific login.",
      parameters: {
        type: "object",
        properties: {
          login: { type: "number", description: "Trading login/account number" },
        },
        required: ["login"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_crm_cashflow",
      description: "Fetch deposits, withdrawals and linked trading accounts for a CRM user id.",
      parameters: {
        type: "object",
        properties: {
          userId: { type: "number", description: "Portal CRM user id" },
          crmId: { type: "number", description: "Alias for userId" },
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_accounts_by_email",
      description: "Find a portal user by email and return the trading accounts linked to that email.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "Client email address" },
        },
        required: ["email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_contract_sizes",
      description: "Fetch contract size mappings or detect contract size values for a symbol.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Optional symbol to detect" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_accounts_metrics",
      description: "Fetch Accounts metrics including deposits, withdrawals, net flow and wallet totals.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_backoffice_metrics",
      description: "Fetch Backoffice metrics including clients, accounts, transactions and KYC counts.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_marketing_metrics",
      description: "Fetch Marketing metrics from GA4.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lp_accounts",
      description: "Fetch LP account list summary.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_symbol_mappings",
      description: "Fetch symbol mapping rules from settings, optionally filtered by symbol.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol search text" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_live_snapshot",
      description: "Fetch a combined cross-department live snapshot for the chat panel.",
      parameters: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "YYYY-MM-DD" },
          toDate: { type: "string", description: "YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_swagger_endpoints",
      description: "List imported Swagger endpoints with optional tag/method/search filters.",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Swagger tag filter, e.g. Coverage or Report" },
          method: { type: "string", description: "HTTP method filter, e.g. get, post" },
          search: { type: "string", description: "Free text match against path/tag/summary" },
          limit: { type: "number", description: "Max rows to return, default 50, max 200" },
        },
      },
    },
  },
];

const registry = {
  auto_resolve_and_call_endpoint: autoResolveAndCallEndpoint,
  list_app_endpoints: listAppEndpoints,
  call_app_endpoint: callAppEndpoint,
  get_account_details: getAccountDetails,
  get_bonus_metrics: getBonusMetrics,
  get_dealing_metrics: getDealingSummary,
  get_coverage_metrics: getCoverageMetrics,
  get_symbol_coverage: getCoverageBySymbol,
  get_lp_metrics: getLpMetrics,
  get_lp_positions: getLpPositions,
  get_lp_equity_summary: getLpEquitySummary,
  get_trading_activity: getTradingActivity,
  get_swap_metrics: getSwapMetrics,
  get_history_aggregate: getHistoryAggregate,
  get_history_deals: getHistoryDeals,
  get_history_volume: getHistoryVolume,
  get_user_accounts_by_email: getUserAccountsByEmail,
  get_crm_cashflow: getCrmCashflow,
  get_accounts_metrics: getAccountsMetrics,
  get_backoffice_metrics: getBackofficeMetrics,
  get_marketing_metrics: getMarketingMetrics,
  get_lp_accounts: getLpAccounts,
  get_contract_sizes: getContractSizes,
  get_symbol_mappings: getSymbolMappings,
  get_live_snapshot: getLiveSnapshot,
  list_swagger_endpoints: listSwaggerEndpoints,
  call_swagger_endpoint: callSwaggerEndpoint,
};

export async function executeTool(name, args = {}) {
  if (name === "call_swagger_endpoint") {
    throw new Error("call_swagger_endpoint is disabled in read-only mode.");
  }
  const fn = registry[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args || {});
}

export function listToolNames() {
  return Object.keys(registry);
}
