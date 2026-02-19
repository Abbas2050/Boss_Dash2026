import React from "react";
import { useParams } from "react-router-dom";
import { BackOfficeDepartment } from "@/components/dashboard/BackOfficeDepartment";
import { AccountsDepartment } from "@/components/dashboard/AccountsDepartment";
import { MarketingDepartment } from "@/components/dashboard/MarketingDepartment";
import { HRDepartment } from "@/components/dashboard/HRDepartment";
import { DealingDepartmentPage } from "@/pages/departments/DealingDepartmentPage";

export const DepartmentPages: React.FC = () => {
  const { dept } = useParams<{ dept?: string }>();
  const selected = (dept || "dealing").toLowerCase();

  const commonProps = {
    selectedEntity: "all",
    refreshKey: 0,
  };

  return (
    <div className="min-h-screen p-6 md:p-8">
      {selected === "dealing" && <DealingDepartmentPage />}
      {selected === "backoffice" && <BackOfficeDepartment {...commonProps} />}
      {selected === "accounts" && <AccountsDepartment {...commonProps} />}
      {selected === "marketing" && <MarketingDepartment {...commonProps} />}
      {selected === "hr" && <HRDepartment {...commonProps} />}

      {!["dealing", "backoffice", "accounts", "marketing", "hr"].includes(selected) && (
        <div className="rounded-2xl border border-border/40 bg-card/75 p-6 shadow-sm">
          <h2 className="text-2xl font-semibold text-foreground capitalize">{selected}</h2>
          <p className="text-sm text-muted-foreground mt-2">This department page is being prepared.</p>
        </div>
      )}
    </div>
  );
};
