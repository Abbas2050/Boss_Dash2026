export type AgentRole = "user" | "assistant";

export interface AgentChatMessage {
  role: AgentRole;
  content: string;
}

export interface AgentChatResponse {
  ok: boolean;
  answer?: string;
  toolsUsed?: string[];
  context?: {
    fromDate: string;
    toDate: string;
  };
  at?: string;
  error?: string;
}

export interface AgentCapabilities {
  model: string;
  tools: string[];
}

export interface AgentLiveSnapshot {
  asOf: string;
  range: {
    from: string;
    to: string;
    fromTs: number;
    toTs: number;
  };
  dealing?: {
    totalEquity?: number;
    totalCredit?: number;
    deals?: number;
  } | null;
  coverage?: {
    coveragePct?: number;
    totalUncovered?: number;
  } | null;
  lpMetrics?: {
    accountCount?: number;
    avgMarginLevel?: number;
  } | null;
  swap?: {
    dueTonight?: number;
  } | null;
}

export async function fetchAgentCapabilities(): Promise<AgentCapabilities> {
  const resp = await fetch("/api/agent/capabilities");
  if (!resp.ok) throw new Error(`Capabilities ${resp.status}`);
  return resp.json();
}

export async function sendAgentChat(payload: {
  message: string;
  fromDate?: string;
  toDate?: string;
  history?: AgentChatMessage[];
}): Promise<AgentChatResponse> {
  const resp = await fetch("/api/agent/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `Chat ${resp.status}`);
  }
  return resp.json();
}
