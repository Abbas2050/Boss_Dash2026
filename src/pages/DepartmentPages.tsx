import React from "react";
import { useParams } from "react-router-dom";
import { AccountsDepartment } from "@/components/dashboard/AccountsDepartment";
import { MarketingDepartment } from "@/components/dashboard/MarketingDepartment";
import { HRDepartment } from "@/components/dashboard/HRDepartment";
import { DealingDepartmentPage } from "@/pages/departments/DealingDepartmentPage";
import { BackofficeDepartmentPage } from "@/pages/departments/BackofficeDepartmentPage";
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

  const commonProps = {
    selectedEntity: "all",
    refreshKey: 0,
  };

  const knownDepartmentSlugs = new Set(getVisibleDepartmentItems(currentUser).map((item) => item.slug).concat(["dealing", "backoffice", "accounts", "marketing", "hr"]));

  return (
    <div className="min-h-screen p-3 sm:p-4 md:p-6 lg:p-8">
      {selected === "dealing" && <DealingDepartmentPage />}
      {selected === "backoffice" && <BackofficeDepartmentPage />}
      {selected === "accounts" && <AccountsDepartment {...commonProps} />}
      {selected === "marketing" && <MarketingDepartment {...commonProps} />}
      {selected === "hr" && <HRDepartment {...commonProps} />}

      {!knownDepartmentSlugs.has(selected) && (
        <div className="rounded-2xl border border-border/40 bg-card/75 p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-foreground capitalize">{selected}</h2>
          <p className="text-sm text-muted-foreground mt-2">This department page is being prepared.</p>
        </div>
      )}
    </div>
  );
};
