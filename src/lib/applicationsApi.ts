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
  data?: Record<string, unknown>;
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
  processedByRaw?: string;
  data?: Record<string, unknown> | null;
  sections: string[];
  description?: string;
  comment?: string;
  idNumber?: string;
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
const CRM_PATH_PREFIXES = ["/api", ""];
const APPROVER_RULES: Record<number, number> = {
  61: 4,  // Change Entity -> Daniel
  62: 11, // Create Account Type -> Elias
  63: 4,  // Create New IB Structure -> Daniel
  64: 11, // Change IB -> Elias
  65: 11, // Change Account Type -> Elias
  66: 4,  // Change IB Commission -> Daniel
  67: 11, // Change Leverage -> Elias
};
const FINAL_APPROVER_RULES: Record<number, number> = {
  61: 7,  // Change Entity -> Backoffice
  62: 7,  // Create Account Type -> Backoffice
  63: 3,  // Create New IB Structure -> Abbas
  64: 7,  // Change IB -> Backoffice
  65: 7,  // Change Account Type -> Backoffice
  66: 3,  // Change IB Commission -> Abbas
  67: 3,  // Change Leverage -> Abbas
};

const MANAGER_ID_TO_NAME: Record<number, string> = {
  3: "Abbas",
  4: "Daniel",
  7: "Backoffice",
  11: "Elias",
  24: "Dealing",
};

export type ApproverRouting = {
  firstApproverId: number;
  finalApproverId: number;
};

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
  for (const rawPath of paths) {
    for (const prefix of CRM_PATH_PREFIXES) {
      const path = `${prefix}${rawPath}`;
      const response = await fetch(path, init);
      if (response.ok) return response;
      if (response.status !== 404) return response;
      lastResponse = response;
    }
  }
  return lastResponse as Response;
}

function inferConfigIdFromType(rawType: unknown): number {
  const t = String(rawType || "").trim().toLowerCase();
  if (!t) return 0;
  if (t.includes("change entity")) return 61;
  if (t.includes("create account type")) return 62;
  if (t.includes("create new ib structure")) return 63;
  if (t === "change ib" || t.includes("change ib ")) return 64;
  if (t.includes("change account type")) return 65;
  if (t.includes("change ib commission")) return 66;
  if (t.includes("change leverage")) return 67;
  return 0;
}

function resolveConfigId(raw: any): number {
  const candidate = Number(
    raw?.configId
      ?? raw?.configID
      ?? raw?.config_id
      ?? raw?.documentConfigId
      ?? raw?.document_config_id
      ?? raw?.config?.id
      ?? raw?.documentConfig?.id
      ?? raw?.config
      ?? 0
  );
  if (Number.isFinite(candidate) && candidate > 0) return candidate;
  const byType = inferConfigIdFromType(raw?.type ?? raw?.title);
  return Number.isFinite(byType) && byType > 0 ? byType : 0;
}

type ApprovalAuditEntry = {
  stage: string;
  status: string;
  managerId: number | null;
  email: string;
  at: string;
  actionKey?: string;
};

type ApprovalRouteEntry = {
  firstApproverId: number | null;
  finalApproverId: number | null;
  updatedByEmail: string;
  reason: string;
  at: string;
};

function parseLatestRouteOverride(comment: string): ApprovalRouteEntry | null {
  const lines = String(comment || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("APPROVAL_ROUTE|")) continue;
    const tokens = line.split("|").slice(1);
    const bag: Record<string, string> = {};
    for (const token of tokens) {
      const idx = token.indexOf("=");
      if (idx <= 0) continue;
      const key = token.slice(0, idx).trim();
      const value = token.slice(idx + 1).trim();
      if (!key) continue;
      bag[key] = value;
    }
    const first = Number(bag.firstApproverId || 0);
    const final = Number(bag.finalApproverId || 0);
    return {
      firstApproverId: Number.isFinite(first) && first > 0 ? first : null,
      finalApproverId: Number.isFinite(final) && final > 0 ? final : null,
      updatedByEmail: String(bag.updatedByEmail || "").trim().toLowerCase(),
      reason: String(bag.reason || "").trim(),
      at: String(bag.at || "").trim(),
    };
  }
  return null;
}

