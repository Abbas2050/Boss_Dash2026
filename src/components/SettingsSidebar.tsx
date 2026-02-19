import React from "react";
import { NavLink } from "react-router-dom";
import { Bell, Briefcase, Link2, ShieldCheck, Users, Workflow } from "lucide-react";
import { Separator } from "./ui/separator";

const settingsMenu = [
  { name: "Coverage", path: "/settings/coverage", icon: Workflow },
  { name: "LP Manager", path: "/settings/lp-manager", icon: Briefcase },
  { name: "Symbol Mapping", path: "/settings/symbol-mapping", icon: Link2 },
  { name: "Alerts", path: "/settings/alerts", icon: Bell },
  { name: "WS Test", path: "/settings/ws-test", icon: ShieldCheck },
];

function Item({
  to,
  label,
  icon: Icon,
}: {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          "group flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
          isActive
            ? "bg-primary/15 text-primary border border-primary/30 shadow-[0_0_0_1px_hsl(var(--primary)/0.15)_inset]"
            : "text-foreground/80 hover:bg-secondary/60 hover:text-foreground border border-transparent",
        ].join(" ")
      }
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </NavLink>
  );
}

export const SettingsSidebar: React.FC = () => (
  <aside className="w-64 bg-card/70 h-full flex flex-col py-6 px-4 shadow-lg border-r border-border/40 backdrop-blur-xl">
    <h2 className="text-foreground text-lg font-semibold mb-3">Settings</h2>
    <p className="text-xs text-muted-foreground mb-5">Configure integrations, alerts and access.</p>

    <nav className="flex flex-col gap-2">
      {settingsMenu.map((item) => (
        <Item key={item.name} to={item.path} label={item.name} icon={item.icon} />
      ))}
    </nav>

    <Separator className="my-6" />

    <Item to="/settings/user-management" label="User Management" icon={Users} />
  </aside>
);
