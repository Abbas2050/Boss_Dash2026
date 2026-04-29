import { getCurrentUser } from "@/lib/auth";
import {
  resolveCrmManagerIdFromSession,
  resolveUserIdByAccountNumber,
  searchAccountsByLogin,
  searchClientsByClientId,
  searchClientsByIbId,
  type CrmAccountSuggestion,
  type CrmClientSuggestion,
} from "@/lib/ticketsApi";

export {
  resolveCrmManagerIdFromSession,
  resolveUserIdByAccountNumber,
  searchAccountsByLogin,
  searchClientsByClientId,
  searchClientsByIbId,
};

export type { CrmAccountSuggestion, CrmClientSuggestion };

export type ApplicationDraft = {
  user: number;
  configId: number;
  sections: ApplicationSectionRequest[];
  createdBy: string;
  uploadedByClient?: boolean;
};

export type ApplicationAnswerAnswerRequest = {
  type: "checkbox" | "country" | "date" | "text";
  value: string | string[];
};

export type ApplicationAnswerRequest = {
  question: string;
  answer: ApplicationAnswerAnswerRequest;
};

export type ApplicationSectionRequest = {
  title: string;
  answers: ApplicationAnswerRequest[];
};

export type ApplicationRecord = {
  id: number;
  configId: number;
  type: string;
  status: string;
  userId: number | null;
  acceptedBy: number | null;
  sections: string[];
  createdAt: string;
  createdBy: string;
  processedAt: string;
  processedBy: string;
  declineReason: string;
  uploadedByClient: boolean;
};

export type ApplicationConfigDefinition = {
  id: number;
  title: string;
  config: Record<string, unknown> | null;
};

const API_VERSION = (import.meta as any).env?.VITE_API_VERSION || "1.0.0";
const API_TOKEN = (import.meta as any).env?.VITE_API_TOKEN || "";

