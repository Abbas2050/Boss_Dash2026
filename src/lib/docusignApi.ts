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
  /** `null` when the CRM could not be asked at all — a dash, never a zero. */
  pendingApplicationsCount: number | null;
  system: {
    status: "operational" | "configuration_required" | string;
    hasCoreConfig: boolean;
    oauthEnabled: boolean;
    connectHmacEnabled: boolean;
    latestUpdatedAt: string | null;
    /** False when the server has no CRM credential, so the count above is unknowable. */
    pendingApplicationsConfigured?: boolean;
    pendingApplicationsError?: string | null;
  };
  webhook?: {
    lastReceivedAt: string | null;
    lastOutcome: string | null;
    /** Reason code of the newest row — `placeholder_not_substituted` means a Test webhook press. */
    lastError?: string | null;
    ageHours: number | null;
    stale: boolean;
    rejected7d: number;
    /** Test webhook presses in the last 7 days; excluded from `rejected7d` because they are not faults. */
    placeholderTests7d?: number;
    recent?: Array<{
      receivedAt: string;
      outcome: string;
      error: string | null;
      applicationId: string | null;
      isPlaceholderTest?: boolean;
    }>;
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
