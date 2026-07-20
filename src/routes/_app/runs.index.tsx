import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import { WindowNotice } from "@/components/atlas/window";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch, parseStringSearch } from "@/lib/atlas-search";
import { formatDurationMs, toClientAtlasError } from "@/lib/atlas-mappers";
import { runsQuery } from "@/lib/atlas-queries";

/**
 * Run states offered as filter chips.
 *
 * Atlas has **no** state filter on `GET /api/workflow-runs` (`atlas/db.py:1176-1185`), so this
 * filters the window the server already returned. That distinction is stated in the UI rather
 * than hidden, because filtering a 25-row window is not the same as querying all runs in a
 * state — and a user who assumed otherwise would draw the wrong conclusion from an empty table.
 */
const RUN_STATES = [
  "running",
  "queued",
  "paused",
  "waiting_for_human",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const Route = createFileRoute("/_app/runs/")({
  validateSearch: (
    search: { limit?: number; workflow?: string; state?: string } & SearchSchemaInput,
  ) => ({
    limit: parseLimitSearch(search.limit),
    /** Pushed down to Atlas: the one filter the runs route actually supports. */
    workflow: parseStringSearch(search.workflow),
    /** Applied to the returned window only — see RUN_STATES above. */
    state: parseStringSearch(search.state),
  }),
  component: RunsIndex,
  head: () => ({ meta: [{ title: "Runs · Atlas Control" }] }),
});

function RunsIndex() {
  const { limit, workflow, state } = Route.useSearch();
  const navigate = Route.useNavigate();
  const runs = useQuery(runsQuery({ limit, workflowDefinitionId: workflow }));

  const rows = state
    ? (runs.data?.items ?? []).filter((r) => r.state.label === state)
    : (runs.data?.items ?? []);

  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="Every workflow execution Atlas has recorded."
        meta={
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => void navigate({ search: (prev) => ({ ...prev, state: undefined }) })}
              className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition ${
                state === undefined
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
              }`}
            >
              all
            </button>
            {RUN_STATES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void navigate({ search: (prev) => ({ ...prev, state: s }) })}
                className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition ${
                  state === s
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
            <span className="mx-2 h-4 w-px bg-border" aria-hidden="true" />
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
        {workflow ? (
          <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="font-mono">
              Filtered to workflow <span className="text-primary">{workflow}</span> by Atlas.
            </span>
            <button
              type="button"
              onClick={() =>
                void navigate({ search: (prev) => ({ ...prev, workflow: undefined }) })
              }
              className="rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest hover:bg-secondary"
            >
              Clear
            </button>
          </div>
        ) : null}

        {runs.isPending ? (
          <LoadingState label="Loading runs" />
        ) : runs.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(runs.error)}
            onRetry={() => void runs.refetch()}
          />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              empty={
                state
                  ? `No ${state} runs in the loaded window of ${runs.data.limit}.`
                  : "Atlas has recorded no workflow runs."
              }
              columns={[
                {
                  key: "id",
                  header: "Run",
                  render: (r) => (
                    <Link
                      to="/runs/$id"
                      params={{ id: r.id }}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {r.id}
                    </Link>
                  ),
                },
                {
                  key: "name",
                  header: "Workflow",
                  render: (r) =>
                    r.workflowDefinitionId ? (
                      <Link
                        to="/workflows/$id"
                        params={{ id: r.workflowDefinitionId }}
                        className="hover:text-primary"
                      >
                        {r.name}
                      </Link>
                    ) : (
                      // Atlas nulls the FK when a definition is deleted (ON DELETE SET NULL).
                      <span title="The workflow definition has been deleted in Atlas.">
                        {r.name}
                      </span>
                    ),
                },
                {
                  key: "createdAt",
                  header: "Created",
                  render: (r) => <span className="font-mono text-xs">{r.createdAt}</span>,
                },
                {
                  key: "startedAt",
                  header: "Started",
                  render: (r) => <span className="font-mono text-xs">{r.startedAt}</span>,
                },
                {
                  key: "durationMs",
                  header: "Duration",
                  render: (r) => (
                    <span className="font-mono text-xs">{formatDurationMs(r.durationMs)}</span>
                  ),
                },
                {
                  key: "state",
                  header: "State",
                  className: "text-right",
                  render: (r) => <StatusPill tone={r.state.tone}>{r.state.label}</StatusPill>,
                },
              ]}
            />
            <WindowNotice
              count={runs.data.items.length}
              limit={runs.data.limit}
              mayHaveMore={runs.data.mayHaveMore}
              noun="runs"
            />
            {state ? (
              <p className="mt-1 text-xs text-muted-foreground">
                The state filter is applied to that window in the browser — Atlas offers no state
                filter on this endpoint, so widen the window to search further back.
              </p>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
