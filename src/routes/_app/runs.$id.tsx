import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DataTable, PageHeader, StatusPill } from "@/components/atlas/page";
import { RunCanvas } from "@/components/atlas/run-canvas";
import { RunLiveSection } from "@/components/atlas/run-live";
import { AtlasErrorState, LoadingState, NotFoundState } from "@/components/atlas/states";
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
import {
  describeAtlasError,
  formatDurationMs,
  toClientAtlasError,
  type ApprovalView,
  type ArtifactView,
  type ClientAtlasError,
  type RunView,
} from "@/lib/atlas-mappers";
import {
  useDecideApproval,
  useDeliverRun,
  useRetryDelivery,
  useRunAction,
} from "@/lib/atlas-mutations";
import { deliveriesQuery, runArtifactsQuery, runEventsQuery, runQuery } from "@/lib/atlas-queries";
import { ATLAS_LIMIT_OPTIONS } from "@/lib/atlas-search";
import type { AtlasErrorKind } from "@/lib/atlas-types";
import {
  appendRunEventPage,
  EMPTY_RUN_EVENT_HISTORY,
  RUN_EVENT_HISTORY_CAP,
} from "@/lib/run-event-history";

/**
 * A single workflow run, read from `GET /api/workflow-runs/{id}`, plus every operator action
 * Atlas exposes for it: pause/resume/cancel, approval decisions, delivery, and downloads.
 *
 * This page never animates or predicts progress: every node state, edge, and persisted event is
 * a value Atlas returned. While a run is live, per-job SSE and a bounded data-layer poll trigger
 * authoritative run refetches; neither source mutates node state itself. The page also does not
 * decide what an operator may do — Atlas re-checks the role on every call, so a control that
 * looks available here can still come back 403, and that 403 is shown as itself.
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

/**
 * The states from which Atlas refuses every lifecycle action.
 *
 * `cancel_run` returns the row unchanged from any of these rather than raising
 * (`atlas/workflows.py:604-608`), so a cancel button offered here would silently do nothing.
 */
const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled"]);

/** How many deliveries of this run to ask Atlas for. Atlas offers no cursor, only a window. */
const DELIVERY_WINDOW = 25;

/** How many rows of a bounded list are added per "show more" press. */
const PAGE_STEP = 25;

// ---------------------------------------------------------------------------
// Local presentation helpers
// ---------------------------------------------------------------------------

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition disabled:cursor-not-allowed disabled:opacity-40";

const BUTTON_TONES = {
  primary: "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20",
  danger: "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20",
  neutral: "border-border bg-secondary/30 text-foreground hover:bg-secondary",
} as const;

type ButtonTone = keyof typeof BUTTON_TONES;

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

function SectionHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {children}
      </h2>
      {aside}
    </div>
  );
}

/**
 * Compact loading and failure states for a section of this page.
 *
 * The page-level `LoadingState`/`AtlasErrorState` claim 60vh, which is right for a whole screen
 * and wrong for one of six panels. The kinds stay distinct — a forbidden delivery list must not
 * read as an empty one, because "your role cannot see deliveries" and "this run has none" lead
 * an operator to opposite conclusions.
 */
function SectionLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-border bg-card px-4 py-8 text-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
    >
      {label}
    </div>
  );
}

/**
 * A denial is not a rejection, and the page must not colour them the same.
 *
 * "Your role cannot do this" is an accent-toned fact about the operator; anything else is a
 * destructive-toned fact about the request.
 */
function errorTone(kind: ClientAtlasError["kind"]): string {
  return kind === "forbidden"
    ? "border-accent/40 bg-accent/10 text-accent"
    : "border-destructive/30 bg-destructive/10 text-destructive";
}

