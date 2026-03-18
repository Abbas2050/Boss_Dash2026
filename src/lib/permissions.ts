import type { AuthUser } from "@/lib/auth";

export const DEALING_TABS = [
  "Dealing",
  "Risk Exposure",
  "Coverage",
  "Bonus",
  "Metrics",
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

export const DASHBOARD_SECTION_KEYS = [
  { key: "Dashboard:Accounts", label: "Accounts Section" },
  { key: "Dashboard:Dealing", label: "Dealing Section" },
  { key: "Dashboard:Backoffice", label: "Back Office Section" },
  { key: "Dashboard:Marketing", label: "Marketing Section" },
  { key: "Dashboard:HR", label: "HR Section" },
  { key: "Dashboard:Alerts", label: "Alerts Section" },
] as const;

export const DEPARTMENT_KEYS = [
  { key: "LiveAgent", label: "Live Agent" },
  { key: "Dealing", label: "Dealing Department" },
  { key: "Accounts", label: "Accounts Department" },
  { key: "Backoffice", label: "Back Office Department" },
  { key: "Marketing", label: "Marketing Department" },
  { key: "HR", label: "HR Department" },
  { key: "Settings", label: "Settings" },
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
  if (hasUserAccess(user, "Dealing") || hasAnyScopedAccess(user, "Dealing")) return "/departments/dealing";
  if (hasUserAccess(user, "Accounts")) return "/departments/accounts";
  if (hasUserAccess(user, "Backoffice")) return "/departments/backoffice";
  if (hasUserAccess(user, "Marketing")) return "/departments/marketing";
  if (hasUserAccess(user, "HR")) return "/departments/hr";
  return "/login";
}
