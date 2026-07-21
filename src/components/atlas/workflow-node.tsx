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

import { NODE_PRESENTATION } from "./workflow-node-presentation";
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

export function WorkflowCanvasNode({ data, selected }: NodeProps) {
  const node = data as CanvasNodeData;
  const presentation = NODE_PRESENTATION[node.kind];
  const Icon = presentation.icon;

  const ring = node.runState
    ? (RUN_STATE_RING[node.runState] ?? "border-border")
    : node.hasIssue
      ? "border-destructive"
      : selected
        ? "border-primary"
        : "border-border";

  return (
    <div
      className={`group relative w-60 rounded-xl border-2 bg-card p-2.5 shadow-lg transition-colors ${ring}`}
      data-node-kind={node.kind}
      data-node-start={node.isStart ? "true" : "false"}
      data-run-state={node.runState ?? undefined}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3 !border-2 !border-card !bg-muted-foreground"
      />

      <div className="flex items-center gap-2.5">
        <div className={`grid size-9 shrink-0 place-items-center rounded-lg ${presentation.tile}`}>
          <Icon className="size-4" strokeWidth={2.25} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold tracking-tight text-foreground">
              {node.title}
            </span>
            {/*
              The start marker is a badge on a real node, not a pseudo-node. Atlas's entry point
              is `graph.start` — a field naming one of the four node types — so a "trigger" node
              on the canvas would be a shape Atlas rejects on save.
            */}
            {node.isStart ? (
              <span className="shrink-0 rounded border border-primary/40 bg-primary/15 px-1 py-px font-mono text-[9px] uppercase tracking-widest text-primary">
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
          <div className="mt-0.5 truncate text-[10px] font-medium text-muted-foreground">
            {node.hint || presentation.description}
          </div>
        </div>
      </div>

      {node.runState ? (
        <div className="mt-2 border-t border-border pt-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {node.runState}
        </div>
      ) : null}

      <Handle
        type="source"
        position={Position.Right}
        className="!size-3 !border-2 !border-card !bg-muted-foreground group-hover:!bg-primary"
      />
    </div>
  );
}