function SectionError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const clientError = toClientAtlasError(error);
  const { title, description, retryable } = describeAtlasError(clientError);
  const tone = errorTone(clientError.kind);

  return (
    <div role="alert" className={`rounded-lg border px-4 py-3 ${tone}`}>
      <p className="font-mono text-[10px] uppercase tracking-widest">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground">{description}</p>
      {retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-3 ${BUTTON_BASE} ${BUTTON_TONES.neutral}`}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * Any mutation failure, rendered where the operator pressed the control.
 *
 * It goes through the same `describeAtlasError` as `SectionError` rather than printing the raw
 * message: Atlas answers an RBAC denial with the body `{"error": "forbidden"}`
 * (`atlas/app.py:241`), so the raw message of a denied Pause/Approve/Retry is the single
 * lowercase word "forbidden" — which, in a destructive box, reads as if Atlas rejected the
 * request rather than the operator's role.
 */
function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const clientError = toClientAtlasError(error);
  const { title, description } = describeAtlasError(clientError);

  return (
    <div role="alert" className={`mt-3 rounded border px-3 py-2 ${errorTone(clientError.kind)}`}>
      <p className="font-mono text-[10px] uppercase tracking-widest">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground">{description}</p>
    </div>
  );
}

/**
 * Why a control is unavailable, stated in the page rather than only in a tooltip.
 *
 * A disabled button with a `title` is invisible to anyone who does not hover it, and "why can't
 * I cancel this run" is exactly the question an operator has at 3am.
 */
function BlockedReasons({ reasons }: { reasons: Array<{ label: string; reason: string }> }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {reasons.map((entry) => (
        <li key={entry.label} className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-mono text-[10px] uppercase tracking-widest">{entry.label}</span>{" "}
          {entry.reason}
        </li>
      ))}
    </ul>
  );
}

function ActionButton({
  label,
  tone = "neutral",
  blocked = null,
  pending = false,
  onClick,
}: {
  label: string;
  tone?: ButtonTone;
  blocked?: string | null;
  pending?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={blocked !== null || pending}
      title={blocked ?? undefined}
      onClick={onClick}
      className={`${BUTTON_BASE} ${BUTTON_TONES[tone]}`}
    >
      {pending ? "Working" : label}
    </button>
  );
}

/** The same button, behind an alert dialog. Used for every irreversible action on this page. */
function ConfirmAction({
  label,
  tone = "danger",
  blocked = null,
  pending = false,
  title,
  confirmLabel,
  description,
  onConfirm,
}: {
  label: string;
  tone?: ButtonTone;
  blocked?: string | null;
  pending?: boolean;
  title: string;
  confirmLabel: string;
  description: ReactNode;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);

  /**
   * The dialog stays open until the mutation settles (Phase 6). Closing on click made the
   * confirmation optimistic: Atlas could still refuse, and the operator had already been
   * shown a closed dialog that read as "done". Now confirm disables both buttons, blocks
   * Escape/overlay dismissal while in flight, and closes only when the request settles — a
   * refusal lands in the section's error slot with the dialog gone but the page state
   * honest. The `wasPending` ref closes it on the transition, not on mount.
   */
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) setOpen(false);
    wasPending.current = pending;
  }, [pending]);

  return (
    <>
      <ActionButton
        label={label}
        tone={tone}
        blocked={blocked}
        pending={pending}
        onClick={() => setOpen(true)}
      />
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && pending) return;
          setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
                {description}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Leave it alone</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              className={
                tone === "danger"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              onClick={(event) => {
                event.preventDefault();
                onConfirm();
              }}
            >
              {pending ? "Working…" : confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ShowMore({
  shown,
  total,
  noun,
  onShowMore,
}: {
  shown: number;
  total: number;
  noun: string;
  onShowMore: () => void;
}) {
  if (shown >= total) return null;
  return (
    <button
      type="button"
      onClick={onShowMore}
      className={`mt-3 ${BUTTON_BASE} ${BUTTON_TONES.neutral}`}
    >
      Show {Math.min(PAGE_STEP, total - shown)} more {noun}
    </button>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Pause, resume, and cancel, with exactly the transitions Atlas permits.
 *
 * The rules are Atlas's, read from `atlas/workflows.py`: `pause_run` (462) raises from anything
 * but `running`, `resume_run` (475) from anything but `paused` or `recovery_required`, and
 * `cancel_run` (604) is a no-op once the run is terminal. Offering a control Atlas would refuse
 * would train an operator to expect an error; hiding it would leave them wondering where it
 * went. So the unavailable ones are disabled and say why.
 */
function RunControls({ run }: { run: RunView }) {
  const runAction = useRunAction();
  const state = run.state.label;
  const terminal = TERMINAL_RUN_STATES.has(state);
  const needsRecoveryAuthorization = state === "recovery_required";

  const pauseBlocked =
    state === "running" ? null : `Atlas pauses a run only from "running"; this one is "${state}".`;
  const resumeBlocked =
    state === "paused" || needsRecoveryAuthorization
      ? null
      : `Atlas resumes a run only from "paused" or "recovery_required"; this one is "${state}".`;
  const cancelBlocked = terminal
    ? `The run already finished as "${state}", and Atlas returns a terminal run unchanged rather than cancelling it.`
    : null;

  const blocked = [
    { label: "Pause", reason: pauseBlocked },
    { label: "Resume", reason: resumeBlocked },
    { label: "Cancel", reason: cancelBlocked },
  ].flatMap((entry) => (entry.reason ? [{ label: entry.label, reason: entry.reason }] : []));

  return (
    <section className="mb-8 rounded-lg border border-border bg-card px-4 py-4">
      <SectionHeading>Run control</SectionHeading>
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          label="Pause"
          blocked={pauseBlocked}
          pending={runAction.isPending}
          onClick={() => runAction.mutate({ runId: run.id, action: "pause" })}
        />
        {needsRecoveryAuthorization ? (
          <RecoveryResumeButton run={run} runAction={runAction} />
        ) : (
          <ActionButton
            label="Resume"
            tone="primary"
            blocked={resumeBlocked}
            pending={runAction.isPending}
            onClick={() => runAction.mutate({ runId: run.id, action: "resume" })}
          />
        )}
        <ConfirmAction
          label="Cancel"
          blocked={cancelBlocked}
          pending={runAction.isPending}
          title="Cancel this run?"
          confirmLabel="Cancel the run"
          description={
            <>
              <p>
                Atlas finalizes the run as <span className="font-mono">cancelled</span>, cancels
                every pending approval on it, and requests cancellation of the job behind each
                running node. A cancelled run cannot be resumed — only a new run can be started.
              </p>
              <p>
                A node&apos;s job that has already been handed to a worker may keep running there
                until the worker honours the cancellation.
              </p>
            </>
          }
          onConfirm={() => runAction.mutate({ runId: run.id, action: "cancel" })}
        />
      </div>
      <BlockedReasons reasons={blocked} />
      <InlineError error={runAction.error} />
    </section>
  );
}

/**
 * The resume that needs an authorization, not just a click.
 *
 * Atlas refuses `resume` on a `recovery_required` run unless the request carries
 * `retry_interrupted: true` ("workflow run requires explicit retry_interrupted authorization",
 * `atlas/workflows.py:481`). That flag is not a formality: Atlas never re-attaches to the
 * in-flight work, so authorizing a retry always submits a **new** job for each interrupted
 * node. Where the old job was callback-pending it is still running on the remote worker, and
 * the retry duplicates it.
 */
function RecoveryResumeButton({
  run,
  runAction,
}: {
  run: RunView;
  /** The caller's mutation, so a refusal lands in the one error slot the control row has. */
  runAction: ReturnType<typeof useRunAction>;
}) {
  const interrupted = run.recovery?.interrupted ?? [];
  const callbackPending = interrupted.filter((node) => node.callbackPending);

  return (
    <ConfirmAction
      label="Authorize retry & resume"
      tone="danger"
      pending={runAction.isPending}
      title="Authorize a retry of the interrupted nodes?"
      confirmLabel="Authorize the retry"
      description={
        <>
          <p>
            Atlas marked this run <span className="font-mono">recovery_required</span> because the
            control plane stopped while node work was in flight. Resuming requires an explicit retry
            authorization, and that authorization submits a{" "}
            <strong className="text-foreground">new job</strong> for every incomplete node — Atlas
            does not re-attach to the old one.
          </p>
          {callbackPending.length > 0 ? (
            <p className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
              {callbackPending.length} of {interrupted.length} interrupted{" "}
              {interrupted.length === 1 ? "node" : "nodes"} had a callback-pending job:{" "}
              {callbackPending.map((node) => node.nodeKey).join(", ")}. That work may still be
              running on the remote worker right now, and its result can still land on the job row.
              Retrying will duplicate it — check those jobs before authorizing.
            </p>
          ) : (
            <p>
              Atlas recorded no callback-pending job among the interrupted nodes, so no remote work
              is known to still be in flight. Side effects the interrupted nodes already performed
              will still be repeated by the retry.
            </p>
          )}
          {run.recovery?.warning ? (
            <p className="font-mono text-xs">Atlas: {run.recovery.warning}</p>
          ) : null}
        </>
      }
      onConfirm={() =>
        runAction.mutate({ runId: run.id, action: "resume", retryInterrupted: true })
      }
    />
  );
}

/** What Atlas found in flight when it restarted, so the operator can check it before retrying. */
function RecoveryPanel({ run }: { run: RunView }) {
  const recovery = run.recovery;
  if (!recovery) return null;

  const active = run.state.label === "recovery_required";

  return (
    <section className="mb-8 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4">
      <SectionHeading>
        Recovery ({recovery.interrupted.length} interrupted{" "}
        {recovery.interrupted.length === 1 ? "node" : "nodes"})
      </SectionHeading>
      {recovery.reason ? (
        <p className="text-sm leading-relaxed text-foreground">{recovery.reason}</p>
      ) : null}
      {recovery.warning ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{recovery.warning}</p>
      ) : null}
      {recovery.retryAuthorizedAt ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          retry already authorized {recovery.retryAuthorizedAt}
        </p>
      ) : null}
      {!active ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          The run has since moved to &quot;{run.state.label}&quot;. This is the record of the
          earlier interruption, kept by Atlas in the run&apos;s counters.
        </p>
      ) : null}

      <div className="mt-4">
        <DataTable
          rows={recovery.interrupted}
          rowKey={(node) => node.nodeKey}
          empty="Atlas named no specific node; the whole run needs authorization to continue."
          columns={[
            {
              key: "nodeKey",
              header: "Node",
              render: (node) => <span className="font-mono text-xs">{node.nodeKey}</span>,
            },
            {
              key: "jobId",
              header: "Job",
              render: (node) => (
                <span className="font-mono text-xs text-muted-foreground">{node.jobId ?? "—"}</span>
              ),
            },
            {
              key: "attempt",
              header: "Attempt",
              render: (node) => (
                <span className="font-mono text-xs tabular-nums">{node.attempt ?? "—"}</span>
              ),
            },
            {
              key: "callbackPending",
              header: "Callback pending",
              className: "text-right",
              render: (node) =>
                node.callbackPending ? (
                  <StatusPill tone="danger">still on worker</StatusPill>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">no</span>
                ),
            },
          ]}
        />
      </div>
    </section>
  );
}

/**
 * Human gates, decided the way Atlas splits them.
 *
 * `approve_approval` raises "approval requires a branch choice" on a gate that declares choices
 * and `choose_approval` raises "approval does not declare branch choices" on one that does not
 * (`atlas/workflows.py:625,652`), so the control set is derived from the gate rather than
 * offered wholesale. Both kinds accept a rejection, and a rejection fails the run.
 */
function ApprovalActions({ approval, runState }: { approval: ApprovalView; runState: string }) {
  const decide = useDecideApproval();

  if (approval.state.label !== "pending") {
    return (
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        decided {approval.decidedAt}
      </span>
    );
  }

  // Atlas re-reads the run inside `_pending_approval_context` and refuses any decision unless
  // the run is parked at the gate, so a decision offered here would fail with its own message.
  if (runState !== "waiting_for_human") {
    return (
      <span className="text-xs text-muted-foreground">
        Atlas accepts a decision only while the run is &quot;waiting_for_human&quot;; this run is
        &quot;{runState}&quot;.
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {approval.choices.length > 0 ? (
          approval.choices.map((choice) => (
            <ActionButton
              key={choice.id}
              label={choice.label}
              tone="primary"
              pending={decide.isPending}
              onClick={() =>
                decide.mutate({
                  approvalId: approval.id,
                  decision: "choose",
                  choice: choice.id,
                })
              }
            />
          ))
        ) : (
          <ActionButton
            label="Approve"
            tone="primary"
            pending={decide.isPending}
            onClick={() => decide.mutate({ approvalId: approval.id, decision: "approve" })}
          />
        )}
        <ConfirmAction
          label="Reject"
          pending={decide.isPending}
          title="Reject this gate and fail the run?"
          confirmLabel="Reject and fail the run"
          description={
            <>
              <p>
                A rejection is not a &quot;no, take the other branch&quot;. Atlas marks the
                gate&apos;s node failed and finalizes the whole run as{" "}
                <span className="font-mono">failed</span> with the error{" "}
                <span className="font-mono">human approval rejected at {approval.nodeKey}</span>.
              </p>
              <p>
                Nothing downstream of the gate will run, and the run cannot be resumed afterwards.
              </p>
            </>
          }
          onConfirm={() => decide.mutate({ approvalId: approval.id, decision: "reject" })}
        />
      </div>
      <InlineError error={decide.error} />
    </div>
  );
}

/**
 * The inverse of the download route's own kind-to-status table (`api.artifacts.$id.content.ts`),
 * so a refused download reads like every other Atlas failure on this page instead of like a
 * transport accident.
 */
const DOWNLOAD_ERROR_KINDS: Record<number, AtlasErrorKind> = {
  400: "validation",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  504: "timeout",
};

async function readDownloadError(response: Response): Promise<ClientAtlasError> {
  const kind = DOWNLOAD_ERROR_KINDS[response.status] ?? "server";
  const body = await response.text().catch(() => "");
  return { kind, message: body.trim() || "The download could not be completed." };
}

/** Artifacts of the run. Only a `file_ref` has bytes behind a download. */
function ArtifactsSection({ runId }: { runId: string }) {
  const artifacts = useQuery(runArtifactsQuery(runId));
  const [shown, setShown] = useState(PAGE_STEP);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<ClientAtlasError | null>(null);

  /**
   * The download is fetched rather than left to a plain `<a href download>`.
   *
   * That anchor cannot fail visibly: the route answers a refusal with Atlas's status and a
   * text/plain body, and `download` makes the browser *save* that body — so a 403 from the role
   * check, or the 400 Atlas raises when a `file_ref` resolves outside the upload root
   * (`atlas/app.py:934-935`), lands on disk as a file containing the word "forbidden" with
   * nothing on screen. Checking the response first puts the refusal in the page.
   */
  async function downloadArtifact(artifact: ArtifactView) {
    setDownloadError(null);
    setDownloadingId(artifact.id);
    try {
      // Same-origin: the route handler adds the Atlas bearer server-side, so the token is
      // never in this URL and never in browser memory.
      const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}/content`);
      if (!response.ok) {
        setDownloadError(await readDownloadError(response));
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = artifact.filename ?? artifact.key;
      link.click();
      // The click only *starts* the save, so revoking in this same task can cancel it; one
      // macrotask later the browser holds its own reference and the blob can be released.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch {
      setDownloadError({
        kind: "network",
        message: "The browser could not reach this origin to fetch the artifact.",
      });
    } finally {
      setDownloadingId(null);
    }
  }

  if (artifacts.isPending) return <SectionLoading label="Loading artifacts" />;
  if (artifacts.isError) {
    return <SectionError error={artifacts.error} onRetry={() => void artifacts.refetch()} />;
  }

  const rows = artifacts.data.slice(0, shown);

  return (
    <>
      <DataTable
        rows={rows}
        rowKey={(artifact) => artifact.id}
        empty="This run produced no artifacts."
        columns={[
          {
            key: "key",
            header: "Key",
            render: (artifact) => (
              <span className="font-mono text-xs text-primary">{artifact.key}</span>
            ),
          },
          {
            key: "kind",
            header: "Kind",
            render: (artifact) => <span className="font-mono text-xs">{artifact.kind}</span>,
          },
          {
            key: "sizeBytes",
            header: "Size",
            render: (artifact) => (
              <span className="font-mono text-xs tabular-nums">
                {formatBytes(artifact.sizeBytes)}
              </span>
            ),
          },
          {
            key: "createdAt",
            header: "Created",
            render: (artifact) => (
              <span className="font-mono text-xs text-muted-foreground">{artifact.createdAt}</span>
            ),
          },
          {
            key: "download",
            header: "Content",
            className: "text-right",
            render: (artifact) =>
              artifact.downloadable ? (
                <ActionButton
                  label="Download"
                  pending={downloadingId === artifact.id}
                  onClick={() => void downloadArtifact(artifact)}
                />
              ) : (
                <span className="text-xs text-muted-foreground">
                  Atlas serves bytes only for &quot;file_ref&quot;; a &quot;{artifact.kind}&quot;
                  artifact carries its content inline.
                </span>
              ),
          },
        ]}
      />
      <InlineError error={downloadError} />
      <ShowMore
        shown={rows.length}
        total={artifacts.data.length}
        noun="artifacts"
        onShowMore={() => setShown((current) => current + PAGE_STEP)}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Showing {rows.length} of the {artifacts.data.length} artifacts Atlas returned. This route is
        unwindowed on Atlas&apos;s side, so the count is the run&apos;s real total.
      </p>
    </>
  );
}

