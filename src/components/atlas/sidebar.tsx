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
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { logoutFn } from "@/lib/auth.functions";
import type { IdentityView } from "@/lib/atlas-mappers";
import type { AtlasRole } from "@/lib/atlas-types";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

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

/**
 * Destinations that not every role can read, and who can.
 *
 * Transcribed from the role/permission matrix in `docs/BACKEND_INTEGRATION.md` (re-verified at
 * Atlas `82207f7`): `/audit` and `/usage` need `audit.read`, `/deliveries` needs
 * `deliveries.read`, and `/users` needs `admin`. Every other destination is a plain `read`,
 * which all four roles hold, so it is absent here.
 *
 * This is **UX only** — the "hide/disable" carve-out, not a second authorization system. Three
 * things make hiding safe rather than a security claim: Atlas re-checks the real role on every
 * call, `_app`'s loader re-verifies the identity on every navigation so this role is current
 * rather than a cookie cache, and each of these pages still renders its own explicit forbidden
 * state when reached directly by URL. The worst case of a role changing underneath us is a link
 * missing for one navigation — never a page that becomes reachable.
 *
 * Why hide instead of disable: an external tenant is a first-class audience here, and a rail of
 * fourteen icons that mostly answer 403 advertises an internal control plane they cannot enter.
 */
const RESTRICTED_DESTINATIONS: Record<string, readonly AtlasRole[]> = {
  "/deliveries": ["admin", "operator", "auditor"],
  "/usage": ["admin", "auditor"],
  "/audit": ["admin", "auditor"],
  "/users": ["admin"],
};

/** Local view preference only — never identity or domain state. */
const NAV_COLLAPSED_KEY = "flow-designer:nav-collapsed";

/**
 * The destinations this identity can actually read, with empty groups dropped.
 *
 * Shared by the desktop rail and the mobile drawer so the two can never disagree about what a
 * role is offered — a drawer that quietly listed four extra 403s would be worse than no drawer.
 */
function useVisibleGroups(identity?: IdentityView) {
  const role = identity?.role;
  return groups
    .map((group) => ({
      label: group.label,
      items: group.items.filter(({ to }) => {
        const allowed = RESTRICTED_DESTINATIONS[to];
        return allowed === undefined || (role !== undefined && allowed.includes(role));
      }),
    }))
    .filter((group) => group.items.length > 0);
}

/** Sign-out, shared by both navigations. See the comment inside for why the cache is cleared. */
function useSignOut() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);

  const onSignOut = useCallback(async () => {
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
  }, [signingOut, queryClient, router]);

  return { signingOut, onSignOut };
}

const isActivePath = (path: string, to: string) =>
  path === to || (to !== "/dashboard" && path.startsWith(to));

/**
 * Navigation below `md`, where the rail is `hidden` and there was previously nothing at all.
 *
 * Not a scaled-down rail: at 375px an icon column would eat a seventh of the width for the
 * whole session, so navigation collapses to one 44px control and a drawer that is only present
 * while it is being used. The bar keeps the two things the rail was also providing and the
 * mobile layout had silently dropped — where you are, and a way to sign out.
 *
 * A top bar rather than the thumb-friendlier bottom edge: on the workflow editor the bottom is
 * already taken by the canvas zoom controls and the Inspector button, and navigation that
 * overlaps the tool you are using is worse than navigation one reach further away.
 */
