import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard, Server, FolderTree, Play, MessagesSquare,
  Workflow, Activity, Zap, Package, Send, BarChart3, ScrollText, Users, Settings2,
} from "lucide-react";

const groups = [
  {
    label: "Operate",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/workflows", label: "Workflows", icon: Workflow },
      { to: "/runs", label: "Runs", icon: Activity },
      { to: "/jobs", label: "Jobs", icon: Play },
      { to: "/triggers", label: "Triggers", icon: Zap },
    ],
  },
  {
    label: "Fleet",
    items: [
      { to: "/fleet", label: "Workers", icon: Server },
      { to: "/workspaces", label: "Workspaces", icon: FolderTree },
      { to: "/conversations", label: "Conversations", icon: MessagesSquare },
    ],
  },
  {
    label: "Data & Audit",
    items: [
      { to: "/artifacts", label: "Artifacts", icon: Package },
      { to: "/deliveries", label: "Deliveries", icon: Send },
      { to: "/usage", label: "Usage", icon: BarChart3 },
      { to: "/audit", label: "Audit Log", icon: ScrollText },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/users", label: "Users & Tokens", icon: Users },
      { to: "/settings", label: "Settings", icon: Settings2 },
    ],
  },
] as const;

export function AtlasSidebar() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => path === to || (to !== "/dashboard" && path.startsWith(to));

  return (
    <nav className="hidden md:flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="grid size-8 place-items-center rounded bg-primary font-bold text-primary-foreground shadow-[0_0_15px_color-mix(in_oklab,var(--color-primary)_50%,transparent)]">
          A
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold tracking-tight">ATLAS.OS</span>
          <span className="font-mono text-[10px] text-muted-foreground">control plane v2.4</span>
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-3 pb-6">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="mb-2 px-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {g.label}
            </div>
            <div className="space-y-0.5">
              {g.items.map(({ to, label, icon: Icon }) => {
                const active = isActive(to);
                return (
                  <Link
                    key={to}
                    to={to}
                    className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-primary/10 text-primary border border-primary/25"
                        : "text-muted-foreground border border-transparent hover:bg-white/5 hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-4" />
                    <span className="font-medium">{label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-4">
        <div className="flex items-center gap-3 px-2 py-1">
          <div className="grid size-8 place-items-center rounded bg-secondary font-mono text-xs">01</div>
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-medium">Operator 01</span>
            <span className="font-mono text-[10px] text-muted-foreground">SYS_ADMIN</span>
          </div>
        </div>
      </div>
    </nav>
  );
}