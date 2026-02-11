import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { FilterSection } from '@/components/dashboard/FilterSection';
import { QuickStats } from '@/components/dashboard/QuickStats';
import { DealingDepartment } from '@/components/dashboard/DealingDepartment';
import { AccountsDepartment } from '@/components/dashboard/AccountsDepartment';
import { HRDepartment } from '@/components/dashboard/HRDepartment';
import { BackOfficeDepartment } from '@/components/dashboard/BackOfficeDepartment';
import { MarketingDepartment } from '@/components/dashboard/MarketingDepartment';
import { NotificationPanel } from '@/components/dashboard/NotificationPanel';
import { AnalyticsSection } from '@/components/dashboard/AnalyticsSection';
import { getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';

import { useState } from 'react';

const Index = () => {
  // Get today's date range in Dubai timezone for default values
  const todayStart = getDubaiDayStart();
  const todayEnd = getDubaiDayEnd();
  
  // Filter state lifted here with default values
  const [selectedEntity, setSelectedEntity] = useState('all');
  const [fromDate, setFromDate] = useState<Date>(todayStart);
  const [toDate, setToDate] = useState<Date>(todayEnd);
  const [activeQuickFilter, setActiveQuickFilter] = useState('today');
  const [appliedEntity, setAppliedEntity] = useState('all');
  const [appliedFromDate, setAppliedFromDate] = useState<Date>(todayStart);
  const [appliedToDate, setAppliedToDate] = useState<Date>(todayEnd);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleApplyFilters = (override?: { fromDate?: Date; toDate?: Date }) => {
    setAppliedEntity(selectedEntity);
    setAppliedFromDate(override?.fromDate ?? fromDate);
    setAppliedToDate(override?.toDate ?? toDate);
    setRefreshKey(prev => prev + 1);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Ambient Background Effects */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-accent/3 rounded-full blur-[100px]" />
        <div className="absolute inset-0 grid-pattern opacity-30" />
      </div>
      <div className="relative z-10">
        <DashboardHeader />
        <main className="p-6 space-y-5">
          {/* Filter Section */}
          <FilterSection
            selectedEntity={selectedEntity}
            setSelectedEntity={setSelectedEntity}
            fromDate={fromDate}
            setFromDate={setFromDate}
            toDate={toDate}
            setToDate={setToDate}
            activeQuickFilter={activeQuickFilter}
            setActiveQuickFilter={setActiveQuickFilter}
            onSubmit={handleApplyFilters}
          />
          {/* Quick Stats Row */}
          <QuickStats
            selectedEntity={appliedEntity}
            fromDate={appliedFromDate}
            toDate={appliedToDate}
            refreshKey={refreshKey}
          />
          {/* Main Dashboard Grid */}
          <div className="grid grid-cols-12 gap-5">
            {/* Dealing Department - Largest, most important */}
            <div className="col-span-12 lg:col-span-4">
              <DealingDepartment 
                selectedEntity={appliedEntity}
                fromDate={appliedFromDate}
                toDate={appliedToDate}
                refreshKey={refreshKey}
              />
            </div>
            {/* Accounts Department */}
            <div className="col-span-12 lg:col-span-4">
              <AccountsDepartment 
                selectedEntity={appliedEntity}
                fromDate={appliedFromDate}
                toDate={appliedToDate}
                refreshKey={refreshKey}
              />
            </div>
            {/* Notifications Panel */}
            <div className="col-span-12 lg:col-span-4">
              <NotificationPanel 
                selectedEntity={appliedEntity}
                fromDate={appliedFromDate}
                toDate={appliedToDate}
                refreshKey={refreshKey}
              />
            </div>
            {/* HR Department */}
            <div className="col-span-12 lg:col-span-4">
              <HRDepartment 
                selectedEntity={appliedEntity}
                fromDate={appliedFromDate}
                toDate={appliedToDate}
                refreshKey={refreshKey}
              />
            </div>
            {/* Back Office Department */}
            <div className="col-span-12 lg:col-span-4">
              <BackOfficeDepartment 
                selectedEntity={appliedEntity}
                fromDate={appliedFromDate}
                toDate={appliedToDate}
                refreshKey={refreshKey}
              />
            </div>
            {/* Marketing Department */}
            <div className="col-span-12 lg:col-span-4">
              <MarketingDepartment 
                selectedEntity={appliedEntity}
                fromDate={appliedFromDate}
                toDate={appliedToDate}
                refreshKey={refreshKey}
              />
            </div>
          </div>
          {/* Analytics & Insights Section */}
          <AnalyticsSection
            selectedEntity={appliedEntity}
            fromDate={appliedFromDate}
            toDate={appliedToDate}
            refreshKey={refreshKey}
          />
          {/* Footer */}
          <footer className="flex items-center justify-between py-4 border-t border-border/20 text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              <span className="font-mono">© 2026 Sky Links Capital</span>
              <span className="w-1 h-1 rounded-full bg-muted-foreground/50" />
              <span>All systems operational</span>
            </div>
            <div className="flex items-center gap-4 font-mono">
              <span>TLS 1.3 Encrypted</span>
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              <span>ISO 27001 Compliant</span>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
};

export default Index;
