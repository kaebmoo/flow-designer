import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { matchesConfiguredOrigin } from "./lib/csrf-origin";
import { renderErrorPage } from "./lib/error-page";
import { logServerError } from "./lib/safe-error-log";

/**
 * CSRF protection for server functions.
 *
 * Defining this file at all is what makes this necessary: TanStack Start installs a default
 * CSRF middleware only when an app has no `startInstance` of its own, so exporting one
 * silently replaces it with whatever this array contains. Without this entry every server
 * function — including login — would accept cross-site requests.
 *
 * How the framework evaluates a request: `Sec-Fetch-Site` wins when present (browsers always
 * send it, and same-origin is required); otherwise `Origin` is matched by the function below;
 * otherwise `Referer`. A request carrying none of the three is denied, since
 * `allowRequestsWithoutOriginCheck` stays at its default of false.
 *
 * The `origin` matcher exists for the reverse-proxy case: the browser sends the public origin
 * while the request URL the server sees is the internal one, so comparing against
 * `PUBLIC_ORIGIN` is what makes the check correct there. It is read per request rather than at
 * module load, and an unset value denies rather than accepting any origin.
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  // Normalisation lives in `matchesConfiguredOrigin` (src/lib/csrf-origin.ts), pure so the
  // rule is unit-tested; `PUBLIC_ORIGIN` is read per request rather than at module load.
  origin: (value) => matchesConfiguredOrigin(value, process.env.PUBLIC_ORIGIN),
});

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    // Safe diagnostic only: a raw `console.error(error)` would print the cause chain, which
    // for an AtlasError can name the private Atlas origin or carry Atlas's raw 5xx text.
    logServerError("request", error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Array order is execution order, with the handler last. `errorMiddleware` stays first so it
// still catches anything thrown downstream; CSRF runs before any server-function handler.
export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware, csrfMiddleware],
}));
