import React from "react";
import { hasAccess } from "@/lib/auth";
import { UnauthorizedPage } from "./UnauthorizedPage";

export const AccessGuard: React.FC<{ page: string; children: React.ReactNode }> = ({ page, children }) => {
  if (!hasAccess(page)) {
    return <UnauthorizedPage />;
  }
  return <>{children}</>;
};