function apiHeaders() {
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

async function fetchWithFallback(paths: string[], init: RequestInit): Promise<Response> {
  let lastResponse: Response | null = null;
  for (const path of paths) {
    const response = await fetch(path, init);
    if (response.ok) return response;
    if (response.status !== 404) return response;
    lastResponse = response;
  }
  return lastResponse as Response;
}

function toApplicationRecord(raw: any): ApplicationRecord {
  const userId = Number(raw?.userId ?? raw?.user);
  const acceptedBy = Number(raw?.acceptedBy ?? raw?.processedBy ?? 0);
  return {
    id: Number(raw?.id || 0),
    configId: Number(raw?.configId || 0),
    type: String(raw?.type || ""),
    status: String(raw?.status || "-"),
    userId: Number.isFinite(userId) && userId > 0 ? userId : null,
    acceptedBy: Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : null,
    sections: Array.isArray(raw?.sections) ? raw.sections.map((v: unknown) => String(v ?? "")) : [],
    createdAt: String(raw?.createdAt || ""),
    createdBy: String(raw?.createdBy || ""),
    processedAt: String(raw?.processedAt || ""),
    processedBy: String(raw?.processedBy || ""),
    declineReason: String(raw?.declineReason || ""),
    uploadedByClient: Boolean(raw?.uploadedByClient),
  };
}

export function getCurrentActorEmail(): string {
  const currentUser = getCurrentUser();
  return String(currentUser?.email || "").trim().toLowerCase();
}

export async function createCrmApplication(input: ApplicationDraft): Promise<ApplicationRecord> {
  requireApiToken();
  const response = await fetchWithFallback(
    [
      `/rest/applications/new?version=${encodeURIComponent(API_VERSION)}`,
      `/rest/user/applications/new?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        user: input.user,
        configId: input.configId,
        status: "pending",
        sections: input.sections,
        createdBy: input.createdBy,
        uploadedByClient: Boolean(input.uploadedByClient),
      }),
    }
  );

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Create application failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload) && payload.length > 0) return toApplicationRecord(payload[0]);
  return toApplicationRecord(payload);
}

function toApplicationConfigDefinition(raw: any): ApplicationConfigDefinition {
  const id = Number(raw?.id || 0);
  return {
    id: Number.isFinite(id) ? id : 0,
    title: String(raw?.title || raw?.name || ""),
    config: raw?.config && typeof raw.config === "object" ? raw.config : null,
  };
}

export async function getCrmApplicationConfig(configId: number): Promise<ApplicationConfigDefinition> {
  requireApiToken();
  const response = await fetchWithFallback(
    [
      `/rest/applications/config/${encodeURIComponent(String(configId))}?version=${encodeURIComponent(API_VERSION)}`,
      `/rest/user/applications/config/${encodeURIComponent(String(configId))}?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "GET",
      headers: apiHeaders(),
    }
  );

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Load application config failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const payload = await response.json();
  return toApplicationConfigDefinition(payload);
}

async function postApplicationsSearch(body: Record<string, unknown>): Promise<ApplicationRecord[]> {
  requireApiToken();
  const response = await fetchWithFallback(
    [
      `/rest/applications?version=${encodeURIComponent(API_VERSION)}`,
      `/rest/user/applications?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Load applications failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) return [];
  return rows.map(toApplicationRecord);
}

export async function listCrmApplicationsAll(): Promise<ApplicationRecord[]> {
  return listCrmApplicationsPage({ limit: 50, offset: 0 });
}

export async function listCrmApplicationsPage(input: { limit: number; offset: number; userId?: number | null }): Promise<ApplicationRecord[]> {
  const limit = Math.max(1, Math.min(200, Number(input?.limit) || 20));
  const offset = Math.max(0, Number(input?.offset) || 0);
  const payload: Record<string, unknown> = {
    segment: { limit, offset },
    orders: [{ field: "createdAt", direction: "DESC" }],
  };
  return postApplicationsSearch(payload);
}

export async function listCrmApplicationsForActor(input: {
  actorEmail?: string;
  userId?: number | null;
  managerId?: number | null;
  limit?: number;
  offset?: number;
}): Promise<ApplicationRecord[]> {
  const actorEmail = String(input?.actorEmail || "").trim().toLowerCase();
  const userId = Number(input?.userId);
  const managerId = Number(input?.managerId);
  const rows = await listCrmApplicationsPage({
    limit: Math.max(1, Math.min(200, Number(input?.limit) || 20)),
    offset: Math.max(0, Number(input?.offset) || 0),
  });
  return rows.filter((row) => {
    const createdBy = String(row.createdBy || "").trim().toLowerCase();
    const processedBy = String(row.processedBy || "").trim().toLowerCase();
    const matchesEmail = actorEmail ? createdBy === actorEmail || processedBy === actorEmail : false;
    const matchesUser = Number.isFinite(userId) && userId > 0 ? row.userId === userId : false;
    const matchesAcceptedBy = Number.isFinite(managerId) && managerId > 0
      ? Number(row.acceptedBy) === managerId
      : false;
    const processedByDigits = Number((processedBy.match(/\d+/)?.[0] || ""));
    const matchesManager = Number.isFinite(managerId) && managerId > 0
      ? processedBy === String(managerId) || processedByDigits === managerId
      : false;
    return matchesEmail || matchesUser || matchesAcceptedBy || matchesManager;
  });
}

export async function approveCrmApplication(applicationId: number, managerId?: number | null): Promise<ApplicationRecord> {
  requireApiToken();
  const id = Number(applicationId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Invalid application id.");
  }
  const acceptedBy = Number(managerId);

  const urls = [
    `/rest/applications/${encodeURIComponent(String(id))}/approve?version=${encodeURIComponent(API_VERSION)}`,
    `/rest/user/applications/${encodeURIComponent(String(id))}/approve?version=${encodeURIComponent(API_VERSION)}`,
  ];
  const bodies: Array<Record<string, unknown> | null> = [
    Number.isFinite(acceptedBy) && acceptedBy > 0 ? { acceptedBy } : null,
    null,
  ];
  let lastStatus = 0;
  let lastText = "";
  let saw403 = false;
  let saw403Text = "";
  for (const body of bodies) {
    for (const url of urls) {
      const response = await fetch(url, {
        method: "PUT",
        headers: apiHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.ok) {
        const payload = await response.json();
        if (Array.isArray(payload) && payload.length > 0) return toApplicationRecord(payload[0]);
        return toApplicationRecord(payload);
      }
      const txt = await response.text().catch(() => "");
      lastStatus = response.status;
      lastText = txt;
      if (response.status === 403) {
        saw403 = true;
        saw403Text = txt;
      }
    }
  }

  if (saw403) {
    throw new Error(
      `Approve application failed (403) - CRM denied access for this application under current API user scope.${
        saw403Text ? ` ${saw403Text.slice(0, 180)}` : ""
      }`
    );
  }
  throw new Error(`Approve application failed (${lastStatus || "unknown"}) ${lastText ? `- ${lastText.slice(0, 220)}` : ""}`);
}

export async function declineCrmApplication(
  applicationId: number,
  managerId?: number | null,
  declineReason = "Declined from dashboard alert"
): Promise<ApplicationRecord> {
  requireApiToken();
  const id = Number(applicationId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Invalid application id.");
  }
  const acceptedBy = Number(managerId);

  const response = await fetchWithFallback(
    [
      `/rest/applications/${encodeURIComponent(String(id))}/decline?version=${encodeURIComponent(API_VERSION)}`,
      `/rest/user/applications/${encodeURIComponent(String(id))}/decline?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "PUT",
      headers: apiHeaders(),
      body: JSON.stringify({
        declineReason,
        ...(Number.isFinite(acceptedBy) && acceptedBy > 0 ? { acceptedBy } : {}),
      }),
    }
  );

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Decline application failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload) && payload.length > 0) return toApplicationRecord(payload[0]);
  return toApplicationRecord(payload);
}