function appendRouteOverrideComment(existingComment: string, entry: ApprovalRouteEntry): string {
  const line = [
    "APPROVAL_ROUTE",
    `firstApproverId=${entry.firstApproverId ?? ""}`,
    `finalApproverId=${entry.finalApproverId ?? ""}`,
    `updatedByEmail=${entry.updatedByEmail}`,
    `reason=${entry.reason.replace(/\|/g, "/")}`,
    `at=${entry.at}`,
  ].join("|");
  const base = String(existingComment || "").trim();
  return base ? `${base}\n${line}` : line;
}

function parseIdNumberRouting(idNumber: string): { firstApproverId: number; finalApproverId: number } | null {
  const s = String(idNumber || "").trim();
  if (!s) return null;
  const parts = s.split("-");
  if (parts.length < 2) return null;
  const first = Number(parts[0]);
  const final = Number(parts[1]);
  if (!Number.isFinite(first) || first <= 0 || !Number.isFinite(final) || final <= 0) return null;
  return { firstApproverId: first, finalApproverId: final };
}

function resolveApproverRouting(configId: number, comment?: string, idNumber?: string): ApproverRouting {
  const defaultFirst = APPROVER_RULES[Number(configId)] || 0;
  const defaultFinal = FINAL_APPROVER_RULES[Number(configId)] || 0;
  // idNumber takes priority (format: firstId-finalId), then comment override, then defaults.
  const idRouting = parseIdNumberRouting(String(idNumber || ""));
  if (idRouting) return idRouting;
  const override = parseLatestRouteOverride(String(comment || ""));
  return {
    firstApproverId: Number(override?.firstApproverId) > 0 ? Number(override?.firstApproverId) : defaultFirst,
    finalApproverId: Number(override?.finalApproverId) > 0 ? Number(override?.finalApproverId) : defaultFinal,
  };
}

export function getApproverRoutingForRecord(row: Pick<ApplicationRecord, "configId" | "comment" | "idNumber">): ApproverRouting {
  return resolveApproverRouting(Number(row?.configId || 0), String(row?.comment || ""), String(row?.idNumber || ""));
}

function parseLatestApprovalAudit(comment: string): ApprovalAuditEntry | null {
  const lines = String(comment || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("APPROVAL_AUDIT|")) continue;
    const tokens = line.split("|").slice(1);
    const bag: Record<string, string> = {};
    for (const token of tokens) {
      const idx = token.indexOf("=");
      if (idx <= 0) continue;
      const key = token.slice(0, idx).trim();
      const value = token.slice(idx + 1).trim();
      if (!key) continue;
      bag[key] = value;
    }
    // Support both old long keys (managerId/status/email/actionKey) and new short keys (mid/st/em/ak).
    const managerId = Number(bag.managerId || bag.mid || 0);
    return {
      stage: String(bag.stage || "").trim().toLowerCase(),
      status: String(bag.status || bag.st || "").trim().toLowerCase(),
      managerId: Number.isFinite(managerId) && managerId > 0 ? managerId : null,
      email: String(bag.email || bag.em || "").trim().toLowerCase(),
      at: String(bag.at || "").trim(),
    };
  }
  return null;
}

function appendApprovalAuditComment(existingComment: string, entry: ApprovalAuditEntry): string {
  const base = String(existingComment || "").trim();
  const actionKey = String(entry.actionKey || "").trim();
  if (actionKey && (base.includes(`ak=${actionKey}`) || base.includes(`actionKey=${actionKey}`))) {
    return base;
  }
  // Get manager name from ID if available.
  const managerName = entry.managerId ? (MANAGER_ID_TO_NAME[entry.managerId] || "") : "";
  const line = [
    "APPROVAL_AUDIT",
    `stage=${entry.stage}`,
    `st=${entry.status}`,
    `mid=${entry.managerId ?? ""}`,
    `nm=${managerName}`,
    `em=${entry.email}`,
    `ak=${actionKey}`,
    `at=${entry.at}`,
  ].join("|");
  let result = base ? `${base}\n${line}` : line;
  // Trim from the front if over 255 chars (CRM field limit).
  if (result.length > 255) {
    const parts = result.split("\n");
    while (result.length > 255 && parts.length > 1) {
      parts.shift();
      result = parts.join("\n");
    }
    // Last resort: hard truncate keeping the tail.
    if (result.length > 255) result = result.slice(-255);
  }
  return result;
}

