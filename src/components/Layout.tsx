import React, { useState, useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { SettingsSidebar } from "./SettingsSidebar";
import { DashboardHeader } from "./dashboard/DashboardHeader";
import { getCurrentUser, hasAccess, isAuthenticated, syncCurrentSession } from "@/lib/auth";
import { getDefaultRouteForUser } from "@/lib/permissions";
import { LiveChatAgent } from "./LiveChatAgent";

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
    <div className={theme === "dark" ? "theme-dark" : "theme-light"}>
      <DashboardHeader theme={theme} onThemeToggle={toggleTheme} />
      <div className="flex min-w-0 flex-col lg:flex-row">
        {isSettings && hasAccess("Settings") && <SettingsSidebar />}
        <main className="min-w-0 flex-1 overflow-x-hidden">
          <Outlet />
        </main>
      </div>
      {hasAccess("LiveAgent") ? <LiveChatAgent /> : null}
    </div>
  );
};
