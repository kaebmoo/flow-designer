import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { AlertTriangle, BellRing, Check, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ArtifactContentActions, ArtifactDownloadError } from "@/components/atlas/artifact-actions";
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
import { useArtifactDownloads } from "@/hooks/use-artifact-downloads";
import {
  ARTIFACT_PREVIEW_MAX_CHARS,
  describeAtlasError,
  formatDurationMs,
  runDeclaredOutputs,
  toClientAtlasError,
  type ApprovalView,
  type ClientAtlasError,
  type RunDetailView,
  type RunView,
} from "@/lib/atlas-mappers";
import { WORKFLOW_INTERFACE_SCHEMA_VERSION } from "@/lib/atlas-types";
import {
  useDecideApproval,
  useDeliverRun,
  useRetryDelivery,
  useRunAction,
} from "@/lib/atlas-mutations";
import { deliveriesQuery, runArtifactsQuery, runEventsQuery, runQuery } from "@/lib/atlas-queries";
import { chooseRunFileKey, type ExistingRunFile } from "@/lib/run-file-keys";
import { ATLAS_LIMIT_OPTIONS } from "@/lib/atlas-search";
import {
  appendRunEventPage,
  EMPTY_RUN_EVENT_HISTORY,
  RUN_EVENT_HISTORY_CAP,
} from "@/lib/run-event-history";
import { observeWorkflowContract } from "@/lib/workflow-run-contract";

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

/**
 * Documented mono type ramp for this page (DESIGN.md sets mono at 9–10px).
 *   - `text-[9px]`  : sub-labels inside a field/chip (the smallest rung)
 *   - `text-[10px]` : the default machine token — ids, headings, status chips
 *   - `text-[11px]` : dense payload/log body where a value must stay readable at length
 *                     (event payload, artifact preview, delivery error). One deliberate
 *                     step up from the token size, never larger.
 */

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded border px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition disabled:cursor-not-allowed disabled:opacity-40";

