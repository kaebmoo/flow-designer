/**
 * Live per-job event streaming for the run detail page (Phase 4).
 *
 * There is no unified run stream in Atlas — the only live source is the per-job SSE stream —
 * so this section subscribes to the job behind each runtime node Atlas reports as `running`,
 * and turns state-shaped events and terminal closes into a refetch of the run's persisted
 * state. Canvas highlighting and node tables read that refetched Atlas state, never the stream
 * directly: the stream is a trigger and a log, not a second source of truth.
 *
 * Nodes without a job (a human gate waiting on a person) have nothing to stream; the page's
 * polling refetch covers them, and this section says so instead of pretending to stream.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { RunDetailView, RuntimeNodeView } from "@/lib/atlas-mappers";
import type { JobStreamEvent, JobStreamPhase, JobStreamSnapshot } from "@/lib/job-stream";
import { queryKeys } from "@/lib/query-keys";
import { useJobEventStream } from "@/lib/use-job-stream";

/**
 * How many per-job streams this page holds open at once. Atlas caps a run's parallelism with
 * `policy.max_jobs`, but that value is the run's, not the browser's; this bounds the browser.
 */
const MAX_STREAMS = 4;

/** Rows of the bounded event buffer actually rendered. The DOM never grows past this. */
const VISIBLE_LOG_ROWS = 150;

/**
 * Event types that mean Atlas state moved and the persisted run view should be refetched.
 * Text/thinking frames deliberately excluded: they change the log, not the run.
 */
const STATE_CHANGING_TYPES = new Set([
  "state",
  "error",
  "done",
  "route",
  "cancel_requested",
  "files.collected",
]);

function phaseLabel(phase: JobStreamPhase): { text: string; tone: string } {
  switch (phase.phase) {
    case "idle":
    case "connecting":
      return { text: "connecting", tone: "border-border text-muted-foreground" };
    case "streaming":
      return { text: "streaming", tone: "border-primary/40 bg-primary/10 text-primary" };
    case "stale":
      return { text: "stale", tone: "border-warning/40 bg-warning/10 text-warning" };
    case "disconnected":
      return {
        text: `reconnecting (attempt ${phase.attempt}, in ${Math.round(phase.retryInMs / 1000)}s)`,
        tone: "border-warning/40 bg-warning/10 text-warning",
      };
    case "terminal":
      return { text: `closed: ${phase.state}`, tone: "border-border text-muted-foreground" };
    case "failed":
      return {
        text:
          phase.reason === "exhausted"
            ? "disconnected"
            : phase.reason === "unauthorized"
              ? "session expired"
              : phase.reason === "forbidden"
                ? "access denied"
                : "job not found",
        tone: "border-destructive/40 bg-destructive/10 text-destructive",
      };
  }
}