/**
 * Outbound webhook deliveries for this run, plus the two things an operator can do about them.
 *
 * `deliver_run` refuses a run that is not `succeeded`/`failed` ("workflow run has not completed
 * yet") and one with no reply address ("workflow run has no _meta.reply.callback_url
 * configured"). Both conditions are visible in the run row, so they are named here instead of
 * being discovered by pressing a button; any *other* refusal still comes back from Atlas and is
 * shown verbatim.
 */
function DeliveriesSection({ run }: { run: RunView }) {
  const deliveries = useQuery(deliveriesQuery({ limit: DELIVERY_WINDOW, runId: run.id }));
  const deliverRun = useDeliverRun();
  const retryDelivery = useRetryDelivery();

  const state = run.state.label;
  const deliverBlocked =
    state !== "succeeded" && state !== "failed"
      ? `Atlas delivers only a succeeded or failed run; this one is "${state}".`
      : run.replyCallbackUrl === null
        ? "This run carries no _meta.reply.callback_url, so Atlas has no address to deliver to."
        : null;

  return (
    <section className="mb-8">
      <SectionHeading
        aside={
          <div className="flex items-center gap-2">
            <ActionButton
              label="Send webhook now"
              tone="primary"
              blocked={deliverBlocked}
              pending={deliverRun.isPending}
              onClick={() => deliverRun.mutate({ runId: run.id })}
            />
          </div>
        }
      >
        Webhook delivery attempts
      </SectionHeading>

      <BlockedReasons
        reasons={deliverBlocked ? [{ label: "Send webhook now", reason: deliverBlocked }] : []}
      />
      {run.replyCallbackUrl ? (
        <p className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          callback url {run.replyCallbackUrl}
        </p>
      ) : null}
      <InlineError error={deliverRun.error} />
      <InlineError error={retryDelivery.error} />

      <div className="mt-3">
        {deliveries.isPending ? (
          <SectionLoading label="Loading webhook deliveries" />
        ) : deliveries.isError ? (
          <SectionError error={deliveries.error} onRetry={() => void deliveries.refetch()} />
        ) : (
          <>
            <DataTable
              rows={deliveries.data}
              rowKey={(delivery) => delivery.id}
              empty="Atlas has not opened a webhook delivery for this run."
              columns={[
                {
                  key: "url",
                  header: "URL",
                  render: (delivery) => (
                    <span className="line-clamp-1 font-mono text-xs break-all">{delivery.url}</span>
                  ),
                },
                {
                  key: "attempts",
                  header: "Attempts",
                  render: (delivery) => (
                    <span className="font-mono text-xs tabular-nums">
                      {delivery.attempts} / {delivery.maxAttempts}
                    </span>
                  ),
                },
                {
                  key: "createdAt",
                  header: "Created",
                  render: (delivery) => (
                    <span className="font-mono text-xs text-muted-foreground">
                      {delivery.createdAt}
                    </span>
                  ),
                },
                {
                  key: "lastError",
                  header: "Last error",
                  render: (delivery) =>
                    delivery.lastError ? (
                      <span
                        title={delivery.lastError}
                        className="line-clamp-1 font-mono text-[11px] text-destructive"
                      >
                        {delivery.lastError}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">—</span>
                    ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (delivery) => (
                    <StatusPill tone={delivery.status.tone}>{delivery.status.label}</StatusPill>
                  ),
                },
                {
                  key: "retry",
                  header: "Retry webhook",
                  className: "text-right",
                  render: (delivery) => {
                    // Only a `pending` row is Atlas's to drive: `_attempt` keeps re-sending it,
                    // and `reconcile` re-drives exactly the pending rows after a restart
                    // (`atlas/outbound.py:388-393`). Every other non-delivered status is the
                    // operator's, and `blocked` is the reason this cannot key off spent
                    // attempts: `_block` writes the status and the reason WITHOUT incrementing
                    // `attempts` (`atlas/outbound.py:442-445`), so a delivery stopped by the
                    // outbound allowlist or a missing signing key never looks exhausted — while
                    // being precisely what `retry_delivery` is for, since it re-validates the
                    // url against the current allowlist (`atlas/outbound.py:352-353`).
                    if (delivery.status.label === "pending") {
                      return (
                        <span className="text-xs text-muted-foreground">
                          Atlas still has attempts left on this webhook delivery and retries it
                          itself.
                        </span>
                      );
                    }
                    if (delivery.status.label === "delivered") {
                      return (
                        <span className="text-xs text-muted-foreground">
                          The receiver accepted this webhook delivery.
                        </span>
                      );
                    }
                    return (
                      <ActionButton
                        label="Retry webhook"
                        pending={retryDelivery.isPending}
                        onClick={() => retryDelivery.mutate({ deliveryId: delivery.id })}
                      />
                    );
                  },
                },
              ]}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              The newest {deliveries.data.length} webhook deliveries for this run, in a window of{" "}
              {DELIVERY_WINDOW}. Atlas reports no total and offers no cursor.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Atlas's persisted run history.
 *
 * Not a live stream: the durable record is a cursor-paged Atlas history. Live progress remains
 * the per-job SSE above, while this page can walk the persisted sequence after a reload.
 * Rendering stays bounded even when an operator loads a long history.
 */
function EventsSection({ runId }: { runId: string }) {
  const [eventWindow, setEventWindow] = useState<number>(500);
  const [after, setAfter] = useState(0);
  const [shown, setShown] = useState(PAGE_STEP);
  const [history, setHistory] = useState(EMPTY_RUN_EVENT_HISTORY);
  const events = useQuery(runEventsQuery(runId, { limit: eventWindow, after }));

  useEffect(() => {
    setAfter(0);
    setShown(PAGE_STEP);
    setHistory(EMPTY_RUN_EVENT_HISTORY);
  }, [runId, eventWindow]);

  useEffect(() => {
    const page = events.data;
    if (!page) return;
    setHistory((current) =>
      page.after === 0
        ? appendRunEventPage(EMPTY_RUN_EVENT_HISTORY, page)
        : appendRunEventPage(current, page),
    );
  }, [events.data]);

  const newestFirst = useMemo(
    () => [...history.events].sort((a, b) => b.seq - a.seq),
    [history.events],
  );
  const rows = newestFirst.slice(0, shown);
  const hasMore = events.data?.hasMore ?? false;

  return (
    <section className="mb-8">
      <SectionHeading
        aside={
          <div className="flex items-center gap-1">
            {ATLAS_LIMIT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setEventWindow(option);
                }}
                className={`rounded-full border px-3 py-0.5 font-mono text-[10px] uppercase tracking-widest transition ${
                  eventWindow === option
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        }
      >
        Run events
      </SectionHeading>

      {events.isPending && history.events.length === 0 ? (
        <SectionLoading label="Loading run events" />
      ) : events.isError ? (
        <SectionError error={events.error} onRetry={() => void events.refetch()} />
      ) : (
        <>
          <DataTable
            rows={rows}
            rowKey={(event) => event.id}
            empty="Atlas recorded no events for this run."
            columns={[
              {
                key: "seq",
                header: "Seq",
                render: (event) => (
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {event.seq}
                  </span>
                ),
              },
              {
                key: "createdAt",
                header: "At",
                render: (event) => <span className="font-mono text-xs">{event.createdAt}</span>,
              },
              {
                key: "type",
                header: "Event",
                render: (event) => (
                  <span className="font-mono text-xs text-primary">{event.type}</span>
                ),
              },
              {
                key: "nodeKey",
                header: "Node",
                render: (event) => (
                  <span className="font-mono text-xs">{event.nodeKey ?? "—"}</span>
                ),
              },
              {
                key: "detail",
                header: "Payload",
                render: (event) =>
                  event.detail ? (
                    <span
                      title={event.detail}
                      className="line-clamp-1 font-mono text-[11px] text-muted-foreground"
                    >
                      {event.detail}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">—</span>
                  ),
              },
            ]}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Showing {rows.length} of {history.events.length} loaded events, newest first. Atlas
            pages this history with an exclusive sequence cursor;{" "}
            {hasMore ? "load more to continue." : "the full history is loaded."}
            {history.dropped > 0
              ? ` Older rows are outside the ${RUN_EVENT_HISTORY_CAP}-event UI cap.`
              : ""}
          </p>
          <ShowMore
            shown={rows.length}
            total={newestFirst.length}
            noun="events"
            onShowMore={() => setShown((current) => current + PAGE_STEP)}
          />
          {hasMore ? (
            <button
              type="button"
              className={`${BUTTON_BASE} ${BUTTON_TONES.neutral} mt-3`}
              disabled={events.isFetching}
              onClick={() => setAfter(events.data?.nextAfter ?? after)}
            >
              {events.isFetching ? "Loading history…" : "Load more events"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Data-layer polling interval while the run is live (Phase 4).
 *
 * Per-job SSE already triggers a refetch on state-shaped events, but not every transition has
 * a streaming job behind it — a human gate waits on a person, a manager decision routes
 * between nodes, and the moment between one node finishing and the next job starting has no
 * open stream at all. A bounded poll of the persisted run covers those gaps. It stops the
 * moment the run is terminal.
 */
const RUN_POLL_MS = 5_000;

function RunDetail() {
  const { id } = Route.useParams();
  /**
   * Seeded from the loader so hydration does not refetch — see the note in `workflows.$id.tsx`.
   */
  const { data: detail } = useQuery({
    ...runQuery(id),
    initialData: Route.useLoaderData(),
    refetchInterval: (query) => {
      const state = query.state.data?.run.state.label;
      return state !== undefined && !TERMINAL_RUN_STATES.has(state) ? RUN_POLL_MS : false;
    },
  });
  const { run, nodes, edges, approvals } = detail;

  /** Atlas's own record of where the run is, and the only source of node highlighting here. */
  const currentNodes = new Set(run.currentNodes);

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

        <RecoveryPanel run={run} />
        <RunControls run={run} />

        <section className="mb-8">
          <SectionHeading>Run graph</SectionHeading>
          {detail.graphSnapshot === null ? (
            <p className="rounded-lg border border-border bg-card px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              This run carries no graph snapshot, so there is no canvas to draw. The runtime nodes
              below are still the authoritative record.
            </p>
          ) : detail.graphSnapshot.ok ? (
            <RunCanvas
              graph={detail.graphSnapshot.graph}
              runtimeNodes={nodes}
              runtimeEdges={edges}
            />
          ) : (
            <p className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-xs leading-relaxed text-foreground">
              The graph this run started on uses something this canvas does not model:{" "}
              <span className="font-mono">{detail.graphSnapshot.reason}</span>. Drawing only the
              part that parsed would misrepresent the run, so the canvas is not shown; the runtime
              node table below is complete.
            </p>
          )}
        </section>

        <RunLiveSection detail={detail} />

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
          <SectionHeading>Runtime nodes ({nodes.length})</SectionHeading>
          <DataTable
            rows={nodes}
            rowKey={(n) => n.id}
            empty="Atlas created no runtime nodes for this run."
            columns={[
              {
                key: "nodeKey",
                header: "Node",
                render: (n) => (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-primary">{n.nodeKey}</span>
                    {/* Atlas's `current_nodes`, not a client-side guess about progress. */}
                    {currentNodes.has(n.nodeKey) ? (
                      <StatusPill tone="primary">current</StatusPill>
                    ) : null}
                  </span>
                ),
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
                    <span
                      title={n.error}
                      className="line-clamp-1 font-mono text-[11px] text-destructive"
                    >
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
          <SectionHeading>Approvals ({approvals.length})</SectionHeading>
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
                render: (a) => (
                  <>
                    <span className="text-sm">{a.label || "—"}</span>
                    {a.reason ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">{a.reason}</span>
                    ) : null}
                  </>
                ),
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
                render: (a) => <StatusPill tone={a.state.tone}>{a.state.label}</StatusPill>,
              },
              {
                key: "actions",
                header: "Act",
                className: "text-right",
                render: (a) => <ApprovalActions approval={a} runState={run.state.label} />,
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

        <section className="mb-8">
          <SectionHeading>Artifacts</SectionHeading>
          <ArtifactsSection runId={run.id} />
        </section>

        <DeliveriesSection run={run} />

        <EventsSection runId={run.id} />

        <section>
          <SectionHeading>Runtime edges ({edges.length})</SectionHeading>
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
      </div>
    </>
  );
}
