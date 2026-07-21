import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Server,
  FolderTree,
  Play,
  MessagesSquare,
  Workflow,
  Activity,
  Zap,
  Package,
  Send,
  BarChart3,
  ScrollText,
  Users,
  Settings2,
  LogOut,
} from "lucide-react";
import { useState } from "react";

import { logoutFn } from "@/lib/auth.functions";
import type { IdentityView } from "@/lib/atlas-mappers";

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
      { to: "/deliveries", label: "Webhook Deliveries", icon: Send },
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

export function AtlasSidebar({ identity }: { identity?: IdentityView }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isActive = (to: string) => path === to || (to !== "/dashboard" && path.startsWith(to));
  const router = useRouter();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      // Always best-effort: the server clears the local session even when Atlas revocation
      // fails, so the user ends up signed out either way.
      await logoutFn();
    } finally {
      /**
       * Drop every cached Atlas response before leaving.
       *
       * `router.invalidate()` only invalidates router loader data; the TanStack Query cache
       * survives it and survives the navigation, because the QueryClient lives for the life of
       * the page. Without this, signing out and signing in as someone else in the same tab
       * renders the *previous* user's workers, runs, and jobs from cache until each query
       * happens to go stale — data the new identity may not be entitled to see.
       */
      queryClient.clear();
      await router.invalidate();
      await router.navigate({ to: "/auth" });
      setSigningOut(false);
    }
  }

  return (
    <nav className="hidden md:flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="grid size-8 place-items-center rounded bg-primary font-bold text-primary-foreground shadow-[0_0_15px_color-mix(in_oklab,var(--color-primary)_50%,transparent)]">
          A
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold tracking-tight">ATLAS.OS</span>
          {/* No version here: the scaffold's "v2.4" was invented. The real Atlas version is
              on the dashboard header and the Settings page, sourced from /api/metrics. */}
          <span className="font-mono text-[10px] text-muted-foreground">control plane</span>
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
                    // The active page is announced, not only coloured.
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-primary/10 text-primary border border-primary/25"
                        : "text-muted-foreground border border-transparent hover:bg-white/5 hover:text-foreground"
                    }`}
                  >
                    <Icon className="size-4" aria-hidden="true" />
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
          <div className="grid size-8 shrink-0 place-items-center rounded bg-secondary font-mono text-xs">
            {identity?.initials ?? "--"}
          </div>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-xs font-medium">
              {identity?.username ?? "Signed out"}
            </span>
            {/* Role is a display hint. Atlas enforces the real permission on every call. */}
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {identity?.roleLabel ?? "—"}
            </span>
          </div>
          {identity ? (
            <button
              type="button"
              onClick={onSignOut}
              disabled={signingOut}
              title="Sign out"
              aria-label="Sign out"
              className="ml-auto grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              <LogOut className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </nav>
  );
}
