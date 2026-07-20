import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { Download } from "lucide-react";

import { DateRangeForm } from "@/components/atlas/date-range";
import { PageHeader } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { Button } from "@/components/ui/button";
import { parseDateBoundary } from "@/lib/atlas-dates";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch } from "@/lib/atlas-search";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import { auditQuery } from "@/lib/atlas-queries";

/** URL input is untrusted: an unusable date falls back to "no bound" instead of crashing. */
function parseDateSearch(value: unknown): string | undefined {
  try {
    return parseDateBoundary(value, "date");
  } catch {
    return undefined;
  }
}

export const Route = createFileRoute("/_app/audit")({
  validateSearch: (search: { limit?: number; from?: string; to?: string } & SearchSchemaInput) => ({
    limit: parseLimitSearch(search.limit),
    /** All three pushed down to Atlas — real query parameters on `GET /api/audit`. */
    from: parseDateSearch(search.from),
    to: parseDateSearch(search.to),
  }),
  component: AuditPage,
  head: () => ({ meta: [{ title: "Audit Log · Atlas Control" }] }),
});

/**
 * Atlas's audit log, as recorded — admin/auditor only (`audit.read`).
 *
 * Newest first, bounded by `limit`; `from`/`to` are inclusive ISO dates or timestamps applied
 * by Atlas itself. There is no offset, cursor, total, or deletion. The CSV export goes through
 * the same-origin `/api/exports/audit-csv` route, which attaches the Atlas bearer server-side.
 */
function AuditPage() {
  const { limit, from, to } = Route.useSearch();
  const navigate = Route.useNavigate();
  const audit = useQuery(auditQuery({ limit, from, to }));

  const exportHref = `/api/exports/audit-csv?limit=${limit}${from ? `&from=${encodeURIComponent(from)}` : ""}${to ? `&to=${encodeURIComponent(to)}` : ""}`;

  return (
    <>
      <PageHeader
        title="Audit Log"
        subtitle="Atlas's immutable record of operator and system actions."
        actions={
          audit.isSuccess ? (
            <Button asChild size="sm" variant="outline">
              {/* A plain same-origin link: the session cookie authenticates it, and the
                  server attaches the Atlas bearer. No token ever appears in this URL. */}
              <a href={exportHref} download>
                <Download className="size-4" /> Export CSV
              </a>
            </Button>
          ) : null
        }
        meta={
          <div className="flex flex-wrap items-center gap-1">
            {ATLAS_LIMIT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => void navigate({ search: (prev) => ({ ...prev, limit: option }) })}
                className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition ${
                  limit === option
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <DateRangeForm
          from={from}
          to={to}
          onApply={(next) =>
            void navigate({ search: (prev) => ({ ...prev, from: next.from, to: next.to }) })
          }
        />

        {audit.isPending ? (
          <LoadingState label="Loading audit entries" />
        ) : audit.isError ? (
          // Operators and viewers land here: `audit.read` belongs to admin and auditor only,
          // so Atlas's 403 renders as the explicit forbidden state.
          <AtlasErrorState
            error={toClientAtlasError(audit.error)}
            onRetry={() => void audit.refetch()}
          />
        ) : audit.data.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
            {from || to
              ? "Atlas recorded no audit entries in this date range."
              : "Atlas has recorded no audit entries yet."}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border bg-card p-4 font-mono text-[11px] leading-relaxed">
              {audit.data.items.map((entry) => (
                <div key={entry.id} className="flex gap-4 whitespace-nowrap py-0.5">
                  <span className="shrink-0 text-primary">{entry.createdAt}</span>
                  <span
                    className="w-40 shrink-0 truncate text-muted-foreground"
                    title={entry.actor}
                  >
                    [{entry.actor}]
                  </span>
                  <span className="w-44 shrink-0 uppercase tracking-widest text-foreground">
                    {entry.action}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    → {entry.resourceType}/{entry.resourceId}
                  </span>
                  {entry.detail ? (
                    <span className="truncate text-muted-foreground/70" title={entry.detail}>
                      {entry.detail}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Showing the {audit.data.items.length} newest entries
              {from || to ? " in the selected range" : ""} (window of {audit.data.limit}, newest
              first).{" "}
              {audit.data.mayHaveMore
                ? "The window is full, so older entries exist — widen the window or narrow the dates."
                : "Atlas reports no total; date bounds are inclusive."}{" "}
              The CSV export carries the same window and filters.
            </p>
          </>
        )}
      </div>
    </>
  );
}
