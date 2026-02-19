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
  return (
    <header className="flex items-center justify-between bg-[#0d0d14] px-6 py-3 shadow-md">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="bg-blue-500 rounded-lg w-10 h-10 flex items-center justify-center text-white font-bold text-xl">FX</div>
          <span className="text-white text-lg font-semibold">Sky Links <span className="text-blue-400">Capital</span></span>
        </div>
        <Separator orientation="vertical" className="mx-4 h-8" />
        <nav className="flex items-center gap-2">
          <span className="text-green-400 font-medium text-sm bg-[#1a3a2a] px-3 py-1 rounded">● SYSTEMS ONLINE</span>
          <Separator orientation="vertical" className="mx-2 h-6" />
          <span className="text-gray-400 text-xs">Last sync: {lastSync}</span>
          <Separator orientation="vertical" className="mx-2 h-6" />
          <Link to="/departments/dealing" className="text-blue-400 hover:underline text-sm px-2">Dealing</Link>
          <Link to="/departments/backoffice" className="text-blue-400 hover:underline text-sm px-2">Backoffice</Link>
          <Link to="/departments/hr" className="text-blue-400 hover:underline text-sm px-2">HR</Link>
          <Link to="/departments/marketing" className="text-blue-400 hover:underline text-sm px-2">Marketing</Link>
          <Link to="/departments/accounts" className="text-blue-400 hover:underline text-sm px-2">Accounts</Link>
        </nav>
      </div>
      <div className="flex items-center gap-6">
        <div className="flex flex-col items-end">
          <span className="text-white text-lg font-mono tracking-widest">{new Date().toLocaleTimeString()}</span>
          <span className="text-gray-400 text-xs">{new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
        </div>
        <button className="relative">
          <span className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full"></span>
          <svg width="24" height="24" fill="none" stroke="white" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2H10a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.92V4a1 1 0 0 0-2 0v1.08A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
        </button>
        <button>
          <svg width="24" height="24" fill="none" stroke="white" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
        </button>
        <button>
          <svg width="24" height="24" fill="none" stroke="white" strokeWidth="2" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8v8H8z"/></svg>
        </button>
        <Switch checked={theme === "light"} onCheckedChange={onThemeToggle} />
        <div className="flex items-center gap-2">
          <span className="text-white font-semibold">Abbas</span>
          <span className="text-blue-400 text-xs">SUPER ADMIN</span>
          <Avatar>
            <AvatarFallback>AU</AvatarFallback>
          </Avatar>
        </div>
      </div>
    </header>
  );
};
