import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState, NotFoundState } from "@/components/atlas/states";
import { toClientAtlasError } from "@/lib/atlas-mappers";
import { workflowQuery } from "@/lib/atlas-queries";

/**
 * A single workflow definition, read from `GET /api/workflows/{id}`.
 *
 * Read-only by design in Phase 2. The canvas editor is Phase 3 work: it saves, runs, and
 * simulates, and it still speaks the pre-Atlas nine-kind node vocabulary. Rendering it here
 * against real Atlas data would show an operator an editable canvas whose Save button does
 * nothing, so this page presents the stored graph as it is instead.
 */
export const Route = createFileRoute("/_app/workflows/$id")({
  /**
   * The loader resolves the workflow during SSR, so a reload renders real data immediately and
   * an unknown id becomes a genuine 404 instead of an empty canvas. It hands the result to the
   * same query cache the component reads, so there is no second fetch after hydration.
   */
  loader: async ({ context, params }) => {
    try {
      return await context.queryClient.ensureQueryData(workflowQuery(params.id));
    } catch (error) {
      // Atlas's 404 is this route's not-found, not a crash. Every other failure — forbidden,
      // timeout, Atlas down — is rethrown so `errorComponent` can tell the operator which.
      if (toClientAtlasError(error).kind === "not_found") throw notFound();
      throw error;
    }
  },
  component: WorkflowDetail,
  pendingComponent: () => <LoadingState label="Loading workflow" />,
  errorComponent: ({ error, reset }) => (
    <AtlasErrorState error={toClientAtlasError(error)} onRetry={reset} />
  ),
  notFoundComponent: () => (
    <NotFoundState description="Atlas has no workflow definition with that id." />
  ),
  head: ({ params }) => ({ meta: [{ title: `Workflow ${params.id} · Atlas Control` }] }),
});

function WorkflowDetail() {
  const { id } = Route.useParams();
  const { data: workflow } = useSuspenseQuery(workflowQuery(id));

  return (
    <>
      <PageHeader
        title={workflow.name}
        subtitle={workflow.description || "No description."}
        meta={
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={workflow.status.tone}>{workflow.status.label}</StatusPill>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {workflow.id} · v{workflow.version} · updated {workflow.updatedAt}
            </span>
          </div>
        }
        actions={
          <Link
            to="/runs"
            search={{ limit: 100, workflow: workflow.id, state: undefined }}
            className="inline-flex items-center rounded border border-border bg-secondary/40 px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition hover:bg-secondary"
          >
            View runs
          </Link>
        }
      />

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/*
          Editing is Phase 3. Saying so beats leaving an operator to discover it by clicking.
        */}
        <p className="mb-6 rounded-lg border border-dashed border-border bg-secondary/20 px-4 py-3 text-xs text-muted-foreground">
          Read-only view of the graph Atlas has stored. Editing, validation, and running a workflow
          are not wired to Atlas yet.
        </p>

        <section className="mb-8">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Nodes ({workflow.graphNodes.length})
          </h2>
          <DataTable
            rows={workflow.graphNodes}
            rowKey={(n) => n.id}
            empty="This workflow's graph has no nodes."
            columns={[
              {
                key: "id",
                header: "Node",
                render: (n) => (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-primary">{n.id}</span>
                    {n.isStart ? (
                      <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-primary">
                        start
                      </span>
                    ) : null}
                  </div>
                ),
              },
              {
                key: "type",
                header: "Type",
                render: (n) => <span className="font-mono text-xs">{n.type}</span>,
              },
              {
                key: "label",
                header: "Label",
                render: (n) => <span className="text-sm">{n.label}</span>,
              },
            ]}
          />
        </section>

        <section className="mb-8">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Edges ({workflow.graphEdges.length})
          </h2>
          <DataTable
            rows={workflow.graphEdges}
            rowKey={(e) => e.id}
            empty="This workflow's graph has no edges."
            columns={[
              {
                key: "from",
                header: "From",
                render: (e) => <span className="font-mono text-xs">{e.from}</span>,
              },
              {
                key: "to",
                header: "To",
                render: (e) => <span className="font-mono text-xs">{e.to}</span>,
              },
              {
                key: "condition",
                header: "Condition",
                className: "text-right",
                render: (e) => (
                  <span className="font-mono text-xs text-muted-foreground">{e.condition}</span>
                ),
              },
            ]}
          />
        </section>

        <section>
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Policy
          </h2>
          <DataTable
            rows={workflow.policy}
            rowKey={(p) => p.key}
            empty="Atlas stored no policy for this workflow; its executor defaults apply."
            columns={[
              {
                key: "key",
                header: "Key",
                render: (p) => <span className="font-mono text-xs">{p.key}</span>,
              },
              {
                key: "value",
                header: "Value",
                className: "text-right",
                render: (p) => <span className="font-mono text-xs">{p.value}</span>,
              },
            ]}
          />
        </section>
      </div>
    </>
  );
}
