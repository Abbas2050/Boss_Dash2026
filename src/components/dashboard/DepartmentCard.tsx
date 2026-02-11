import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';

interface DepartmentCardProps {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  accentColor?: 'primary' | 'success' | 'warning' | 'destructive';
}

const accentColors = {
  primary: 'hsl(186 100% 50%)',
  success: 'hsl(142 76% 45%)',
  warning: 'hsl(38 92% 50%)',
  destructive: 'hsl(0 85% 55%)',
};

export function DepartmentCard({ title, icon: Icon, children, accentColor = 'primary' }: DepartmentCardProps) {
  const color = accentColors[accentColor];
  
  return (
    <div className="cyber-card h-full p-4 corner-accent">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 pb-3 border-b border-border/50">
        <div 
          className="p-2 rounded-lg"
          style={{ 
            background: `linear-gradient(135deg, ${color}20, transparent)`,
            boxShadow: `0 0 20px ${color}30`
          }}
        >
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
        <h2 className="font-display text-sm tracking-wider uppercase" style={{ color }}>
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
          <span className="text-xs text-muted-foreground font-mono">LIVE</span>
        </div>
      </div>
      
      {/* Content */}
      <div className="space-y-3">
        {children}
      </div>
    </div>
  );
}
