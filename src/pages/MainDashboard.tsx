import React from "react";
import { DealingDepartment } from "../components/dashboard/DealingDepartment";
import { AccountsDepartment } from "../components/dashboard/AccountsDepartment";
import { NotificationPanel } from "../components/dashboard/NotificationPanel";
import { hasAccess } from "@/lib/auth";
import { UnauthorizedPage } from "@/components/UnauthorizedPage";

export const MainDashboard: React.FC = () => {
  if (!hasAccess("Dashboard")) {
    return <UnauthorizedPage title="Dashboard Access Required" />;
  }

  const canAccounts = hasAccess("Dashboard:Accounts");
  const canDealing = hasAccess("Dashboard:Dealing");
  const canAlerts = hasAccess("Dashboard:Alerts");

  return (
    <div className="bg-background min-h-screen">
      <main className="p-3 sm:p-4 md:p-6 lg:p-8">
        <div className="grid grid-cols-12 gap-6">
          {/* Accounts Section */}
          <div className="col-span-12 lg:col-span-6">
            {canAccounts ? <AccountsDepartment selectedEntity="all" refreshKey={0} /> : null}
            {/* Dealing Section */}
            {canDealing ? (
              <div className="mt-6">
                <h2 className="text-xl font-bold text-primary mb-2">Dealing</h2>
                <DealingDepartment selectedEntity="all" refreshKey={0} />
              </div>
            ) : null}
            {!canAccounts && !canDealing && (
              <div className="rounded-xl border border-border/40 bg-card/70 p-4 text-sm text-muted-foreground">
                No dashboard sections are assigned to your user.
              </div>
            )}
          </div>
          {/* Minimized Live Alerts shown in header; keep this column for accounts/dealing pairing */}
          <div className="col-span-12 lg:col-span-6">
            {canAlerts ? (
              <div className="mb-6">
                <NotificationPanel selectedEntity="all" refreshKey={0} minimized />
              </div>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
};
