import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
// SignalR removed: use SSE/EventSource for real-time alerts
import { Layout } from "./components/Layout";
import Index from "./pages/Index";
import LeverageUpdate from "./pages/LeverageUpdate";
import LPManager from "./pages/LPManager";
import NotFound from "./pages/NotFound";
import { CoveragePage } from "./pages/settings/CoveragePage";
import { LPManagerPage } from "./pages/settings/LPManagerPage";
import { SymbolMappingPage } from "./pages/settings/SymbolMappingPage";
import { WSTestPage } from "./pages/settings/WSTestPage";
import { UserManagementPage } from "./pages/settings/UserManagementPage";
import { AlertsSettingsPage } from "./pages/settings/AlertsSettingsPage";
import { MainDashboard } from "./pages/MainDashboard";
import { DepartmentPages } from "./pages/DepartmentPages";
import { LiveAlertsNotifier } from "./components/LiveAlertsNotifier";
import LoginPage from "./pages/LoginPage";
import { hasAccess } from "./lib/auth";
import { UnauthorizedPage } from "./components/UnauthorizedPage";

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
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
