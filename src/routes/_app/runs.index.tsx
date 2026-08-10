import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import {
  Ban,
  CheckCircle2,
  Clock,
  LifeBuoy,
  Loader2,
  PauseCircle,
  UserCheck,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";

import { DataTable, FilterChip, PageHeader, StatusPill } from "@/components/atlas/page";
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
 *
 * The list mirrors Atlas's own run-state vocabulary, including `recovery_required`, which Atlas
 * writes when it restarts while a node is in flight (`atlas/workflows.py:567,599`). That state
 * is exactly the one an operator most needs to filter for, and omitting the chip would leave
 * those runs findable only by scrolling.
 */
const RUN_STATES = [
  "running",
  "queued",
  "paused",
  "waiting_for_human",
  "recovery_required",
  "succeeded",
  "failed",
  "cancelled",
] as const;

/**
 * State → glyph. Several run states collapse to the same tone (`failed` and `recovery_required`
 * are both `danger`; `paused` and `waiting_for_human` are both `warning`), so tone alone can't
 * separate them at a glance. A distinct icon per state makes them scannable before the label is
 * read — honouring the never-colour-alone rule with a second, pre-reading channel. States Atlas
 * may emit that aren't mapped here fall back to `StatusPill`'s tone dot.
 */
const STATE_ICONS: Record<string, ReactNode> = {
  running: <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />,
  queued: <Clock aria-hidden="true" />,
  paused: <PauseCircle aria-hidden="true" />,
  waiting_for_human: <UserCheck aria-hidden="true" />,
  recovery_required: <LifeBuoy aria-hidden="true" />,
  succeeded: <CheckCircle2 aria-hidden="true" />,
  failed: <XCircle aria-hidden="true" />,
  cancelled: <Ban aria-hidden="true" />,
};

/**
 * Plain-language gloss for the states whose raw Atlas token is jargon to an external customer.
 * Surfaced as hover help on the pill (and inline when that state is the active filter). The mono
 * token stays the label — this only adds a human sentence, never replaces the real state.
 */
const STATE_GLOSS: Record<string, string> = {
  waiting_for_human: "Paused at a human-decision gate, waiting for someone to approve or reject.",
  recovery_required:
    "Atlas restarted while a node was in flight; the run must be resumed to continue.",
  paused: "Execution was paused and can be resumed.",
  cancelled: "Stopped before it finished.",
  queued: "Accepted and waiting to start.",
};

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
            <div
              role="group"
              aria-label="Filter by state"
              className="flex flex-wrap items-center gap-1"
            >
              <FilterChip
                active={state === undefined}
                onClick={() => void navigate({ search: (prev) => ({ ...prev, state: undefined }) })}
              >
                all
              </FilterChip>
              {RUN_STATES.map((s) => (
                <FilterChip
                  key={s}
                  active={state === s}
                  onClick={() => void navigate({ search: (prev) => ({ ...prev, state: s }) })}
                >
                  {s}
                </FilterChip>
              ))}
            </div>
            <span className="mx-2 h-4 w-px bg-border" aria-hidden="true" />
            <div
              role="group"
              aria-label="Rows to load"
              className="flex flex-wrap items-center gap-1"
            >
              {ATLAS_LIMIT_OPTIONS.map((option) => (
                <FilterChip
                  key={option}
                  active={limit === option}
                  onClick={() => void navigate({ search: (prev) => ({ ...prev, limit: option }) })}
                >
                  {option}
                </FilterChip>
              ))}
            </div>
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
            {state ? (
              // The caveat lives ABOVE the table so an empty filtered result never reads as
              // "no such runs exist" — it's a browser-side filter over one loaded window, not a
              // query across all of Atlas. A plain-language gloss follows for jargon states.
              <p className="mb-3 max-w-3xl text-xs text-muted-foreground">
                Showing <span className="font-mono">{state}</span> runs filtered in your browser
                from the loaded window of {runs.data.limit} — Atlas offers no state filter on this
                endpoint, so widen the window to search further back.
                {STATE_GLOSS[state] ? ` ${STATE_GLOSS[state]}` : ""}
              </p>
            ) : null}
            <DataTable
              rows={rows}
              rowKey={(r) => r.id}
              onRowClick={(r) => void navigate({ to: "/runs/$id", params: { id: r.id } })}
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
                      // Row click already navigates here; stop the bubble so the link doesn't
                      // double-fire the row handler.
                      onClick={(e) => e.stopPropagation()}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      {r.id}
                    </Link>
                  ),
                },
                {
                  key: "state",
                  header: "State",
                  render: (r) => (
                    // title carries a plain-language gloss for jargon states (mouse hover) without
                    // displacing the mono token; an sr-only copy makes the same gloss reach screen
                    // readers; the icon separates same-tone states pre-reading.
                    <span title={STATE_GLOSS[r.state.label]}>
                      <StatusPill tone={r.state.tone} icon={STATE_ICONS[r.state.label]}>
                        {r.state.label}
                      </StatusPill>
                      {STATE_GLOSS[r.state.label] ? (
                        <span className="sr-only"> — {STATE_GLOSS[r.state.label]}</span>
                      ) : null}
                    </span>
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
                        // This link targets a different route than the row; stop the bubble so the
                        // row's run-navigation doesn't override it.
                        onClick={(e) => e.stopPropagation()}
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
              ]}
            />
            <WindowNotice
              count={runs.data.items.length}
              limit={runs.data.limit}
              mayHaveMore={runs.data.mayHaveMore}
              noun="run"
            />
          </>
        )}
      </div>
    </>
  );
}
