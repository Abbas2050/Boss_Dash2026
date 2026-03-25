import { SWAGGER_ENDPOINTS, SWAGGER_META } from "./swaggerCatalog.js";

const groupByTag = () => {
  const out = {};
  for (const ep of SWAGGER_ENDPOINTS) {
    const tag = ep.tag || "General";
    if (!out[tag]) out[tag] = [];
    out[tag].push(`${ep.method.toUpperCase()} ${ep.path}`);
  }
  return out;
};

export const API_PLAYBOOK = {
  source: SWAGGER_META.source,
  title: SWAGGER_META.title,
  version: SWAGGER_META.version,
  fetchedAt: SWAGGER_META.fetchedAt,
  endpointCount: SWAGGER_META.endpointCount,
  groups: groupByTag(),
  intentToTool: [
    { intent: "which endpoint / what api does this use", tools: ["list_app_endpoints"] },
    { intent: "call a known read-only endpoint", tools: ["call_app_endpoint"] },
    { intent: "account details/login equity", tools: ["get_account_details"] },
    { intent: "accounts by email / trading accounts for an email", tools: ["get_user_accounts_by_email"] },
    { intent: "crm user cashflow / deposits withdrawals by user", tools: ["get_crm_cashflow"] },
    { intent: "lp withdrawable equity", tools: ["get_lp_equity_summary"] },
    { intent: "lp metrics/margin/equity", tools: ["get_lp_metrics"] },
    { intent: "coverage/uncovered/risk", tools: ["get_coverage_metrics"] },
    { intent: "coverage for a specific symbol", tools: ["get_symbol_coverage"] },
    { intent: "lp positions by lp", tools: ["get_lp_positions"] },
    { intent: "most traded symbol / trading activity", tools: ["get_trading_activity"] },
    { intent: "history deals by login", tools: ["get_history_deals"] },
    { intent: "history volume", tools: ["get_history_volume"] },
    { intent: "bonus pnl / bonus dashboard", tools: ["get_bonus_metrics"] },
    { intent: "swap", tools: ["get_swap_metrics"] },
    { intent: "history net pl/real lp pl", tools: ["get_history_aggregate"] },
    { intent: "accounts deposits/withdrawals", tools: ["get_accounts_metrics"] },
    { intent: "backoffice", tools: ["get_backoffice_metrics"] },
    { intent: "marketing", tools: ["get_marketing_metrics"] },
    { intent: "lp account list", tools: ["get_lp_accounts"] },
    { intent: "contract size or detect multiplier", tools: ["get_contract_sizes"] },
    { intent: "symbol mapping", tools: ["get_symbol_mappings"] },
    { intent: "unknown or raw API question", tools: ["list_app_endpoints", "call_app_endpoint", "list_swagger_endpoints"] },
  ],
};

export function getApiPlaybookText() {
  const lines = [];
  lines.push(`Swagger source: ${API_PLAYBOOK.source}`);
  lines.push(`Title/version: ${API_PLAYBOOK.title} ${API_PLAYBOOK.version}`);
  lines.push(`Endpoints imported: ${API_PLAYBOOK.endpointCount}`);
  lines.push("Tags:");
  for (const [tag, routes] of Object.entries(API_PLAYBOOK.groups)) {
    lines.push(`- ${tag}: ${routes.length} endpoints`);
  }
  lines.push("Intent -> tool routing:");
  for (const row of API_PLAYBOOK.intentToTool) {
    lines.push(`- ${row.intent} => ${row.tools.join(", ")}`);
  }
  return lines.join("\n");
}