function normalizeDocStatus(raw: unknown): string {
  return String(raw || "").trim().toLowerCase();
}

function deriveDocAcceptedBy(doc: any): number {
  const acceptedByDirect = Number(doc?.acceptedBy ?? 0);
  if (Number.isFinite(acceptedByDirect) && acceptedByDirect > 0) return acceptedByDirect;
  const processedByRaw = String(doc?.processedBy ?? "").trim();
  const processedByDigits = Number((processedByRaw.match(/\d+/)?.[0] || ""));
  if (Number.isFinite(processedByDigits) && processedByDigits > 0) return processedByDigits;
  const latestAudit = parseLatestApprovalAudit(String(doc?.comment || "").trim());
  const fromAudit = Number(latestAudit?.managerId || 0);
  return Number.isFinite(fromAudit) && fromAudit > 0 ? fromAudit : 0;
}

function deriveDocWorkflowStatus(doc: any): string {
  const status = String(doc?.status || "").trim().toLowerCase();
  // CRM can store: "Approved", "Approved by manager", "Declined", "pending", etc.
  if (status === "approved by manager") return "approved by manager";
  if (status === "approved") return "approved";
  if (status === "declined" || status === "rejected") return "declined";
  if (status === "pending") return "pending";
  if (status === "expired") return "expired";
  if (status === "deleted") return "deleted";
  return status;
}

function inferApprovalStage(configId: number, managerId: number | null, statusRaw: string, comment?: string, idNumber?: string): string {
  const status = String(statusRaw || "").trim().toLowerCase();
  const routing = resolveApproverRouting(configId, comment, idNumber);
  const approverOwner = routing.firstApproverId;
  const finalOwner = routing.finalApproverId;
  if (status === "approved by manager") return "manager";
  if (status === "approved") {
    if (finalOwner > 0 && Number(managerId) === finalOwner) return "final";
    if (approverOwner > 0 && Number(managerId) === approverOwner) return "manager";
    return "final";
  }
  if (status === "declined" || status === "rejected") return finalOwner > 0 && Number(managerId) === finalOwner ? "final" : "manager";
  return "system";
}

