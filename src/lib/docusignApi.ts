import { authHeaders } from "@/lib/auth";

export type DocusignClientItem = {
  applicationId: string;
  name: string;
  email: string;
  status: string;
  updatedAt: string;
  crmUploadStatus?: string;
};

export type DocusignPendingApplicationItem = {
  applicationId: string;
  userId: number | null;
  status: string;
  createdAt: string;
  createdBy: string;
  fullName: string;
};

export type DocusignOverview = {
  ok: boolean;
  summary: { sent: number; pending: number; completed: number; needsAttention?: number };
  pendingClients: DocusignClientItem[];
  completedClients: DocusignClientItem[];
  needsAttentionClients?: DocusignClientItem[];
  pendingApplications: DocusignPendingApplicationItem[];
  pendingApplicationsCount: number;
  system: {
    status: "operational" | "configuration_required" | string;
    hasCoreConfig: boolean;
    oauthEnabled: boolean;
    connectHmacEnabled: boolean;
    latestUpdatedAt: string | null;
    pendingApplicationsError?: string | null;
  };
};

export async function fetchDocusignOverview(): Promise<DocusignOverview> {
  const res = await fetch("/api/docusign/overview", {
    headers: { Accept: "application/json", ...authHeaders() },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Docusign overview API ${res.status}`);
  }

  return res.json();
}

export async function runDocusignSyncNow(): Promise<{ ok: boolean; sent?: number; approved?: number; alreadySent?: number; failed?: number; message?: string }> {
  const res = await fetch("/api/docusign/run-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `run-sync ${res.status}`);
  return data;
}
