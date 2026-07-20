import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState, NotFoundState } from "@/components/atlas/states";
import { formatDurationMs, toClientAtlasError } from "@/lib/atlas-mappers";
import { runQuery } from "@/lib/atlas-queries";

/**
 * A single workflow run, read from `GET /api/workflow-runs/{id}`.
 *
 * Atlas returns the run plus its runtime nodes, runtime edges, and approvals in one response.
 * There is no `run.log` field and no live run stream: run history is persisted JSON at
 * `/events`, and live progress needs per-job SSE, which is Phase 4. Nothing here polls, and
 * nothing here simulates progress with a timer.
 */
export const Route = createFileRoute("/_app/runs/$id")({
  loader: async ({ context, params }) => {
    try {
      return await context.queryClient.ensureQueryData(runQuery(params.id));
    } catch (error) {
      if (toClientAtlasError(error).kind === "not_found") throw notFound();
      throw error;
    }
  },
  component: RunDetail,
  pendingComponent: () => <LoadingState label="Loading run" />,
  errorComponent: ({ error, reset }) => (
    <AtlasErrorState error={toClientAtlasError(error)} onRetry={reset} />
  ),
  notFoundComponent: () => <NotFoundState description="Atlas has no run with that id." />,
  head: ({ params }) => ({ meta: [{ title: `Run ${params.id} · Atlas Control` }] }),
});

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-background/50 p-2">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-xs break-all">{value}</div>
    </div>
  );
}

function RunDetail() {
  const { id } = Route.useParams();
  const { data: detail } = useSuspenseQuery(runQuery(id));
  const { run, nodes, edges, approvals } = detail;

  return (
    <>
      <PageHeader
        title={run.id}
        subtitle={run.name}
        meta={
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={run.state.tone}>{run.state.label}</StatusPill>
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              created {run.createdAt} · started {run.startedAt} · {formatDurationMs(run.durationMs)}
            </span>
          </div>
        }
        actions={
          run.workflowDefinitionId ? (
            <Link
              to="/workflows/$id"
              params={{ id: run.workflowDefinitionId }}
              className="inline-flex items-center rounded bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground"
            >
              Open Workflow
            </Link>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Definition deleted
            </span>
          )
        }
      />

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {run.error ? (
          <p className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {run.error}
          </p>
        ) : null}

        <div className="mb-8 grid gap-3 md:grid-cols-4">
          <Field label="Finished" value={run.finishedAt} />
          <Field
            label="Current nodes"
            value={run.currentNodes.length > 0 ? run.currentNodes.join(", ") : "—"}
          />
          <Field label="Workflow" value={run.workflowDefinitionId ?? "—"} />
          <Field label="Run id" value={run.id} />
        </div>

        <section className="mb-8">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Runtime nodes ({nodes.length})
          </h2>
          <DataTable
            rows={nodes}
            rowKey={(n) => n.id}
            empty="Atlas created no runtime nodes for this run."
            columns={[
              {
                key: "nodeKey",
                header: "Node",
                render: (n) => <span className="font-mono text-xs text-primary">{n.nodeKey}</span>,
              },
              {
                key: "jobId",
                header: "Job",
                render: (n) => (
                  <span className="font-mono text-xs text-muted-foreground">{n.jobId ?? "—"}</span>
                ),
              },
              {
                key: "attempt",
                header: "Attempt",
                render: (n) => <span className="font-mono text-xs tabular-nums">{n.attempt}</span>,
              },
              {
                key: "durationMs",
                header: "Duration",
                render: (n) => (
                  <span className="font-mono text-xs">{formatDurationMs(n.durationMs)}</span>
                ),
              },
              {
                key: "error",
                header: "Error",
                render: (n) =>
                  n.error ? (
                    <span className="line-clamp-1 font-mono text-[11px] text-destructive">
                      {n.error}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ),
              },
              {
                key: "state",
                header: "State",
                className: "text-right",
                render: (n) => <StatusPill tone={n.state.tone}>{n.state.label}</StatusPill>,
              },
            ]}
          />
        </section>

        <section className="mb-8">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Approvals ({approvals.length})
          </h2>
          <DataTable
            rows={approvals}
            rowKey={(a) => a.id}
            empty="This run has no human gates."
            columns={[
              {
                key: "nodeKey",
                header: "Node",
                render: (a) => <span className="font-mono text-xs">{a.nodeKey}</span>,
              },
              {
                key: "label",
                header: "Label",
                render: (a) => <span className="text-sm">{a.label || "—"}</span>,
              },
              {
                key: "selectedChoice",
                header: "Decision",
                render: (a) => (
                  <span className="font-mono text-xs text-muted-foreground">
                    {a.selectedChoice ?? "—"}
                  </span>
                ),
              },
              {
                key: "state",
                header: "State",
                className: "text-right",
                render: (a) => <StatusPill tone={a.state.tone}>{a.state.label}</StatusPill>,
              },
            ]}
          />
          {detail.approvalsMayBeTruncated ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Atlas caps the approvals embedded in a run response at 100 and reports no total, so
              this list may be truncated.
            </p>
          ) : null}
        </section>

        <section>
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Runtime edges ({edges.length})
          </h2>
          <DataTable
            rows={edges}
            rowKey={(e) => e.id}
            empty="Atlas recorded no edge transitions for this run."
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
                key: "matched",
                header: "Condition matched",
                className: "text-right",
                render: (e) => (
                  <span className="font-mono text-xs text-muted-foreground">
                    {/* Null when Atlas recorded no evaluation result for the edge. */}
                    {e.matched === null ? "—" : String(e.matched)}
                  </span>
                ),
              },
            ]}
          />
        </section>

        <p className="mt-8 text-xs text-muted-foreground">
          Live event streaming and run controls (pause, resume, cancel, approvals, artifacts) are
          not wired to Atlas yet.
        </p>
      </div>
    </>
  );
}
