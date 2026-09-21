import { describe, expect, it } from "vitest";
import type { AuthUser } from "@/lib/auth";
import {
  canAccessSettingsItem,
  getVisibleSettingsMenuItems,
  SETTINGS_MENU_ITEMS,
  SETTINGS_PAGE_KEYS,
  settingsPageKey,
} from "@/lib/permissions";

function makeUser(access: string[], role = "Analyst"): AuthUser {
  return { id: "1", name: "Test", email: "test@example.com", role, access, status: "active" } as AuthUser;
}

const visible = (access: string[], role?: string) =>
  getVisibleSettingsMenuItems(makeUser(access, role)).map((i) => i.key);

const item = (key: string) => {
  const found = SETTINGS_MENU_ITEMS.find((i) => i.key === key);
  if (!found) throw new Error(`no settings item ${key}`);
  return found;
};

const CORE = ["coverage", "google-sheet-mapping", "lp-manager", "lp-info", "internal-accounts",
  "symbol-mapping", "alerts", "client-account-monitor", "ws-test"];
const ADMIN = ["api-clients", "api-vendor-urls", "finalto-accounts", "finalto-admin", "lp-equity-history"];

describe("settings page chips", () => {
  it("offers one chip per settings page, every page except User Management", () => {
    expect(SETTINGS_PAGE_KEYS.map((k) => k.key).sort()).toEqual(
      SETTINGS_MENU_ITEMS.filter((i) => i.key !== "user-management").map((i) => `Settings:${i.key}`).sort(),
    );
    expect(SETTINGS_PAGE_KEYS.find((k) => k.key === "Settings:lp-info")?.label).toBe("LP Info");
    expect(settingsPageKey("lp-info")).toBe("Settings:lp-info");
  });

  it("a single page chip opens exactly that page", () => {
    expect(visible(["Settings:lp-info"])).toEqual(["lp-info"]);
  });

  it("a page chip opens an admin page without Manage Users & Roles", () => {
    expect(visible(["Settings:lp-equity-history"])).toEqual(["lp-equity-history"]);
    expect(canAccessSettingsItem(makeUser(["Settings:finalto-admin"]), item("finalto-admin"))).toBe(true);
  });

  it("a page chip opens LP Statements without Backoffice", () => {
    expect(visible(["Settings:lp-statements"])).toEqual(["lp-statements"]);
  });
});

describe("what existing users keep", () => {
  it("the broad Settings key still opens every standard page, and only those", () => {
    expect(visible(["Settings"]).sort()).toEqual([...CORE].sort());
  });

  // The regression that matters most: page keys share the "Settings:" prefix,
  // and hasUserAccess treats owning a prefix as owning everything under it. If
  // page chips went through that cascade, every existing Settings user would
  // silently gain API Clients, Finalto Admin and the rest.
  it("the broad Settings key does NOT open any admin page", () => {
    const user = makeUser(["Settings"]);
    for (const key of ADMIN) expect(canAccessSettingsItem(user, item(key))).toBe(false);
  });

  it("Settings + Backoffice still opens LP Statements; Settings + Manage Users still opens the admin pages", () => {
    expect(visible(["Settings", "Backoffice"])).toContain("lp-statements");
    const admin = visible(["Settings", "Auth:ManageUsers"]);
    for (const key of [...ADMIN, "user-management"]) expect(admin).toContain(key);
  });

  it("Super Admin sees everything", () => {
    expect(visible([], "Super Admin")).toHaveLength(SETTINGS_MENU_ITEMS.length);
  });
});

describe("User Management is never granted by a chip", () => {
  it("ignores a Settings:user-management key", () => {
    expect(visible(["Settings:user-management"])).toEqual([]);
  });

  it("does not let a page chip stand in for Settings in another page's pair", () => {
    // Owning one page chip must not satisfy the "Settings" half of any
    // requiredPermissions pair.
    expect(visible(["Settings:lp-info", "Auth:ManageUsers"])).toEqual(["lp-info"]);
  });
});
