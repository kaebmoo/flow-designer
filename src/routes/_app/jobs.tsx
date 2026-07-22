import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { AtlasErrorState, LoadingState } from "@/components/atlas/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { WindowNotice } from "@/components/atlas/window";
import { ATLAS_LIMIT_OPTIONS, parseLimitSearch, parseStringSearch } from "@/lib/atlas-search";
import {
  formatDurationMs,
  toClientAtlasError,
  type JobDetailView,
  type JobView,
} from "@/lib/atlas-mappers";
import { useCancelJob } from "@/lib/atlas-mutations";
import { jobQuery, jobsQuery, runQuery, runsQuery, workflowsQuery } from "@/lib/atlas-queries";

const appRoute = getRouteApi("/_app");
const WORKFLOW_PICKER_LIMIT = 100;
const WORKFLOW_LOOKUP_LIMIT = 100;

/** Matches the height and focus ring of `Input`, which has no `select` counterpart. */
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Job states offered as filter chips, taken from Atlas's own job-state enum.
 *
 * As with runs, Atlas exposes no state filter on `GET /api/jobs` (`atlas/db.py:2605-2618`), so
 * these filter the window that was already fetched. The UI says so.
 */
const JOB_STATES = [
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const Route = createFileRoute("/_app/jobs")({
  validateSearch: (
    search: {
      limit?: number;
      state?: string;
      workflow?: string;
      group?: string;
      job?: string;
    } & SearchSchemaInput,
  ) => ({
    limit: parseLimitSearch(search.limit),
    state: parseStringSearch(search.state),
    workflow: parseStringSearch(search.workflow),
    group: parseStringSearch(search.group) === "workflow" ? "workflow" : undefined,
    /** The open detail pane lives in the URL, so a reload or a shared link keeps it open. */
    job: parseStringSearch(search.job),
  }),
  component: JobsPage,
  head: () => ({ meta: [{ title: "Jobs · Atlas Control" }] }),
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

interface JobWorkflowInfo {
  workflowDefinitionId: string | null;
  workflowName: string;
  runId: string;
  nodeKey: string;
}

interface JobWorkflowGroup {
  key: string;
  title: string;
  subtitle: string;
  workflowDefinitionId: string | null;
  rows: JobView[];
}

function WorkflowCell({ info }: { info: JobWorkflowInfo | undefined }) {
  if (!info) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="No workflow runtime-node link was found in the loaded run window."
      >
        —
      </span>
    );
  }

  return (
    <div className="min-w-0">
      {info.workflowDefinitionId ? (
        <Link
          to="/workflows/$id"
          params={{ id: info.workflowDefinitionId }}
          onClick={(event) => event.stopPropagation()}
          className="truncate text-sm text-primary hover:underline"
        >
          {info.workflowName}
        </Link>
      ) : (
        <div className="truncate text-sm">{info.workflowName}</div>
      )}
      <div className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        <Link
          to="/runs/$id"
          params={{ id: info.runId }}
          onClick={(event) => event.stopPropagation()}
          className="truncate hover:text-primary hover:underline"
        >
          {info.runId}
        </Link>
        <span aria-hidden="true">·</span>
        <span className="truncate">{info.nodeKey}</span>
      </div>
    </div>
  );
}

function jobWorkflowGroup(job: JobView, info: JobWorkflowInfo | undefined): JobWorkflowGroup {
  if (!info) {
    return {
      key: "standalone",
      title: "Standalone or unmatched",
      subtitle: "No workflow runtime-node link in the loaded run window.",
      workflowDefinitionId: null,
      rows: [job],
    };
  }

  return {
    key: info.workflowDefinitionId ?? `deleted:${info.runId}`,
    title: info.workflowName,
    subtitle: info.workflowDefinitionId ?? "Workflow definition deleted in Atlas.",
    workflowDefinitionId: info.workflowDefinitionId,
    rows: [job],
  };
}

function groupJobsByWorkflow(
  rows: JobView[],
  jobWorkflows: Map<string, JobWorkflowInfo>,
): JobWorkflowGroup[] {
  const groups = new Map<string, JobWorkflowGroup>();

  for (const job of rows) {
    const next = jobWorkflowGroup(job, jobWorkflows.get(job.id));
    const existing = groups.get(next.key);
    if (existing) {
      existing.rows.push(job);
    } else {
      groups.set(next.key, next);
    }
  }

  return [...groups.values()];
}

/** Job states Atlas treats as finished; cancelling one is a silent no-op on Atlas's side. */
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "cancelled"]);

/**
 * The cancel-job control (Phase 6): confirmation before the side effect, honest about what
 * Atlas actually does — `POST /api/jobs/{id}/cancel` marks the row `cancel_requested`; the
 * worker keeps running until it honours the request. Visible per role as UX only
 * (`jobs.run` = admin/operator); Atlas enforces the real permission on the call.
 */
