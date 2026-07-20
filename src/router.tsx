import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { isClientAtlasError } from "./lib/atlas-mappers";
import { routeTree } from "./routeTree.gen";

/**
 * Sends the browser to the sign-in page when Atlas rejects the session mid-visit.
 *
 * Every read already re-validates the session server-side and clears the sealed cookie on a
 * 401, but the *browser* needs telling too. A route loader only covers navigation between
 * routes; changing a search parameter re-runs a page's query without re-running the layout
 * loader, so without this the app keeps rendering a signed-in shell whose panels all fail.
 *
 * A full document navigation rather than a router navigate, deliberately. The QueryClient lives
 * for the life of the page, so the previous identity's responses sit in memory where a later
 * sign-in could read them; replacing the document discards the entire cache along with
 * everything else, which is the guarantee that matters once the session that fetched it is gone.
 * `replace`, so the back button cannot return to the dead page.
 */
function handleExpiredSession(error: unknown) {
  if (typeof window === "undefined") return;
  if (!isClientAtlasError(error) || error.kind !== "unauthorized") return;
  if (window.location.pathname === "/auth") return;

  window.location.replace("/auth");
}

export const getRouter = () => {
  const queryClient = new QueryClient({
    /**
     * One handler for every Atlas read, so no individual page can forget to check for a dead
     * session. Route loaders are covered too — they go through the same query cache.
     */
    queryCache: new QueryCache({ onError: handleExpiredSession }),
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
