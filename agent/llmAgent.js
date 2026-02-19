import { AGENT_TOOLS, executeTool, listToolNames } from "./tools.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

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
  const systemPrompt =
    "You are Sky Links live operations agent for Dealing, LP, Backoffice, Accounts, and Marketing. " +
    "Always call tools to fetch data before answering factual metric questions. " +
    "Use provided date window when the user does not specify. " +
    "Answer in concise business language and include key numbers.";

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content: `Default date range: ${context.fromDate} to ${context.toDate}.`,
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
      return { answer: extractAssistantText(assistantMessage), toolsUsed };
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
    answer: "I fetched data but could not complete a final response in time.",
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

  if (q.includes("equity") || q.includes("credit") || q.includes("lots") || q.includes("dealing")) {
    const dealing = await call("get_dealing_metrics");
    return {
      answer: `Dealing (${context.fromDate} to ${context.toDate}): Equity ${dealing.totalEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Credit ${dealing.totalCredit.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Net Lots ${dealing.netLots.toFixed(2)}, Deals ${dealing.deals.toLocaleString()}.`,
      toolsUsed,
    };
  }
  if (q.includes("coverage") || q.includes("uncovered") || q.includes("risk")) {
    const coverage = await call("get_coverage_metrics");
    return {
      answer: `Coverage: ${coverage.coveragePct.toFixed(2)}%, Total Uncovered ${coverage.totalUncovered.toFixed(2)}, Symbols ${coverage.symbolCount}, LPs ${coverage.lpCount}.`,
      toolsUsed,
    };
  }
  if (q.includes("swap")) {
    const swap = await call("get_swap_metrics");
    return {
      answer: `Swap tracker: Positions ${swap.positionCount}, Due Tonight ${swap.dueTonight}, Negative Swap Positions ${swap.negativeSwapPositions}, Total Swap ${swap.totalSwap.toFixed(2)}.`,
      toolsUsed,
    };
  }
  if (q.includes("marketing") || q.includes("sessions") || q.includes("ga4")) {
    const marketing = await call("get_marketing_metrics");
    return {
      answer: `Marketing (${context.fromDate} to ${context.toDate}): Sessions ${marketing.sessions.toLocaleString()}, Active Users ${marketing.activeUsers.toLocaleString()}, New Users ${marketing.newUsers.toLocaleString()}, Conversions ${marketing.conversions.toLocaleString()}.`,
      toolsUsed,
    };
  }
  if (q.includes("backoffice") || q.includes("kyc") || q.includes("clients")) {
    const backoffice = await call("get_backoffice_metrics");
    return {
      answer: `Backoffice (${context.fromDate} to ${context.toDate}): Clients ${backoffice.totalClients.toLocaleString()}, MT5 Accounts ${backoffice.totalMt5Accounts.toLocaleString()}, Deposits ${backoffice.deposits}, Withdrawals ${backoffice.withdrawals}, KYC Approved ${backoffice.kyc.approved}.`,
      toolsUsed,
    };
  }
  if (q.includes("account") || q.includes("deposit") || q.includes("withdraw")) {
    const accounts = await call("get_accounts_metrics");
    return {
      answer: `Accounts (${context.fromDate} to ${context.toDate}): Deposits ${accounts.totalDeposits.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Withdrawals ${accounts.totalWithdrawals.toLocaleString(undefined, { maximumFractionDigits: 2 })}, Net Flow ${accounts.netFlow.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`,
      toolsUsed,
    };
  }

  const snap = await call("get_live_snapshot");
  return {
    answer: `Live snapshot (${context.fromDate} to ${context.toDate}): Equity ${snap.dealing?.totalEquity?.toLocaleString?.() ?? "-"}, Coverage ${snap.coverage?.coveragePct?.toFixed?.(2) ?? "-"}%, LP Accounts ${snap.lpMetrics?.accountCount ?? "-"}, Swap Due Tonight ${snap.swap?.dueTonight ?? "-"}.`,
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