function LiveLogRow({ event }: { event: JobStreamEvent }) {
  return (
    <li className="flex gap-2 border-b border-border/40 px-2 py-0.5 last:border-b-0">
      <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {event.seq}
      </span>
      <span className="w-28 shrink-0 truncate font-mono text-[10px] uppercase tracking-wider text-primary">
        {event.type}
        {!event.known ? (
          <span className="text-warning" title="Event type this client does not recognise.">
            {" "}
            ?
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
        {event.text ?? event.detail}
      </span>
    </li>
  );
}

function JobLiveStream({
  node,
  onAtlasChanged,
}: {
  node: RuntimeNodeView;
  onAtlasChanged: () => void;
}) {
  const { snapshot, retry } = useJobEventStream(node.jobId, true, {
    onEvent: (event) => {
      if (STATE_CHANGING_TYPES.has(event.type)) onAtlasChanged();
    },
    onTerminal: () => onAtlasChanged(),
    onGap: () => onAtlasChanged(),
    // A 401 on the stream means the session died mid-visit. Refetching the run makes the read
    // path see the same 401, which clears the session server-side and lets the existing
    // QueryCache guard redirect — the stream adds no fourth guard of its own.
    onAuthError: () => onAtlasChanged(),
  });

  return <JobStreamPanel nodeKey={node.nodeKey} snapshot={snapshot} onRetry={retry} />;
}

/** Presentation split from the hook so tests and states can render it directly. */
export function JobStreamPanel({
  nodeKey,
  snapshot,
  onRetry,
}: {
  nodeKey: string;
  snapshot: JobStreamSnapshot;
  onRetry: () => void;
}) {
  const { text, tone } = phaseLabel(snapshot.phase);
  const visible = snapshot.events.slice(-VISIBLE_LOG_ROWS);
  const hiddenInBuffer = snapshot.events.length - visible.length;

  return (
    <div className="rounded-lg border border-border bg-card" data-testid={`job-stream-${nodeKey}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-xs text-primary">{nodeKey}</span>
        <span
          data-testid="stream-status"
          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${tone}`}
        >
          {text}
        </span>
        {snapshot.phase.phase === "failed" && snapshot.phase.reason === "exhausted" ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-border bg-secondary/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition hover:bg-secondary"
          >
            Retry
          </button>
        ) : null}
        {snapshot.gapNotice ? (
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-warning">
            gap — persisted history refetched
          </span>
        ) : null}
      </div>

      {snapshot.events.length === 0 ? (
        <p className="px-3 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          No events yet on this stream.
        </p>
      ) : (
        <>
          <ul data-testid="live-log" className="max-h-64 overflow-y-auto">
            {visible.map((event) => (
              <LiveLogRow key={event.seq} event={event} />
            ))}
          </ul>
          <p className="border-t border-border px-3 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            Live window: showing {visible.length}
            {hiddenInBuffer > 0 ? ` of ${snapshot.events.length} buffered` : ""} events
            {snapshot.dropped > 0
              ? `; ${snapshot.dropped} older events compacted out of memory`
              : ""}
            . The complete record is Atlas&apos;s persisted history below.
            {snapshot.duplicates > 0 ? ` ${snapshot.duplicates} duplicate frame(s) dropped.` : ""}
            {snapshot.malformed > 0 ? ` ${snapshot.malformed} unreadable frame(s) ignored.` : ""}
          </p>
        </>
      )}
    </div>
  );
}

/** Runtime-node states whose job may still emit events worth streaming. */
const STREAMABLE_NODE_STATES = new Set(["running"]);

export function RunLiveSection({ detail }: { detail: RunDetailView }) {
  const queryClient = useQueryClient();
  const runId = detail.run.id;

  /**
   * The narrowest refetch that covers what an event can change: this run's detail (state,
   * runtime nodes, approvals — the canvas reads these) and this run's persisted events. Not
   * the dashboard, not the run list, not other runs.
   */
  const onAtlasChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.runDetail(runId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runEventsAll(runId) });
  }, [queryClient, runId]);

  const terminal = ["succeeded", "failed", "cancelled"].includes(detail.run.state.label);
  const streamable = detail.nodes.filter(
    (node) => node.jobId !== null && STREAMABLE_NODE_STATES.has(node.state.label),
  );
  const streamed = streamable.slice(0, MAX_STREAMS);

  if (terminal && streamed.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Live job events
      </h2>
      {streamed.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          No node is running a job right now, so there is nothing to stream — Atlas has no run-level
          live stream. The page refetches the persisted run state on an interval instead; a waiting
          human gate advances when its approval is decided.
        </p>
      ) : (
        <div className="space-y-3">
          {streamed.map((node) => (
            <JobLiveStream key={node.jobId} node={node} onAtlasChanged={onAtlasChanged} />
          ))}
          {streamable.length > streamed.length ? (
            <p className="text-xs text-muted-foreground">
              Streaming {streamed.length} of {streamable.length} running jobs; the rest advance
              through the same refetch without a live log.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
