/**
 * This module talks to the same CRM (FXBO) as reports/reportShared.js and the
 * /rest proxy in server.js, so it reads the same variable names they do.
 *
 * It did not, and that was the whole defect. It asked for VITE_API_URL and
 * VITE_API_TOKEN -- server-side code reading VITE_-prefixed names. Those names
 * were deliberately retired from the server environment because Vite compiles
 * anything VITE_-prefixed into the browser bundle, which had put the CRM
 * credential in the shipped JavaScript where any logged-in user could read it.
 * Everything else moved to the unprefixed names; this module was missed, so it
 * threw "VITE_API_URL is required" on every call and the Back Office panel
 * displayed that failure next to a count of 0.
 *
 * The VITE_ names are still accepted as a legacy fallback so a server whose
 * .env has not been migrated keeps working; drop them once production is clean.
 */

// First non-empty value among the given variable names, in preference order.
// Trimming matters: a .env edited on Windows leaves a trailing CR on the value,
// which the CRM rejects with a 403 that says nothing about whitespace.
function envValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

const CRM_DEFAULT_ORIGIN = "https://portal.skylinkscapital.com";

/** The CRM bearer token, or "" when none is configured. Never logged. */
export function getCrmApiToken() {
  return envValue("API_TOKEN", "VITE_API_TOKEN");
}

/**
 * Is this module able to reach the CRM at all?
 *
 * Callers use this to render "not configured" rather than a count. A missing
 * variable is a fact about us; zero pending applications is a fact about the
 * CRM. Showing the first as the second is how the panel came to claim there
 * were no pending applications while it was in fact never asking.
 */
export function isCrmConfigured() {
  return Boolean(getCrmApiToken());
}

export class CrmNotConfiguredError extends Error {
  constructor(message = "CRM API token not configured (API_TOKEN)") {
    super(message);
    this.name = "CrmNotConfiguredError";
    this.code = "crm_not_configured";
  }
}

/**
 * The `/rest` base every endpoint below is hung off.
 *
 * Two shapes arrive here and both must work. REST_PROXY_TARGET is a bare origin
 * (that is how server.js and reportShared.js define it), while the legacy
 * VITE_API_URL was a full path that could already end in /rest or even
 * /rest/transactions. Each previously-handled path shape resolves to exactly the
 * base it always did; only a bare origin -- which never worked, because callers
 * append "/users" -- gains its "/rest".
 */
export function getCrmBaseUrl() {
  const configured = envValue("REST_PROXY_TARGET", "VITE_API_URL") || CRM_DEFAULT_ORIGIN;
  const trimmed = configured.replace(/\/+$/, "");
  if (trimmed.includes("/rest/transactions")) {
    return trimmed.replace(/\/rest\/transactions$/, "/rest");
  }
  if (trimmed.includes("/transactions")) {
    return trimmed.replace(/\/transactions$/, "");
  }
  if (trimmed.endsWith("/rest")) return trimmed;
  // Origin with no path of its own, e.g. "https://portal.skylinkscapital.com".
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(trimmed)) return `${trimmed}/rest`;
  return trimmed;
}

export function authHeaders() {
  const token = getCrmApiToken();
  // The thrown message names the VARIABLE, never the value: this error reaches
  // an HTTP response body and the Back Office panel.
  if (!token) throw new CrmNotConfiguredError();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
}

export function versionQuery() {
  return `version=${encodeURIComponent(envValue("API_VERSION", "VITE_API_VERSION") || "1.0.0")}`;
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

export async function fetchCrmUserByEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) throw new Error("email is required");

  const endpoint = `${getCrmBaseUrl()}/users?${versionQuery()}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email: normalizedEmail,
      segment: { limit: 5, offset: 0 },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`CRM users lookup failed (${resp.status}): ${text}`);
  }

  const rows = await resp.json();
  const list = Array.isArray(rows) ? rows : [];
  const match = list.find((u) => String(u?.email || "").trim().toLowerCase() === normalizedEmail);
  if (!match) return null;

  return {
    id: Number(match.id),
    firstName: String(match.firstName || "").trim(),
    lastName: String(match.lastName || "").trim(),
    email: String(match.email || "").trim().toLowerCase(),
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

    let record;
    if (Array.isArray(json)) {
      record = json.find((entry) => String(entry?.id) === String(applicationId));
    } else {
      record = String(json?.id) === String(applicationId) ? json : null;
    }
    if (!record) continue;

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

export async function createCrmDocument(payload) {
  const endpoint = `${getCrmBaseUrl()}/documents/new?${versionQuery()}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`CRM documents/new failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json();
}
