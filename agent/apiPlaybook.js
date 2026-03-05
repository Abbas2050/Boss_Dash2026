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
    { intent: "lp withdrawable equity", tools: ["get_lp_equity_summary"] },
    { intent: "lp metrics/margin/equity", tools: ["get_lp_metrics"] },
    { intent: "coverage/uncovered/risk", tools: ["get_coverage_metrics"] },
    { intent: "swap", tools: ["get_swap_metrics"] },
    { intent: "history net pl/real lp pl", tools: ["get_history_aggregate"] },
    { intent: "accounts deposits/withdrawals", tools: ["get_accounts_metrics"] },
    { intent: "backoffice", tools: ["get_backoffice_metrics"] },
    { intent: "marketing", tools: ["get_marketing_metrics"] },
    { intent: "lp account list", tools: ["get_lp_accounts"] },
    { intent: "unknown or raw API question", tools: ["list_swagger_endpoints", "call_swagger_endpoint"] },
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
