import {
  getAccountsMetrics,
  getBackofficeMetrics,
  getCoverageMetrics,
  getDealingSummary,
  getHistoryAggregate,
  getLiveSnapshot,
  getLpAccounts,
  getLpMetrics,
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
];

const registry = {
  get_dealing_metrics: getDealingSummary,
  get_coverage_metrics: getCoverageMetrics,
  get_lp_metrics: getLpMetrics,
  get_swap_metrics: getSwapMetrics,
  get_history_aggregate: getHistoryAggregate,
  get_accounts_metrics: getAccountsMetrics,
  get_backoffice_metrics: getBackofficeMetrics,
  get_marketing_metrics: getMarketingMetrics,
  get_lp_accounts: getLpAccounts,
  get_live_snapshot: getLiveSnapshot,
};

export async function executeTool(name, args = {}) {
  const fn = registry[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args || {});
}

export function listToolNames() {
  return Object.keys(registry);
}
