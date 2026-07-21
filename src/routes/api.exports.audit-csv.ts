/**
 * Same-origin transport glue for `GET /api/audit?format=csv`.
 *
 * Exists for the same single reason as the artifact-content route: the Atlas bearer must never
 * reach browser code or a URL. The browser follows a plain link to this origin; the
 * Authorization header is attached here, server-side, from the sealed session cookie. Atlas
 * enforces `audit.read` — a viewer or operator following this link gets Atlas's 403 relayed,
 * not a synthesised file.
 *
 * No domain logic, nothing cached. The one thing added to Atlas's bytes is a correct filename:
 * Atlas's shared CSV helper names *both* exports `atlas-usage.csv` (`atlas/app.py:1133-1141`),
 * which would save an audit export under a usage name.
 */

import { createFileRoute } from "@tanstack/react-router";

import { atlasExportAuditCsv } from "@/lib/atlas-api.server";
import { parseDateBoundary } from "@/lib/atlas-dates";
import { clampAtlasLimit } from "@/lib/atlas-limits";
import { requireAtlasToken } from "@/lib/auth.server";
import { transportBadRequest, transportErrorResponse } from "@/lib/transport-error.server";

export const Route = createFileRoute("/api/exports/audit-csv")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // The three parameters Atlas accepts, validated as untrusted input; nothing else from
        // the query string is forwarded. Validated in its own block so the only messages a 400
        // can carry are the rule-describing ones the date/limit validators themselves write —
        // an unexpected internal throw must not be echoed as if it were input feedback.
        let params: { limit: number | undefined; from: string | undefined; to: string | undefined };
        const url = new URL(request.url);
        try {
          params = {
            limit: clampAtlasLimit(Number(url.searchParams.get("limit") ?? "") || undefined),
            from: parseDateBoundary(url.searchParams.get("from"), "from"),
            to: parseDateBoundary(url.searchParams.get("to"), "to"),
          };
        } catch (error) {
          return transportBadRequest(
            error instanceof Error ? error.message : "Invalid export parameters.",
          );
        }
        try {
          // Authentication happens here — this URL is reachable directly over HTTP.
          const token = await requireAtlasToken();
          // Relay Atlas's byte stream: nothing is buffered here, so a large export costs
          // this server a pipe, not the whole file in memory. A client disconnect aborts
          // the upstream read through the request signal.
          const upstream = await atlasExportAuditCsv(token, params, { signal: request.signal });
          return new Response(upstream.body, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="atlas-audit.csv"',
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
