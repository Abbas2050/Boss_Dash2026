import { useState } from 'react';
import { BackOfficeDepartment } from '@/components/dashboard/BackOfficeDepartment';
import { FilterSection } from '@/components/dashboard/FilterSection';
import { AnalyticsSection } from '@/components/dashboard/AnalyticsSection';
import { getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';

export function BackofficeDepartmentPage() {
  const [selectedEntity, setSelectedEntity] = useState('all');
  const [fromDate, setFromDate] = useState<Date>(() => getDubaiDayStart());
  const [toDate, setToDate] = useState<Date>(() => getDubaiDayEnd());
  const [activeQuickFilter, setActiveQuickFilter] = useState('today');

  const [appliedEntity, setAppliedEntity] = useState('all');
  const [appliedFromDate, setAppliedFromDate] = useState<Date>(() => getDubaiDayStart());
  const [appliedToDate, setAppliedToDate] = useState<Date>(() => getDubaiDayEnd());
  const [refreshKey, setRefreshKey] = useState(0);

  const handleApplyFilters = (override?: { fromDate?: Date; toDate?: Date }) => {
    const nextFromDate = override?.fromDate ?? fromDate;
    const nextToDate = override?.toDate ?? toDate;

    setAppliedEntity(selectedEntity);
    setAppliedFromDate(new Date(nextFromDate));
    setAppliedToDate(new Date(nextToDate));
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div className="space-y-5">
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

      <BackOfficeDepartment
        selectedEntity={appliedEntity}
        fromDate={appliedFromDate}
        toDate={appliedToDate}
        refreshKey={refreshKey}
        variant="full"
      />

      <AnalyticsSection
        selectedEntity={appliedEntity}
        fromDate={appliedFromDate}
        toDate={appliedToDate}
        refreshKey={refreshKey}
      />
    </div>
  );
}
