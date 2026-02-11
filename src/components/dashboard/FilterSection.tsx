import { useState } from 'react';
import { Calendar, ChevronDown, Building2, Filter, X } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { getDubaiDate, getDubaiDayEnd, getDubaiDayStart } from '@/lib/dubaiTime';
import { Button } from '@/components/ui/button';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const entities = [
  { value: 'all', label: 'All Entities' },
  { value: 'StVincent', label: 'StVincent' },
  { value: 'Mauritius', label: 'Mauritius' },
  { value: 'SCA_MAU', label: 'SCA_MAU' },
];

const quickFilters = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this-week', label: 'This Week' },
  { value: 'last-week', label: 'Last Week' },
  { value: 'this-month', label: 'This Month' },
  { value: 'last-month', label: 'Last Month' },
  { value: 'this-quarter', label: 'This Quarter' },
  { value: 'ytd', label: 'YTD' },
];

interface FilterSectionProps {
  selectedEntity: string;
  setSelectedEntity: (v: string) => void;
  fromDate?: Date;
  setFromDate: (d?: Date) => void;
  toDate?: Date;
  setToDate: (d?: Date) => void;
  activeQuickFilter: string;
  setActiveQuickFilter: (v: string) => void;
  onSubmit: (override?: { fromDate?: Date; toDate?: Date }) => void;
}

export function FilterSection({
  selectedEntity,
  setSelectedEntity,
  fromDate,
  setFromDate,
  toDate,
  setToDate,
  activeQuickFilter,
  setActiveQuickFilter,
  onSubmit,
}: FilterSectionProps) {
  const handleEntityChange = (value: string) => {
    const currentFrom = fromDate ? new Date(fromDate) : undefined;
    const currentTo = toDate ? new Date(toDate) : undefined;
    setSelectedEntity(value);
    setActiveQuickFilter('');
    setFromDate(currentFrom);
    setToDate(currentTo);
  };

  const handleFromDateSelect = (date?: Date) => {
    setFromDate(date);
    setActiveQuickFilter('');
  };

  const handleToDateSelect = (date?: Date) => {
    setToDate(date);
    setActiveQuickFilter('');
  };

  const handleQuickFilter = (filter: string) => {
    setActiveQuickFilter(filter);
    const now = getDubaiDate();
    const today = getDubaiDayStart(now);
    const todayEnd = getDubaiDayEnd(now);
    let nextFrom: Date | undefined;
    let nextTo: Date | undefined;
    switch (filter) {
      case 'today':
        nextFrom = today;
        nextTo = todayEnd;
        break;
      case 'yesterday':
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        nextFrom = yesterday;
        nextTo = new Date(yesterday);
        nextTo.setHours(23, 59, 59, 999);
        break;
      case 'this-week':
        const weekStart = new Date(today);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        nextFrom = weekStart;
        nextTo = todayEnd;
        break;
      case 'last-week':
        const lastWeekEnd = new Date(today);
        lastWeekEnd.setDate(lastWeekEnd.getDate() - lastWeekEnd.getDay() - 1);
        const lastWeekStart = new Date(lastWeekEnd);
        lastWeekStart.setDate(lastWeekStart.getDate() - 6);
        nextFrom = lastWeekStart;
        nextTo = lastWeekEnd;
        break;
      case 'this-month':
        nextFrom = new Date(today.getFullYear(), today.getMonth(), 1);
        nextTo = todayEnd;
        break;
      case 'last-month':
        const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
        nextFrom = lastMonthStart;
        nextTo = lastMonthEnd;
        break;
      case 'this-quarter':
        const quarter = Math.floor(today.getMonth() / 3);
        nextFrom = new Date(today.getFullYear(), quarter * 3, 1);
        nextTo = todayEnd;
        break;
      case 'ytd':
        nextFrom = new Date(today.getFullYear(), 0, 1);
        nextTo = todayEnd;
        break;
    }

    if (nextFrom || nextTo) {
      setFromDate(nextFrom ? new Date(nextFrom) : undefined);
      setToDate(nextTo ? new Date(nextTo) : undefined);
    }
  };

  const clearFilters = () => {
    const now = getDubaiDate();
    const today = getDubaiDayStart(now);
    const todayEnd = getDubaiDayEnd(now);
    setSelectedEntity('all');
    setFromDate(today);
    setToDate(todayEnd);
    setActiveQuickFilter('today');
  };

  const hasActiveFilters = selectedEntity !== 'all' || fromDate || toDate;

  return (
    <div className="cyber-card p-4">
      <div className="flex items-center justify-between gap-6">
        {/* Left: Entity & Date Filters */}
        <div className="flex items-center gap-4">
          {/* Filter Icon */}
          <div className="flex items-center gap-2 pr-4 border-r border-border/50">
            <div className="p-2 rounded-lg bg-primary/10">
              <Filter className="w-4 h-4 text-primary" />
            </div>
            <span className="text-sm font-medium text-muted-foreground">Filters</span>
          </div>

          {/* Entity Selector */}
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-muted-foreground" />
            <Select value={selectedEntity} onValueChange={handleEntityChange}>
              <SelectTrigger className="w-[180px] h-9 bg-secondary/50 border-border/50 hover:border-primary/50 transition-colors">
                <SelectValue placeholder="Select Entity" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border/50">
                {entities.map((entity) => (
                  <SelectItem 
                    key={entity.value} 
                    value={entity.value}
                    className="hover:bg-primary/10 focus:bg-primary/10 cursor-pointer"
                  >
                    {entity.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date Separator */}
          <div className="h-6 w-px bg-border/50" />

          {/* From Date */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "h-9 justify-start text-left font-normal bg-secondary/50 border-border/50 hover:border-primary/50 hover:bg-secondary/70",
                  !fromDate && "text-muted-foreground"
                )}
              >
                <Calendar className="mr-2 h-4 w-4" />
                {fromDate ? format(fromDate, "dd MMM yyyy") : "From Date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 bg-card border-border/50" align="start">
              <CalendarComponent
                mode="single"
                selected={fromDate}
                onSelect={handleFromDateSelect}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>

          {/* To Label */}
          <span className="text-xs text-muted-foreground font-mono">TO</span>

          {/* To Date */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "h-9 justify-start text-left font-normal bg-secondary/50 border-border/50 hover:border-primary/50 hover:bg-secondary/70",
                  !toDate && "text-muted-foreground"
                )}
              >
                <Calendar className="mr-2 h-4 w-4" />
                {toDate ? format(toDate, "dd MMM yyyy") : "To Date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 bg-card border-border/50" align="start">
              <CalendarComponent
                mode="single"
                selected={toDate}
                onSelect={handleToDateSelect}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>

          {/* Clear Filters */}
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-9 px-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              <X className="w-4 h-4 mr-1" />
              Clear
            </Button>
          )}
        </div>

        {/* Right: Quick Filters */}
        <div className="flex items-center gap-1.5">
          {quickFilters.map((filter) => (
            <button
              key={filter.value}
              onClick={() => handleQuickFilter(filter.value)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200",
                activeQuickFilter === filter.value
                  ? "bg-primary text-primary-foreground shadow-lg shadow-primary/25"
                  : "bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground border border-transparent hover:border-border/50"
              )}
            >
              {filter.label}
            </button>
          ))}
          <Button
            variant="default"
            size="sm"
            className="ml-2 h-9"
            onClick={onSubmit}
          >
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
}
