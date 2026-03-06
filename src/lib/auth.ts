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
  if (!res.ok) return null;

  const payload = (await res.json()) as { token: string; user: AuthUser };
  if (!payload?.token || !payload?.user) return null;

  setSession({ token: payload.token, user: payload.user, at: Date.now() });
  write(USERS_KEY, [payload.user]);
  return payload.user;
}

export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function getCurrentUser(): AuthUser | null {
  const session = getSession();
  return session?.user || null;
}

export function isAuthenticated(): boolean {
  const session = getSession();
  return Boolean(session?.token && session?.user);
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
