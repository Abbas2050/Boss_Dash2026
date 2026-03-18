import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
// SignalR removed: use SSE/EventSource for real-time alerts
import { Layout } from "./components/Layout";
import { LiveAlertsNotifier } from "./components/LiveAlertsNotifier";
import { hasAccess } from "./lib/auth";
import { UnauthorizedPage } from "./components/UnauthorizedPage";

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

function SettingsRoute({ children }: { children: any }) {
  if (!hasAccess("Settings")) return <UnauthorizedPage title="Settings Access Required" />;
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
            <Route path="coverage.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="risk-exposure.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="metrics.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="contract-sizes.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="history.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="transactions.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="swap-tracker.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="clients-nop%201.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="clients-nop 1.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="bonus-coverage.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="bonus-risk.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="bonus-pnl.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="bonus-equity.html" element={<Navigate to="/departments/dealing" replace />} />
            <Route path="account-alerts.html" element={<Navigate to="/settings/alerts" replace />} />

              {/* Settings pages (will show sidebar) */}
              <Route path="settings/coverage" element={<SettingsRoute><CoveragePage /></SettingsRoute>} />
              <Route path="settings/lp-manager" element={<SettingsRoute><LPManagerPage /></SettingsRoute>} />
              <Route path="settings/symbol-mapping" element={<SettingsRoute><SymbolMappingPage /></SettingsRoute>} />
              <Route path="settings/alerts" element={<SettingsRoute><AlertsSettingsPage /></SettingsRoute>} />
              <Route path="settings/ws-test" element={<SettingsRoute><WSTestPage /></SettingsRoute>} />
              <Route path="settings/user-management" element={<SettingsRoute><UserManagementPage /></SettingsRoute>} />

              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
