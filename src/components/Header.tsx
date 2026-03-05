import React from "react";
import { Switch } from "./ui/switch";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Separator } from "./ui/separator";
import { Link } from "react-router-dom";

interface HeaderProps {
  systemStatus: string;
  lastSync: string;
  theme: "dark" | "light";
  onThemeToggle: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  systemStatus,
  lastSync,
  theme,
  onThemeToggle,
}) => {
  const isOnline = String(systemStatus || "").toLowerCase() === "online";

  return (
    <header className="flex items-center justify-between border-b border-border/50 bg-card/95 px-6 py-3 text-foreground shadow-md backdrop-blur">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-xl font-bold text-primary-foreground">FX</div>
          <span className="text-lg font-semibold">
            Sky Links <span className="text-primary">Capital</span>
          </span>
        </div>
        <Separator orientation="vertical" className="mx-4 h-8" />
        <nav className="flex items-center gap-2">
          <span className={`rounded px-3 py-1 text-sm font-medium ${isOnline ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
            ● {isOnline ? "SYSTEMS ONLINE" : "CHECKING SYSTEMS"}
          </span>
          <Separator orientation="vertical" className="mx-2 h-6" />
          <span className="text-xs text-muted-foreground">Last sync: {lastSync}</span>
          <Separator orientation="vertical" className="mx-2 h-6" />
          <Link to="/departments/dealing" className="px-2 text-sm text-primary hover:underline">Dealing</Link>
          <Link to="/departments/backoffice" className="px-2 text-sm text-primary hover:underline">Backoffice</Link>
          <Link to="/departments/hr" className="px-2 text-sm text-primary hover:underline">HR</Link>
          <Link to="/departments/marketing" className="px-2 text-sm text-primary hover:underline">Marketing</Link>
          <Link to="/departments/accounts" className="px-2 text-sm text-primary hover:underline">Accounts</Link>
        </nav>
      </div>
      <div className="flex items-center gap-6">
        <div className="flex flex-col items-end">
          <span className="text-lg font-mono tracking-widest text-foreground">{new Date().toLocaleTimeString()}</span>
          <span className="text-xs text-muted-foreground">
            {new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
          </span>
        </div>
        <button className="relative text-muted-foreground hover:text-foreground" type="button" aria-label="Notifications">
          <span className="absolute right-0 top-0 h-2 w-2 rounded-full bg-destructive" />
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2H10a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.92V4a1 1 0 0 0-2 0v1.08A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
        </button>
        <button className="text-muted-foreground hover:text-foreground" type="button" aria-label="Clock">
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
        </button>
        <button className="text-muted-foreground hover:text-foreground" type="button" aria-label="Apps">
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8v8H8z"/></svg>
        </button>
        <Switch checked={theme === "light"} onCheckedChange={onThemeToggle} />
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Abbas</span>
          <span className="text-xs text-primary">SUPER ADMIN</span>
          <Avatar>
            <AvatarFallback>AU</AvatarFallback>
          </Avatar>
        </div>
      </div>
    </header>
  );
};
