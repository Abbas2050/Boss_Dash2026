import { ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface MetricRowProps {
  label: string;
  value: string | number;
  change?: number;
  prefix?: string;
  suffix?: string;
  icon?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export function MetricRow({ 
  label, 
  value, 
  change, 
  prefix = '', 
  suffix = '',
  icon,
  size = 'md'
}: MetricRowProps) {
  const sizeClasses = {
    sm: 'text-xs sm:text-sm',
    md: 'text-base sm:text-lg',
    lg: 'text-xl sm:text-2xl',
  };

  const getTrendIcon = () => {
    if (change === undefined || change === 0) return <Minus className="w-3 h-3 text-muted-foreground" />;
    if (change > 0) return <TrendingUp className="w-3 h-3 text-success" />;
    return <TrendingDown className="w-3 h-3 text-destructive" />;
  };

  const getTrendColor = () => {
    if (change === undefined || change === 0) return 'text-muted-foreground';
    if (change > 0) return 'status-positive';
    return 'status-negative';
  };

  return (
    <div className="flex items-start sm:items-center justify-between py-1.5 group hover:bg-primary/5 px-2 -mx-2 rounded transition-colors gap-2">
      <div className="min-w-0 flex flex-1 items-start sm:items-center gap-2">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <span className="text-muted-foreground text-xs sm:text-sm leading-tight font-body break-words">{label}</span>
      </div>
      <div className="shrink-0 flex items-center gap-2 text-right">
        <span className={`font-mono font-semibold ${sizeClasses[size]}`}>
          {prefix}{typeof value === 'number' ? value.toLocaleString() : value}{suffix}
        </span>
        {change !== undefined && (
          <div className={`flex items-center gap-1 ${getTrendColor()}`}>
            {getTrendIcon()}
            <span className="text-xs font-mono">{Math.abs(change).toFixed(1)}%</span>
          </div>
        )}
      </div>
    </div>
  );
}
