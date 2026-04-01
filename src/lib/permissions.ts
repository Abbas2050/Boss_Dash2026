import type { AuthUser } from "@/lib/auth";

export const DEALING_TABS = [
  "Dealing",
  "Risk Exposure",
  "Coverage",
  "Bonus",
  "Metrics",
  "Equity Overview",
  "Contract Sizes",
  "Deal Matching",
  "Clients NOP",
  "Rebate Calculator",
  "Client Profiling",
  "History",
  "Swap Tracker",
] as const;

export const BONUS_SUB_TABS = ["Bonus Coverage", "Bonus Risk", "Bonus PNL", "Bonus Equity"] as const;

export type DealingTab = (typeof DEALING_TABS)[number];

export const DASHBOARD_ROOT_KEY = { key: "Dashboard", label: "Main Dashboard" } as const;

export const DASHBOARD_SECTION_KEYS = [
  { key: "Dashboard:Accounts", label: "Accounts Section" },
  { key: "Dashboard:Dealing", label: "Dealing Section" },
  { key: "Dashboard:Backoffice", label: "Back Office Section" },
  { key: "Dashboard:Marketing", label: "Marketing Section" },
  { key: "Dashboard:HR", label: "HR Section" },
  { key: "Dashboard:Alerts", label: "Alerts Section" },
] as const;

export const DASHBOARD_ACCESS_KEYS = [DASHBOARD_ROOT_KEY, ...DASHBOARD_SECTION_KEYS] as const;

export type DashboardSectionItem = {
  key: string;
  label: string;
  title: string;
};

export const DASHBOARD_SECTION_ITEMS: readonly DashboardSectionItem[] = [
  { key: "Dashboard:Accounts", label: "Accounts", title: "Accounts Section" },
  { key: "Dashboard:Dealing", label: "Dealing", title: "Dealing Section" },
  { key: "Dashboard:Backoffice", label: "Backoffice", title: "Back Office Section" },
  { key: "Dashboard:Marketing", label: "Marketing", title: "Marketing Section" },
  { key: "Dashboard:HR", label: "HR", title: "HR Section" },
  { key: "Dashboard:Alerts", label: "Alerts", title: "Alerts Section" },
] as const;

export const DEPARTMENT_KEYS = [
  { key: "LiveAgent", label: "Live Agent" },
  { key: "Dealing", label: "Dealing Department" },
  { key: "Accounts", label: "Accounts Department" },
  { key: "Backoffice", label: "Back Office Department" },
  { key: "Marketing", label: "Marketing Department" },
  { key: "HR", label: "HR Department" },
  { key: "Settings", label: "Settings" },
  { key: "Alerts", label: "Alerts" },
] as const;

export type DepartmentNavItem = {
  key: string;
  label: string;
  path: string;
  slug: string;
  requiredPermissions: string[];
  scopedPrefix?: string;
};

export const DEPARTMENT_NAV_ITEMS: readonly DepartmentNavItem[] = [
  {
    key: "dealing",
    label: "Dealing",
    path: "/departments/dealing",
    slug: "dealing",
    requiredPermissions: ["Dealing"],
    scopedPrefix: "Dealing",
  },
  {
    key: "backoffice",
    label: "Backoffice",
    path: "/departments/backoffice",
    slug: "backoffice",
    requiredPermissions: ["Backoffice"],
  },
  {
    key: "accounts",
    label: "Accounts",
    path: "/departments/accounts",
    slug: "accounts",
    requiredPermissions: ["Accounts"],
  },
  {
    key: "marketing",
    label: "Marketing",
    path: "/departments/marketing",
    slug: "marketing",
    requiredPermissions: ["Marketing"],
  },
  {
    key: "hr",
    label: "HR",
    path: "/departments/hr",
    slug: "hr",
    requiredPermissions: ["HR"],
  },
] as const;

export const DEALING_TAB_KEYS = DEALING_TABS.map((tab) => ({
  key: `Dealing:${tab}`,
  label: tab,
})).concat(
  BONUS_SUB_TABS.map((tab) => ({
    key: `Dealing:${tab}`,
    label: tab,
  }))
);

