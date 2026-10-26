// The Sales department's place in the nav. Default (jsdom) environment, like
// every other test under src/.
//
// The server is the confidentiality boundary -- GET /api/sales/commission
// resolves the caller from their verified session and sends a salesperson no
// revenue field at all. These assertions are about the nav agreeing with it, so
// that nobody is shown a page which can only answer 403.
import { describe, it, expect } from "vitest";
import type { AuthUser } from "@/lib/auth";
import {
  DEPARTMENT_KEYS,
  DEPARTMENT_NAV_ITEMS,
  USER_ROLE_TEMPLATES,
  getDepartmentItemBySlug,
  getVisibleDepartmentItems,
  hasSalesScope,
} from "@/lib/permissions";

function user(partial: Partial<AuthUser>): AuthUser {
  return {
    id: "1",
    name: "Test",
    email: "test@example.com",
    role: "Analyst",
    access: [],
    status: "active",
    ...partial,
  };
}

const salesItem = DEPARTMENT_NAV_ITEMS.find((item) => item.slug === "sales")!;
const visibleSlugs = (u: AuthUser | null) => getVisibleDepartmentItems(u).map((item) => item.slug);

describe("the Sales department exists", () => {
  it("is routable at /departments/sales", () => {
    expect(getDepartmentItemBySlug("sales")).toBe(salesItem);
    expect(salesItem.path).toBe("/departments/sales");
    expect(salesItem.requiredPermissions).toEqual(["Sales"]);
  });

  it("has an access chip an admin can tick", () => {
    expect(DEPARTMENT_KEYS.map((k) => k.key)).toContain("Sales");
  });
});

describe("hasSalesScope mirrors what the server will serve", () => {
  it("admits a Super Admin", () => {
    expect(hasSalesScope(user({ role: "Super Admin" }))).toBe(true);
  });

  it("admits a user with a crmManagerId", () => {
    expect(hasSalesScope(user({ crmManagerId: 28 }))).toBe(true);
  });

  it("admits one whose id arrived as a string", () => {
    // The field is typed `number`, but a value that slipped through as "28"
    // still matches on the server, so it must not read as "no id" here.
    expect(hasSalesScope(user({ crmManagerId: "28" as unknown as number }))).toBe(true);
  });

  it("refuses a user with no usable id", () => {
    expect(hasSalesScope(user({}))).toBe(false);
    expect(hasSalesScope(user({ crmManagerId: 0 }))).toBe(false);
    expect(hasSalesScope(user({ crmManagerId: -1 }))).toBe(false);
    expect(hasSalesScope(user({ crmManagerId: "abc" as unknown as number }))).toBe(false);
    expect(hasSalesScope(null)).toBe(false);
  });
});

describe("who sees the nav item", () => {
  it("shows it to a salesperson who has both the chip and the id", () => {
    expect(visibleSlugs(user({ access: ["Sales"], crmManagerId: 28 }))).toContain("sales");
  });

  it("hides it from a user with the chip but no manager id", () => {
    // This is the whole point of the extra gate: the server answers 403, so a
    // visible nav item would promise a page that can never load.
    expect(visibleSlugs(user({ access: ["Sales"] }))).not.toContain("sales");
  });

  it("hides it from a user with the manager id but no chip", () => {
    expect(visibleSlugs(user({ crmManagerId: 28 }))).not.toContain("sales");
  });

  it("shows it to a Super Admin", () => {
    expect(visibleSlugs(user({ role: "Super Admin" }))).toContain("sales");
  });
});

describe("role templates", () => {
  it("gives Sales to Super Admin only", () => {
    expect(USER_ROLE_TEMPLATES["Super Admin"]).toContain("Sales");
    for (const role of ["Manager", "Analyst", "Support"] as const) {
      expect(USER_ROLE_TEMPLATES[role], role).not.toContain("Sales");
    }
  });

  it("does not invent a fifth template for salespeople", () => {
    // A template stamps an `access[]` array, and a salesperson's entitlement is
    // the crmManagerId on their own record -- a per-person fact no template can
    // express. A "Sales" template applied before that field was filled in would
    // hand out a nav item and a 403, and would need a fifth ALLOWED_ROLES value
    // that every `role ===` comparison in the app has never seen.
    expect(Object.keys(USER_ROLE_TEMPLATES).sort()).toEqual([
      "Analyst",
      "Manager",
      "Super Admin",
      "Support",
    ]);
  });

  it("leaves the Manager template otherwise intact", () => {
    // Excluding one key must not have excluded its neighbours.
    for (const key of ["Dealing", "Accounts", "Backoffice", "Marketing", "HR", "Settings", "Alerts"]) {
      expect(USER_ROLE_TEMPLATES.Manager, key).toContain(key);
    }
  });
});
