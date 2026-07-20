import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { PageHeader, StatusPill } from "@/components/atlas/page";
import { Button } from "@/components/ui/button";
import { useCreateWorkflow } from "@/lib/atlas-mutations";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { WindowNotice } from "@/components/atlas/window";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch } from "@/lib/atlas-search";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import { workflowsQuery } from "@/lib/atlas-queries";

export const Route = createFileRoute("/_app/workflows/")({
  /**
   * `limit` lives in the URL so a shared or reloaded link shows the same window.
   *
   * The input type is optional and the output is not: a link may omit the parameter, and the
   * component always receives a clamped number rather than having to default it again.
   */
  validateSearch: (search: { limit?: number } & SearchSchemaInput) => ({
    limit: parseLimitSearch(search.limit),
  }),
  component: WorkflowsIndex,
  head: () => ({ meta: [{ title: "Workflows · Atlas Control" }] }),
});

/**
 * Workflow definitions, read from `GET /api/workflows?limit=`.
 *
 * The scaffold's "runs/24h" and "% ok" figures are gone: Atlas stores neither on a workflow
 * definition, and there is no aggregate endpoint that supplies them per workflow.
 *
 * "New workflow" creates the smallest graph Atlas accepts and opens it. There is no client-side
 * draft state: a workflow that exists only in the browser could not be validated (Atlas checks
 * a *stored* workflow by id) or run, so it would be a second, weaker kind of workflow to
 * explain. Creating it immediately means everything on the editor works from the first click.
 */
function WorkflowsIndex() {
  const { limit } = Route.useSearch();
  const navigate = Route.useNavigate();
  const routerNavigate = useNavigate();
  const workflows = useQuery(workflowsQuery({ limit }));
  const create = useCreateWorkflow();

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="Workflow definitions stored in Atlas."
        actions={
          <Button
            type="button"
            size="sm"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(
                {
                  name: "Untitled workflow",
                  description: "",
                  graph: {
                    start: "worker_1",
                    nodes: [{ id: "worker_1", type: "worker", prompt: "" }],
                    edges: [],
                  },
                  policy: {},
                },
                {
                  onSuccess: (workflow) =>
                    routerNavigate({ to: "/workflows/$id", params: { id: workflow.id } }),
                },
              )
            }
          >
            <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
            {create.isPending ? "Creating…" : "New workflow"}
          </Button>
        }
        meta={
          <div className="flex items-center gap-1">
            <span className="mr-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Window
            </span>
            {ATLAS_LIMIT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => void navigate({ search: { limit: option } })}
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
        {/* Outside the list branches on purpose: creating the first workflow fails from the
            empty state, which is exactly where the message would otherwise be invisible. */}
        {create.error ? (
          <p role="alert" className="mb-4 text-xs text-destructive">
            {create.error.message}
          </p>
        ) : null}
        {workflows.isPending ? (
          <LoadingState label="Loading workflows" />
        ) : workflows.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(workflows.error)}
            onRetry={() => void workflows.refetch()}
          />
        ) : workflows.data.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-secondary/20 p-10 text-center text-sm text-muted-foreground">
            Atlas has no workflow definitions yet.
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {workflows.data.items.map((w) => (
                <Link
                  key={w.id}
                  to="/workflows/$id"
                  params={{ id: w.id }}
                  className="group flex flex-col rounded-lg border border-border bg-card p-5 transition hover:border-primary/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-base font-bold">{w.name}</div>
                      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {w.description || "No description."}
                      </div>
                    </div>
                    <StatusPill tone={w.status.tone}>{w.status.label}</StatusPill>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    <span>{w.nodeCount} nodes</span>
                    <span>{w.edgeCount} edges</span>
                    <span>v{w.version}</span>
                    <span className="w-full">updated {w.updatedAt}</span>
                  </div>
                </Link>
              ))}
            </div>
            <WindowNotice
              count={workflows.data.items.length}
              limit={workflows.data.limit}
              mayHaveMore={workflows.data.mayHaveMore}
              noun="workflows"
            />
          </>
        )}
      </div>
    </>
  );
}
