import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
// SignalR removed: use SSE/EventSource for real-time alerts
import { Layout } from "./components/Layout";
import { LiveAlertsNotifier } from "./components/LiveAlertsNotifier";
import { getCurrentUser } from "./lib/auth";
import { UnauthorizedPage } from "./components/UnauthorizedPage";
import { canAccessAll, LEGACY_ROUTE_ALIASES, SETTINGS_MENU_ITEMS } from "./lib/permissions";

const Index = lazy(() => import("./pages/Index"));
const LeverageUpdate = lazy(() => import("./pages/LeverageUpdate"));
const LPManager = lazy(() => import("./pages/LPManager"));
const NotFound = lazy(() => import("./pages/NotFound"));
const CoveragePage = lazy(() => import("./pages/settings/CoveragePage").then((m) => ({ default: m.CoveragePage })));
const LPManagerPage = lazy(() => import("./pages/settings/LPManagerPage").then((m) => ({ default: m.LPManagerPage })));
const SymbolMappingPage = lazy(() => import("./pages/settings/SymbolMappingPage").then((m) => ({ default: m.SymbolMappingPage })));
const WSTestPage = lazy(() => import("./pages/settings/WSTestPage").then((m) => ({ default: m.WSTestPage })));
const UserManagementPage = lazy(() => import("./pages/settings/UserManagementPage").then((m) => ({ default: m.UserManagementPage })));
const AlertsSettingsPage = lazy(() => import("./pages/settings/AlertsSettingsPage").then((m) => ({ default: m.AlertsSettingsPage })));
const MainDashboard = lazy(() => import("./pages/MainDashboard").then((m) => ({ default: m.MainDashboard })));
const DepartmentPages = lazy(() => import("./pages/DepartmentPages").then((m) => ({ default: m.DepartmentPages })));
const LoginPage = lazy(() => import("./pages/LoginPage"));

const queryClient = new QueryClient();

const settingsPageComponents = {
  coverage: CoveragePage,
  "lp-manager": LPManagerPage,
  "symbol-mapping": SymbolMappingPage,
  alerts: AlertsSettingsPage,
  "ws-test": WSTestPage,
  "user-management": UserManagementPage,
} as const;

function SettingsRoute({
  children,
  requiredPermissions,
  title,
}: {
  children: React.ReactNode;
  requiredPermissions: readonly string[];
  title: string;
}) {
  const currentUser = getCurrentUser();
  if (!canAccessAll(currentUser, requiredPermissions)) return <UnauthorizedPage title={title} />;
  return children;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <LiveAlertsNotifier />
      <BrowserRouter>
        <Suspense fallback={<div className="p-4 text-sm text-slate-500">Loading...</div>}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<Layout />}>
              <Route index element={<Index />} />
              <Route path="dashboard" element={<MainDashboard />} />
              <Route path="departments">
                <Route index element={<DepartmentPages />} />
                <Route path=":dept" element={<DepartmentPages />} />
              </Route>
              <Route path="leverage-update" element={<LeverageUpdate />} />
              <Route path="LPManager" element={<LPManager />} />

            {/* Legacy static HTML aliases */}
            {LEGACY_ROUTE_ALIASES.map((item) => (
              <Route key={item.path} path={item.path} element={<Navigate to={item.to} replace />} />
            ))}

              {/* Settings pages (will show sidebar) */}
              {SETTINGS_MENU_ITEMS.map((item) => {
                const PageComponent = settingsPageComponents[item.key];
                return (
                  <Route
                    key={item.key}
                    path={item.path.replace(/^\//, "")}
                    element={
                      <SettingsRoute requiredPermissions={item.requiredPermissions} title={`${item.name} Access Required`}>
                        <PageComponent />
                      </SettingsRoute>
                    }
                  />
                );
              })}

              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
