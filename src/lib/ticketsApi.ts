import { getCurrentUser } from "@/lib/auth";

export type TicketAttachment = {
  name: string;
  file: string;
};

export type TicketDraft = {
  user: number;
  manager: number;
  status: string;
  title: string;
  text: string;
  category: string;
  attachments?: TicketAttachment[];
};

export type TicketRecord = {
  id: number;
  user: number | null;
  manager: number | null;
  title: string;
  status: string;
  category: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketComment = {
  id: number;
  ticket: number;
  text: string;
  user: number | null;
  manager: number | null;
  isPrivate: boolean;
  createdAt: string;
};

export type HelpDeskCategory = {
  value: string;
  label: string;
};

export type CrmClientSuggestion = {
  id: number;
  cid: string;
  firstName: string;
  lastName: string;
  email: string;
};

export type CrmAccountSuggestion = {
  login: string;
  userId: number | null;
  groupName: string;
  serverId: number | null;
};

type CrmAccount = {
  userId?: number;
  login?: string | number;
  groupName?: string;
  serverId?: number;
};

const API_VERSION = (import.meta as any).env?.VITE_API_VERSION || "1.0.0";
const API_TOKEN = (import.meta as any).env?.VITE_API_TOKEN || "";
const DEFAULT_TICKET_STATUS = "pending support";

const MANAGER_EMAIL_TO_ID: Record<string, number> = {
  "dealing@skylinkscapital.com": 11,
  "backoffice@skylinkscapital.com": 7,
  "d.takieddine@gmail.com": 4,
  "abbas@skylinkscapital.com": 3,
  "irungbam@skylinkscapital.com": 16,
};

function crmHeaders() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${API_TOKEN}`,
  };
}

function requireApiToken() {
  if (!API_TOKEN) {
    throw new Error("VITE_API_TOKEN is missing. Please set it in .env.");
  }
}

export function resolveCrmManagerIdFromSession(): number {
  const currentUser = getCurrentUser();
  const email = String(currentUser?.email || "").trim().toLowerCase();
  const managerId = MANAGER_EMAIL_TO_ID[email];
  if (!managerId) {
    throw new Error(`No CRM manager mapping found for logged-in email: ${email || "unknown"}`);
  }
  return managerId;
}

export async function resolveUserIdByAccountNumber(accountNumber: string): Promise<number | null> {
  requireApiToken();
  const login = String(accountNumber || "").trim();
  if (!login) return null;

  const endpoint = `/rest/accounts?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify({
      login,
      segment: { limit: 1, offset: 0 },
    }),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Account lookup failed (${response.status}) ${txt ? `- ${txt.slice(0, 180)}` : ""}`);
  }

  const rows = (await response.json()) as CrmAccount[] | null;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const userId = Number(rows[0]?.userId);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

function toAccountSuggestion(raw: any): CrmAccountSuggestion | null {
  const login = String(raw?.login ?? "").trim();
  if (!login) return null;
  const userId = Number(raw?.userId);
  const serverId = Number(raw?.serverId);
  return {
    login,
    userId: Number.isFinite(userId) && userId > 0 ? userId : null,
    groupName: String(raw?.groupName || ""),
    serverId: Number.isFinite(serverId) ? serverId : null,
  };
}

export async function searchAccountsByLogin(input: string): Promise<CrmAccountSuggestion[]> {
  requireApiToken();
  const value = String(input || "").trim();
  if (!value) return [];

  const endpoint = `/rest/accounts?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify({
      login: value,
      segment: { limit: 20, offset: 0 },
      orders: [{ field: "createdAt", direction: "DESC" }],
    }),
  });

  if (!response.ok) return [];
  const rows = await response.json();
  if (!Array.isArray(rows)) return [];
  return rows
    .map(toAccountSuggestion)
    .filter((item: CrmAccountSuggestion | null): item is CrmAccountSuggestion => Boolean(item));
}

