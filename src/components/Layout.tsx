import React, { useState, useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { SettingsSidebar } from "./SettingsSidebar";
import { DashboardHeader } from "./dashboard/DashboardHeader";
import { hasAccess, isAuthenticated } from "@/lib/auth";
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

  useEffect(() => {
    // Toggle both `dark` and `light` classes on the root for theme-aware CSS
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme === "light");
    try { localStorage.setItem('theme', theme); } catch(e) {}
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const isSettings = location.pathname.startsWith("/settings");
  const loggedIn = isAuthenticated();

  if (!loggedIn) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className={theme === "dark" ? "theme-dark" : "theme-light"}>
      <DashboardHeader theme={theme} onThemeToggle={toggleTheme} />
      <div className="flex">
        {isSettings && hasAccess("Settings") && <SettingsSidebar />}
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
      <LiveChatAgent />
    </div>
  );
};
