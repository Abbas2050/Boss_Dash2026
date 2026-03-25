export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  access: string[];
  status: "active" | "suspended";
}

export interface AuthUpsertInput {
  id?: string;
  name: string;
  email: string;
  role: string;
  access: string[];
  status: "active" | "suspended";
  password?: string;
}

const USERS_KEY = "slc.users.v2";
const SESSION_KEY = "slc.session.v2";

type SessionPayload = {
  token: string;
  user: AuthUser;
  at: number;
};

type AuthApiError = {
  error?: string;
  message?: string;
};

export type AuthAuditEvent = {
  id: number;
  actorUserId: string | null;
  action: string;
  targetUserId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

function mapLoginErrorMessage(status: number, code?: string): string {
  if (code === "email_password_required") return "Email and password are required.";
  if (code === "invalid_credentials") return "Invalid email or password.";
  if (code === "user_suspended") return "Your account is suspended. Contact an administrator.";
  if (code === "too_many_attempts" || status === 429) return "Too many login attempts. Please wait and try again.";
  if (status === 500) return "Login service is temporarily unavailable. Please try again.";
  return "Login failed. Please try again.";
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getSession(): SessionPayload | null {
  return read<SessionPayload>(SESSION_KEY);
}

function setSession(session: SessionPayload | null) {
  if (!session) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  write(SESSION_KEY, session);
}

function authHeaders(): Record<string, string> {
  const token = getSession()?.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function getTokenExpiryMs(token: string): number | null {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    const decoded = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof decoded?.exp !== "number") return null;
    return decoded.exp * 1000;
  } catch {
    return null;
  }
}

function isSessionExpired(session: SessionPayload | null): boolean {
  if (!session?.token) return true;
  const expiry = getTokenExpiryMs(session.token);
  if (!expiry) return false;
  return Date.now() >= expiry;
}

export function getAuthToken(): string | null {
  return getSession()?.token || null;
}

export function getUsers(): AuthUser[] {
  return read<AuthUser[]>(USERS_KEY) || [];
}

export async function refreshUsers(): Promise<AuthUser[]> {
  const res = await fetch("/api/auth/users", {
    headers: {
      Accept: "application/json",
      ...authHeaders(),
    },
  });
  if (!res.ok) {
    throw new Error(`Users API ${res.status}`);
  }
  const users = (await res.json()) as AuthUser[];
  write(USERS_KEY, users);
  return users;
}

export async function upsertUser(next: AuthUpsertInput): Promise<AuthUser> {
  const isUpdate = Boolean(next.id);
  const endpoint = isUpdate ? `/api/auth/users/${encodeURIComponent(String(next.id))}` : "/api/auth/users";
  const method = isUpdate ? "PUT" : "POST";
  const body = {
    name: next.name,
    email: next.email,
    role: next.role,
    status: next.status,
    access: next.access,
    ...(next.password ? { password: next.password } : {}),
  };

  const res = await fetch(endpoint, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Save user failed (${res.status})`);
  }
  const json = (await res.json()) as { user: AuthUser };
  await refreshUsers().catch(() => undefined);
  return json.user;
}

export async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`/api/auth/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      ...authHeaders(),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Delete user failed (${res.status})`);
  }
  await refreshUsers().catch(() => undefined);
}

export async function login(identity: string, password: string): Promise<AuthUser | null> {
  const email = identity.trim().toLowerCase();
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    let code = "";
    try {
      const json = (await res.json()) as AuthApiError;
      code = String(json?.error || "");
    } catch {
      // Ignore parse issues and fallback to status-based message.
    }
    throw new Error(mapLoginErrorMessage(res.status, code));
  }

  const payload = (await res.json()) as { token: string; user: AuthUser };
  if (!payload?.token || !payload?.user) return null;

  setSession({ token: payload.token, user: payload.user, at: Date.now() });
  write(USERS_KEY, [payload.user]);
  return payload.user;
}

export function logout(): void {
  const headers = authHeaders();
  localStorage.removeItem(SESSION_KEY);
  if (headers.Authorization) {
    fetch("/api/auth/logout", {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...headers,
      },
    }).catch(() => undefined);
  }
}

export function getCurrentUser(): AuthUser | null {
  const session = getSession();
  return session?.user || null;
}

export function isAuthenticated(): boolean {
  const session = getSession();
  if (!session?.token || !session?.user) return false;
  if (isSessionExpired(session)) {
    setSession(null);
    return false;
  }
  return true;
}

export async function syncCurrentSession(): Promise<AuthUser | null> {
  const session = getSession();
  if (!session?.token) return null;
  if (isSessionExpired(session)) {
    setSession(null);
    return null;
  }

  const res = await fetch("/api/auth/me", {
    headers: {
      Accept: "application/json",
      ...authHeaders(),
    },
  });

  if (!res.ok) {
    setSession(null);
    throw new Error(`Session check failed (${res.status})`);
  }

  const payload = (await res.json()) as { user: AuthUser };
  if (!payload?.user) {
    setSession(null);
    return null;
  }

  setSession({ token: session.token, user: payload.user, at: Date.now() });
  return payload.user;
}

export async function fetchAuthAuditEvents(limit = 100): Promise<AuthAuditEvent[]> {
  const q = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const res = await fetch(`/api/auth/audit-events?limit=${q}`, {
    headers: {
      Accept: "application/json",
      ...authHeaders(),
    },
  });
  if (!res.ok) {
    throw new Error(`Audit API ${res.status}`);
  }
  const rows = (await res.json()) as AuthAuditEvent[];
  return Array.isArray(rows) ? rows : [];
}

export function hasAccess(page: string): boolean {
  const currentUser = getCurrentUser();
  if (!currentUser) return false;
  if (currentUser.role === "Super Admin") return true;
  const owned = Array.isArray(currentUser.access) ? currentUser.access : [];
  if (owned.includes(page)) return true;
  const idx = page.indexOf(":");
  if (idx > 0) {
    const prefix = page.slice(0, idx);
    return owned.includes(prefix);
  }
  return false;
}
