import { describe, expect, it } from "vitest";

import type { AtlasWorkerSuggestion } from "@/lib/atlas-types";
import { applyWorkerSuggestion, unresolvedAgentNodes } from "@/lib/workflow-ai-assists";
import type { WorkflowGraph } from "@/lib/workflow-graph";

const graph: WorkflowGraph = {
  start: "role_node",
  nodes: [
    { id: "role_node", type: "worker", role: "reporter", prompt: "Report" },
    { id: "auto_node", type: "worker", prompt: "Auto route" },
    { id: "bound_node", type: "manager", worker_id: "wrk_1", schema: "manager_decision_v1" },
  ],
  edges: [],
};

describe("workflow AI assist helpers", () => {
  it("offers suggestions only for unresolved role-bearing agent nodes", () => {
    expect(unresolvedAgentNodes(graph).map((node) => node.id)).toEqual(["role_node"]);
  });

  it("applies only the worker id returned by Atlas", () => {
    const suggestion: AtlasWorkerSuggestion = {
      node_id: "role_node",
      role: "reporter",
      worker_id: "wrk_9",
      reason: "Role match.",
      state: "matched",
    };
    const next = applyWorkerSuggestion(graph, suggestion);
    expect(next.nodes.find((node) => node.id === "role_node")).toMatchObject({
      worker_id: "wrk_9",
    });
    expect(applyWorkerSuggestion(graph, { ...suggestion, worker_id: undefined })).toBe(graph);
  });
});
