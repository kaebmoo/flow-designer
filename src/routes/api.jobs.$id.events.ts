/**
 * Same-origin transport glue for `GET /api/jobs/{job_id}/events?after=<seq>` (Phase 4).
 *
 * This exists for one reason: the Atlas bearer must never reach browser code or a URL. The
 * browser opens this same-origin stream; the `Authorization` header is added here, server-side,
 * from the sealed session cookie, and Atlas's `text/event-stream` bytes are relayed untouched.
 *
 * Thin transport glue only, per the architecture rule: no domain logic, no persistence, no
 * secrets of its own, nothing cached, no frame is parsed or rewritten. Authentication happens
 * here — this URL is reachable directly over HTTP, so no route guard is assumed — and
 * authorization stays with Atlas, which re-checks the role behind the bearer on the call.
 *
 * Like the artifact route, the `server` property is the only `createFileRoute` prop, so
 * TanStack Start prunes the subtree from the client route tree and the `*.server.ts` imports
 * below never reach the browser bundle.
 */

import { createFileRoute } from "@tanstack/react-router";

import { atlasOpenJobEventStream, isAtlasError } from "@/lib/atlas-api.server";
import type { AtlasErrorKind } from "@/lib/atlas-types";
import { requireAtlasToken } from "@/lib/auth.server";

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

/** Atlas's own status and message, forwarded as plain text — this route invents neither. */
function errorResponse(error: unknown): Response {
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (isAtlasError(error)) {
    return new Response(error.message, { status: STATUS_FOR_KIND[error.kind], headers });
  }
  return new Response("The event stream could not be opened.", { status: 500, headers });
}

/**
 * `after` is the one query parameter Atlas accepts on this route, and it is validated here at
 * the trust boundary: a non-negative integer or a 400. Nothing else from the request's query
 * string is forwarded — forwarding arbitrary parameters would be the generic proxy the
 * architecture forbids.
 */
function parseAfter(raw: string | null): number | null {
  if (raw === null || raw === "") return 0;
  if (!/^\d{1,15}$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

export const Route = createFileRoute("/api/jobs/$id/events")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        try {
          const token = await requireAtlasToken();
          const after = parseAfter(new URL(request.url).searchParams.get("after"));
          if (after === null) {
            return new Response("after must be a non-negative integer.", {
              status: 400,
              headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            });
          }

          // `request.signal` aborts when the browser goes away, which cancels the upstream
          // Atlas read — no abandoned tab may pin an Atlas handler thread.
          const upstream = await atlasOpenJobEventStream(token, params.id, after, request.signal);

          return new Response(upstream.body, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              // Authenticated live data: no cache may keep or coalesce it.
              "cache-control": "no-store",
              // Belt-and-braces for proxies that buffer streamed responses (nginx honours it).
              "x-accel-buffering": "no",
            },
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