function toApplicationRecord(raw: any): ApplicationRecord {
  const userId = Number(raw?.userId ?? raw?.user);
  const processedByRawDirect = String(raw?.processedBy ?? raw?.acceptedBy ?? "").trim();
  const acceptedByDirect = Number(raw?.acceptedBy ?? 0);
  const processedByDigits = Number((processedByRawDirect.match(/\d+/)?.[0] || ""));
  const configId = resolveConfigId(raw);
  const data = raw?.data && typeof raw.data === "object" ? raw.data : null;
  const description = String(raw?.description || "").trim();
  const comment = String(raw?.comment || "").trim();
  const latestAudit = parseLatestApprovalAudit(comment);
  const processingAudit = latestAudit && latestAudit.stage !== "created" ? latestAudit : null;
  const acceptedBy = Number.isFinite(acceptedByDirect) && acceptedByDirect > 0
    ? acceptedByDirect
    : (Number.isFinite(processedByDigits) && processedByDigits > 0
      ? processedByDigits
      : (Number(processingAudit?.managerId) > 0 ? Number(processingAudit?.managerId) : 0));
  const processedByRaw = processedByRawDirect
    || (processingAudit?.email ? processingAudit.email : "")
    || (Number(acceptedBy) > 0 ? String(acceptedBy) : "");
  const dataCreatedBy =
    data && typeof (data as Record<string, unknown>)["createdBy"] === "string"
      ? String((data as Record<string, unknown>)["createdBy"]).trim()
      : "";
  const extractEmail = (text: string): string => {
    if (!text) return "";
    const explicit = text.match(/created\s*by\s*:\s*([^\s]+@[^\s]+)/i);
    if (explicit?.[1]) return String(explicit[1]).trim();
    const plain = text.match(/^[^\s]+@[^\s]+$/i);
    if (plain?.[0]) return String(plain[0]).trim();
    const any = text.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
    return any?.[1] ? String(any[1]).trim() : "";
  };
  const descriptionCreatedBy = (() => {
    return extractEmail(description) || extractEmail(comment);
  })();
  return {
    id: Number(raw?.id || 0),
    configId: Number.isFinite(configId) ? configId : 0,
    type: String(raw?.type || raw?.title || ""),
    status: String(raw?.status || "-"),
    userId: Number.isFinite(userId) && userId > 0 ? userId : null,
    acceptedBy: Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : null,
    processedByRaw: processedByRaw || null,
    data,
    sections: Array.isArray(raw?.sections) ? raw.sections.map((v: unknown) => String(v ?? "")) : [],
    description,
    comment,
    idNumber: String(raw?.idNumber || ""),
    createdAt: String(raw?.createdAt || ""),
    createdBy: String(raw?.createdBy || dataCreatedBy || descriptionCreatedBy || ""),
    processedAt: String(raw?.processedAt || processingAudit?.at || ""),
    processedBy: String(raw?.processedBy || processingAudit?.email || (Number(acceptedBy) > 0 ? String(acceptedBy) : "")),
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
  const dataPayload: Record<string, unknown> = input.data ?? {};
  const createdByEmail = String(input.createdBy || "").trim().toLowerCase();
  const configId = Number(input.configId);
  const firstApproverId = APPROVER_RULES[configId] || 0;
  const finalApproverId = FINAL_APPROVER_RULES[configId] || 0;
  const idNumber = Number.isFinite(firstApproverId) && Number.isFinite(finalApproverId) && firstApproverId > 0 && finalApproverId > 0
    ? `${firstApproverId}-${finalApproverId}`
    : "";
  const creationAudit = appendApprovalAuditComment("", {
    stage: "created",
    status: "pending",
    managerId: null,
    email: createdByEmail,
    at: new Date().toISOString(),
  });

  const response = await fetchWithFallback(
    [
      `/rest/documents/new?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        user: input.user,
        config: input.configId,
        status: "pending",
        description: `Created by: ${createdByEmail}`,
        comment: creationAudit,
        idNumber,
        data: dataPayload,
        isUploadedByClient: Boolean(input.uploadedByClient),
      }),
    }
  );

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Create document failed (${response.status}) ${txt ? `- ${txt.slice(0, 800)}` : ""}`);
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
      `/rest/documents/config/${encodeURIComponent(String(configId))}?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "GET",
      headers: apiHeaders(),
    }
  );

  if (response.ok) {
    const payload = await response.json();
    return toApplicationConfigDefinition(payload);
  }

  // Some CRM environments don't expose /config/{id} but do expose /configs.
  const listResponse = await fetchWithFallback(
    [
      `/rest/documents/configs?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "GET",
      headers: apiHeaders(),
    }
  );

  if (!listResponse.ok) {
    const txt = await listResponse.text().catch(() => "");
    throw new Error(`Load document config failed (${listResponse.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const configs = await listResponse.json();
  if (Array.isArray(configs)) {
    const exact = configs.find((cfg: any) => Number(cfg?.id) === Number(configId));
    if (exact) return toApplicationConfigDefinition(exact);
  }

  throw new Error(`Load document config failed (404) - Config ${configId} not found in /rest/documents/configs`);
}

async function postApplicationsSearch(body: Record<string, unknown>): Promise<ApplicationRecord[]> {
  requireApiToken();
  const response = await fetchWithFallback(
    [
      `/rest/documents?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Load documents failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
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
    configIds: [61, 62, 63, 64, 65, 66, 67],
    segment: { limit, offset },
    orders: [{ field: "createdAt", direction: "DESC" }],
  };
  if (Number.isFinite(Number(input?.userId)) && Number(input?.userId) > 0) {
    payload.userIds = [Number(input?.userId)];
  }
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
  const targetLimit = Math.max(1, Math.min(200, Number(input?.limit) || 20));
  const targetOffset = Math.max(0, Number(input?.offset) || 0);

  const matchesActor = (row: ApplicationRecord): boolean => {
    const createdBy = String(row.createdBy || "").trim().toLowerCase();
    const processedBy = String(row.processedBy || "").trim().toLowerCase();
    const processedByRaw = String(row.processedByRaw || "").trim().toLowerCase();
    const status = String(row.status || "").trim().toLowerCase();
    const acceptedBy = Number(row.acceptedBy || 0);
    const matchesEmail = actorEmail ? createdBy === actorEmail || processedBy === actorEmail : false;
    const matchesUser = Number.isFinite(userId) && userId > 0 ? row.userId === userId : false;
    const matchesAcceptedBy = Number.isFinite(managerId) && managerId > 0
      ? Number(row.acceptedBy) === managerId
      : false;
    const processedByDigits = Number((processedBy.match(/\d+/)?.[0] || ""));
    const processedByRawDigits = Number((processedByRaw.match(/\d+/)?.[0] || ""));
    const matchesManager = Number.isFinite(managerId) && managerId > 0
      ? processedBy === String(managerId)
        || processedByDigits === managerId
        || processedByRaw === String(managerId)
        || processedByRawDigits === managerId
      : false;
    const routing = getApproverRoutingForRecord(row);
    const finalOwner = routing.finalApproverId;
    if (managerId > 0 && finalOwner === managerId) {
      // Final approver recent list should only contain records finally approved by that final approver.
      const finalApproved = status === "approved";
      const approvedByFinalOwner = (Number.isFinite(acceptedBy) && acceptedBy === managerId)
        || processedBy === String(managerId)
        || processedByRaw === String(managerId)
        || processedByDigits === managerId
        || processedByRawDigits === managerId;
      return finalApproved && approvedByFinalOwner;
    }
    const matchesApproverScope = Number.isFinite(managerId) && managerId > 0
      ? (routing.firstApproverId === managerId || routing.finalApproverId === managerId)
      : false;
    return matchesEmail || matchesUser || matchesAcceptedBy || matchesManager || matchesApproverScope;
  };

  const batchSize = 200;
  const maxPages = 10;
  const matches: ApplicationRecord[] = [];
  const seen = new Set<number>();

  for (let page = 0; page < maxPages; page += 1) {
    const rows = await listCrmApplicationsPage({
      limit: batchSize,
      offset: page * batchSize,
    });
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      const id = Number(row.id);
      if (Number.isFinite(id) && id > 0) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      if (matchesActor(row)) matches.push(row);
    }

    if (rows.length < batchSize) break;
    if (matches.length >= targetOffset + targetLimit) break;
  }

  return matches.slice(targetOffset, targetOffset + targetLimit);
}