function CancelJobControl({ job }: { job: JobDetailView }) {
  const identity = appRoute.useLoaderData();
  const role = identity.status === "authenticated" ? identity.identity.role : null;
  const cancel = useCancelJob();
  const [confirming, setConfirming] = useState(false);

  if (role !== "admin" && role !== "operator") return null;

  const state = job.state.label;
  const blocked = TERMINAL_JOB_STATES.has(state)
    ? `The job already finished as "${state}"; Atlas returns a terminal job unchanged.`
    : state === "cancel_requested" || job.cancelRequested
      ? "Cancellation is already requested; Atlas will not request it twice."
      : null;

  return (
    <div>
      <button
        type="button"
        disabled={blocked !== null || cancel.isPending}
        onClick={() => setConfirming(true)}
        className="inline-flex items-center rounded border border-destructive/40 bg-destructive/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-destructive transition hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Cancel job
      </button>
      {blocked ? <p className="mt-1 text-xs text-muted-foreground">{blocked}</p> : null}
      {cancel.error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {cancel.error.message}
        </p>
      ) : null}
      <AlertDialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next && cancel.isPending) return;
          setConfirming(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel job {job.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              Atlas marks the job <span className="font-mono">cancel_requested</span> and asks the
              worker to stop. Work already handed to the worker may keep running until the worker
              honours the request, and any result it still reports will land on the job row. If this
              job belongs to a workflow run, that run&apos;s node fails when the cancellation
              completes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancel.isPending}>Keep it running</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancel.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                // The dialog stays open until Atlas answers; a refusal renders beside the
                // control instead of being hidden behind an optimistic close.
                event.preventDefault();
                cancel.mutate({ jobId: job.id }, { onSettled: () => setConfirming(false) });
              }}
            >
              {cancel.isPending ? "Requesting…" : "Request cancellation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The detail pane fetches `GET /api/jobs/{id}` rather than reusing the list row.
 *
 * That route returns the un-joined row, so it has no `worker_name`/`workspace_key` — but it is
 * the authoritative current state of the job, and it works on a cold reload where no list row
 * has been fetched yet.
 *
 * A non-modal panel, not a dialog: there is no overlay and the page behind stays interactive,
 * so it must not claim `aria-modal` or trap Tab. What it does own (Phase 6): an accessible
 * name, focus moved into it when it opens, Escape to close, and focus handed back to the
 * element that opened it.
 */
function JobDetailPane({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const job = useQuery(jobQuery(jobId));
  const paneRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    paneRef.current?.focus();
    return () => opener?.focus();
  }, [jobId]);

  return (
    <aside
      ref={paneRef}
      tabIndex={-1}
      aria-label={`Job ${jobId} details`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="absolute right-6 top-6 bottom-6 z-40 flex w-96 max-w-[calc(100%-3rem)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl animate-slide-in-right focus:outline-none"
    >
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Job
          </div>
          <h2 className="truncate text-sm font-bold">{jobId}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close job details"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-6 text-sm">
        {job.isPending ? (
          <LoadingState label="Loading job" />
        ) : job.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(job.error)}
            onRetry={() => void job.refetch()}
          />
        ) : (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <StatusPill tone={job.data.state.tone}>{job.data.state.label}</StatusPill>
              {job.data.cancelRequested ? (
                <span className="font-mono text-[10px] uppercase tracking-widest text-accent">
                  cancel requested
                </span>
              ) : null}
            </div>

            <CancelJobControl job={job.data} />

            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Prompt
              </div>
              <div className="max-h-48 overflow-auto rounded border border-border bg-background/50 p-3 font-mono text-xs whitespace-pre-wrap">
                {job.data.prompt}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Worker id" value={job.data.workerId} />
              <Field label="Execution" value={job.data.execution} />
              <Field label="Model" value={job.data.model || "—"} />
              <Field label="Session" value={job.data.sessionId ?? "—"} />
              <Field label="Started" value={job.data.startedAt} />
              <Field label="Duration" value={formatDurationMs(job.data.durationMs)} />
            </div>

            {job.data.routeReason ? (
              <Field label="Routing reason" value={job.data.routeReason} />
            ) : null}

            {job.data.error ? (
              <div>
                <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  Error
                </div>
                <div className="rounded border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive">
                  {job.data.error}
                </div>
              </div>
            ) : null}

            <div>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Assistant output
              </div>
              {job.data.assistantText ? (
                // Bounded height: a long completion must not grow the pane without limit.
                <pre className="max-h-64 overflow-auto rounded border border-border bg-background/60 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/90">
                  {job.data.assistantText}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Atlas has stored no assistant output for this job.
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                This is the persisted result. Live token streaming is not wired to Atlas yet.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function JobsPage() {
  const { limit, state, workflow, group, job: selectedJobId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const groupByWorkflow = group === "workflow";
  const workflowLookupNeeded = groupByWorkflow || workflow !== undefined;
  const workflowLookupLimit = Math.min(limit, WORKFLOW_LOOKUP_LIMIT);

  const jobs = useQuery(jobsQuery({ limit }));
  const workflows = useQuery(workflowsQuery({ limit: WORKFLOW_PICKER_LIMIT }));
  const workflowRuns = useQuery({
    ...runsQuery({ limit: workflowLookupLimit, workflowDefinitionId: workflow }),
    enabled: workflowLookupNeeded,
  });
  const runDetails = useQueries({
    queries: workflowLookupNeeded
      ? (workflowRuns.data?.items ?? []).map((run) => runQuery(run.id))
      : [],
  });

  const workflowOptions = workflows.data?.items ?? [];
  const workflowNames = new Map(workflowOptions.map((w) => [w.id, w.name]));
  const selectedWorkflowName = workflow
    ? (workflowNames.get(workflow) ?? workflowRuns.data?.items[0]?.name ?? workflow)
    : null;
  const jobWorkflows = useMemo(() => {
    const byJobId = new Map<string, JobWorkflowInfo>();
    for (const result of runDetails) {
      if (!result.isSuccess) continue;
      for (const node of result.data.nodes) {
        if (!node.jobId) continue;
        byJobId.set(node.jobId, {
          workflowDefinitionId: result.data.run.workflowDefinitionId,
          workflowName: result.data.run.name,
          runId: result.data.run.id,
          nodeKey: node.nodeKey,
        });
      }
    }
    return byJobId;
  }, [runDetails]);

  const stateRows = state
    ? (jobs.data?.items ?? []).filter((j) => j.state.label === state)
    : (jobs.data?.items ?? []);
  const rows = workflow
    ? stateRows.filter((j) => jobWorkflows.get(j.id)?.workflowDefinitionId === workflow)
    : stateRows;
  const groupedRows = groupByWorkflow ? groupJobsByWorkflow(rows, jobWorkflows) : [];
  const workflowLookupPending =
    workflowLookupNeeded &&
    (workflowRuns.isPending || runDetails.some((result) => result.isPending));
  const workflowLookupIncomplete =
    workflowLookupNeeded && (workflowRuns.isError || runDetails.some((result) => result.isError));
  const empty =
    workflow && state
      ? `No ${state} jobs matched ${selectedWorkflowName} in the loaded job/run windows.`
      : workflow
        ? `No jobs matched ${selectedWorkflowName} in the loaded job/run windows.`
        : state
          ? `No ${state} jobs in the loaded window of ${jobs.data?.limit ?? limit}.`
          : "Atlas has recorded no jobs.";
  const toggleSelectedJob = (jobId: string) =>
    void navigate({
      search: (prev) => ({ ...prev, job: selectedJobId === jobId ? undefined : jobId }),
    });
  const jobColumns = [
    {
      key: "id",
      header: "Job",
      render: (j: JobView) => <span className="font-mono text-xs text-primary">{j.id}</span>,
    },
    {
      key: "prompt",
      header: "Prompt",
      render: (j: JobView) => <span className="line-clamp-1 text-sm">{j.prompt}</span>,
    },
    ...(workflowLookupNeeded && !groupByWorkflow
      ? [
          {
            key: "workflow",
            header: "Workflow",
            render: (j: JobView) => <WorkflowCell info={jobWorkflows.get(j.id)} />,
          },
        ]
      : []),
    {
      key: "workerName",
      header: "Worker",
      render: (j: JobView) => <span className="text-sm">{j.workerName ?? j.workerId}</span>,
    },
    {
      key: "workspaceKey",
      header: "Workspace",
      render: (j: JobView) => <span className="font-mono text-xs">{j.workspaceKey ?? "—"}</span>,
    },
    {
      key: "createdAt",
      header: "Created",
      render: (j: JobView) => <span className="font-mono text-xs">{j.createdAt}</span>,
    },
    {
      key: "durationMs",
      header: "Duration",
      render: (j: JobView) => (
        <span className="font-mono text-xs">{formatDurationMs(j.durationMs)}</span>
      ),
    },
    {
      key: "state",
      header: "State",
      className: "text-right",
      render: (j: JobView) => <StatusPill tone={j.state.tone}>{j.state.label}</StatusPill>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Every worker execution Atlas has recorded — routed manually or by a workflow."
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Workflow
              </span>
              <select
                value={workflow ?? ""}
                onChange={(event) =>
                  void navigate({
                    search: (prev) => ({ ...prev, workflow: event.target.value || undefined }),
                  })
                }
                className={`${SELECT_CLASS} h-7 w-56 text-xs`}
              >
                <option value="" className="bg-card text-foreground">
                  All workflows
                </option>
                {workflow && !workflowNames.has(workflow) ? (
                  <option value={workflow} className="bg-card text-foreground">
                    {workflow}
                  </option>
                ) : null}
                {workflowOptions.map((w) => (
                  <option key={w.id} value={w.id} className="bg-card text-foreground">
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    group: groupByWorkflow ? undefined : "workflow",
                  }),
                })
              }
              className={`rounded border px-3 py-1 font-mono text-[10px] uppercase tracking-widest transition ${
                groupByWorkflow
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
              }`}
            >
              Group by workflow
            </button>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
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
            {JOB_STATES.map((s) => (
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
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Window
            </span>
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
      <div className="relative flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto px-8 py-6">
          {workflow ? (
            <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="font-mono">
                Filtered to workflow <span className="text-primary">{selectedWorkflowName}</span>.
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

          {jobs.isPending ? (
            <LoadingState label="Loading jobs" />
          ) : jobs.isError ? (
            <AtlasErrorState
              error={toClientAtlasError(jobs.error)}
              onRetry={() => void jobs.refetch()}
            />
          ) : workflowLookupPending ? (
            <LoadingState label="Resolving workflow jobs" />
          ) : (
            <>
              {groupByWorkflow ? (
                <div className="space-y-5">
                  {groupedRows.length === 0 ? (
                    <DataTable rows={[]} rowKey={(j) => j.id} empty={empty} columns={jobColumns} />
                  ) : (
                    groupedRows.map((section) => (
                      <section key={section.key} aria-labelledby={`jobs-${section.key}`}>
                        <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
                          <div className="min-w-0">
                            <h2
                              id={`jobs-${section.key}`}
                              className="truncate text-sm font-bold tracking-tight"
                            >
                              {section.workflowDefinitionId ? (
                                <Link
                                  to="/workflows/$id"
                                  params={{ id: section.workflowDefinitionId }}
                                  className="hover:text-primary hover:underline"
                                >
                                  {section.title}
                                </Link>
                              ) : (
                                section.title
                              )}
                            </h2>
                            <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                              {section.subtitle}
                            </div>
                          </div>
                          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                            {section.rows.length} jobs
                          </span>
                          {section.workflowDefinitionId &&
                          section.workflowDefinitionId !== workflow ? (
                            <button
                              type="button"
                              aria-label={`Filter ${section.title}`}
                              onClick={() =>
                                void navigate({
                                  search: (prev) => ({
                                    ...prev,
                                    workflow: section.workflowDefinitionId ?? undefined,
                                  }),
                                })
                              }
                              className="rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:bg-secondary hover:text-foreground"
                            >
                              Filter
                            </button>
                          ) : null}
                        </div>
                        <DataTable
                          rows={section.rows}
                          rowKey={(j) => j.id}
                          onRowClick={(j) => toggleSelectedJob(j.id)}
                          columns={jobColumns}
                        />
                      </section>
                    ))
                  )}
                </div>
              ) : (
                <DataTable
                  rows={rows}
                  rowKey={(j) => j.id}
                  onRowClick={(j) => toggleSelectedJob(j.id)}
                  empty={empty}
                  columns={jobColumns}
                />
              )}
              <WindowNotice
                count={jobs.data.items.length}
                limit={jobs.data.limit}
                mayHaveMore={jobs.data.mayHaveMore}
                noun="jobs"
              />
              {workflowLookupNeeded ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Atlas offers no workflow filter on the jobs endpoint; this view matches jobs to
                  runtime nodes from the newest {workflowRuns.data?.limit ?? workflowLookupLimit}{" "}
                  workflow runs{workflow ? " for the selected workflow" : ""}.{" "}
                  {workflow
                    ? "Jobs from older runs may be omitted from this filtered view."
                    : "Jobs from older runs may appear under standalone or unmatched."}
                </p>
              ) : null}
              {workflowLookupIncomplete ? (
                <p className="mt-1 text-xs text-destructive">
                  Some workflow run details could not be loaded, so workflow grouping may be
                  incomplete.
                </p>
              ) : null}
              {state ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  The state filter is applied to that window in the browser — Atlas offers no state
                  filter on this endpoint, so widen the window to search further back.
                </p>
              ) : null}
            </>
          )}
        </div>

        {selectedJobId ? (
          <JobDetailPane
            jobId={selectedJobId}
            onClose={() => void navigate({ search: (prev) => ({ ...prev, job: undefined }) })}
          />
        ) : null}
      </div>
    </>
  );
}
