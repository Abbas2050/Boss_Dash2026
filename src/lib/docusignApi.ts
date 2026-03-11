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
  summary: {
    sent: number;
    pending: number;
    completed: number;
  };
  pendingClients: DocusignClientItem[];
  completedClients: DocusignClientItem[];
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
    headers: {
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Docusign overview API ${res.status}`);
  }

  return res.json();
}
