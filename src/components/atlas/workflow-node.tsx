/**
 * A canvas node.
 *
 * One source handle and one target handle, always — there are no named output ports, because
 * Atlas edges carry no handle and no label. Branching is expressed by drawing several outgoing
 * edges and giving each its own condition in the edge inspector, and `sourceHandle` is not part
 * of the semantic model at all.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";

import { MONO_RAMP, NODE_PRESENTATION } from "./workflow-node-presentation";
import type { NodeKind } from "@/lib/workflow-graph";

export interface CanvasNodeData extends Record<string, unknown> {
  kind: NodeKind;
  /** What the operator reads: a gate's label, otherwise the node id. */
  title: string;
  /** A derived one-liner — never stored, never sent. */
  hint: string;
  isStart: boolean;
  /** True when local validation has an issue anchored to this node. */
  hasIssue: boolean;
  /**
   * The runtime state Atlas reported for this node in the run being viewed, if any.
   *
   * Read straight from a run's `nodes` array. There is no timer anywhere near this: a node that
   * looks like it is running is one Atlas says is running.
   */
  runState?: string;
}

/** Atlas's runtime node states (`atlas/db.py` free TEXT, so an unknown one stays neutral). */
const RUN_STATE_RING: Record<string, string> = {
  running: "border-primary",
  waiting_for_human: "border-warning",
  succeeded: "border-success",
  failed: "border-destructive",
  interrupted: "border-destructive",
  skipped: "border-border opacity-60",
};

/**
 * The same states as flat colours, for the minimap's node marks.
 *
 * Kept beside `RUN_STATE_RING` so the overview and the canvas can never disagree about what a
 * state looks like. Resolved values rather than classes because React Flow paints these as an
 * SVG `fill` attribute, outside Tailwind's reach.
 */
const RUN_STATE_FILL: Record<string, string> = {
  running: "var(--color-primary)",
  waiting_for_human: "var(--color-warning)",
  succeeded: "var(--color-success)",
  failed: "var(--color-destructive)",
  interrupted: "var(--color-destructive)",
  skipped: "var(--color-border)",
};

/**
 * What colour a node gets on the minimap.
 *
 * Deliberately neutral at rest. Colouring every node by *kind* would fill the overview with the
 * rationed cyan on any worker-heavy graph and spend the One Signal Rule on decoration — the
 * exact charge against the old minimap, just in the right palette. So the map stays quiet until
 * there is something to report, and then it becomes the one place the whole run's state is
 * visible at a glance: which branch is running, what is waiting on a human, what failed.
 */
export function minimapNodeFill(data: CanvasNodeData): string {
  if (data.runState) return RUN_STATE_FILL[data.runState] ?? "var(--color-muted-foreground)";
  if (data.hasIssue) return "var(--color-destructive)";
  return "var(--color-muted-foreground)";
}

export function WorkflowCanvasNode({ data, selected }: NodeProps) {
  const node = data as CanvasNodeData;
  const presentation = NODE_PRESENTATION[node.kind];
  const Icon = presentation.icon;

  /**
   * The border says what Atlas says. Nothing else is allowed to take it.
   *
   * Selection used to compete for this same border, and lose: the chain checked `runState`
   * first, so while watching a run there was no way to see which node was selected — and a node
   * with a validation issue had the same problem in the editor. Both are real states that
   * co-occur, so they need two channels, not one that overwrites the other.
   */
  const stateBorder = node.runState
    ? (RUN_STATE_RING[node.runState] ?? "border-border")
    : node.hasIssue
      ? "border-destructive"
      : "border-border";

  /**
   * Selection is a halo just outside that border — same rationed cyan, different geometry.
   *
   * Concentric rings read as two facts at once (amber border + cyan halo = "waiting on a human,
   * and this is the one you are editing") where two colours on one border could only ever read
   * as one. Offset 0 keeps it tight against the card so it does not collide with the keyboard
   * focus outline, which sits further out at 3px.
   */
  const selectionHalo = selected ? "ring-2 ring-ring" : "";

  return (
    <div
      className={`group relative w-60 rounded-xl border-2 bg-card p-2.5 shadow-lg transition-colors ${stateBorder} ${selectionHalo}`}
      data-node-kind={node.kind}
      data-node-start={node.isStart ? "true" : "false"}
      data-node-selected={selected ? "true" : "false"}
      data-run-state={node.runState ?? undefined}
    >
      {/*
        DESIGN specifies handles as 10px cyan dots ringed in the node background. Reconciled to
        that spec here: at canvas zoom the dots are small enough that the cyan reads as "this is a
        connection point" without meaningfully spending the rationed accent, and it makes the
        draggable target obvious to a first-time operator.
      */}
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2.5 !border-2 !border-card !bg-primary"
      />

      <div className="flex items-center gap-2.5">
        <div className={`grid size-9 shrink-0 place-items-center rounded-lg ${presentation.tile}`}>
          <Icon className="size-4" strokeWidth={2.25} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">
              {node.title}
            </span>
            {/*
              The start marker is a badge on a real node, not a pseudo-node. Atlas's entry point
              is `graph.start` — a field naming one of the four node types — so a "trigger" node
              on the canvas would be a shape Atlas rejects on save.
            */}
            {node.isStart ? (
              <span
                className={`shrink-0 rounded border border-primary/40 bg-primary/15 px-1 py-px font-mono ${MONO_RAMP.chip} uppercase tracking-widest text-primary`}
              >
                start
              </span>
            ) : null}
            {/* The red ring alone must not be the only issue signal: an icon plus an
                accessible name back it for colour-blind operators and screen readers. The
                issue text itself lives in the editor's Checks list. */}
            {node.hasIssue && !node.runState ? (
              <AlertTriangle
                className="size-3 shrink-0 text-destructive"
                role="img"
                aria-label="This node has a validation issue"
              />
            ) : null}
          </div>
          <div className={`mt-0.5 truncate ${MONO_RAMP.meta} font-medium text-muted-foreground`}>
            {node.hint || presentation.description}
          </div>
        </div>
      </div>

      {node.runState ? (
        <div
          className={`mt-2 border-t border-border pt-1.5 font-mono ${MONO_RAMP.meta} uppercase tracking-widest text-muted-foreground`}
        >
          {node.runState}
        </div>
      ) : null}

      <Handle
        type="source"
        position={Position.Right}
        className="!size-2.5 !border-2 !border-card !bg-primary"
      />
    </div>
  );
}
