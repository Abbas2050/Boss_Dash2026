import { AGENT_TOOLS, executeTool, listToolNames } from "./tools.js";
import { getApiPlaybookText } from "./apiPlaybook.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const API_PLAYBOOK_TEXT = getApiPlaybookText();

function detectRequiredTools(message) {
  const q = String(message || "").toLowerCase();
  const required = [];
  if (q.includes("swagger") || q.includes("endpoint list") || q.includes("what api") || q.includes("which api")) {
    required.push("list_swagger_endpoints");
  }
  if (q.includes("lp withdrawable") || q.includes("client withdrawable") || q.includes("equity summary")) required.push("get_lp_equity_summary");
  if (q.includes("lp metrics") || q.includes("margin level") || q.includes("total margin")) required.push("get_lp_metrics");
  if (q.includes("coverage") || q.includes("uncovered") || q.includes("risk")) required.push("get_coverage_metrics");
  if (q.includes("swap")) required.push("get_swap_metrics");
  if (q.includes("history") || q.includes("real lp p/l") || q.includes("net p/l")) required.push("get_history_aggregate");
  if (q.includes("account") || q.includes("deposit") || q.includes("withdraw")) required.push("get_accounts_metrics");
  if (q.includes("backoffice") || q.includes("kyc") || q.includes("client count")) required.push("get_backoffice_metrics");
  if (q.includes("marketing") || q.includes("ga4") || q.includes("sessions")) required.push("get_marketing_metrics");
  if (q.includes("lp account list") || q.includes("lp accounts")) required.push("get_lp_accounts");
  return [...new Set(required)];
}

function standardizeAnswer(answer, { context, toolsUsed }) {
  const lines = [];
  lines.push(`As of: ${new Date().toISOString()}`);
  lines.push(`Date range: ${context.fromDate} to ${context.toDate}`);
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
    "If a query needs raw endpoint visibility, use list_swagger_endpoints only. " +
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
    ...(Array.isArray(history) ? history.slice(-8) : []),
    { role: "user", content: message },
  ];

  const toolsUsed = [];
  for (let i = 0; i < 5; i += 1) {
    const result = await callOpenAI(messages);
    const choice = result?.choices?.[0];
    const assistantMessage = choice?.message;
    if (!assistantMessage) break;
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls || [];
    if (!toolCalls.length) {
      return { answer: standardizeAnswer(extractAssistantText(assistantMessage), { context, toolsUsed }), toolsUsed };
    }

    for (const call of toolCalls) {
      const name = call?.function?.name;
      const args = parseJsonSafe(call?.function?.arguments);
      const mergedArgs = { fromDate: context.fromDate, toDate: context.toDate, ...(args || {}) };
      const output = await executeTool(name, mergedArgs);
      toolsUsed.push(name);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(compactToolResult(output)),
      });
    }
  }

  return {
    answer: standardizeAnswer("I fetched data but could not complete a final response in time.", { context, toolsUsed }),
    toolsUsed,
  };
}

