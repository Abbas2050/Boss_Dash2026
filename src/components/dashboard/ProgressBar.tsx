interface ProgressBarProps {
  value: number;
  max?: number;
  label?: string;
  color?: 'primary' | 'success' | 'warning' | 'destructive';
  showValue?: boolean;
}

const colorClasses = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

const glowColors = {
  primary: 'shadow-[0_0_10px_hsl(186_100%_50%_/_0.5)]',
  success: 'shadow-[0_0_10px_hsl(142_76%_45%_/_0.5)]',
  warning: 'shadow-[0_0_10px_hsl(38_92%_50%_/_0.5)]',
  destructive: 'shadow-[0_0_10px_hsl(0_85%_55%_/_0.5)]',
};

export function ProgressBar({ 
  value, 
  max = 100, 
  label, 
  color = 'primary',
  showValue = true 
}: ProgressBarProps) {
  const percentage = Math.min((value / max) * 100, 100);
  
  return (
    <div className="space-y-1.5">
      {(label || showValue) && (
        <div className="flex items-center justify-between text-xs">
          {label && <span className="text-muted-foreground">{label}</span>}
          {showValue && <span className="font-mono text-foreground">{percentage.toFixed(0)}%</span>}
        </div>
      )}
      <div className="h-2 bg-secondary/50 rounded-full overflow-hidden">
        <div 
          className={`h-full rounded-full transition-all duration-500 ${colorClasses[color]} ${glowColors[color]}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
