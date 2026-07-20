import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import { workersQuery } from "@/lib/atlas-queries";

export const Route = createFileRoute("/_app/fleet")({
  component: FleetPage,
  head: () => ({ meta: [{ title: "Fleet · Atlas Control" }] }),
});

/**
 * The worker fleet, read from `GET /api/workers`.
 *
 * There is no add/re-poll control here in Phase 2: both are mutations (`POST /api/workers`,
 * `POST /api/workers/poll`) and belong to Phase 3. A button that did nothing would claim a
 * capability the page does not have.
 */
function FleetPage() {
  const workers = useQuery(workersQuery());

  return (
    <>
      <PageHeader
        title="Fleet"
        subtitle="Every thClaws worker Atlas can route to. Health reflects Atlas's last poll."
        meta={
          workers.data ? (
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {workers.data.length} worker{workers.data.length === 1 ? "" : "s"} registered
            </span>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {workers.isPending ? (
          <LoadingState label="Loading fleet" />
        ) : workers.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(workers.error)}
            onRetry={() => void workers.refetch()}
          />
        ) : (
          <DataTable
            rows={workers.data}
            rowKey={(w) => w.id}
            empty="Atlas has no workers registered."
            columns={[
              {
                key: "name",
                header: "Worker",
                render: (w) => (
                  <div>
                    <div className="text-sm font-medium">{w.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{w.baseUrl}</div>
                  </div>
                ),
              },
              {
                key: "role",
                header: "Role",
                render: (w) => <span className="font-mono text-xs">{w.role || "—"}</span>,
              },
              {
                key: "tags",
                header: "Tags",
                render: (w) =>
                  w.tags.length === 0 ? (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {w.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded border border-border bg-secondary/40 px-1.5 py-0.5 font-mono text-[10px]"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ),
              },
              {
                key: "agentVersion",
                header: "Agent",
                render: (w) => (
                  <span className="font-mono text-xs text-muted-foreground">
                    {/* Null until Atlas has polled the worker at least once. */}
                    {w.agentVersion ?? "not polled"}
                  </span>
                ),
              },
              {
                key: "lastError",
                header: "Last Error",
                render: (w) =>
                  w.lastError ? (
                    <span className="line-clamp-1 font-mono text-[11px] text-destructive">
                      {w.lastError}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ),
              },
              {
                key: "status",
                header: "Status",
                render: (w) => <StatusPill tone={w.status.tone}>{w.status.label}</StatusPill>,
              },
              {
                key: "lastSeenAt",
                header: "Last Seen",
                className: "text-right",
                render: (w) => (
                  <span className="font-mono text-xs text-muted-foreground">{w.lastSeenAt}</span>
                ),
              },
            ]}
          />
        )}
      </div>
    </>
  );
}