const BUTTON_TONES = {
  primary: "border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
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

/**
 * A section title. `emphasis` lifts action-critical sections (Run control, Approvals, Recovery)
 * one weight/tone step above the reference tables so an operator can tell "here is something to
 * act on" from "here is a record to read" without reading either.
 */
function SectionHeading({
  children,
  aside,
  emphasis = false,
}: {
  children: ReactNode;
  aside?: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2
        className={
          emphasis
            ? "font-mono text-[11px] font-semibold uppercase tracking-widest text-foreground"
            : "font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
        }
      >
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
  icon,
  tone = "neutral",
  blocked = null,
  pending = false,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
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
      {icon && !pending ? <span className="[&_svg]:size-3.5">{icon}</span> : null}
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
                  ? "bg-destructive-solid text-destructive-foreground hover:bg-destructive-solid/90"
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
      <SectionHeading emphasis>Run control</SectionHeading>
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
      <SectionHeading emphasis>
        Recovery ({recovery.interrupted.length} interrupted{" "}
        {recovery.interrupted.length === 1 ? "node" : "nodes"})
      </SectionHeading>
      {active ? (
        <p className="mb-2 text-sm leading-relaxed text-foreground">
          Atlas set this run to <span className="font-mono">recovery_required</span> — the control
          plane stopped while node work was still in flight, so the run needs you to authorize
          continuing before it will move again.
        </p>
      ) : null}
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

      <p className="mt-4 mb-2 text-xs leading-relaxed text-muted-foreground">
        A node marked <span className="font-mono">callback-pending</span> still has a job that may
        be running on a remote worker right now; its result can land after the interruption, so
        authorizing a retry can duplicate it.
      </p>
      <div>
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
            <ConfirmAction
              key={choice.id}
              label={choice.label}
              tone="primary"
              pending={decide.isPending}
              title={`Take the "${choice.label}" branch?`}
              confirmLabel={`Choose "${choice.label}"`}
              description={
                <p>
                  Atlas records <span className="font-mono">{choice.label}</span> as the decision at{" "}
                  <span className="font-mono">{approval.nodeKey}</span> and continues the run down
                  that branch. A gate can only be decided once, and the run advances immediately.
                </p>
              }
              onConfirm={() =>
                decide.mutate({
                  approvalId: approval.id,
                  decision: "choose",
                  choice: choice.id,
                })
              }
            />
          ))
        ) : (
          <ConfirmAction
            label="Approve"
            tone="primary"
            pending={decide.isPending}
            title="Approve this gate and continue?"
            confirmLabel="Approve and continue"
            description={
              <p>
                Atlas records the approval at <span className="font-mono">{approval.nodeKey}</span>{" "}
                and continues the run past the gate. A gate can only be decided once, and the run
                advances immediately.
              </p>
            }
            onConfirm={() => decide.mutate({ approvalId: approval.id, decision: "approve" })}
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
 * The one thing an operator most needs to do on a parked run, lifted out of section ~11 to the
 * top of the page.
 *
 * When the run is `waiting_for_human` it will not move until a gate is decided, so the decision
 * controls are rendered here — above the graph — instead of only far down in the Approvals
 * table. It reuses {@link ApprovalActions}, so this is the same authoritative control (and the
 * same Atlas guard), not a shortcut that bypasses it. Renders nothing unless the run is actually
 * parked at a pending gate.
 */
function PendingApprovalCard({
  approvals,
  runState,
}: {
  approvals: ApprovalView[];
  runState: string;
}) {
  const pending = approvals.filter((approval) => approval.state.label === "pending");
  if (runState !== "waiting_for_human" || pending.length === 0) return null;

  return (
    <section
      aria-labelledby="pending-approval-heading"
      className="mb-8 rounded-lg border-2 border-accent/50 bg-accent/10 px-4 py-4"
    >
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-accent" />
        <h2
          id="pending-approval-heading"
          className="font-mono text-[11px] font-semibold uppercase tracking-widest text-accent"
        >
          Waiting for a human decision
        </h2>
      </div>
      <p className="mb-4 text-sm leading-relaxed text-foreground">
        This run is paused at{" "}
        {pending.length === 1 ? "a human gate" : `${pending.length} human gates`} and will not
        continue until {pending.length === 1 ? "it is" : "each is"} decided below.
      </p>
      <ul className="space-y-3">
        {pending.map((approval) => (
          <li
            key={approval.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded border border-accent/30 bg-card px-3 py-3"
          >
            <div className="min-w-0">
              <span className="font-mono text-xs text-foreground">{approval.nodeKey}</span>
              {approval.label ? (
                <span className="mt-0.5 block text-sm text-foreground">{approval.label}</span>
              ) : null}
              {approval.reason ? (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {approval.reason}
                </span>
              ) : null}
              {/* Whether anyone has actually been chased. Muted, not a status hue: this is a
                  fact about the reminder ledger, not a state Atlas reported for the run. */}
              {approval.overdueLevel > 0 ? (
                <span className="mt-1 flex items-baseline gap-1.5 text-xs text-muted-foreground">
                  <BellRing aria-hidden className="size-3 shrink-0 translate-y-0.5" />
                  <span>
                    {approval.overdueLevel === 1
                      ? "Overdue reminder sent"
                      : `Escalated to level ${approval.overdueLevel}`}{" "}
                    ·{" "}
                    <Link
                      to="/deliveries"
                      search={{ event: "approval_overdue" }}
                      className="text-primary underline underline-offset-2"
                    >
                      check delivery
                    </Link>
                  </span>
                </span>
              ) : null}
            </div>
            <ApprovalActions approval={approval} runState={runState} />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        The full record for every gate on this run is in the{" "}
        <a href="#approvals" className="text-primary underline underline-offset-2">
          Approvals
        </a>{" "}
        section below.
      </p>
    </section>
  );
}

/**
 * The exact input Atlas persisted for this run, bounded and collapsed.
 *
 * Collapsed by default because this is the run's business payload: a permit application, a
 * customer record, whatever the caller sent. Someone screen-sharing a run page should not
 * broadcast it by opening the page, and someone who needs it is one click away.
 *
 * `_meta` shows here with everything else — it is part of what Atlas stored, and hiding the
 * reply configuration from the one view that explains a delivery would be unhelpful. It stays
 * inside this bounded preview: nothing on this page feeds run input into a generated snippet.
 */
function RunInputSection({ detail }: { detail: RunDetailView }) {
  if (detail.inputPreview === null) return null;

  return (
    <section className="mb-8">
      <SectionHeading>Run input</SectionHeading>
      <details className="rounded-lg border border-border bg-card" data-testid="run-input">
        <summary className="cursor-pointer px-4 py-3 text-xs text-muted-foreground">
          Show the input this run was started with
        </summary>
        <div className="border-t border-border px-4 py-3">
          <p className="mb-2 text-xs leading-relaxed text-warning">
            This is the caller&apos;s payload as Atlas stored it. It may contain personal or
            otherwise sensitive data — take care before sharing a screenshot or an export.
          </p>
          <pre
            data-testid="run-input-preview"
            className="max-h-80 overflow-auto rounded border border-border bg-secondary/20 px-3 py-2 text-[11px] leading-relaxed"
          >
            {detail.inputPreview}
          </pre>
          {detail.inputTruncated ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Truncated at {ARTIFACT_PREVIEW_MAX_CHARS.toLocaleString()} characters. Atlas holds the
              complete value; read it with{" "}
              <span className="font-mono">GET /api/workflow-runs/{detail.run.id}</span>.
            </p>
          ) : null}
        </div>
      </details>
    </section>
  );
}

/**
 * The application interface (and workflow version) this run actually started with, frozen at
 * creation — never a re-read of the current live workflow definition, which may have been edited
 * or deleted since. A legacy run, a run against a workflow with no interface, and a run recorded
 * before Atlas migration 015 all read the same way here: no authoritative contract available,
 * stated plainly rather than guessed from the workflow this run happens to still point at.
 */
function RunInterfaceSection({ detail }: { detail: RunDetailView }) {
  const snapshot = detail.interfaceSnapshot;

  return (
    <section className="mb-8">
      <SectionHeading>Application interface</SectionHeading>
      {snapshot.kind === "absent" ? (
        <p
          data-testid="run-interface-absent"
          className="rounded-lg border border-border bg-card px-4 py-3 text-xs leading-relaxed text-muted-foreground"
        >
          No authoritative contract is available for this run — it started against a workflow with
          no declared interface, or against an Atlas checkout old enough to have none. This is a
          fact about the run as it started, not a guess from the current workflow definition.
        </p>
      ) : snapshot.value.schema_version !== WORKFLOW_INTERFACE_SCHEMA_VERSION ? (
        <div
          data-testid="run-interface-unsupported"
          className="rounded-lg border border-warning/40 bg-card px-4 py-3 text-xs"
        >
          <p className="mb-2 text-foreground">
            Started against workflow version{" "}
            <span className="font-mono">{snapshot.workflowVersion ?? "unknown"}</span> with
            interface schema_version{" "}
            <span className="font-mono">{snapshot.value.schema_version}</span> — a format newer than
            this build of Flow Designer understands (only{" "}
            <span className="font-mono">schema_version {WORKFLOW_INTERFACE_SCHEMA_VERSION}</span> is
            interpreted). The frozen snapshot is shown raw, uninterpreted, so nothing below is a
            guess.
          </p>
          <pre className="max-h-64 overflow-auto rounded border border-border bg-secondary/20 px-3 py-2 text-[11px] leading-relaxed">
            {JSON.stringify(snapshot.value, null, 2)}
          </pre>
        </div>
      ) : (
        <div
          data-testid="run-interface-present"
          className="rounded-lg border border-success/40 bg-card px-4 py-3 text-xs"
        >
          <p className="mb-2 text-foreground">
            Started against workflow version{" "}
            <span className="font-mono">{snapshot.workflowVersion ?? "unknown"}</span>, interface{" "}
            <span className="font-mono">schema_version</span> (the format version of this contract){" "}
            <span className="font-mono">{snapshot.value.schema_version}</span>.
          </p>
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              Show the input_schema and outputs this run was declared against
            </summary>
            <div className="mt-2 space-y-3">
              <pre className="max-h-64 overflow-auto rounded border border-border bg-secondary/20 px-3 py-2 text-[11px] leading-relaxed">
                {JSON.stringify(snapshot.value.input_schema, null, 2)}
              </pre>
              {snapshot.value.outputs && snapshot.value.outputs.length > 0 ? (
                <ul className="space-y-1">
                  {snapshot.value.outputs.map((output) => (
                    <li key={output.key} className="text-xs">
                      <span className="font-mono text-foreground">{output.key}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — kind {output.kind}
                        {output.key === snapshot.value.primary_output ? " · primary" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No public output was declared.</p>
              )}
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

/**
 * Artifacts of the run. Only a `file_ref` has bytes behind a download.
 *
 * `observedKeys` are the artifact keys the run's **own graph snapshot** declares — not the live
 * workflow definition, which may have been edited since. They are marked so a test run's expected
 * output is findable at a glance, and every other row is still listed: an artifact this UI did
 * not predict is exactly the one worth noticing, so nothing is filtered.
 */
/**
 * Attach input files to this run as `file_ref` artifacts.
 *
 * Bytes travel through this origin's transport route (`/api/workflow-runs/{id}/files`), never
 * to Atlas directly — the browser holds no bearer. Uploads are sequential on purpose: Atlas
 * writes each file atomically, and one clear per-file error beats a burst of parallel
 * failures. The intended flow for inputs is a run started held (born `paused`): attach
 * everything here, then Resume — uploads can never race the first node's dispatch.
 */
/** Used when the refusal carries no usable text of its own. */
const UPLOAD_FALLBACK_ERROR = "The file could not be uploaded.";

function InputFilesUploader({
  runId,
  runState,
  existingFiles,
  onUploaded,
}: {
  runId: string;
  runState: string;
  /**
   * The artifacts the run already carries, by key and stored filename. Both matter: the key
   * says what is taken, and the filename is the only thing that separates "the operator is
   * replacing this file" from "two different files whose names sanitise alike".
   */
  existingFiles: readonly ExistingRunFile[];
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // What the last batch actually attached. A silent refresh is not an answer: after a partial
  // failure the table grows by two rows while the alert names only the third file, and nothing
  // on the page says whether the first two are on the run or not.
  const [attached, setAttached] = useState(0);

  const terminal = runState === "succeeded" || runState === "failed" || runState === "cancelled";
  const blockedReason = terminal
    ? `This run is "${runState}" — files attached now can no longer reach a node.`
    : null;

  async function uploadFiles(files: FileList) {
    setUploading(true);
    setUploadError(null);
    setAttached(0);
    // Grows as the batch goes: two files picked together collide with each other just as
    // readily as with something already on the run.
    const known: ExistingRunFile[] = [...existingFiles];
    let landed = 0;
    try {
      for (const file of Array.from(files)) {
        const { key, replaces } = chooseRunFileKey(file.name, known);
        if (!replaces) known.push({ key, filename: file.name });
        const response = await fetch(
          `/api/workflow-runs/${encodeURIComponent(runId)}/files?key=${encodeURIComponent(key)}`,
          {
            method: "POST",
            headers: {
              "content-type": file.type || "application/octet-stream",
              // Percent-encoded: fetch() throws on any header byte above U+00FF, so a Thai
              // filename sent raw never leaves the browser. The transport route decodes.
              "x-filename": encodeURIComponent(file.name),
            },
            body: file,
          },
        );
        if (!response.ok) {
          // The transport route answers `text/plain` — that is the house shape for these
          // routes (`transport-error.server.ts`, shared with the CSV exports and the event
          // stream). Reading it as JSON discarded every refusal Atlas or the route wrote and
          // showed the generic fallback instead. Length-capped because an intermediary (a
          // proxy error page) can answer here too, and that is not operator copy.
          const body = (await response.text().catch(() => "")).trim();
          const message = body.length > 0 && body.length <= 300 ? body : UPLOAD_FALLBACK_ERROR;
          throw new Error(`${file.name}: ${message}`);
        }
        landed += 1;
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : UPLOAD_FALLBACK_ERROR);
    } finally {
      // Refreshed on any file that landed, not only on a clean batch. Uploads are sequential,
      // so a failure on the third file leaves the first two genuinely attached to the run —
      // and leaving them off the table until a reload is how an operator re-attaches a file
      // Atlas already holds.
      if (landed > 0) onUploaded();
      setAttached(landed);
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-primary/30 bg-primary/[0.04] p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) {
              void uploadFiles(event.target.files);
            }
          }}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Upload className="size-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Attach input files
            </h3>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Attach files before resuming a held run. Each file is stored as a{" "}
            <span className="font-mono">file_ref</span> artifact with key{" "}
            <span className="font-mono">upload_&lt;name&gt;</span> and passed to workers through{" "}
            <span className="font-mono">push_files</span>.
          </p>
        </div>
        <ActionButton
          label={uploading ? "Uploading" : "Upload input file"}
          icon={<Upload aria-hidden="true" />}
          tone="primary"
          blocked={blockedReason}
          pending={uploading}
          onClick={() => inputRef.current?.click()}
        />
      </div>

      {/* The reason lives in the page, not in the disabled button's `title`: `BUTTON_BASE`
          fades a disabled button but a tooltip is unreachable by keyboard and screen reader
          either way. This is the same primitive Run control uses for the same reason. */}
      <BlockedReasons
        reasons={blockedReason ? [{ label: "Upload input file", reason: blockedReason }] : []}
      />

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Re-attaching the same filename replaces it; different filenames are added because Atlas
        cannot remove an artifact once created.
      </p>

      {/* Announced, and paired with an icon — the tone is never the only signal. */}
      {attached === 0 ? null : (
        <p role="status" className="mt-2 flex items-start gap-1.5 text-xs text-success">
          <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {attached === 1
            ? "1 file attached to this run."
            : `${attached} files attached to this run.`}
        </p>
      )}
      {uploadError === null ? null : (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {uploadError}
        </p>
      )}
    </div>
  );
}

function ArtifactsSection({
  runId,
  runState,
  observedKeys,
  declaredOutputs,
}: {
  runId: string;
  runState: string;
  observedKeys: Set<string>;
  /** From the run's `interface_snapshot`; `null` when this run has no declared contract. */
  declaredOutputs: { keys: Set<string>; primary: string | null } | null;
}) {
  const artifacts = useQuery(runArtifactsQuery(runId));
  const [shown, setShown] = useState(PAGE_STEP);
  const { pendingIds, downloadError, downloadArtifact } = useArtifactDownloads();

  if (artifacts.isPending) return <SectionLoading label="Loading artifacts" />;
  if (artifacts.isError) {
    return <SectionError error={artifacts.error} onRetry={() => void artifacts.refetch()} />;
  }

  const rows = artifacts.data.slice(0, shown);

  return (
    <>
      <InputFilesUploader
        runId={runId}
        runState={runState}
        // The whole list, not the paged `rows`: a key collides whether or not its row is shown.
        existingFiles={artifacts.data.map(({ key, filename }) => ({ key, filename }))}
        onUploaded={() => void artifacts.refetch()}
      />
      <DataTable
        rows={rows}
        rowKey={(artifact) => artifact.id}
        empty="This run produced no artifacts."
        columns={[
          {
            key: "key",
            header: "Key",
            render: (artifact) => (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-foreground">{artifact.key}</span>
                {declaredOutputs?.keys.has(artifact.key) ? (
                  <span
                    data-testid={`declared-output-${artifact.key}`}
                    title="This run's interface_snapshot declares this key as a public output. Possible, not guaranteed on every run."
                    aria-label="Declared output: this run's interface declares this key as a public output — possible, not guaranteed on every run."
                    className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-success"
                  >
                    declared{artifact.key === declaredOutputs.primary ? " · primary" : ""}
                  </span>
                ) : observedKeys.has(artifact.key) ? (
                  <span
                    data-testid={`observed-output-${artifact.key}`}
                    title="This graph declares this key on a worker node. Observed, not guaranteed."
                    aria-label="Observed output: this run's graph declares this key on a worker node — observed, not guaranteed."
                    className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
                  >
                    observed
                  </span>
                ) : null}
              </span>
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
            render: (artifact) => (
              <ArtifactContentActions
                artifact={artifact}
                downloading={pendingIds.has(artifact.id)}
                onDownload={(row) => void downloadArtifact(row)}
              />
            ),
          },
        ]}
      />
      <ArtifactDownloadError error={downloadError} />
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

      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        A webhook delivery is the HTTP callback Atlas sends to your reply address when the run
        finishes, so another system learns the result without polling for it.
      </p>

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
                  <span className="font-mono text-xs text-foreground">{event.type}</span>
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

  /** Whether any gate is still awaiting a decision — drives the Approvals section's amber lift. */
  const hasPendingGate = approvals.some((approval) => approval.state.label === "pending");

  /**
   * Output keys this run's own graph snapshot declares.
   *
   * Read from the snapshot rather than the live workflow definition on purpose: the definition
   * may have been edited or deleted since, and marking a row against a graph the run never used
   * would be a lie about what produced it.
   */
  const observedOutputKeys = useMemo(
    () =>
      new Set(
        detail.graphSnapshot?.ok
          ? observeWorkflowContract(detail.graphSnapshot.graph, {
              workflowId: run.workflowDefinitionId ?? "",
              observedVersion: 0,
            }).outputs.map((output) => output.key)
          : [],
      ),
    [detail.graphSnapshot, run.workflowDefinitionId],
  );

  /**
   * Declared output keys from this run's own `interface_snapshot` — the authoritative counterpart
   * of {@link observedOutputKeys} above, from the run's frozen interface rather than its frozen
   * graph. `null` when this run has no interface snapshot, so the artifact table can tell "no
   * declared contract" apart from "a declared contract with zero outputs".
   */
  const declaredOutputs = useMemo(
    () => runDeclaredOutputs(detail.interfaceSnapshot),
    [detail.interfaceSnapshot],
  );

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
        <PendingApprovalCard approvals={approvals} runState={run.state.label} />

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

        <RunInputSection detail={detail} />
        <RunInterfaceSection detail={detail} />

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
                    <span className="font-mono text-xs text-foreground">{n.nodeKey}</span>
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

        <section
          id="approvals"
          className={
            hasPendingGate
              ? "mb-8 rounded-lg border-2 border-accent/50 bg-accent/[0.06] px-4 py-4 scroll-mt-6"
              : "mb-8 scroll-mt-6"
          }
        >
          <SectionHeading emphasis>Approvals ({approvals.length})</SectionHeading>
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
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Artifacts are the files and values this run produced — a node&apos;s output, a generated
            document, a collected result.
          </p>
          <ArtifactsSection
            runId={run.id}
            runState={run.state.label}
            observedKeys={observedOutputKeys}
            declaredOutputs={declaredOutputs}
          />
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
