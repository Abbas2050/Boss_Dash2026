function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getCrmBaseUrl() {
  const apiUrl = required("VITE_API_URL");
  const trimmed = String(apiUrl).replace(/\/+$/, "");
  if (trimmed.includes("/rest/transactions")) {
    return trimmed.replace(/\/rest\/transactions$/, "/rest");
  }
  if (trimmed.includes("/transactions")) {
    return trimmed.replace(/\/transactions$/, "");
  }
  if (trimmed.endsWith("/rest")) return trimmed;
  return trimmed;
}

function authHeaders() {
  const token = required("VITE_API_TOKEN");
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function versionQuery() {
  return `version=${encodeURIComponent(process.env.VITE_API_VERSION || "1.0.0")}`;
}

function readFirstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeApplicant(payload) {
  if (!payload || typeof payload !== "object") return null;

  const root = payload;
  const user = root.user && typeof root.user === "object" ? root.user : null;
  const client = root.client && typeof root.client === "object" ? root.client : null;
  const applicant = root.applicant && typeof root.applicant === "object" ? root.applicant : null;

  const userIdValue =
    root.userId ??
    root.clientId ??
    user?.id ??
    client?.id ??
    applicant?.id ??
    null;

  const firstName = readFirstNonEmpty(
    root.firstName,
    user?.firstName,
    client?.firstName,
    applicant?.firstName,
    root.data?.firstName,
    root.data?.personalInfo?.firstName
  );
  const lastName = readFirstNonEmpty(
    root.lastName,
    user?.lastName,
    client?.lastName,
    applicant?.lastName,
    root.data?.lastName,
    root.data?.personalInfo?.lastName
  );
  const email = readFirstNonEmpty(
    root.email,
    user?.email,
    client?.email,
    applicant?.email,
    root.data?.email,
    root.data?.personalInfo?.email,
    root.data?.contactInfo?.email
  ).toLowerCase();

  const userId = Number(userIdValue || 0) || null;
  const fullName = `${firstName} ${lastName}`.trim();

  return {
    userId,
    firstName,
    lastName,
    fullName,
    email,
    raw: payload,
  };
}

export async function fetchCrmUserById(userId) {
  if (!userId) throw new Error("userId is required");

  const endpoint = `${getCrmBaseUrl()}/users?${versionQuery()}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      ids: [Number(userId)],
      segment: { limit: 1, offset: 0 },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`CRM users lookup failed (${resp.status}): ${text}`);
  }

  const rows = await resp.json();
  const user = Array.isArray(rows) ? rows[0] : null;
  if (!user) return null;

  return {
    id: Number(user.id),
    firstName: String(user.firstName || "").trim(),
    lastName: String(user.lastName || "").trim(),
    email: String(user.email || "").trim().toLowerCase(),
  };
}

async function fetchJsonIfOk(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) return null;
  return resp.json();
}

export async function fetchCrmApplicationApplicantById(applicationId) {
  if (!applicationId) throw new Error("applicationId is required");

  const baseUrl = getCrmBaseUrl();
  const id = encodeURIComponent(String(applicationId));
  const query = versionQuery();

  const candidates = [
    {
      url: `${baseUrl}/applications/${id}?${query}`,
      options: { method: "GET", headers: { Accept: "application/json", Authorization: authHeaders().Authorization } },
    },
    {
      url: `${baseUrl}/applications/config/${id}?${query}`,
      options: { method: "GET", headers: { Accept: "application/json", Authorization: authHeaders().Authorization } },
    },
    {
      url: `${baseUrl}/applications?${query}`,
      options: {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ids: [applicationId], segment: { limit: 1, offset: 0 } }),
      },
    },
  ];

  for (const candidate of candidates) {
    const json = await fetchJsonIfOk(candidate.url, candidate.options).catch(() => null);
    if (!json) continue;

    const record = Array.isArray(json) ? json[0] : json;
    const parsed = normalizeApplicant(record);
    if (parsed && (parsed.userId || parsed.email || parsed.fullName)) {
      return parsed;
    }
  }

  return null;
}

export async function fetchCrmApplicationsByType(type = "docusign", query = {}) {
  const endpoint = `${getCrmBaseUrl()}/applications?${versionQuery()}`;

  const payload = {
    type: String(type || "docusign"),
  };

  if (query && typeof query === "object") {
    if (query.user != null) payload.user = query.user;
    if (query.createdAt) payload.createdAt = query.createdAt;
    if (query.processedAt) payload.processedAt = query.processedAt;
    if (query.checkedAt) payload.checkedAt = query.checkedAt;
    if (query.uploadedByClient != null) payload.uploadedByClient = Boolean(query.uploadedByClient);
    if (Array.isArray(query.orders) && query.orders.length > 0) payload.orders = query.orders;
    if (query.segment && typeof query.segment === "object") payload.segment = query.segment;
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`CRM applications lookup failed (${resp.status}): ${text}`);
  }

  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}
