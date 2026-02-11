import { useEffect, useState } from 'react';
import { Shield, Bell, Settings, Clock, RefreshCw } from 'lucide-react';

export function DashboardHeader() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastUpdate, setLastUpdate] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    const updateTimer = setInterval(() => {
      setLastUpdate(new Date());
    }, 30000);

    return () => {
      clearInterval(timer);
      clearInterval(updateTimer);
    };
  }, []);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: false 
    });
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', { 
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  };

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-border/30 bg-gradient-to-r from-card/80 via-card/60 to-card/80 backdrop-blur-xl sticky top-0 z-50">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary via-primary/80 to-accent/60 flex items-center justify-center shadow-lg shadow-primary/30 animate-pulse-glow">
              <span className="font-display font-bold text-primary-foreground text-sm">FX</span>
            </div>
            <div className="absolute -inset-1 rounded-xl bg-gradient-to-br from-primary/20 to-accent/10 blur-sm -z-10" />
          </div>
          <div>
            <h1 className="font-display text-xl tracking-widest text-foreground">
              Sky Links <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">Capital</span>
            </h1>
            <p className="text-[10px] text-muted-foreground font-mono tracking-widest uppercase">Enterprise Dashboard v2.0</p>
          </div>
        </div>
        
        <div className="h-8 w-px bg-gradient-to-b from-transparent via-border/50 to-transparent mx-2" />
        
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-success/10 border border-success/30 shadow-inner shadow-success/5">
          <span className="w-2 h-2 rounded-full bg-success animate-pulse shadow-lg shadow-success/50" />
          <span className="text-xs font-mono text-success tracking-wider">SYSTEMS ONLINE</span>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground bg-secondary/30 px-3 py-1.5 rounded-lg">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: '3s' }} />
            <span className="text-xs font-mono">Last sync: {formatTime(lastUpdate)}</span>
          </div>
          
          <div className="h-4 w-px bg-border/30" />
          
          <div className="flex items-center gap-3 bg-gradient-to-r from-secondary/40 to-secondary/20 px-4 py-2 rounded-xl border border-border/30">
            <Clock className="w-4 h-4 text-primary" />
            <div className="text-right">
              <div className="font-mono text-lg font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-foreground to-foreground/80">{formatTime(currentTime)}</div>
              <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">{formatDate(currentTime)}</div>
            </div>
          </div>
        </div>

        <div className="h-8 w-px bg-gradient-to-b from-transparent via-border/50 to-transparent" />

        <div className="flex items-center gap-1">
          <button className="p-2.5 rounded-xl hover:bg-secondary/50 transition-all duration-200 relative group">
            <Bell className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
            <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-destructive animate-pulse shadow-lg shadow-destructive/50" />
          </button>
          <button className="p-2.5 rounded-xl hover:bg-secondary/50 transition-all duration-200 group">
            <Settings className="w-5 h-5 text-muted-foreground group-hover:text-primary group-hover:rotate-90 transition-all duration-300" />
          </button>
          <button className="p-2.5 rounded-xl hover:bg-secondary/50 transition-all duration-200 group">
            <Shield className="w-5 h-5 text-muted-foreground group-hover:text-success transition-colors" />
          </button>
        </div>

        <div className="flex items-center gap-3 pl-4 border-l border-border/30">
          <div className="text-right">
            <div className="text-sm font-semibold">Abbas</div>
            <div className="text-[10px] text-primary font-mono uppercase tracking-wider">Super Admin</div>
          </div>
          <div className="relative">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/40 via-accent/30 to-primary/20 flex items-center justify-center border border-primary/30 shadow-lg shadow-primary/20">
              <span className="font-display text-sm font-bold">AU</span>
            </div>
            <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-success border-2 border-card" />
          </div>
        </div>
      </div>
    </header>
  );
}
