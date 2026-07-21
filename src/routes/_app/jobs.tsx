import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { formatDurationMs, toClientAtlasError, type JobDetailView } from "@/lib/atlas-mappers";
import { useCancelJob } from "@/lib/atlas-mutations";
import { jobQuery, jobsQuery } from "@/lib/atlas-queries";

const appRoute = getRouteApi("/_app");

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
    search: { limit?: number; state?: string; job?: string } & SearchSchemaInput,
  ) => ({
    limit: parseLimitSearch(search.limit),
    state: parseStringSearch(search.state),
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
      className="fixed right-0 top-0 bottom-0 z-40 flex w-96 flex-col border-l border-border bg-card shadow-2xl animate-slide-in-right focus:outline-none"
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
  const { limit, state, job: selectedJobId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const jobs = useQuery(jobsQuery({ limit }));

  const rows = state
    ? (jobs.data?.items ?? []).filter((j) => j.state.label === state)
    : (jobs.data?.items ?? []);

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Every worker execution Atlas has recorded — routed manually or by a workflow."
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
        {jobs.isPending ? (
          <LoadingState label="Loading jobs" />
        ) : jobs.isError ? (
          <AtlasErrorState
            error={toClientAtlasError(jobs.error)}
            onRetry={() => void jobs.refetch()}
          />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(j) => j.id}
              onRowClick={(j) => void navigate({ search: (prev) => ({ ...prev, job: j.id }) })}
              empty={
                state
                  ? `No ${state} jobs in the loaded window of ${jobs.data.limit}.`
                  : "Atlas has recorded no jobs."
              }
              columns={[
                {
                  key: "id",
                  header: "Job",
                  render: (j) => <span className="font-mono text-xs text-primary">{j.id}</span>,
                },
                {
                  key: "prompt",
                  header: "Prompt",
                  render: (j) => <span className="line-clamp-1 text-sm">{j.prompt}</span>,
                },
                {
                  key: "workerName",
                  header: "Worker",
                  render: (j) => <span className="text-sm">{j.workerName ?? j.workerId}</span>,
                },
                {
                  key: "workspaceKey",
                  header: "Workspace",
                  render: (j) => <span className="font-mono text-xs">{j.workspaceKey ?? "—"}</span>,
                },
                {
                  key: "createdAt",
                  header: "Created",
                  render: (j) => <span className="font-mono text-xs">{j.createdAt}</span>,
                },
                {
                  key: "durationMs",
                  header: "Duration",
                  render: (j) => (
                    <span className="font-mono text-xs">{formatDurationMs(j.durationMs)}</span>
                  ),
                },
                {
                  key: "state",
                  header: "State",
                  className: "text-right",
                  render: (j) => <StatusPill tone={j.state.tone}>{j.state.label}</StatusPill>,
                },
              ]}
            />
            <WindowNotice
              count={jobs.data.items.length}
              limit={jobs.data.limit}
              mayHaveMore={jobs.data.mayHaveMore}
              noun="jobs"
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

      {selectedJobId ? (
        <JobDetailPane
          jobId={selectedJobId}
          onClose={() => void navigate({ search: (prev) => ({ ...prev, job: undefined }) })}
        />
      ) : null}
    </>
  );
}
