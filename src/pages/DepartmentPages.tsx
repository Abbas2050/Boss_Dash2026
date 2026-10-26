import React from "react";
import { useParams } from "react-router-dom";
import { AccountsDepartment } from "@/components/dashboard/AccountsDepartment";
import { HRDepartment } from "@/components/dashboard/HRDepartment";
import { DealingDepartmentPage } from "@/pages/departments/DealingDepartmentPage";
import { BackofficeDepartmentPage } from "@/pages/departments/BackofficeDepartmentPage";
import { MarketingDepartmentPage } from "@/pages/departments/MarketingDepartmentPage";
import { ClientProfileDepartmentPage } from "@/pages/departments/ClientProfileDepartmentPage";
import { getCurrentUser } from "@/lib/auth";
import { canAccessDepartmentItem, getDepartmentItemBySlug, getVisibleDepartmentItems } from "@/lib/permissions";
import { UnauthorizedPage } from "@/components/UnauthorizedPage";

export const DepartmentPages: React.FC = () => {
  const { dept } = useParams<{ dept?: string }>();
  const currentUser = getCurrentUser();
  const defaultDepartment = getVisibleDepartmentItems(currentUser)[0]?.slug || "dealing";
  const selected = (dept || defaultDepartment).toLowerCase();
  const departmentItem = getDepartmentItemBySlug(selected);

  if (departmentItem && !canAccessDepartmentItem(currentUser, departmentItem)) {
    return <UnauthorizedPage />;
  }
  if (selected === "cp" && currentUser?.role !== "Super Admin") {
    return <UnauthorizedPage />;
  }

  const commonProps = {
    selectedEntity: "all",
    refreshKey: 0,
  };

  const knownDepartmentSlugs = new Set(getVisibleDepartmentItems(currentUser).map((item) => item.slug).concat(["dealing", "backoffice", "accounts", "marketing", "hr", "cp", "sales"]));

  return (
    <div className="min-h-screen p-3 sm:p-4 md:p-6 lg:p-8">
      {selected === "dealing" && <DealingDepartmentPage />}
      {selected === "backoffice" && <BackofficeDepartmentPage />}
      {selected === "accounts" && <AccountsDepartment {...commonProps} layout="page" />}
      {selected === "marketing" && <MarketingDepartmentPage />}
      {selected === "hr" && <HRDepartment {...commonProps} />}
      {selected === "cp" && <ClientProfileDepartmentPage />}

      {/* ───────────────────────── PLACEHOLDER ─────────────────────────
          The real Sales commission page is a separate task. It builds
          against the contract already shipped at
          GET /api/sales/commission (sales/commissionRoute.js), whose
          response shape differs by caller: a Super Admin receives revenue
          and margin fields, a salesperson receives no revenue field at all.

          This block exists because `sales` is now a known department slug,
          so the "being prepared" fallback below no longer fires for it and
          the route would otherwise render an empty page. Replace the whole
          block with <SalesDepartmentPage />; do not delete the route entry
          in permissions.ts with it. */}
      {selected === "sales" && (
        <div className="rounded-2xl border border-border/40 bg-card/75 p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-foreground">Sales</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Commission reporting is being prepared. The server side is live at
            <code className="mx-1 rounded bg-secondary/40 px-1 py-0.5 text-xs">GET /api/sales/commission</code>
            and this page is the next task.
          </p>
        </div>
      )}

      {!knownDepartmentSlugs.has(selected) && (
        <div className="rounded-2xl border border-border/40 bg-card/75 p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-foreground capitalize">{selected}</h2>
          <p className="text-sm text-muted-foreground mt-2">This department page is being prepared.</p>
        </div>
      )}
    </div>
  );
};
