import { describe, expect, it } from "vitest";
import type { AuthUser } from "@/lib/auth";
import {
  DASHBOARD_SECTION_ITEMS,
  getVisibleDashboardSectionItems,
  hasDashboardSectionAccess,
} from "@/lib/permissions";

function makeUser(access: string[], role = "Analyst"): AuthUser {
  return {
    id: "1",
    name: "Test",
    email: "test@example.com",
    role,
    access,
    status: "active",
  } as AuthUser;
}

describe("dashboard section access", () => {
  it("granting only 'Dashboard' (Main Dashboard) does NOT grant any section", () => {
    const user = makeUser(["Dashboard"]);
    expect(getVisibleDashboardSectionItems(user)).toEqual([]);
    expect(hasDashboardSectionAccess(user, "Dashboard:Dealing")).toBe(false);
  });

  it("granting a single section grants only that section", () => {
    const user = makeUser(["Dashboard", "Dashboard:Dealing"]);
    const visible = getVisibleDashboardSectionItems(user).map((i) => i.key);
    expect(visible).toEqual(["Dashboard:Dealing"]);
  });

  it("exposes the two split Dealing sections, Analytics, Filters and Quick Stats", () => {
    const keys = DASHBOARD_SECTION_ITEMS.map((i) => i.key);
    expect(keys).toContain("Dashboard:Dealing");
    expect(keys).toContain("Dashboard:DealingLP");
    expect(keys).toContain("Dashboard:Analytics");
    expect(keys).toContain("Dashboard:Filters");
    expect(keys).toContain("Dashboard:QuickStats");
  });

  it("Super Admin sees every section regardless of access list", () => {
    const user = makeUser([], "Super Admin");
    expect(getVisibleDashboardSectionItems(user).length).toBe(DASHBOARD_SECTION_ITEMS.length);
  });
});
