import React from "react";
import { DealingDepartment } from "../components/dashboard/DealingDepartment";
import { AccountsDepartment } from "../components/dashboard/AccountsDepartment";
import { NotificationPanel } from "../components/dashboard/NotificationPanel";

export const MainDashboard: React.FC = () => {
  return (
    <div className="bg-background min-h-screen">
      <main className="p-8">
        <div className="grid grid-cols-12 gap-6">
          {/* Accounts Section */}
          <div className="col-span-12 lg:col-span-6">
            <AccountsDepartment selectedEntity="all" refreshKey={0} />
            {/* Dealing Section */}
            <div className="mt-6">
              <h2 className="text-xl font-bold text-primary mb-2">Dealing</h2>
              <DealingDepartment selectedEntity="all" refreshKey={0} />
            </div>
          </div>
          {/* Minimized Live Alerts shown in header; keep this column for accounts/dealing pairing */}
          <div className="col-span-12 lg:col-span-6">
            <div className="mb-6">
              <NotificationPanel selectedEntity="all" refreshKey={0} minimized />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
