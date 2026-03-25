import React from "react";
import { NavLink } from "react-router-dom";
import { Bell, Briefcase, Link2, ShieldCheck, Users, Workflow } from "lucide-react";
import { Separator } from "./ui/separator";
import { getCurrentUser } from "@/lib/auth";
import { getVisibleSettingsMenuItems } from "@/lib/permissions";

const settingsIconMap = {
  Bell,
  Briefcase,
  Link2,
  ShieldCheck,
  Users,
  Workflow,
} as const;

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
  (() => {
    const visibleItems = getVisibleSettingsMenuItems(getCurrentUser());
    const coreItems = visibleItems.filter((item) => item.group === "core");
    const adminItems = visibleItems.filter((item) => item.group === "admin");

    return (
      <aside className="hidden lg:flex lg:w-64 bg-card/70 h-full lg:sticky lg:top-[72px] flex-col py-6 px-4 shadow-lg border-r border-border/40 backdrop-blur-xl">
        <h2 className="text-foreground text-lg font-semibold mb-3">Settings</h2>
        <p className="text-xs text-muted-foreground mb-5">Configure integrations, alerts and access.</p>

        <nav className="flex flex-col gap-2">
          {coreItems.map((item) => (
            <Item key={item.key} to={item.path} label={item.name} icon={settingsIconMap[item.icon]} />
          ))}
        </nav>

        {adminItems.length > 0 ? <Separator className="my-6" /> : null}

        {adminItems.map((item) => (
          <Item key={item.key} to={item.path} label={item.name} icon={settingsIconMap[item.icon]} />
        ))}
      </aside>
    );
  })()
);
