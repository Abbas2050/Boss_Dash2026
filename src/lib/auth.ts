export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  access: string[];
  status: "active" | "suspended";
  password: string;
}

const USERS_KEY = "slc.users.v1";
const SESSION_KEY = "slc.session.v1";

const DEFAULT_ACCESS = ["Dealing", "Accounts", "Settings", "Backoffice", "HR", "Marketing", "Alerts"];

const seedUsers: AuthUser[] = [
  {
    id: "1",
    name: "Abbas",
    email: "abbas@skylinks.capital",
    role: "Super Admin",
    access: DEFAULT_ACCESS,
    status: "active",
    password: "admin123",
  },
];

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

function ensureSeed() {
  const users = read<AuthUser[]>(USERS_KEY);
  if (!users || users.length === 0) {
    write(USERS_KEY, seedUsers);
  }
}

export function getUsers(): AuthUser[] {
  ensureSeed();
  return read<AuthUser[]>(USERS_KEY) || [];
}

export function upsertUser(next: AuthUser): void {
  const users = getUsers();
  const idx = users.findIndex((u) => u.id === next.id);
  if (idx >= 0) users[idx] = next;
  else users.unshift(next);
  write(USERS_KEY, users);
}

export function deleteUser(id: string): void {
  const users = getUsers().filter((u) => u.id !== id);
  write(USERS_KEY, users);
}

export function setUsers(users: AuthUser[]): void {
  write(USERS_KEY, users);
}

export function authenticate(identity: string, password: string): AuthUser | null {
  const id = identity.trim().toLowerCase();
  const user = getUsers().find(
    (u) =>
      (u.email || "").toLowerCase() === id &&
      u.password === password &&
      u.status === "active"
  );
  return user || null;
}

export function login(identity: string, password: string): AuthUser | null {
  const user = authenticate(identity, password);
  if (!user) return null;
  write(SESSION_KEY, { userId: user.id, at: Date.now() });
  return user;
}

export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function getCurrentUser(): AuthUser | null {
  const session = read<{ userId: string }>(SESSION_KEY);
  if (!session?.userId) return null;
  return getUsers().find((u) => u.id === session.userId && u.status === "active") || null;
}

export function isAuthenticated(): boolean {
  return !!getCurrentUser();
}

export function hasAccess(page: string): boolean {
  const currentUser = getCurrentUser();
  if (!currentUser) return false;
  return currentUser.access.includes(page) || currentUser.role === "Super Admin";
}
