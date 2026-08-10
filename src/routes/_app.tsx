import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AtlasMobileNav, AtlasSidebar } from "@/components/atlas/sidebar";
import { SessionWarning } from "@/components/atlas/session-warning";
import { StaleDataWarning } from "@/components/atlas/stale-data-warning";
import { AtlasErrorState, LoadingState, NotFoundState } from "@/components/atlas/states";
import { getIdentityFn } from "@/lib/auth.functions";

/**
 * The authenticated layout.
 *
 * The loader verifies the *current* Atlas identity before any protected content renders,
 * rather than trusting the identity cached in the session cookie — a token revoked or a role
 * changed in Atlas takes effect on the next navigation.
 *
 * This is a navigation boundary, not the security boundary. Each server function validates
 * the session itself, because the RPC endpoints are reachable directly and this loader
 * cannot vouch for them.
 */
export const Route = createFileRoute("/_app")({
  loader: async () => {
    const result = await getIdentityFn();

    if (result.status === "unauthenticated") {
      throw redirect({ to: "/auth" });
    }
    // An Atlas outage or a forbidden response is passed through to be rendered as itself.
    // Redirecting to the login page here would tell the operator the wrong story.
    return result;
  },
  component: AppLayout,
  pendingComponent: () => <LoadingState label="Verifying identity" />,
  errorComponent: ({ error }) => (
    <AtlasErrorState error={{ kind: "server", message: error.message }} />
  ),
  notFoundComponent: () => <NotFoundState />,
});

function AppLayout() {
  const result = Route.useLoaderData();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  if (result.status === "error") {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background text-foreground">
        <AtlasErrorState error={result.error} />
      </div>
    );
  }

  return (
    /*
      `data-hydrated` is published once React owns this tree.

      Every page in here is server-rendered, so its buttons exist and are clickable before
      hydration — and a click in that window does nothing at all, because the handler is not
      attached yet. That is a real defect for a fast operator on a slow connection as much as
      for a browser test, and it is invisible: nothing happens, and there is nothing to see.
      Publishing the signal is the same fix `/auth` already carries on its form, hoisted to the
      shell so it covers every authenticated page rather than one.
    */
    <div
      className="flex h-screen w-full overflow-hidden bg-background text-foreground"
      data-hydrated={hydrated ? "true" : undefined}
    >
      {/*
        The first tab stop on every page.

        Navigation is fourteen links before anything on the page itself, which a keyboard or
        screen-reader user was walking on every single navigation. A raw `<a href="#…">` on
        purpose: the router's `Link` would intercept a same-page hash and never move focus,
        which is the one thing this control exists to do.
      */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow"
      >
        Skip to content
      </a>
      <AtlasSidebar identity={result.identity} />
      {/* `tabIndex={-1}` so the skip link can actually land focus here. */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-w-0 flex-1 flex-col overflow-hidden"
      >
        <AtlasMobileNav identity={result.identity} />
        <SessionWarning expiresAt={result.identity.sessionExpiresAt} />
        <StaleDataWarning />
        <Outlet />
      </main>
    </div>
  );
}
