import { useEffect, useState } from 'react';
import { Clock, RefreshCw, TrendingUp, FileText, Users, MoonStar, Sun } from 'lucide-react';
import { NavLink } from '../../components/NavLink';
import { Button } from '../../components/ui/button';
import { FiSettings } from 'react-icons/fi';
import { Switch } from '../ui/switch';
// notifications moved out of header
import { Toast } from '../Toast';
import { useMemo } from 'react';
import { getCurrentUser, hasAccess, logout } from '@/lib/auth';
import { useNavigate } from 'react-router-dom';

interface DashboardHeaderProps {
  theme: 'dark' | 'light';
  onThemeToggle: () => void;
}

export function DashboardHeader({ theme, onThemeToggle }: DashboardHeaderProps) {
  const navigate = useNavigate();
  const currentUser = getCurrentUser();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [mobileOpen, setMobileOpen] = useState(false);

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

  // simple toast list for minimized alerts
  const [toasts, setToasts] = useState<{id:string;message:string}[]>([]);
  const addToast = (message: string) => {
    const id = String(Date.now());
    setToasts(t => [...t, { id, message }]);
  };
  const removeToast = (id: string) => setToasts(t => t.filter(x => x.id !== id));

  // sample: move any NotificationPanel emits into toasts (placeholder)
  const exampleAlert = useMemo(() => () => addToast('New alert: Coverage drift detected'), []);

  // derive system online state from last update timestamp (true if recent)
  const systemOnline = (Date.now() - lastUpdate.getTime()) < 120000; // 2 minutes
  const can = (section: string) => hasAccess(section);

  return (
    <>
    <header className="flex items-center justify-between px-2 md:px-6 py-2 md:py-3 border-b border-border/30 bg-gradient-to-r from-card/80 via-card/60 to-card/80 backdrop-blur-xl sticky top-0 z-50">
      {/* Left: logo, title, nav, online */}
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

        <div className="flex items-center gap-4">
          <nav className="hidden md:flex items-center gap-2">
            <NavLink to="/" activeClassName="bg-primary/10 text-primary shadow" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-foreground/90 hover:bg-card/40 transition">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
              <span>Home</span>
            </NavLink>
            {can("Dealing") && <NavLink to="/departments/dealing" activeClassName="bg-primary/10 text-primary shadow" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-foreground/90 hover:bg-card/40 transition">
              <TrendingUp className="w-4 h-4" />
              <span>Dealing</span>
            </NavLink>}
            {can("Backoffice") && <NavLink to="/departments/backoffice" activeClassName="bg-primary/10 text-primary shadow" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-foreground/90 hover:bg-card/40 transition">
              <FileText className="w-4 h-4" />
              <span>Backoffice</span>
            </NavLink>}
            {can("Accounts") && <NavLink to="/departments/accounts" activeClassName="bg-primary/10 text-primary shadow" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-foreground/90 hover:bg-card/40 transition">
              <Users className="w-4 h-4" />
              <span>Accounts</span>
            </NavLink>}
            {can("Marketing") && <NavLink to="/departments/marketing" activeClassName="bg-primary/10 text-primary shadow" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-foreground/90 hover:bg-card/40 transition">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 10v6a1 1 0 0 0 1 1h3m10-7v6a1 1 0 0 1-1 1h-3m-6-7V7a1 1 0 0 1 1-1h3m6 0v2m0 0a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4z" /></svg>
              <span>Marketing</span>
            </NavLink>}
            {can("HR") && <NavLink to="/departments/hr" activeClassName="bg-primary/10 text-primary shadow" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-foreground/90 hover:bg-card/40 transition">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="7" r="4" /><path d="M5.5 21a7.5 7.5 0 0 1 13 0" /></svg>
              <span>HR</span>
            </NavLink>}
          </nav>
        </div>
      </div>

      {/* Right: timers, controls, switch, profile */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground bg-secondary/30 px-2 py-1 rounded-md">
            <RefreshCw className="w-4 h-4 animate-spin" style={{ animationDuration: '3s' }} />
            <span className="text-xs font-mono">{formatTime(lastUpdate)}</span>
          </div>

          <div className="h-4 w-px bg-border/30" />

          <div className="hidden sm:flex items-center gap-2 bg-secondary/10 px-3 py-1 rounded-md">
            <Clock className="w-4 h-4 text-primary" />
            <div className="font-mono text-sm font-semibold">{formatTime(currentTime)}</div>
          </div>
        </div>

        <div className="h-8 w-px bg-gradient-to-b from-transparent via-border/50 to-transparent" />

        <div className="flex items-center gap-2">
          {can("Settings") && <div className="hidden md:block">
            <NavLink to="/settings/coverage">
              <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-foreground p-2" aria-label="Settings">
                <FiSettings size={20} />
              </Button>
            </NavLink>
          </div>}

          {/* Mobile hamburger */}
          <div className="md:hidden">
            <button onClick={() => setMobileOpen(o => !o)} className="p-2 rounded-md bg-secondary/10">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground"><path d="M3 12h18M3 6h18M3 18h18"></path></svg>
            </button>
          </div>
        </div>

        <div className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-secondary/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
          <MoonStar className={`h-4 w-4 ${theme === 'dark' ? 'text-primary' : ''}`} />
          <Switch checked={theme === 'light'} onCheckedChange={() => onThemeToggle()} />
          <Sun className={`h-4 w-4 ${theme === 'light' ? 'text-warning' : ''}`} />
        </div>

        <div className="flex items-center gap-3 pl-4 border-l border-border/30">
          <div className="text-right">
            <div className="text-sm font-semibold">{currentUser?.name || "Guest"}</div>
            <div className="text-[10px] text-primary font-mono uppercase tracking-wider">{currentUser?.role || "User"}</div>
          </div>
          <div className="relative">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/40 via-accent/30 to-primary/20 flex items-center justify-center border border-primary/30 shadow-lg shadow-primary/20">
              <span className="font-display text-sm font-bold">
                {(currentUser?.name || "U").split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full ${systemOnline ? 'bg-success' : 'bg-destructive'} border-2 border-card`} aria-label={systemOnline ? 'System online' : 'System offline'} />
          </div>
          <button
            onClick={() => {
              logout();
              navigate("/login");
            }}
            className="ml-2 text-xs rounded-md border border-border/50 px-2 py-1 hover:bg-secondary/60"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
    {/* Toast container */}
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
      {toasts.map(t => (
        <Toast key={t.id} id={t.id} message={t.message} onClose={removeToast} />
      ))}
    </div>

    {/* Mobile slide-over menu */}
    {mobileOpen && (
      <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setMobileOpen(false)}>
        <div className="absolute right-0 top-0 w-64 h-full bg-card shadow-lg p-4" onClick={e => e.stopPropagation()}>
          <nav className="flex flex-col gap-2">
            {can("Dealing") && <NavLink to="/departments/dealing" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card/40 transition"><TrendingUp className="w-4 h-4" />Dealing</NavLink>}
            {can("Backoffice") && <NavLink to="/departments/backoffice" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card/40 transition"><FileText className="w-4 h-4" />Backoffice</NavLink>}
            {can("Accounts") && <NavLink to="/departments/accounts" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card/40 transition"><Users className="w-4 h-4" />Accounts</NavLink>}
            {can("Marketing") && <NavLink to="/departments/marketing" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card/40 transition"><svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 10v6a1 1 0 0 0 1 1h3m10-7v6a1 1 0 0 1-1 1h-3m-6-7V7a1 1 0 0 1 1-1h3m6 0v2m0 0a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4z" /></svg>Marketing</NavLink>}
            {can("HR") && <NavLink to="/departments/hr" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card/40 transition"><svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="7" r="4" /><path d="M5.5 21a7.5 7.5 0 0 1 13 0" /></svg>HR</NavLink>}
            {can("Settings") && <NavLink to="/settings/coverage" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card/40 transition">Coverage</NavLink>}
            {can("Settings") && <NavLink to="/settings/lp-manager" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card/40 transition">LP Manager</NavLink>}
            {can("Settings") && <NavLink to="/settings/user-management" className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card/40 transition">User Management</NavLink>}
          </nav>
        </div>
      </div>
    )}
    </>
  );
}
