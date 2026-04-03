import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { MarketingDepartment } from '../../components/dashboard/MarketingDepartment';

function toInputDate(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fromInputDate(value: string, endOfDay = false) {
  if (!value) return new Date();
  const [y, m, d] = value.split('-').map((v) => Number(v));
  const dt = new Date(y, (m || 1) - 1, d || 1);
  if (endOfDay) dt.setHours(23, 59, 59, 999);
  else dt.setHours(0, 0, 0, 0);
  return dt;
}

function startOfDay(d: Date) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date) {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function startOfWeek(d: Date) {
  const out = startOfDay(d);
  const day = out.getDay();
  const diffToMonday = (day + 6) % 7;
  out.setDate(out.getDate() - diffToMonday);
  return out;
}

function endOfWeek(d: Date) {
  const out = startOfWeek(d);
  out.setDate(out.getDate() + 6);
  return endOfDay(out);
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

function startOfQuarter(d: Date) {
  const quarterStartMonth = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), quarterStartMonth, 1, 0, 0, 0, 0);
}

export function MarketingDepartmentPage() {
  const quickFilterOptions = [
    'Today',
    'Yesterday',
    'This Week',
    'Last Week',
    'This Month',
    'Last Month',
    'This Quarter',
    'YTD',
  ] as const;
  const [activeQuickFilter, setActiveQuickFilter] = useState<(typeof quickFilterOptions)[number] | null>(null);

  const [fromDateInput, setFromDateInput] = useState<string>(() => {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    return toInputDate(start);
  });
  const [toDateInput, setToDateInput] = useState<string>(() => toInputDate(new Date()));

  const [appliedFromDate, setAppliedFromDate] = useState<Date>(() => {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    return start;
  });
  const [appliedToDate, setAppliedToDate] = useState<Date>(() => {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    return now;
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const applyFilters = () => {
    const nextFrom = fromInputDate(fromDateInput, false);
    const nextTo = fromInputDate(toDateInput, true);
    setAppliedFromDate(nextFrom);
    setAppliedToDate(nextTo);
    setRefreshKey((prev) => prev + 1);
  };

  const applyQuickFilter = (preset: (typeof quickFilterOptions)[number]) => {
    const now = new Date();
    let from = startOfDay(now);
    let to = endOfDay(now);

    if (preset === 'Today') {
      from = startOfDay(now);
      to = endOfDay(now);
    } else if (preset === 'Yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      from = startOfDay(y);
      to = endOfDay(y);
    } else if (preset === 'This Week') {
      from = startOfWeek(now);
      to = endOfDay(now);
    } else if (preset === 'Last Week') {
      const lastWeekAnchor = new Date(now);
      lastWeekAnchor.setDate(lastWeekAnchor.getDate() - 7);
      from = startOfWeek(lastWeekAnchor);
      to = endOfWeek(lastWeekAnchor);
    } else if (preset === 'This Month') {
      from = startOfMonth(now);
      to = endOfDay(now);
    } else if (preset === 'Last Month') {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      from = startOfMonth(lastMonth);
      to = endOfMonth(lastMonth);
    } else if (preset === 'This Quarter') {
      from = startOfQuarter(now);
      to = endOfDay(now);
    } else if (preset === 'YTD') {
      from = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      to = endOfDay(now);
    }

    setFromDateInput(toInputDate(from));
    setToDateInput(toInputDate(to));
    setAppliedFromDate(from);
    setAppliedToDate(to);
    setActiveQuickFilter(preset);
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/60 bg-card/75 p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.16em] text-muted-foreground">Marketing Filters</div>
            <div className="mt-1 text-sm font-semibold text-foreground">Select Date Range</div>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3 lg:w-auto">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>From</span>
              <input
                type="date"
                value={fromDateInput}
                onChange={(e) => setFromDateInput(e.target.value)}
                className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-sm text-foreground outline-none ring-primary/40 focus:ring"
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>To</span>
              <input
                type="date"
                value={toDateInput}
                onChange={(e) => setToDateInput(e.target.value)}
                className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-sm text-foreground outline-none ring-primary/40 focus:ring"
              />
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={applyFilters}
                className="inline-flex h-9 items-center gap-1 rounded-md border border-primary/40 bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <CalendarDays className="h-4 w-4" /> Apply
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 lg:max-w-[720px] lg:justify-end">
            {quickFilterOptions.map((preset) => {
              const active = activeQuickFilter === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => applyQuickFilter(preset)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    active
                      ? 'border-primary/50 bg-primary/15 text-primary'
                      : 'border-border/60 bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  {preset}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <MarketingDepartment
        selectedEntity="all"
        fromDate={appliedFromDate}
        toDate={appliedToDate}
        refreshKey={refreshKey}
      />
    </div>
  );
}