function toTicketRecord(raw: any): TicketRecord {
  const fallbackText =
    String(raw?.text || "").trim() ||
    String(raw?.comment?.text || "").trim() ||
    "";
  return {
    id: Number(raw?.id || 0),
    user: Number.isFinite(Number(raw?.user)) ? Number(raw.user) : null,
    manager: Number.isFinite(Number(raw?.manager)) ? Number(raw.manager) : null,
    title: String(raw?.title || "-"),
    status: String(raw?.status || "-"),
    category: String(raw?.category || "-"),
    text: fallbackText,
    createdAt: String(raw?.createdAt || ""),
    updatedAt: String(raw?.updatedAt || ""),
  };
}

function toSuggestion(raw: any): CrmClientSuggestion | null {
  const id = Number(raw?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    cid: String(raw?.cid ?? raw?.cId ?? raw?.clientId ?? id),
    firstName: String(raw?.firstName || ""),
    lastName: String(raw?.lastName || ""),
    email: String(raw?.email || ""),
  };
}

export async function searchClientsByClientId(clientId: string): Promise<CrmClientSuggestion[]> {
  requireApiToken();
  const id = Number(String(clientId || "").trim());
  if (!Number.isFinite(id) || id <= 0) return [];

  const endpoint = `/rest/users?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify({
      ids: [id],
      segment: { limit: 20, offset: 0 },
    }),
  });

  if (!response.ok) return [];
  const rows = await response.json();
  if (!Array.isArray(rows)) return [];
  return rows.map(toSuggestion).filter((item: CrmClientSuggestion | null): item is CrmClientSuggestion => Boolean(item));
}

export async function searchClientsByIbId(ibId: string): Promise<CrmClientSuggestion[]> {
  requireApiToken();
  const val = String(ibId || "").trim();
  const num = Number(val);
  if (!val) return [];

  const endpoint = `/rest/users?version=${encodeURIComponent(API_VERSION)}`;

  // First try via cids (as documented).
  const byCid = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify({
      cids: Number.isFinite(num) && num > 0 ? [num] : [val],
      segment: { limit: 20, offset: 0 },
    }),
  }).catch(() => null);

  if (byCid?.ok) {
    const rows = await byCid.json();
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.map(toSuggestion).filter((item: CrmClientSuggestion | null): item is CrmClientSuggestion => Boolean(item));
    }
  }

  // Fallback: some setups may still match by ids.
  if (Number.isFinite(num) && num > 0) {
    return searchClientsByClientId(String(num));
  }
  return [];
}

export async function createCrmTicket(input: TicketDraft): Promise<TicketRecord> {
  requireApiToken();
  const endpoint = `/rest/help-desk/tickets/new?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify({
      user: input.user,
      manager: input.manager,
      status: input.status || DEFAULT_TICKET_STATUS,
      title: input.title,
      text: input.text,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      category: input.category,
    }),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Create ticket failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const raw = await response.json();
  return toTicketRecord(raw);
}

