import {
  callSwaggerEndpoint,
  getAccountsMetrics,
  getBackofficeMetrics,
  getCoverageMetrics,
  getDealingSummary,
  getHistoryAggregate,
  getLiveSnapshot,
  getLpAccounts,
  getLpEquitySummary,
  getLpMetrics,
  listSwaggerEndpoints,
  getMarketingMetrics,
  getSwapMetrics,
} from "./metricsService.js";

export const AGENT_TOOLS = [
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
      name: "get_lp_metrics",
      description: "Fetch LP metrics such as equity, margin and free margin.",
      parameters: { type: "object", properties: {} },
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
      name: "get_swap_metrics",
      description: "Fetch swap tracker metrics.",
      parameters: { type: "object", properties: {} },
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
  {
    type: "function",
    function: {
      name: "call_swagger_endpoint",
      description: "Call any endpoint imported from Swagger by exact path+method with query/path params/body.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Exact swagger path, e.g. /Report/GetSummaryByGroup" },
          method: { type: "string", description: "HTTP method, e.g. get/post/put/delete" },
          query: { type: "object", description: "Query string params as key/value map" },
          pathParams: { type: "object", description: "Path template params, e.g. {\"lpName\":\"OneRoyal\"}" },
          body: { type: "object", description: "JSON body for POST/PUT/PATCH" },
        },
        required: ["path", "method"],
      },
    },
  },
];

const registry = {
  get_dealing_metrics: getDealingSummary,
  get_coverage_metrics: getCoverageMetrics,
  get_lp_metrics: getLpMetrics,
  get_lp_equity_summary: getLpEquitySummary,
  get_swap_metrics: getSwapMetrics,
  get_history_aggregate: getHistoryAggregate,
  get_accounts_metrics: getAccountsMetrics,
  get_backoffice_metrics: getBackofficeMetrics,
  get_marketing_metrics: getMarketingMetrics,
  get_lp_accounts: getLpAccounts,
  get_live_snapshot: getLiveSnapshot,
  list_swagger_endpoints: listSwaggerEndpoints,
  call_swagger_endpoint: callSwaggerEndpoint,
};

export async function executeTool(name, args = {}) {
  const fn = registry[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args || {});
}

export function listToolNames() {
  return Object.keys(registry);
}
