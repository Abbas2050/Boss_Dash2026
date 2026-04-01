import React from "react";
import { InternalAccountsTab } from "@/pages/departments/dealing/InternalAccountsTab";

export const InternalAccountsPage: React.FC = () => {
  const backendBaseUrl = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || "https://api.skylinkscapital.com").replace(/\/+$/, "");

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="mx-auto max-w-[1300px]">
        <InternalAccountsTab backendBaseUrl={backendBaseUrl} refreshKey={0} />
      </div>
    </div>
  );
};
