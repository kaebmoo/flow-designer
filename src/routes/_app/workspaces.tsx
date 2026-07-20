import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import { workspacesQuery } from "@/lib/atlas-queries";

export const Route = createFileRoute("/_app/workspaces")({
  component: WorkspacesPage,
  head: () => ({ meta: [{ title: "Workspaces · Atlas Control" }] }),
});

/**
 * Workspaces, read from `GET /api/workspaces`.
 *
 * The previous scaffold synthesised a directory from the worker's role and a random job count.
 * Both are gone: the directory is whatever Atlas recorded for the worker machine, and Atlas
 * exposes no per-workspace job count at all, so no such column is shown.
 */
function WorkspacesPage() {
  const workspaces = useQuery(workspacesQuery());

  return (
    <>
      <PageHeader
        title="Workspaces"
        subtitle="Project directories exposed by each worker. The workspace_key resolves on the worker machine."
        meta={
          workspaces.data ? (
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {workspaces.data.length} workspace{workspaces.data.length === 1 ? "" : "s"} mapped
            </span>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {workspaces.isPending ? (
          <LoadingState label="Loading workspaces" />
        ) : workspaces.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(workspaces.error)}
            onRetry={() => void workspaces.refetch()}
          />
        ) : (
          <DataTable
            rows={workspaces.data}
            rowKey={(w) => w.id}
            empty="Atlas has no workspaces mapped to a worker."
            columns={[
              {
                key: "workspaceKey",
                header: "Workspace Key",
                render: (w) => (
                  <span className="font-mono text-sm text-primary">{w.workspaceKey}</span>
                ),
              },
              {
                key: "company",
                header: "Company",
                render: (w) => <span className="text-sm">{w.company || "—"}</span>,
              },
              {
                key: "workerName",
                header: "Worker",
                render: (w) => (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{w.workerName}</span>
                    <StatusPill tone={w.workerStatus.tone}>{w.workerStatus.label}</StatusPill>
                  </div>
                ),
              },
              {
                key: "workspaceDir",
                header: "Directory (on worker)",
                render: (w) => (
                  <span className="font-mono text-xs text-muted-foreground">{w.workspaceDir}</span>
                ),
              },
              {
                key: "tags",
                header: "Tags",
                className: "text-right",
                render: (w) =>
                  w.tags.length === 0 ? (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ) : (
                    <div className="flex flex-wrap justify-end gap-1">
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
            ]}
          />
        )}
      </div>
    </>
  );
}
