/**
 * Same-origin transport glue for `GET /api/usage?format=csv`.
 *
 * See `api.exports.audit-csv.ts` — same boundary, same reasoning: the sealed session supplies
 * the bearer server-side, Atlas enforces `audit.read`, and this route adds no domain logic.
 * The usage route has no `limit`; the inclusive date range is the only size control.
 */

import { createFileRoute } from "@tanstack/react-router";

import { atlasExportUsageCsv, isAtlasError } from "@/lib/atlas-api.server";
import { parseDateBoundary } from "@/lib/atlas-dates";
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

function errorResponse(error: unknown): Response {
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  if (isAtlasError(error)) {
    /**
     * An Atlas 5xx message is a raw Python exception string that can name the database file
     * or an internal path; substitute the same generic copy `toClientAtlasError` uses. Every
     * other kind carries a message Atlas wrote *for* the caller and passes through.
     */
    const message =
      error.kind === "server" ? "Atlas failed to process the request." : error.message;
    return new Response(message, { status: STATUS_FOR_KIND[error.kind], headers });
  }
  if (error instanceof Error && error.message) {
    return new Response(error.message, { status: 400, headers });
  }
  return new Response("The export could not be completed.", { status: 500, headers });
}

export const Route = createFileRoute("/api/exports/usage-csv")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const token = await requireAtlasToken();
          const url = new URL(request.url);
          const params = {
            from: parseDateBoundary(url.searchParams.get("from"), "from"),
            to: parseDateBoundary(url.searchParams.get("to"), "to"),
          };
          // Relay the stream: /api/usage has no limit, so an export can be the whole ledger —
          // it flows through without ever being held in this server's memory.
          const upstream = await atlasExportUsageCsv(token, params, { signal: request.signal });
          return new Response(upstream.body, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="atlas-usage.csv"',
              "cache-control": "private, no-store",
            },
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
