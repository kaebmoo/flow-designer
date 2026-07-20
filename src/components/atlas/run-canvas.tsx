/**
 * Read-only canvas of the graph a run started on, highlighted from Atlas runtime state.
 *
 * The graph comes from the run's own `graph_snapshot` — not the current workflow definition,
 * which may have been edited or deleted since the run began. Node highlighting comes from the
 * run's runtime nodes exactly as Atlas returned them; there is no timer anywhere near this. A
 * node changes colour when a refetch (triggered by the per-job SSE stream or the run's
 * polling interval) brings back a new state from Atlas.
 *
 * Nothing here is editable and nothing is persisted: layout is the auto-layout every time,
 * because a run views a frozen snapshot, not the editor's draft with its locally stored
 * positions.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";

import { describeCondition, type GraphNode, type WorkflowGraph } from "@/lib/workflow-graph";
import type { RuntimeEdgeView, RuntimeNodeView } from "@/lib/atlas-mappers";
import { autoLayout } from "./workflow-layout";
import { WorkflowCanvasNode, type CanvasNodeData } from "./workflow-node";

const nodeTypes: NodeTypes = { atlas: WorkflowCanvasNode };

function nodeTitle(node: GraphNode): string {
  return node.type === "human_gate" && node.label ? node.label : node.id;
}

/** The one-liner under the title: what Atlas's runtime record says about this node. */
function runtimeHint(runtime: RuntimeNodeView | undefined): string {
  if (!runtime) return "not started";
  const attempt = runtime.attempt > 1 ? ` · attempt ${runtime.attempt}` : "";
  const job = runtime.jobId ? ` · ${runtime.jobId}` : "";
  return `${runtime.state.label}${attempt}${job}`;
}

export function RunCanvas({
  graph,
  runtimeNodes,
  runtimeEdges,
}: {
  graph: WorkflowGraph;
  runtimeNodes: RuntimeNodeView[];
  runtimeEdges: RuntimeEdgeView[];
}) {
  const layout = useMemo(() => autoLayout(graph), [graph]);

  /** Latest runtime record per node key (Atlas orders oldest-first, so the last attempt wins). */
  const runtimeByKey = useMemo(() => {
    const map = new Map<string, RuntimeNodeView>();
    for (const node of runtimeNodes) map.set(node.nodeKey, node);
    return map;
  }, [runtimeNodes]);

  /**
   * Kept and merged rather than rebuilt, for the same reason as the editor: React Flow v12
   * stores each node's measurement on the object it was handed and hides an unmeasured node.
   * Rebuilding the array on every refetch would blink the whole canvas invisible each time a
   * runtime state changes.
   */
  const [flowNodes, setFlowNodes] = useState<Node<CanvasNodeData>[]>([]);

  useEffect(() => {
    setFlowNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const existing = byId.get(node.id);
        const runtime = runtimeByKey.get(node.id);
        return {
          ...existing,
          id: node.id,
          type: "atlas",
          position: existing?.position ?? layout[node.id] ?? { x: 0, y: 0 },
          draggable: false,
          connectable: false,
          selectable: false,
          data: {
            kind: node.type,
            title: nodeTitle(node),
            hint: runtimeHint(runtime),
            isStart: graph.start === node.id,
            hasIssue: false,
            // Atlas's runtime state, verbatim — the only source of highlighting here.
            runState: runtime?.state.label,
          },
        } satisfies Node<CanvasNodeData>;
      });
    });
  }, [graph, layout, runtimeByKey]);

  const flowEdges: Edge[] = useMemo(() => {
    const fired = new Set(
      runtimeEdges
        .filter((edge) => edge.matched === true)
        .map((edge) => `${edge.from}->${edge.to}`),
    );
    return graph.edges.map((edge, index) => ({
      id: `e${index}:${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      label: describeCondition(edge.condition),
      // An edge Atlas recorded as matched is drawn in the primary tone; the rest stay neutral.
      style: fired.has(`${edge.from}->${edge.to}`)
        ? { stroke: "var(--color-primary)", strokeWidth: 2 }
        : undefined,
    }));
  }, [graph, runtimeEdges]);

  // Forwarding changes keeps React Flow's measurement flowing; with dragging and selection
  // disabled, dimension changes are all that arrives.
  const onNodesChange = (changes: NodeChange<Node<CanvasNodeData>>[]) =>
    setFlowNodes((previous) => applyNodeChanges(changes, previous));

  return (
    <div className="h-96 rounded-lg border border-border bg-card" data-testid="run-canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
