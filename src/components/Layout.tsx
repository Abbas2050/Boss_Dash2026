import React, { useState, useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { SettingsSidebar } from "./SettingsSidebar";
import { DashboardHeader } from "./dashboard/DashboardHeader";
import { getCurrentUser, hasAccess, isAuthenticated, syncCurrentSession } from "@/lib/auth";
import { getDefaultRouteForUser } from "@/lib/permissions";
import { LiveChatAgent } from "./LiveChatAgent";
import { TicketsFab } from "./TicketsFab";
import { AlertsHubProvider, useAlertsHub } from "./AlertsHubProvider";

const DisconnectBanner: React.FC = () => {
  const { disconnected, silence } = useAlertsHub();
  if (!disconnected) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow">
      <span>⚠ Disconnected from data backend — retrying…</span>
      <button
        type="button"
        onClick={silence}
        className="rounded border border-white/40 bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20"
      >
        Silence
      </button>
    </div>
  );
};

export const Layout: React.FC = () => {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = localStorage.getItem('theme');
      if (saved === "light" || saved === "dark") return saved;
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
      return "dark";
    } catch (e) {
      return 'dark';
    }
  });
  const location = useLocation();
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    // Toggle both `dark` and `light` classes on the root for theme-aware CSS
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme === "light");
    try { localStorage.setItem('theme', theme); } catch(e) {}
  }, [theme]);

  useEffect(() => {
    let mounted = true;
    syncCurrentSession()
      .catch(() => undefined)
      .finally(() => {
        if (mounted) setAuthChecked(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const isSettings = location.pathname.startsWith("/settings");
  const loggedIn = isAuthenticated();
  const currentUser = loggedIn ? getCurrentUser() : null;

  if (!authChecked) {
    return <div className="p-6 text-sm text-muted-foreground">Checking session...</div>;
  }

  if (!loggedIn) {
    return <Navigate to="/login" replace />;
  }
  if (location.pathname === "/" && !hasAccess("Dashboard")) {
    return <Navigate to={getDefaultRouteForUser(currentUser)} replace />;
  }

  return (
    <AlertsHubProvider>
      <DisconnectBanner />
      <div className={theme === "dark" ? "theme-dark" : "theme-light"}>
        <DashboardHeader theme={theme} onThemeToggle={toggleTheme} />
        <div className="flex min-w-0 flex-col lg:flex-row">
          {isSettings && hasAccess("Settings") && <SettingsSidebar />}
          <main className="min-w-0 flex-1 overflow-x-clip">
            <Outlet />
          </main>
        </div>
        <TicketsFab />
        {hasAccess("LiveAgent") ? <LiveChatAgent /> : null}
      </div>
    </AlertsHubProvider>
  );
};
