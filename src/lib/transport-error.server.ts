/**
 * The one way a same-origin transport route (artifact bytes, SSE, CSV export) answers a
 * failure.
 *
 * SERVER ONLY — imported by server-only route files, never by client code.
 *
 * These routes return raw bytes, not the RPC result envelope, so `toClientAtlasError`'s
 * redaction has to be applied here instead: an Atlas 5xx message is a raw Python exception
 * string (`atlas/app.py:256`) that can name the database file or an internal path, and it
 * must not travel to a browser as an HTTP response body. Every other kind carries a message
 * Atlas wrote *for* the caller and passes through, exactly as the RPC boundary does.
 */

import { isAtlasError } from "./atlas-api.server";
import { toClientAtlasError } from "./atlas-mappers";
import type { AtlasErrorKind } from "./atlas-types";

const STATUS_FOR_KIND: Record<AtlasErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  server: 502,
  timeout: 504,
  network: 502,
  protocol: 502,
};

const PLAIN_TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
} as const;

/**
 * Maps a thrown failure onto a safe plain-text response.
 *
 * An `AtlasError` keeps its status mapping and its caller-safe message (5xx text is
 * substituted by `toClientAtlasError`). Anything else — an internal throw whose message
 * could name a module path or environment rule — becomes the route's own generic
 * `fallbackMessage` with a 500, never the raw message.
 */
export function transportErrorResponse(error: unknown, fallbackMessage: string): Response {
  if (isAtlasError(error)) {
    const safe = toClientAtlasError(error);
    return new Response(safe.message, {
      status: STATUS_FOR_KIND[error.kind],
      headers: PLAIN_TEXT_HEADERS,
    });
  }
  return new Response(fallbackMessage, { status: 500, headers: PLAIN_TEXT_HEADERS });
}

/** A 400 for a request parameter this route itself refused, with rule-describing copy. */
export function transportBadRequest(message: string): Response {
  return new Response(message, { status: 400, headers: PLAIN_TEXT_HEADERS });
}
