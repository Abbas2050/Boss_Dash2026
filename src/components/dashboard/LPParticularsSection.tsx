import React from "react";
import { DepartmentCard } from "./DepartmentCard";
import { DollarSign } from "lucide-react";
import { MetricRow } from "./MetricRow";

const lpData = [
  { lp: "NOOR CAPITAL", equity: 1161475, marginLevel: "299 %", safestLimit: 1500000 },
  { lp: "BROCTAGON", equity: 1010028, marginLevel: "497 %", safestLimit: 600000 },
  { lp: "FX EDGE", equity: 719281, marginLevel: "289 %", safestLimit: 800000 },
  { lp: "LMAX", equity: 728566, marginLevel: "11177 %", safestLimit: 1000000 },
  { lp: "HANTEC", equity: 743080, marginLevel: "3315 %", safestLimit: 550000 },
  { lp: "AMANA", equity: 382922, marginLevel: "403 %", safestLimit: 1500000 },
];

const totals = {
  equity: 11764025,
  equityWithdraw: 7604025,
  balance: 7581673,
  credit: 4160000,
  margin: 7789710,
  freeMargin: 9880474,
  safestLimit: 13700000,
};

export const LPParticularsSection: React.FC = () => (
  <DepartmentCard title="LP Particulars" icon={DollarSign} accentColor="primary">
    <div className="flex items-center justify-between mb-2">
      <div className="text-sm font-semibold text-primary tracking-wide flex items-center gap-2">
        <DollarSign className="w-4 h-4 text-primary" />
        Top LPs <span className="text-xs text-muted-foreground font-normal">(by Equity)</span>
      </div>
      <div className="text-xs text-muted-foreground font-mono">2026-02-16 10:01:02</div>
    </div>
    <div className="grid grid-cols-3 gap-3 pb-2 mb-6 w-full">
      {lpData.map((row, i) => {
        // Parse margin level as number (remove % and spaces)
        const marginNum = parseFloat((row.marginLevel || '').replace(/[^\d.\-]/g, ''));
        const isHealthy = marginNum > 200;
        const equityColor = isHealthy ? 'text-green-400' : 'text-red-400';
        const marginColor = isHealthy ? 'text-green-500 font-bold' : 'text-red-500 font-bold';
        const barColor = isHealthy ? 'from-green-400 to-green-600' : 'from-red-400 to-red-600';
        return (
          <div
            key={row.lp}
            className={
              `relative p-3 rounded-lg border bg-card/30 border-primary/20 flex flex-col items-start justify-center min-h-[90px] group transition-all duration-200 cursor-pointer hover:scale-[1.03] hover:shadow-xl`}
          >
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-primary" />
              <span className="font-mono text-xs font-semibold tracking-wider">{row.lp}</span>
            </div>
            <div className={`font-mono font-bold text-lg ${equityColor}`}> 
              {row.equity.toLocaleString()} <span className="text-xs font-normal">USD</span>
            </div>
            <div className={marginColor}>
              Margin Level: {row.marginLevel}
            </div>
            <div className="w-full bg-muted/30 rounded h-2 mt-2 overflow-hidden">
              <div
                className={`bg-gradient-to-r ${barColor} h-2 rounded`}
                style={{ width: row.safestLimit && typeof row.safestLimit === 'number' && row.safestLimit > 0 ? `${Math.min(100, (row.equity / row.safestLimit) * 100)}%` : '100%' }}
              />
            </div>
            <div className="flex justify-between text-xs mt-1 text-muted-foreground font-mono w-full">
              <span>Equity</span>
              <span>Limit: {typeof row.safestLimit === 'number' ? row.safestLimit.toLocaleString() : row.safestLimit}</span>
            </div>
          </div>
        );
      })}
    </div>
    <div className="space-y-1 pt-2 border-t border-border/30">
      <MetricRow label="Total Equity" value={totals.equity} prefix="$" icon={<DollarSign className="w-3.5 h-3.5" />} />
      <MetricRow label="Total Limit" value={totals.safestLimit} prefix="$" icon={<DollarSign className="w-3.5 h-3.5" />} />
      <MetricRow label="Total Withdrawable" value={totals.equityWithdraw} prefix="$" icon={<DollarSign className="w-3.5 h-3.5" />} />
    </div>
  </DepartmentCard>
);