async function runRuleBasedFallback({ message, context }) {
  const q = String(message || "").toLowerCase();
  const toolsUsed = [];
  const call = async (name, args = {}) => {
    toolsUsed.push(name);
    return executeTool(name, { fromDate: context.fromDate, toDate: context.toDate, ...args });
  };

  if (q.includes("swagger") || q.includes("endpoint list") || q.includes("what api") || q.includes("which api")) {
    const list = await call("list_swagger_endpoints", { limit: 40 });
    return {
      answer: standardizeAnswer(
        `Imported Swagger endpoints: ${list.meta?.endpointCount ?? "-"} total. Showing ${list.totalMatched}.`,
        { context, toolsUsed },
      ),
      toolsUsed,
    };
  }

  if (q.includes("equity") || q.includes("credit") || q.includes("lots") || q.includes("dealing")) {
    const dealing = await call("get_dealing_metrics");
    return {
      answer: `Dealing (${context.fromDate} to ${context.toDate}): Equity ${dealing.totalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Credit ${dealing.totalCredit.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Net Lots ${dealing.netLots.toFixed(2)}, Deals ${dealing.deals.toLocaleString()}.`,
      toolsUsed,
    };
  }
  if (q.includes("lp withdrawable") || q.includes("client withdrawable") || q.includes("equity summary")) {
    const lpEq = await call("get_lp_equity_summary");
    return {
      answer: standardizeAnswer(
        `LP Equity Summary: LP Withdrawable Equity ${lpEq.lpWithdrawableEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}, ` +
          `Client Withdrawable Equity ${lpEq.clientWithdrawableEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}, ` +
          `Difference ${lpEq.difference.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
        { context, toolsUsed },
      ),
      toolsUsed,
    };
  }
  if (q.includes("coverage") || q.includes("uncovered") || q.includes("risk")) {
    const coverage = await call("get_coverage_metrics");
    return {
      answer: standardizeAnswer(
        `Coverage: ${coverage.coveragePct.toFixed(2)}%, Total Uncovered ${coverage.totalUncovered.toFixed(2)}, Symbols ${coverage.symbolCount}, LPs ${coverage.lpCount}.`,
        { context, toolsUsed },
      ),
      toolsUsed,
    };
  }
  if (q.includes("swap")) {
    const swap = await call("get_swap_metrics");
    return {
      answer: standardizeAnswer(
        `Swap tracker: Positions ${swap.positionCount}, Due Tonight ${swap.dueTonight}, Negative Swap Positions ${swap.negativeSwapPositions}, Total Swap ${swap.totalSwap.toFixed(2)}.`,
        { context, toolsUsed },
      ),
      toolsUsed,
    };
  }
  if (q.includes("marketing") || q.includes("sessions") || q.includes("ga4")) {
    const marketing = await call("get_marketing_metrics");
    return {
      answer: standardizeAnswer(
        `Marketing (${context.fromDate} to ${context.toDate}): Sessions ${marketing.sessions.toLocaleString()}, Active Users ${marketing.activeUsers.toLocaleString()}, New Users ${marketing.newUsers.toLocaleString()}, Conversions ${marketing.conversions.toLocaleString()}.`,
        { context, toolsUsed },
      ),
      toolsUsed,
    };
  }
  if (q.includes("backoffice") || q.includes("kyc") || q.includes("clients")) {
    const backoffice = await call("get_backoffice_metrics");
    return {
      answer: standardizeAnswer(
        `Backoffice (${context.fromDate} to ${context.toDate}): Clients ${backoffice.totalClients.toLocaleString()}, MT5 Accounts ${backoffice.totalMt5Accounts.toLocaleString()}, Deposits ${backoffice.deposits}, Withdrawals ${backoffice.withdrawals}, KYC Approved ${backoffice.kyc.approved}.`,
        { context, toolsUsed },
      ),
      toolsUsed,
    };
  }
  if (q.includes("account") || q.includes("deposit") || q.includes("withdraw")) {
    const accounts = await call("get_accounts_metrics");
    return {
      answer: standardizeAnswer(
        `Accounts (${context.fromDate} to ${context.toDate}): Deposits ${accounts.totalDeposits.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Withdrawals ${accounts.totalWithdrawals.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Net Flow ${accounts.netFlow.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
        { context, toolsUsed },
      ),
      toolsUsed,
    };
  }

  const snap = await call("get_live_snapshot");
  return {
    answer: standardizeAnswer(
      `Live snapshot (${context.fromDate} to ${context.toDate}): Equity ${snap.dealing?.totalEquity?.toLocaleString?.() ?? "-"}, Coverage ${snap.coverage?.coveragePct?.toFixed?.(2) ?? "-"}%, LP Accounts ${snap.lpMetrics?.accountCount ?? "-"}, Swap Due Tonight ${snap.swap?.dueTonight ?? "-"}.`,
      { context, toolsUsed },
    ),
    toolsUsed,
  };
}

export async function runAgentChat({ message, history, context }) {
  if (!message || !String(message).trim()) {
    return { answer: "Please enter a question.", toolsUsed: [] };
  }

  if (OPENAI_API_KEY) {
    return runOpenAIToolLoop({ message, history, context });
  }

  return runRuleBasedFallback({ message, context });
}

export function agentCapabilities() {
  return {
    model: OPENAI_API_KEY ? OPENAI_MODEL : "rule-based-fallback",
    tools: listToolNames(),
  };
}
