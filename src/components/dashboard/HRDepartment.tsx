import { useEffect, useState } from 'react';
import { Users, UserCheck, Calendar, AlertCircle, FileCheck, Shield } from 'lucide-react';
import { DepartmentCard } from './DepartmentCard';
import { MetricRow } from './MetricRow';
import { ProgressBar } from './ProgressBar';
import { StatusBadge } from './StatusBadge';

interface LeaveEntry {
  name: string;
  from: string;
  to: string;
  returnDate: string;
  status: 'ongoing' | 'upcoming' | 'returning';
}

export function HRDepartment({ selectedEntity, fromDate, toDate, refreshKey }: { selectedEntity: string; fromDate?: Date; toDate?: Date; refreshKey: number }) {
  const [metrics, setMetrics] = useState({
    presentToday: 12,
    onLeave: 2,
    totalWorkforce: 14,
    complianceStatus: 94,
    visaExpirations: 3,
  });

  const leaveSchedule: LeaveEntry[] = [
    { name: 'Apollo', from: '19-Jan-26', to: '6-Feb-26', returnDate: '9-Feb-26', status: 'ongoing' },
    { name: 'Praveen', from: '4-Feb-26', to: '4-Feb-26', returnDate: '5-Feb-26', status: 'ongoing' },
    { name: 'Prem', from: '9-Mar-26', to: '19-Mar-26', returnDate: '20-Mar-26', status: 'upcoming' },
    { name: 'Sujaan', from: '23-Mar-26', to: '27-Mar-26', returnDate: '30-Mar-26', status: 'upcoming' },
  ];

  useEffect(() => {
    console.log('👥 HRDepartment filters:', { selectedEntity, fromDate, toDate, refreshKey });
  }, [selectedEntity, fromDate, toDate, refreshKey]);

  const attendanceRate = (metrics.presentToday / metrics.totalWorkforce) * 100;


  return (
    <DepartmentCard title="Human Resources" icon={Users} accentColor="warning">
      {/* Attendance Cards */}
      <div className="grid grid-cols-3 gap-2">
        <div className="text-center p-2 rounded-lg bg-success/10 border border-success/20">
          <UserCheck className="w-4 h-4 text-success mx-auto mb-1" />
          <div className="font-mono font-semibold text-lg">{metrics.presentToday}</div>
          <div className="text-xs text-muted-foreground">Present</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-warning/10 border border-warning/20">
          <Calendar className="w-4 h-4 text-warning mx-auto mb-1" />
          <div className="font-mono font-semibold text-lg">{metrics.onLeave}</div>
          <div className="text-xs text-muted-foreground">On Leave</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-primary/10 border border-primary/20">
          <Users className="w-4 h-4 text-primary mx-auto mb-1" />
          <div className="font-mono font-semibold text-lg">{metrics.totalWorkforce}</div>
          <div className="text-xs text-muted-foreground">Total</div>
        </div>
      </div>

      {/* Attendance Rate Progress */}
      <div className="pt-2 border-t border-border/30">
        <ProgressBar 
          value={attendanceRate} 
          color={attendanceRate > 90 ? 'success' : attendanceRate > 80 ? 'warning' : 'destructive'} 
          label={`Attendance Rate: ${attendanceRate.toFixed(1)}%`}
        />
      </div>

      {/* Leave Schedule */}
      <div className="pt-2 border-t border-border/30">
        <div className="flex items-center gap-2 mb-2">
          <Calendar className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs text-muted-foreground font-semibold">Leave Schedule</span>
        </div>
        <div className="space-y-1.5">
          {leaveSchedule.map((leave, idx) => (
            <div key={idx} className="p-2 rounded-md bg-secondary/30 border border-border/40 text-xs">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-semibold text-foreground">{leave.name}</span>
                <StatusBadge 
                  status={leave.status === 'ongoing' ? 'online' : 'warning'} 
                  label={leave.status === 'ongoing' ? 'Ongoing' : 'Upcoming'} 
                />
              </div>
              <div className="grid grid-cols-3 gap-2 text-muted-foreground text-[10px]">
                <div>
                  <div className="text-[9px] opacity-70">From</div>
                  <span className="font-mono">{leave.from}</span>
                </div>
                <div>
                  <div className="text-[9px] opacity-70">To</div>
                  <span className="font-mono">{leave.to}</span>
                </div>
                <div>
                  <div className="text-[9px] opacity-70">Return</div>
                  <span className="font-mono text-success">{leave.returnDate}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </DepartmentCard>
  );
}
