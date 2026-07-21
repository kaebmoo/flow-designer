/**
 * Same-origin transport glue for `GET /api/usage?format=csv`.
 *
 * See `api.exports.audit-csv.ts` — same boundary, same reasoning: the sealed session supplies
 * the bearer server-side, Atlas enforces `audit.read`, and this route adds no domain logic.
 * The usage route has no `limit`; the inclusive date range is the only size control.
 */

import { createFileRoute } from "@tanstack/react-router";

import { atlasExportUsageCsv } from "@/lib/atlas-api.server";
import { parseDateBoundary } from "@/lib/atlas-dates";
import { requireAtlasToken } from "@/lib/auth.server";
import { transportBadRequest, transportErrorResponse } from "@/lib/transport-error.server";

export const Route = createFileRoute("/api/exports/usage-csv")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Validated in its own block so a 400 can only carry the validators' rule-describing
        // copy — an unexpected internal throw must not be echoed as if it were input feedback.
        let params: { from: string | undefined; to: string | undefined };
        const url = new URL(request.url);
        try {
          params = {
            from: parseDateBoundary(url.searchParams.get("from"), "from"),
            to: parseDateBoundary(url.searchParams.get("to"), "to"),
          };
        } catch (error) {
          return transportBadRequest(
            error instanceof Error ? error.message : "Invalid export parameters.",
          );
        }
        try {
          const token = await requireAtlasToken();
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
          return transportErrorResponse(error, "The export could not be completed.");
        }
      },
    },
  },
});
