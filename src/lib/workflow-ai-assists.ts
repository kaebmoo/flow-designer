import type { AtlasWorkerSuggestion } from "@/lib/atlas-types";
import type { GraphNode, WorkflowGraph } from "@/lib/workflow-graph";

export function unresolvedAgentNodes(
  graph: WorkflowGraph,
): Array<GraphNode & { type: "worker" | "manager" }> {
  return graph.nodes.filter(
    (node): node is GraphNode & { type: "worker" | "manager" } =>
      (node.type === "worker" || node.type === "manager") &&
      typeof node.role === "string" &&
      node.role.trim().length > 0 &&
      !node.worker_id &&
      !node.workspace_id,
  );
}

/** Applies only an explicit Atlas worker id; unavailable/fallback rows never invent an id. */
export function applyWorkerSuggestion(
  graph: WorkflowGraph,
  suggestion: AtlasWorkerSuggestion,
): WorkflowGraph {
  if (!suggestion.worker_id) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === suggestion.node_id && (node.type === "worker" || node.type === "manager")
        ? { ...node, worker_id: suggestion.worker_id }
        : node,
    ),
  };
}
