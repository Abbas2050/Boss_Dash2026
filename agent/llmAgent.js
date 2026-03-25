import { AGENT_TOOLS, executeTool, listToolNames } from "./tools.js";
import { getApiPlaybookText } from "./apiPlaybook.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const API_PLAYBOOK_TEXT = getApiPlaybookText();

const PORTAL_HINTS = [
  "crm",
  "email",
  "kyc",
  "wallet",
  "transaction",
  "transactions",
  "deposit",
  "withdraw",
  "withdrawal",
  "client",
  "clients",
  "user id",
  "userid",
  "cashflow",
  "backoffice",
];

const MT5_HINTS = [
  "mt5",
  "login",
  "equity",
  "margin",
  "free margin",
  "coverage",
  "risk",
  "swap",
  "history",
  "deal",
  "deals",
  "symbol",
  "lp",
  "bonus",
  "contract size",
  "pnl",
  "nop",
];

function countHints(text, hints) {
  let score = 0;
  for (const hint of hints) {
    if (text.includes(hint)) score += 1;
  }
  return score;
}

function classifyRoute(message) {
  const q = String(message || "").toLowerCase();
  const portalScore = countHints(q, PORTAL_HINTS);
  const mt5Score = countHints(q, MT5_HINTS);

  if (portalScore > 0 && mt5Score === 0) return { route: "portal", reason: "portal-only keywords" };
  if (mt5Score > 0 && portalScore === 0) return { route: "mt5", reason: "mt5-only keywords" };
  if (portalScore > 0 && mt5Score > 0) return { route: "mixed", reason: "both portal and mt5 keywords" };
  return { route: "auto", reason: "no strong routing keywords" };
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function startOfWeek(date) {
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const base = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  base.setUTCDate(base.getUTCDate() + diff);
  return base;
}

function endOfWeek(date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return end;
}

function parseNaturalDateRange(message, fallbackContext) {
  const text = String(message || "").toLowerCase();
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const make = (fromDate, toDate, reason) => ({
    fromDate: formatIsoDate(fromDate),
    toDate: formatIsoDate(toDate),
    reason,
  });

  if (text.includes("last month")) {
    const lastMonthDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    return make(startOfMonth(lastMonthDate), endOfMonth(lastMonthDate), "last month");
  }
  if (text.includes("this month") || text.includes("month to date") || text.includes("mtd")) {
    return make(startOfMonth(today), today, "this month");
  }
  if (text.includes("last week")) {
    const lastWeekRef = new Date(today);
    lastWeekRef.setUTCDate(today.getUTCDate() - 7);
    return make(startOfWeek(lastWeekRef), endOfWeek(lastWeekRef), "last week");
  }
  if (text.includes("this week") || text.includes("week to date") || text.includes("wtd")) {
    return make(startOfWeek(today), today, "this week");
  }
  if (text.includes("yesterday")) {
    const y = new Date(today);
    y.setUTCDate(today.getUTCDate() - 1);
    return make(y, y, "yesterday");
  }
  if (text.includes("today") || text.includes("current day")) {
    return make(today, today, "today");
  }

  return {
    fromDate: fallbackContext.fromDate,
    toDate: fallbackContext.toDate,
    reason: "default range",
  };
}

function detectRequiredTools(message) {
  const q = String(message || "").toLowerCase();
  const required = [];
  if (q.includes("swagger") || q.includes("endpoint list") || q.includes("what api") || q.includes("which api") || q.includes("which endpoint")) {
    required.push("list_app_endpoints");
  }
  if (q.includes("endpoint") && (q.includes("call") || q.includes("run") || q.includes("query"))) required.push("call_app_endpoint");
  if (q.includes("@") && q.includes("account")) required.push("get_user_accounts_by_email");
  if (q.includes("login") || q.includes("account details") || q.includes("account info") || q.includes("user info")) required.push("get_account_details");
  if (q.includes("lp withdrawable") || q.includes("client withdrawable") || q.includes("equity summary")) required.push("get_lp_equity_summary");
  if (q.includes("lp metrics") || q.includes("margin level") || q.includes("total margin")) required.push("get_lp_metrics");
  if (q.includes("coverage") || q.includes("uncovered") || q.includes("risk")) required.push("get_coverage_metrics");
  if (q.includes("crm") && (q.includes("cashflow") || q.includes("deposit") || q.includes("withdraw"))) required.push("get_crm_cashflow");
  if ((q.includes("coverage") || q.includes("uncovered")) && (q.includes("symbol") || q.includes("xau") || q.includes("eurusd") || q.includes("gold"))) required.push("get_symbol_coverage");
  if (q.includes("lp positions") || q.includes("what positions does") || q.includes("currently long") || q.includes("currently short")) required.push("get_lp_positions");
  if (q.includes("most traded") || q.includes("traded more") || q.includes("top symbol") || q.includes("trading activity") || q.includes("volume by symbol")) required.push("get_trading_activity");
  if (q.includes("history deals") || (q.includes("deal") && q.includes("login"))) required.push("get_history_deals");
  if (q.includes("history volume") || q.includes("volume yards") || q.includes("yards")) required.push("get_history_volume");
  if (q.includes("bonus") || q.includes("watermark") || q.includes("pnl smart")) required.push("get_bonus_metrics");
  if (q.includes("swap")) required.push("get_swap_metrics");
  if (q.includes("history") || q.includes("real lp p/l") || q.includes("net p/l")) required.push("get_history_aggregate");
  if (q.includes("account") || q.includes("deposit") || q.includes("withdraw")) required.push("get_accounts_metrics");
  if (q.includes("backoffice") || q.includes("kyc") || q.includes("client count")) required.push("get_backoffice_metrics");
  if ((q.includes("client") || q.includes("clients")) && (q.includes("mt5 account") || q.includes("mt5 accounts") || q.includes("created"))) {
    required.push("get_backoffice_metrics");
  }
  if (q.includes("marketing") || q.includes("ga4") || q.includes("sessions")) required.push("get_marketing_metrics");
  if (q.includes("lp account list") || q.includes("lp accounts")) required.push("get_lp_accounts");
  if (q.includes("contract size") || q.includes("multiplier") || q.includes("detect contract")) required.push("get_contract_sizes");
  if (q.includes("symbol mapping") || q.includes("mapped symbol") || q.includes("mapping rule")) required.push("get_symbol_mappings");
  return [...new Set(required)];
}

function standardizeAnswer(answer, { context, toolsUsed, routeMeta }) {
  const lines = [];
  lines.push(`As of: ${new Date().toISOString()}`);
  lines.push(`Date range: ${context.fromDate} to ${context.toDate}`);
  if (routeMeta?.route) {
    lines.push(`Routing: ${routeMeta.route}${routeMeta.reason ? ` (${routeMeta.reason})` : ""}`);
  }
  lines.push(`Tools used: ${toolsUsed.length ? toolsUsed.join(", ") : "none"}`);
  lines.push("Result:");
  lines.push(answer || "No answer generated.");
  return lines.join("\n");
}

function parseJsonSafe(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function compactToolResult(value) {
  const text = JSON.stringify(value);
  if (text.length <= 4000) return value;
  return { note: "truncated", preview: text.slice(0, 4000) };
}

function summarizeToolOutput(name, output) {
  if (!output || typeof output !== "object") return output;

  switch (name) {
    case "list_app_endpoints":
      return {
        totalMatched: output.totalMatched,
        totalAvailable: output.totalAvailable,
        endpoints: Array.isArray(output.endpoints) ? output.endpoints.slice(0, 10) : [],
      };
    case "call_app_endpoint":
      return {
        endpointId: output.endpointId,
        status: output.response?.status,
        ok: output.response?.ok,
      };
    case "get_dealing_metrics":
      return {
        totalEquity: output.totalEquity,
        totalCredit: output.totalCredit,
        netLots: output.netLots,
        deals: output.deals,
      };
    case "get_coverage_metrics":
      return {
        coveragePct: output.coveragePct,
        totalUncovered: output.totalUncovered,
        symbolCount: output.symbolCount,
        lpCount: output.lpCount,
      };
    case "get_symbol_coverage":
      return {
        symbol: output.symbol,
        clientNet: output.clientNet,
        uncovered: output.uncovered,
        coveragePct: output.coveragePct,
        lpCount: output.lpCount,
      };
    case "get_bonus_metrics":
      return {
        range: output.range,
        grossPnl: output.grossPnl,
        totalEquity: output.totalEquity,
        lpRealizedPnl: output.lpRealizedPnl,
        lpUnrealizedPnl: output.lpUnrealizedPnl,
        monthlyRows: output.monthlyRows,
      };
    case "get_lp_metrics":
      return {
        accountCount: output.accountCount,
        avgMarginLevel: output.avgMarginLevel,
        totals: {
          equity: output.totals?.equity,
          margin: output.totals?.margin,
          freeMargin: output.totals?.freeMargin,
        },
      };
    case "get_lp_positions":
      return {
        lpName: output.lpName,
        positionCount: output.positionCount,
        symbolCount: output.symbolCount,
        totalNetLots: output.totalNetLots,
        topSymbols: output.topSymbols,
      };
    case "get_lp_equity_summary":
      return {
        lpWithdrawableEquity: output.lpWithdrawableEquity,
        clientWithdrawableEquity: output.clientWithdrawableEquity,
        difference: output.difference,
      };
    case "get_trading_activity":
      return {
        dealCount: output.dealCount,
        symbolCount: output.symbolCount,
        topSymbolsByLots: output.topSymbolsByLots,
        topSymbolsByDeals: output.topSymbolsByDeals,
        totals: output.totals,
      };
    case "get_swap_metrics":
      return {
        positionCount: output.positionCount,
        dueTonight: output.dueTonight,
        negativeSwapPositions: output.negativeSwapPositions,
        totalSwap: output.totalSwap,
      };
    case "get_account_details":
      return {
        login: output.login,
        account: output.account,
        user: output.user,
      };
    case "get_user_accounts_by_email":
      return {
        email: output.email,
        matchedUsers: Array.isArray(output.matchedUsers) ? output.matchedUsers.slice(0, 5) : [],
        tradingAccountsCount: output.tradingAccountsCount,
        logins: Array.isArray(output.logins) ? output.logins.slice(0, 10) : [],
      };
    case "get_history_aggregate":
      return {
        rowCount: output.rowCount,
        totals: {
          netPL: output.totals?.netPL,
          realLpPL: output.totals?.realLpPL,
          lpPL: output.totals?.lpPL,
          grossProfit: output.totals?.grossProfit,
        },
      };
    case "get_history_deals":
      return {
        login: output.login,
        totalDeals: output.totalDeals,
        totals: output.totals,
      };
    case "get_history_volume":
      return {
        rowCount: output.rowCount,
        totals: output.totals,
        topByYards: Array.isArray(output.topByYards) ? output.topByYards.slice(0, 5) : [],
      };
    case "get_accounts_metrics":
      return {
        totalDeposits: output.totalDeposits,
        totalWithdrawals: output.totalWithdrawals,
        netFlow: output.netFlow,
        walletTotal: output.walletTotal,
      };
    case "get_backoffice_metrics":
      return {
        totalClients: output.totalClients,
        totalMt5Accounts: output.totalMt5Accounts,
        deposits: output.deposits,
        withdrawals: output.withdrawals,
        kyc: output.kyc,
      };
    case "get_crm_cashflow":
      return {
        userId: output.userId,
        fromDate: output.fromDate,
        toDate: output.toDate,
        depositsCount: output.depositsCount,
        withdrawalsCount: output.withdrawalsCount,
        totalDeposits: output.totalDeposits,
        totalWithdrawals: output.totalWithdrawals,
        netFlow: output.netFlow,
        tradingAccountsCount: output.tradingAccountsCount,
      };
    case "get_contract_sizes":
      return {
        symbol: output.symbol || null,
        count: output.count,
        detected: output.detected || null,
      };
    case "get_marketing_metrics":
      return {
        sessions: output.sessions,
        activeUsers: output.activeUsers,
        newUsers: output.newUsers,
        conversions: output.conversions,
      };
    case "get_lp_accounts":
      return {
        count: output.count,
        lpNames: Array.isArray(output.lpNames) ? output.lpNames.slice(0, 5) : [],
      };
    case "get_symbol_mappings":
      return {
        count: output.count,
        items: Array.isArray(output.items) ? output.items.slice(0, 5) : [],
      };
    case "get_live_snapshot":
      return {
        dealing: output.dealing
          ? {
              totalEquity: output.dealing.totalEquity,
              totalCredit: output.dealing.totalCredit,
              deals: output.dealing.deals,
            }
          : null,
        coverage: output.coverage
          ? {
              coveragePct: output.coverage.coveragePct,
              totalUncovered: output.coverage.totalUncovered,
            }
          : null,
        lpMetrics: output.lpMetrics
          ? {
              accountCount: output.lpMetrics.accountCount,
              avgMarginLevel: output.lpMetrics.avgMarginLevel,
            }
          : null,
        swap: output.swap
          ? {
              dueTonight: output.swap.dueTonight,
            }
          : null,
      };
    case "list_swagger_endpoints":
      return {
        endpointCount: output.meta?.endpointCount,
        totalMatched: output.totalMatched,
      };
    default:
      return compactToolResult(output);
  }
}

function extractAssistantText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n")
    .trim();
}

async function callOpenAI(messages) {
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.1,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: "auto",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}${text ? `: ${text}` : ""}`);
  }
  return resp.json();
}

async function runOpenAIToolLoop({ message, history, context }) {
  const requiredTools = detectRequiredTools(message);
  const routeMeta = classifyRoute(message);
  const routingHint = requiredTools.length
    ? `For this query, you must call these tool(s) before answering: ${requiredTools.join(", ")}.`
    : "For this query, decide and call the most relevant tools before answering.";
  const systemPrompt =
    "You are Sky Links live operations agent for Dealing, LP, Backoffice, Accounts, and Marketing. " +
    "Always call tools to fetch data before answering factual metric questions. " +
    "Use provided date window when the user does not specify. " +
    "Do live calculations from tool outputs when needed. " +
    "Do not invent fields. " +
    "Agent is strictly read-only: never perform updates/deletes/creates and never suggest code/system changes. " +
    "If a query needs endpoint discovery or a generic read-only endpoint call, use list_app_endpoints and call_app_endpoint. " +
    "Source routing policy: Use Portal tools for CRM/users/transactions/deposits/withdrawals/KYC/wallet/backoffice questions. " +
    "Use MT5/backend tools for login/account equity/margin/dealing/coverage/risk/swap/history/bonus/contract-size questions. " +
    "If a query spans both domains, call both relevant tool sets and state that explicitly. " +
    "Answer in concise business language and include key numbers in a structured format.";

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "system", content: `API playbook:\n${API_PLAYBOOK_TEXT}` },
    {
      role: "system",
      content: `Default date range: ${context.fromDate} to ${context.toDate}.`,
    },
    {
      role: "system",
      content:
        `${routingHint} ` +
        "Output format required: As of, Date range, Summary bullets, Data points, Sources/tools, and any limitations.",
    },
    {
      role: "system",
      content: `Detected route for this query: ${routeMeta.route} (${routeMeta.reason}). Prioritize tools from this source domain.`,
    },
    ...(Array.isArray(history) ? history.slice(-8) : []),
    { role: "user", content: message },
  ];

  const toolsUsed = [];
  const toolSummaries = [];
  for (let i = 0; i < 5; i += 1) {
    const result = await callOpenAI(messages);
    const choice = result?.choices?.[0];
    const assistantMessage = choice?.message;
    if (!assistantMessage) break;
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls || [];
    if (!toolCalls.length) {
      return {
        answer: standardizeAnswer(extractAssistantText(assistantMessage), { context, toolsUsed, routeMeta }),
        toolsUsed,
        toolSummaries,
      };
    }

    for (const call of toolCalls) {
      const name = call?.function?.name;
      const args = parseJsonSafe(call?.function?.arguments);
      const mergedArgs = { fromDate: context.fromDate, toDate: context.toDate, ...(args || {}) };
      const output = await executeTool(name, mergedArgs);
      toolsUsed.push(name);
      toolSummaries.push({ tool: name, data: summarizeToolOutput(name, output) });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(compactToolResult(output)),
      });
    }
  }

  return {
    answer: standardizeAnswer("I fetched data but could not complete a final response in time.", { context, toolsUsed, routeMeta }),
    toolsUsed,
    toolSummaries,
  };
}

async function runRuleBasedFallback({ message, context }) {
  const q = String(message || "").toLowerCase();
  const routeMeta = classifyRoute(message);
  const toolsUsed = [];
  const toolSummaries = [];
  const call = async (name, args = {}) => {
    toolsUsed.push(name);
    const output = await executeTool(name, { fromDate: context.fromDate, toDate: context.toDate, ...args });
    toolSummaries.push({ tool: name, data: summarizeToolOutput(name, output) });
    return output;
  };

  const emailMatch = q.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);

  if (q.includes("swagger") || q.includes("endpoint list") || q.includes("what api") || q.includes("which api") || q.includes("which endpoint")) {
    const list = await call("list_app_endpoints", { limit: 40 });
    return {
      answer: standardizeAnswer(
        `Read-only app endpoints available: ${list.totalAvailable ?? "-"} total. Showing ${list.totalMatched}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }

  if (q.includes("endpoint") && (q.includes("call") || q.includes("run") || q.includes("query"))) {
    const endpoints = await call("list_app_endpoints", { search: q, limit: 1 });
    const endpointId = endpoints?.endpoints?.[0]?.id;
    if (endpointId) {
      const called = await call("call_app_endpoint", { endpointId });
      return {
        answer: standardizeAnswer(
          `Called endpoint ${endpointId}. Status ${called.response?.status ?? "-"}.`,
          { context, toolsUsed, routeMeta },
        ),
        toolsUsed,
        toolSummaries,
      };
    }
  }

  if (emailMatch && q.includes("account")) {
    const byEmail = await call("get_user_accounts_by_email", { email: emailMatch[0] });
    return {
      answer: standardizeAnswer(
        `${byEmail.email} has ${byEmail.tradingAccountsCount} trading account(s). ` +
          `${byEmail.logins.length ? `Logins: ${byEmail.logins.map((item) => item.login).filter(Boolean).join(", ")}.` : "No trading accounts were found."}`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }

  if (q.includes("crm") && (q.includes("cashflow") || q.includes("deposit") || q.includes("withdraw"))) {
    const userIdMatch = q.match(/\b(\d{3,})\b/);
    if (userIdMatch) {
      const flow = await call("get_crm_cashflow", { userId: Number(userIdMatch[1]) });
      return {
        answer: standardizeAnswer(
          `CRM user ${flow.userId} cashflow (${flow.fromDate} to ${flow.toDate}): Deposits ${flow.totalDeposits.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Withdrawals ${flow.totalWithdrawals.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Net Flow ${flow.netFlow.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Trading Accounts ${flow.tradingAccountsCount}.`,
          { context, toolsUsed, routeMeta },
        ),
        toolsUsed,
        toolSummaries,
      };
    }
  }

  if (q.includes("login") || q.includes("account details") || q.includes("account info") || q.includes("user info")) {
    const loginMatch = q.match(/\b(\d{4,})\b/);
    if (loginMatch) {
      const account = await call("get_account_details", { login: Number(loginMatch[1]) });
      return {
        answer: standardizeAnswer(
          `Login ${account.login}: Equity ${Number(account.account?.equity || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, Balance ${Number(account.account?.balance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, Margin ${Number(account.account?.margin || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, Free Margin ${Number(account.account?.freeMargin || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
          { context, toolsUsed, routeMeta },
        ),
        toolsUsed,
        toolSummaries,
      };
    }
  }

  if (q.includes("equity") || q.includes("credit") || q.includes("lots") || q.includes("dealing")) {
    const dealing = await call("get_dealing_metrics");
    return {
      answer: standardizeAnswer(
        `Dealing (${context.fromDate} to ${context.toDate}): Equity ${dealing.totalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Credit ${dealing.totalCredit.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Net Lots ${dealing.netLots.toFixed(2)}, Deals ${dealing.deals.toLocaleString()}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }
  if (q.includes("lp withdrawable") || q.includes("client withdrawable") || q.includes("equity summary")) {
    const lpEq = await call("get_lp_equity_summary");
    return {
      answer: standardizeAnswer(
        `LP Equity Summary: LP Withdrawable Equity ${lpEq.lpWithdrawableEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}, ` +
          `Client Withdrawable Equity ${lpEq.clientWithdrawableEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}, ` +
          `Difference ${lpEq.difference.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }
  if (q.includes("coverage") || q.includes("uncovered") || q.includes("risk")) {
    const coverage = await call("get_coverage_metrics");
    return {
      answer: standardizeAnswer(
        `Coverage: ${coverage.coveragePct.toFixed(2)}%, Total Uncovered ${coverage.totalUncovered.toFixed(2)}, Symbols ${coverage.symbolCount}, LPs ${coverage.lpCount}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }

  if (q.includes("bonus") || q.includes("watermark") || q.includes("pnl smart")) {
    const bonus = await call("get_bonus_metrics");
    return {
      answer: standardizeAnswer(
        `Bonus (${bonus.range?.from ?? context.fromDate} to ${bonus.range?.to ?? context.toDate}): Gross PnL ${Number(bonus.grossPnl || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, LP Realized ${Number(bonus.lpRealizedPnl || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, LP Unrealized ${Number(bonus.lpUnrealizedPnl || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, Monthly Rows ${bonus.monthlyRows || 0}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }

  if (q.includes("history deals") || (q.includes("deal") && q.includes("login"))) {
    const loginMatch = q.match(/\b(\d{4,})\b/);
    if (loginMatch) {
      const deals = await call("get_history_deals", { login: Number(loginMatch[1]) });
      return {
        answer: standardizeAnswer(
          `History deals for login ${deals.login}: ${deals.totalDeals} deals, Profit ${Number(deals.totals?.profit || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, Commission ${Number(deals.totals?.commission || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, Swap ${Number(deals.totals?.swap || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
          { context, toolsUsed, routeMeta },
        ),
        toolsUsed,
        toolSummaries,
      };
    }
  }

  if (q.includes("history volume") || q.includes("volume yards") || q.includes("yards")) {
    const volume = await call("get_history_volume");
    return {
      answer: standardizeAnswer(
        `History volume (${context.fromDate} to ${context.toDate}): Trades ${Number(volume.totals?.tradeCount || 0).toLocaleString()}, Lots ${Number(volume.totals?.totalLots || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, Notional USD ${Number(volume.totals?.notionalUsd || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}, Volume Yards ${Number(volume.totals?.volumeYards || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }

  if (q.includes("contract size") || q.includes("multiplier") || q.includes("detect contract")) {
    const symbolMatch = q.match(/\b([A-Z]{3,10})\b/);
    const contract = await call("get_contract_sizes", symbolMatch ? { symbol: symbolMatch[1] } : {});
    return {
      answer: standardizeAnswer(
        symbolMatch
          ? `Contract size detect for ${symbolMatch[1]}: ${JSON.stringify(contract.detected || {})}`
          : `Contract size mappings available: ${contract.count || 0}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }
  if (q.includes("swap")) {
    const swap = await call("get_swap_metrics");
    return {
      answer: standardizeAnswer(
        `Swap tracker: Positions ${swap.positionCount}, Due Tonight ${swap.dueTonight}, Negative Swap Positions ${swap.negativeSwapPositions}, Total Swap ${swap.totalSwap.toFixed(2)}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }
  if (q.includes("marketing") || q.includes("sessions") || q.includes("ga4")) {
    const marketing = await call("get_marketing_metrics");
    return {
      answer: standardizeAnswer(
        `Marketing (${context.fromDate} to ${context.toDate}): Sessions ${marketing.sessions.toLocaleString()}, Active Users ${marketing.activeUsers.toLocaleString()}, New Users ${marketing.newUsers.toLocaleString()}, Conversions ${marketing.conversions.toLocaleString()}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }
  if (q.includes("backoffice") || q.includes("kyc") || q.includes("clients")) {
    const backoffice = await call("get_backoffice_metrics");
    return {
      answer: standardizeAnswer(
        `Backoffice (${context.fromDate} to ${context.toDate}): Clients ${backoffice.totalClients.toLocaleString()}, MT5 Accounts ${backoffice.totalMt5Accounts.toLocaleString()}, Deposits ${backoffice.deposits}, Withdrawals ${backoffice.withdrawals}, KYC Approved ${backoffice.kyc.approved}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }
  if (q.includes("account") || q.includes("deposit") || q.includes("withdraw")) {
    const accounts = await call("get_accounts_metrics");
    return {
      answer: standardizeAnswer(
        `Accounts (${context.fromDate} to ${context.toDate}): Deposits ${accounts.totalDeposits.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Withdrawals ${accounts.totalWithdrawals.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Net Flow ${accounts.netFlow.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
        { context, toolsUsed, routeMeta },
      ),
      toolsUsed,
      toolSummaries,
    };
  }

  const snap = await call("get_live_snapshot");
  return {
    answer: standardizeAnswer(
      `Live snapshot (${context.fromDate} to ${context.toDate}): Equity ${snap.dealing?.totalEquity?.toLocaleString?.() ?? "-"}, Coverage ${snap.coverage?.coveragePct?.toFixed?.(2) ?? "-"}%, LP Accounts ${snap.lpMetrics?.accountCount ?? "-"}, Swap Due Tonight ${snap.swap?.dueTonight ?? "-"}.`,
      { context, toolsUsed, routeMeta },
    ),
    toolsUsed,
    toolSummaries,
  };
}

export async function runAgentChat({ message, history, context }) {
  if (!message || !String(message).trim()) {
    return { answer: "Please enter a question.", toolsUsed: [], toolSummaries: [] };
  }

  const effectiveContext = parseNaturalDateRange(message, context);

  if (OPENAI_API_KEY) {
    return runOpenAIToolLoop({ message, history, context: effectiveContext });
  }

  return runRuleBasedFallback({ message, context: effectiveContext });
}

export function agentCapabilities() {
  return {
    model: OPENAI_API_KEY ? OPENAI_MODEL : "rule-based-fallback",
    tools: listToolNames(),
  };
}