export async function approveCrmApplication(applicationId: number, managerId?: number | null): Promise<ApplicationRecord> {
  requireApiToken();
  const id = Number(applicationId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Invalid application id.");
  }
  const acceptedBy = Number(managerId);
  const current = await fetchWithFallback(
    [
      `/rest/documents/${encodeURIComponent(String(id))}?version=${encodeURIComponent(API_VERSION)}`,
    ],
    { method: "GET", headers: apiHeaders() },
  );
  if (!current.ok) {
    const txt = await current.text().catch(() => "");
    throw new Error(`Approve document prefetch failed (${current.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }
  const doc = await current.json();
  const user = Number(doc?.userId ?? doc?.user);
  const config = Number(doc?.configId ?? doc?.config);
  const actorEmail = getCurrentActorEmail();
  const existingComment = String(doc?.comment || "").trim();
  const existingIdNumber = String(doc?.idNumber || "").trim();
  const actionKey = `${id}:approved:${Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : 0}:${actorEmail}`;
  const nextComment = appendApprovalAuditComment(existingComment, {
    stage: inferApprovalStage(config, Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : null, "approved", existingComment, existingIdNumber),
    status: "approved",
    managerId: Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : null,
    email: actorEmail,
    actionKey,
    at: new Date().toISOString(),
  });
  const response = await fetchWithFallback(
    [
      `/rest/documents/update?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        id,
        user,
        config,
        status: "approved",
        processedBy: Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : undefined,
        processedAt: doc?.processedAt ?? undefined,
        declineReason: doc?.declineReason ?? undefined,
        description: doc?.description ?? undefined,
        comment: nextComment,
        idNumber: doc?.idNumber ?? undefined,
        data: doc?.data && typeof doc.data === "object" ? doc.data : {},
      }),
    },
  );
  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Approve document failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }
  const payload = await response.json();
  return toApplicationRecord(payload);
}

