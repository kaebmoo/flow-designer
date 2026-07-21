/**
 * The incoming request's abort signal, for cancelling safe reads end-to-end.
 *
 * SERVER ONLY — same import rules as every other `*.server.ts` module.
 *
 * When the browser aborts an RPC (TanStack Query cancels its signal on navigation, and the
 * fetch carrying the request dies with it), the server runtime aborts the incoming request's
 * signal. Handing that signal to the typed Atlas operation is what makes the cancellation
 * reach Atlas's socket instead of stopping at this server.
 *
 * Reads only. A mutation must never be auto-cancelled this way: Atlas may already have
 * accepted the side effect, and aborting the response would make the UI report an action as
 * not-taken that in fact happened.
 */

import { getRequest } from "@tanstack/react-start/server";

/** The current request's signal, or undefined outside a request context (unit tests). */
export function currentRequestSignal(): AbortSignal | undefined {
  try {
    return getRequest().signal;
  } catch {
    return undefined;
  }
}
