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

import { atlasExportAuditCsv, isAtlasError } from "@/lib/atlas-api.server";
import { parseDateBoundary } from "@/lib/atlas-dates";
import { clampAtlasLimit } from "@/lib/atlas-limits";
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
    return new Response(error.message, { status: STATUS_FOR_KIND[error.kind], headers });
  }
  if (error instanceof Error && error.message) {
    return new Response(error.message, { status: 400, headers });
  }
  return new Response("The export could not be completed.", { status: 500, headers });
}

export const Route = createFileRoute("/api/exports/audit-csv")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          // Authentication happens here — this URL is reachable directly over HTTP.
          const token = await requireAtlasToken();
          const url = new URL(request.url);
          // The three parameters Atlas accepts, validated as untrusted input; nothing else
          // from the query string is forwarded.
          const params = {
            limit: clampAtlasLimit(Number(url.searchParams.get("limit") ?? "") || undefined),
            from: parseDateBoundary(url.searchParams.get("from"), "from"),
            to: parseDateBoundary(url.searchParams.get("to"), "to"),
          };
          const csv = await atlasExportAuditCsv(token, params);
          return new Response(csv, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="atlas-audit.csv"',
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