export const NOTIFICATION_KEYS = [
  { key: "Notifications:UserChangeAlert", label: "User Change Alert" },
  { key: "Notifications:AccountAlert", label: "Account Risk Alert" },
  { key: "Notifications:PositionMatchTableUpdate", label: "Position Match Update" },
  { key: "Notifications:DealUpdate", label: "Deal Update" },
  { key: "Notifications:PositionUpdate", label: "Position Update" },
  { key: "Notifications:OrderUpdate", label: "Order Update" },
  { key: "Notifications:TransactionAlert", label: "Transaction Alert" },
] as const;

export const ADMIN_ACCESS_KEYS = [
  { key: "Auth:ManageUsers", label: "Manage Users & Roles" },
] as const;

export type SettingsMenuItem = {
  key: string;
  name: string;
  path: string;
  icon: "Workflow" | "Briefcase" | "Link2" | "Bell" | "ShieldCheck" | "Users";
  group: "core" | "admin";
  requiredPermissions: string[];
};

export const SETTINGS_MENU_ITEMS = [
  { key: "coverage", name: "Coverage", path: "/settings/coverage", icon: "Workflow", group: "core", requiredPermissions: ["Settings"] },
  { key: "lp-manager", name: "LP Manager", path: "/settings/lp-manager", icon: "Briefcase", group: "core", requiredPermissions: ["Settings"] },
  { key: "internal-accounts", name: "Internal Accounts", path: "/settings/internal-accounts", icon: "Briefcase", group: "core", requiredPermissions: ["Settings"] },
  { key: "symbol-mapping", name: "Symbol Mapping", path: "/settings/symbol-mapping", icon: "Link2", group: "core", requiredPermissions: ["Settings"] },
  { key: "alerts", name: "Alerts", path: "/settings/alerts", icon: "Bell", group: "core", requiredPermissions: ["Settings"] },
  { key: "ws-test", name: "WS Test", path: "/settings/ws-test", icon: "ShieldCheck", group: "core", requiredPermissions: ["Settings"] },
  {
    key: "user-management",
    name: "User Management",
    path: "/settings/user-management",
    icon: "Users",
    group: "admin",
    requiredPermissions: ["Settings", "Auth:ManageUsers"],
  },
] as const satisfies readonly SettingsMenuItem[];

export const SETTINGS_MENU_CORE = SETTINGS_MENU_ITEMS.filter((item) => item.group === "core");
export const SETTINGS_MENU_ADMIN = SETTINGS_MENU_ITEMS.filter((item) => item.group === "admin");

export type UserRoleTemplate = "Super Admin" | "Manager" | "Analyst" | "Support";

export const LEGACY_ROUTE_ALIASES = [
  { path: "coverage.html", to: "/departments/dealing" },
  { path: "risk-exposure.html", to: "/departments/dealing" },
  { path: "metrics.html", to: "/departments/dealing" },
  { path: "equity-overview.html", to: "/departments/dealing" },
  { path: "internal-accounts.html", to: "/settings/internal-accounts" },
  { path: "contract-sizes.html", to: "/departments/dealing" },
  { path: "history.html", to: "/departments/dealing" },
  { path: "transactions.html", to: "/departments/dealing" },
  { path: "swap-tracker.html", to: "/departments/dealing" },
  { path: "clients-nop%201.html", to: "/departments/dealing" },
  { path: "clients-nop 1.html", to: "/departments/dealing" },
  { path: "bonus-coverage.html", to: "/departments/dealing" },
  { path: "bonus-risk.html", to: "/departments/dealing" },
  { path: "bonus-pnl.html", to: "/departments/dealing" },
  { path: "bonus-equity.html", to: "/departments/dealing" },
  { path: "account-alerts.html", to: "/settings/alerts" },
] as const;

function uniqueKeys(keys: readonly string[]) {
  return Array.from(new Set(keys));
}

