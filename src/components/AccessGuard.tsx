import React from "react";
import { Navigate } from "react-router-dom";
import { hasAccess } from "@/lib/auth";

export const AccessGuard: React.FC<{ page: string; children: React.ReactNode }> = ({ page, children }) => {
  if (!hasAccess(page)) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="text-3xl font-bold text-destructive mb-4">Access Denied</div>
        <div className="text-muted-foreground text-lg">You do not have permission to view this page.</div>
        <a href="/" className="mt-6 rounded-lg bg-primary px-6 py-2 font-semibold text-primary-foreground shadow transition hover:bg-primary/80">Go Home</a>
      </div>
    );
  }
  return <>{children}</>;
};
