import React from "react";
import { InternalAccountsTab } from "@/pages/departments/dealing/InternalAccountsTab";
import { BACKEND_BASE_URL } from "@/lib/backendBase";

export const InternalAccountsPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1300px]">
        <InternalAccountsTab backendBaseUrl={BACKEND_BASE_URL} refreshKey={0} />
      </div>
    </div>
  );
};