export async function updateCrmApplicationStatus(
  applicationId: number,
  status: string,
  managerId?: number | null,
): Promise<ApplicationRecord> {
  requireApiToken();
  const id = Number(applicationId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid application id.");
  const nextStatusRaw = String(status || "").trim();
  if (!nextStatusRaw) throw new Error("Status is required.");
  
  // CRM accepts: "approved", "Approved by manager", "declined", "pending", "expired", "deleted"
  // We pass it as-is, but validate the type for business logic
  const normalized = nextStatusRaw.toLowerCase();
  const isApprovedLike = normalized === "approved by manager" || normalized === "approved";
  const isDeclined = normalized === "declined" || normalized === "rejected";
  
  // For business logic validation, treat "Approved by manager" and "approved" the same
  const validationStatus = isApprovedLike ? "approved" : isDeclined ? "declined" : normalized;

  const acceptedBy = Number(managerId);
  const current = await fetchWithFallback(
    [
      `/rest/documents/${encodeURIComponent(String(id))}?version=${encodeURIComponent(API_VERSION)}`,
    ],
    { method: "GET", headers: apiHeaders() },
  );
  if (!current.ok) {
    const txt = await current.text().catch(() => "");
    throw new Error(`Update document prefetch failed (${current.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }
  const doc = await current.json();
  const currentWorkflow = deriveDocWorkflowStatus(doc);
  if (isApprovedLike) {
    // Already fully approved - skip (but "Approved by manager" → "approved" is a valid upgrade, don't skip)
    if (currentWorkflow === "approved" && normalized === "approved") {
      return toApplicationRecord(doc);
    }
    // Already at the same "Approved by manager" stage - skip
    if (currentWorkflow === "approved by manager" && normalized === "approved by manager") {
      return toApplicationRecord(doc);
    }
    if (currentWorkflow === "declined" || currentWorkflow === "rejected") {
      throw new Error("This application was already declined and cannot be approved.");
    }
  }
  if (isDeclined) {
    if (currentWorkflow === "declined" || currentWorkflow === "rejected") {
      return toApplicationRecord(doc);
    }
    if (currentWorkflow === "approved" || currentWorkflow === "approved by manager") {
      throw new Error("This application was already approved and cannot be declined.");
    }
  }
  const user = Number(doc?.userId ?? doc?.user);
  const config = Number(doc?.configId ?? doc?.config);
  const actorEmail = getCurrentActorEmail();
  const existingComment = String(doc?.comment || "").trim();
  const existingIdNumber = String(doc?.idNumber || "").trim();
  const actionKey = `${id}:${nextStatusRaw}:${Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : 0}:${actorEmail}`;
  const nextComment = appendApprovalAuditComment(existingComment, {
    stage: inferApprovalStage(config, Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : null, nextStatusRaw, existingComment, existingIdNumber),
    status: normalized,
    managerId: Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : null,
    email: actorEmail,
    actionKey,
    at: new Date().toISOString(),
  });
  const response = await fetchWithFallback(
    [
      `/rest/documents/update?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        id,
        user,
        config,
        status: nextStatusRaw,
        processedBy: Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : undefined,
        processedAt: doc?.processedAt ?? undefined,
        declineReason: doc?.declineReason ?? undefined,
        description: doc?.description ?? undefined,
        comment: nextComment,
        idNumber: doc?.idNumber ?? undefined,
        data: doc?.data && typeof doc.data === "object" ? doc.data : {},
      }),
    },
  );
  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Update document status failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }
  const data = await response.json();
  if (Array.isArray(data) && data.length > 0) return toApplicationRecord(data[0]);
  return toApplicationRecord(data);
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

  const current = await fetchWithFallback(
    [
      `/rest/documents/${encodeURIComponent(String(id))}?version=${encodeURIComponent(API_VERSION)}`,
    ],
    { method: "GET", headers: apiHeaders() },
  );
  if (!current.ok) {
    const txt = await current.text().catch(() => "");
    throw new Error(`Decline document prefetch failed (${current.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }
  const doc = await current.json();
  const currentWorkflow = deriveDocWorkflowStatus(doc);
  if (currentWorkflow === "declined" || currentWorkflow === "rejected") {
    return toApplicationRecord(doc);
  }
  if (currentWorkflow === "approved") {
    throw new Error("This application was already approved and cannot be declined.");
  }
  const user = Number(doc?.userId ?? doc?.user);
  const config = Number(doc?.configId ?? doc?.config);
  const actorEmail = getCurrentActorEmail();
  const existingComment = String(doc?.comment || "").trim();
  const existingIdNumber = String(doc?.idNumber || "").trim();
  const actionKey = `${id}:declined:${Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : 0}:${actorEmail}`;
  const nextComment = appendApprovalAuditComment(existingComment, {
    stage: inferApprovalStage(config, Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : null, "declined", existingComment, existingIdNumber),
    status: "declined",
    managerId: Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : null,
    email: actorEmail,
    actionKey,
    at: new Date().toISOString(),
  });
  const response = await fetchWithFallback(
    [
      `/rest/documents/update?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        id,
        user,
        config,
        status: "declined",
        declineReason,
        processedBy: Number.isFinite(acceptedBy) && acceptedBy > 0 ? acceptedBy : undefined,
        processedAt: doc?.processedAt ?? undefined,
        description: doc?.description ?? undefined,
        comment: nextComment,
        idNumber: doc?.idNumber ?? undefined,
        data: doc?.data && typeof doc.data === "object" ? doc.data : {},
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

export async function updateCrmApplicationRouting(input: {
  applicationId: number;
  firstApproverId: number;
  finalApproverId: number;
  reason: string;
}): Promise<ApplicationRecord> {
  requireApiToken();
  const id = Number(input.applicationId);
  const firstApproverId = Number(input.firstApproverId);
  const finalApproverId = Number(input.finalApproverId);
  const reason = String(input.reason || "").trim();
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid application id.");
  if (!Number.isFinite(firstApproverId) || firstApproverId <= 0) throw new Error("Invalid first approver.");
  if (!Number.isFinite(finalApproverId) || finalApproverId <= 0) throw new Error("Invalid final approver.");
  if (!reason) throw new Error("Reason is required.");

  const current = await fetchWithFallback(
    [
      `/rest/documents/${encodeURIComponent(String(id))}?version=${encodeURIComponent(API_VERSION)}`,
    ],
    { method: "GET", headers: apiHeaders() },
  );
  if (!current.ok) {
    const txt = await current.text().catch(() => "");
    throw new Error(`Routing prefetch failed (${current.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const doc = await current.json();
  const user = Number(doc?.userId ?? doc?.user);
  const config = Number(doc?.configId ?? doc?.config);
  // Preserve all existing fields; only update idNumber for the routing.
  const idNumber = `${firstApproverId}-${finalApproverId}`;
  const response = await fetchWithFallback(
    [
      `/rest/documents/update?version=${encodeURIComponent(API_VERSION)}`,
    ],
    {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        id,
        user,
        config,
        status: normalizeDocStatus(doc?.status) || "pending",
        processedBy: doc?.processedBy ?? undefined,
        processedAt: doc?.processedAt ?? undefined,
        declineReason: doc?.declineReason ?? undefined,
        description: doc?.description ?? undefined,
        comment: doc?.comment ?? undefined,
        idNumber,
        data: doc?.data && typeof doc.data === "object" ? doc.data : {},
      }),
    }
  );

  if (!response.ok) {
    const txt = await response.text().catch(() => "");
    throw new Error(`Update routing failed (${response.status}) ${txt ? `- ${txt.slice(0, 220)}` : ""}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload) && payload.length > 0) return toApplicationRecord(payload[0]);
  return toApplicationRecord(payload);
}