async function postTicketSearch(body: Record<string, unknown>): Promise<TicketRecord[]> {
  requireApiToken();
  const endpoint = `/rest/help-desk/tickets?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Load tickets failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) return [];
  return rows.map(toTicketRecord);
}

export async function listCrmTicketsAll(): Promise<TicketRecord[]> {
  return postTicketSearch({
    segment: { limit: 200, offset: 0 },
    orders: [{ field: "createdAt", direction: "DESC" }],
  });
}

export async function listCrmTicketsForActor(input: { managerId?: number | null; userId?: number | null }): Promise<TicketRecord[]> {
  const managerId = Number(input?.managerId);
  const userId = Number(input?.userId);
  const hasManager = Number.isFinite(managerId) && managerId > 0;
  const hasUser = Number.isFinite(userId) && userId > 0;

  if (!hasManager && !hasUser) return [];

  const basePayload = {
    segment: { limit: 200, offset: 0 },
    orders: [{ field: "createdAt", direction: "DESC" }],
  };

  const calls: Promise<TicketRecord[]>[] = [];
  if (hasManager) calls.push(postTicketSearch({ ...basePayload, managerIds: [managerId] }));
  if (hasUser) calls.push(postTicketSearch({ ...basePayload, userIds: [userId] }));

  const chunks = await Promise.all(calls);
  const merged = chunks.flat();
  const map = new Map<number, TicketRecord>();
  for (const row of merged) {
    if (!row?.id) continue;
    if (!map.has(row.id)) map.set(row.id, row);
  }

  return Array.from(map.values()).sort((a, b) => {
    const at = new Date(a.createdAt).getTime();
    const bt = new Date(b.createdAt).getTime();
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
}

export async function listHelpDeskCategories(): Promise<HelpDeskCategory[]> {
  requireApiToken();
  const endpoint = `/rest/help-desk/categories?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Load categories failed (${response.status}) ${txt ? `- ${txt.slice(0, 200)}` : ""}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.categories)
          ? payload.categories
          : [];
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const parsed = rows
    .map((row: any) => {
      if (typeof row === "string") {
        const v = row.trim();
        return v ? { value: v, label: v } : null;
      }
      const value = String(row?.value || row?.title || row?.name || row?.category || "").trim();
      if (!value) return null;
      const label = String(row?.label || row?.title || row?.name || value).trim();
      return { value, label };
    })
    .filter((row: HelpDeskCategory | null): row is HelpDeskCategory => Boolean(row));

  const seen = new Set<string>();
  const deduped: HelpDeskCategory[] = [];
  for (const item of parsed) {
    const key = item.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

export async function closeCrmTicket(ticketId: number): Promise<TicketRecord> {
  requireApiToken();
  const endpoint = `/rest/help-desk/tickets/${encodeURIComponent(String(ticketId))}/close?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Close ticket failed (${response.status}) ${txt ? `- ${txt.slice(0, 200)}` : ""}`);
  }

  const raw = await response.json();
  return toTicketRecord(raw);
}

export async function approveCrmTicket(ticketId: number): Promise<TicketRecord> {
  requireApiToken();
  const endpoint = `/rest/help-desk/tickets/${encodeURIComponent(String(ticketId))}?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: crmHeaders(),
    body: JSON.stringify({ status: "pending client" }),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Approve ticket failed (${response.status}) ${txt ? `- ${txt.slice(0, 200)}` : ""}`);
  }

  const raw = await response.json();
  return toTicketRecord(raw);
}

export async function addCrmTicketComment(
  ticketId: number,
  text: string,
  actor?: { manager?: number | null; user?: number | null }
): Promise<void> {
  requireApiToken();
  const endpoint = `/rest/help-desk/tickets/${encodeURIComponent(String(ticketId))}/comments?version=${encodeURIComponent(API_VERSION)}`;
  const payload: Record<string, unknown> = { text };
  const manager = Number(actor?.manager);
  const user = Number(actor?.user);
  if (Number.isFinite(manager) && manager > 0) payload.manager = manager;
  if (Number.isFinite(user) && user > 0) payload.user = user;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Add comment failed (${response.status}) ${txt ? `- ${txt.slice(0, 200)}` : ""}`);
  }
}

export async function listCrmTicketComments(ticketId: number): Promise<TicketComment[]> {
  requireApiToken();
  const endpoint = `/rest/help-desk/tickets/comments?version=${encodeURIComponent(API_VERSION)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: crmHeaders(),
    body: JSON.stringify({
      ticketIds: [ticketId],
      segment: { limit: 200, offset: 0 },
      orders: [{ field: "createdAt", direction: "ASC" }],
    }),
  });

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Load comments failed (${response.status}) ${txt ? `- ${txt.slice(0, 200)}` : ""}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) return [];
  return rows.map((row: any) => ({
    id: Number(row?.id || 0),
    ticket: Number(row?.ticket || ticketId),
    text: String(row?.text || ""),
    user: Number.isFinite(Number(row?.user)) ? Number(row.user) : null,
    manager: Number.isFinite(Number(row?.manager)) ? Number(row.manager) : null,
    isPrivate: Boolean(row?.isPrivate ?? row?.private),
    createdAt: String(row?.createdAt || ""),
  }));
}