function rootPrefixes(keys: readonly { key: string }[]) {
  return uniqueKeys(keys.map((item) => item.key.split(":")[0]).filter(Boolean));
}

export const USER_ROLE_TEMPLATES: Record<UserRoleTemplate, string[]> = {
  "Super Admin": uniqueKeys([
    ...DASHBOARD_ACCESS_KEYS.map((item) => item.key),
    ...DEPARTMENT_KEYS.map((item) => item.key),
    ...DEALING_TAB_KEYS.map((item) => item.key),
    ...NOTIFICATION_KEYS.map((item) => item.key),
    ...ADMIN_ACCESS_KEYS.map((item) => item.key),
  ]),
  Manager: uniqueKeys([
    DASHBOARD_ROOT_KEY.key,
    ...DEPARTMENT_KEYS
      .filter((item) => item.key !== "LiveAgent")
      .map((item) => item.key),
    ...rootPrefixes(NOTIFICATION_KEYS),
  ]),
  Analyst: uniqueKeys([
    DASHBOARD_ROOT_KEY.key,
    ...DEPARTMENT_KEYS
      .filter((item) => ["Dealing", "Accounts", "Backoffice", "Alerts"].includes(item.key))
      .map((item) => item.key),
  ]),
  Support: uniqueKeys([
    DASHBOARD_ROOT_KEY.key,
    ...DEPARTMENT_KEYS
      .filter((item) => ["Accounts", "Alerts"].includes(item.key))
      .map((item) => item.key),
  ]),
};

export function hasUserAccess(user: AuthUser | null | undefined, permission: string): boolean {
  if (!user) return false;
  if (user.role === "Super Admin") return true;
  const owned = Array.isArray(user.access) ? user.access : [];
  if (owned.includes(permission)) return true;
  const idx = permission.indexOf(":");
  if (idx > 0) {
    const prefix = permission.slice(0, idx);
    if (owned.includes(prefix)) return true;
  }
  return false;
}

function hasAnyScopedAccess(user: AuthUser | null | undefined, prefix: string): boolean {
  if (!user) return false;
  if (user.role === "Super Admin") return true;
  const owned = Array.isArray(user.access) ? user.access : [];
  return owned.some((p) => p.startsWith(`${prefix}:`));
}

export function getDefaultRouteForUser(user: AuthUser | null | undefined): string {
  if (!user) return "/login";
  if (hasUserAccess(user, "Dashboard")) return "/";
  const firstDepartment = getVisibleDepartmentItems(user)[0];
  if (firstDepartment) return firstDepartment.path;
  const firstSettingsItem = getVisibleSettingsMenuItems(user)[0];
  if (firstSettingsItem) return firstSettingsItem.path;
  return "/login";
}

export function canAccessAll(user: AuthUser | null | undefined, permissions: readonly string[]): boolean {
  return permissions.every((permission) => hasUserAccess(user, permission));
}

export function canAccessDepartmentItem(user: AuthUser | null | undefined, item: DepartmentNavItem): boolean {
  if (canAccessAll(user, item.requiredPermissions)) return true;
  if (item.scopedPrefix) return hasAnyScopedAccess(user, item.scopedPrefix);
  return false;
}

export function getVisibleDepartmentItems(user: AuthUser | null | undefined) {
  return DEPARTMENT_NAV_ITEMS.filter((item) => canAccessDepartmentItem(user, item));
}

export function getDepartmentItemBySlug(slug: string | null | undefined) {
  const normalized = String(slug || "").trim().toLowerCase();
  return DEPARTMENT_NAV_ITEMS.find((item) => item.slug === normalized) || null;
}

export function getVisibleSettingsMenuItems(user: AuthUser | null | undefined) {
  return SETTINGS_MENU_ITEMS.filter((item) => canAccessAll(user, item.requiredPermissions));
}

export function getVisibleDashboardSectionItems(user: AuthUser | null | undefined) {
  return DASHBOARD_SECTION_ITEMS.filter((item) => hasUserAccess(user, item.key));
}