export function AtlasMobileNav({ identity }: { identity?: IdentityView }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const visibleGroups = useVisibleGroups(identity);
  const { signingOut, onSignOut } = useSignOut();

  // Close on navigation. Radix keeps an open sheet open across a route change, which would
  // leave the drawer covering the page the operator just asked for.
  useEffect(() => setOpen(false), [path]);

  const current = visibleGroups
    .flatMap((group) => group.items)
    .find(({ to }) => isActivePath(path, to));

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2 py-1.5 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation"
            className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-interactive hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-[17rem] flex-col gap-0 bg-sidebar p-0">
          <SheetHeader className="border-b border-border px-4 py-4 text-left">
            <SheetTitle className="flex items-center gap-3 text-sm font-bold tracking-tight">
              <span className="grid size-8 shrink-0 place-items-center rounded bg-primary font-bold text-primary-foreground">
                A
              </span>
              ATLAS
            </SheetTitle>
            <SheetDescription className="font-mono text-[10px] uppercase tracking-widest">
              control plane
            </SheetDescription>
          </SheetHeader>

          <nav aria-label="Primary navigation" className="flex-1 space-y-5 overflow-y-auto p-3">
            {visibleGroups.map((group) => (
              <div key={group.label}>
                <div className="mb-1 px-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.items.map(({ to, label, icon: Icon }) => {
                    const active = isActivePath(path, to);
                    return (
                      <Link
                        key={to}
                        to={to}
                        aria-current={active ? "page" : undefined}
                        className={`flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors ${
                          active
                            ? "border border-primary/25 bg-primary/10 text-primary"
                            : "border border-transparent text-muted-foreground hover:bg-highlight/5 hover:text-foreground"
                        }`}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        <span className="font-medium">{label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="flex items-center gap-3 border-t border-border p-3">
            <div className="grid size-9 shrink-0 place-items-center rounded bg-secondary font-mono text-xs">
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
                aria-label="Sign out"
                className="ml-auto grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-interactive hover:text-foreground disabled:opacity-50"
              >
                <LogOut className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {/*
        The current section, which the rail communicates with a highlighted item and mobile had
        no equivalent for. Reads as the page's location line, so the drawer is a way back to the
        map rather than the only thing telling you where you are.
      */}
      <span className="truncate text-sm font-semibold tracking-tight">
        {current?.label ?? "Atlas Control"}
      </span>
    </div>
  );
}

export function AtlasSidebar({ identity }: { identity?: IdentityView }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  // The workflow detail is an authoring surface: its canvas and node palette need stable space.
  // Keep global navigation as an icon rail there; standard operational pages can opt into the
  // wider, layout-pushing navigation without obscuring their content.
  const isWorkflowEditor = /^\/workflows\/[^/]+$/.test(path);
  const isActive = (to: string) => isActivePath(path, to);
  const { signingOut, onSignOut } = useSignOut();
  /**
   * Collapsed = an icon rail (labels reachable by hover title and screen-reader label),
   * reclaiming ~11rem for content — the workflow canvas is the page that asked for it.
   * Read in an effect: localStorage does not exist during server rendering, and a blocked
   * storage simply means the author starts with the compact rail and an unobstructed workspace.
   */
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(NAV_COLLAPSED_KEY) !== "0");
    } catch {
      /* start collapsed */
    }
  }, []);
  const toggleCollapsed = () =>
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(NAV_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* preference just won't persist */
      }
      return next;
    });
  const effectiveCollapsed = isWorkflowEditor || collapsed;

  /**
   * An unknown identity is treated as holding nothing beyond plain `read`.
   *
   * The prop is optional and this component renders inside the authenticated shell, so in
   * practice it is always set; when it is not, showing fewer links is the honest default —
   * offering a destination we cannot say the viewer can reach is the failure mode worth
   * avoiding, not the reverse.
   */
  const visibleGroups = useVisibleGroups(identity);

  const toggleButton = (
    <button
      type="button"
      onClick={toggleCollapsed}
      aria-expanded={!effectiveCollapsed}
      aria-label={effectiveCollapsed ? "Expand navigation" : "Collapse navigation"}
      title={effectiveCollapsed ? "Expand navigation" : "Collapse navigation"}
      className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      {effectiveCollapsed ? (
        <PanelLeftOpen className="size-4" aria-hidden="true" />
      ) : (
        <PanelLeftClose className="size-4" aria-hidden="true" />
      )}
    </button>
  );

  return (
    <nav
      aria-label="Primary navigation"
      className={`hidden shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 motion-reduce:transition-none md:flex ${
        effectiveCollapsed ? "w-14" : "w-60"
      }`}
    >
      <div id="primary-navigation-panel" className="flex min-h-0 flex-1 flex-col">
        <div
          className={
            effectiveCollapsed
              ? "flex flex-col items-center gap-2 px-2 py-5"
              : "flex items-center gap-3 px-5 py-5"
          }
        >
          <div className="grid size-8 shrink-0 place-items-center rounded bg-primary font-bold text-primary-foreground shadow-[0_0_15px_color-mix(in_oklab,var(--color-primary)_50%,transparent)]">
            A
          </div>
          {effectiveCollapsed ? null : (
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-sm font-bold tracking-tight">ATLAS</span>
              {/* No version here: the scaffold's "v2.4" was invented. The real Atlas version is
                  on the dashboard header and the Settings page, sourced from /api/metrics. */}
              <span className="font-mono text-[10px] text-muted-foreground">control plane</span>
            </div>
          )}
          {isWorkflowEditor ? null : (
            <span className={effectiveCollapsed ? "" : "ml-auto"}>{toggleButton}</span>
          )}
        </div>

        <div
          className={`flex-1 space-y-6 overflow-y-auto pb-6 ${effectiveCollapsed ? "px-2" : "px-3"}`}
        >
          {visibleGroups.map((g) => {
            const items = g.items;
            return (
              <div key={g.label}>
                {effectiveCollapsed ? (
                  // Groups still separate visually via the parent's space-y; the label itself
                  // has no room on the rail, and every item carries its own accessible name.
                  <div aria-hidden="true" className="mb-2 border-t border-border" />
                ) : (
                  <div className="mb-2 px-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {g.label}
                  </div>
                )}
                <div className="space-y-0.5">
                  {items.map(({ to, label, icon: Icon }) => {
                    const active = isActive(to);
                    return (
                      <Link
                        key={to}
                        to={to}
                        // The active page is announced, not only coloured.
                        aria-current={active ? "page" : undefined}
                        aria-label={effectiveCollapsed ? label : undefined}
                        title={effectiveCollapsed ? label : undefined}
                        className={`flex items-center rounded-md text-sm transition-colors ${
                          effectiveCollapsed ? "justify-center px-0 py-2" : "gap-3 px-3 py-2"
                        } ${
                          active
                            ? "bg-primary/10 text-primary border border-primary/25"
                            : "text-muted-foreground border border-transparent hover:bg-highlight/5 hover:text-foreground"
                        }`}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {effectiveCollapsed ? null : <span className="font-medium">{label}</span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className={`border-t border-border ${effectiveCollapsed ? "p-2" : "p-4"}`}>
          <div
            className={
              effectiveCollapsed
                ? "flex flex-col items-center gap-2 py-1"
                : "flex items-center gap-3 px-2 py-1"
            }
          >
            <div
              className="grid size-8 shrink-0 place-items-center rounded bg-secondary font-mono text-xs"
              title={effectiveCollapsed ? (identity?.username ?? "Signed out") : undefined}
            >
              {identity?.initials ?? "--"}
            </div>
            {effectiveCollapsed ? null : (
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-xs font-medium">
                  {identity?.username ?? "Signed out"}
                </span>
                {/* Role is a display hint. Atlas enforces the real permission on every call. */}
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {identity?.roleLabel ?? "—"}
                </span>
              </div>
            )}
            {identity ? (
              <button
                type="button"
                onClick={onSignOut}
                disabled={signingOut}
                title="Sign out"
                aria-label="Sign out"
                className={`grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50 ${
                  effectiveCollapsed ? "" : "ml-auto"
                }`}
              >
                <LogOut className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </nav>
  );
}
