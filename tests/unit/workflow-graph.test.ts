import { describe, expect, it } from "vitest";

import {
  CONDITION_TYPES,
  MANAGER_SCHEMA,
  describeCondition,
  edgeIsInCycle,
  edgesRemovedWithNode,
  hasCycle,
  hasLoopGuard,
  isConnectionAllowed,
  layoutStorageKey,
  parseWorkflowGraph,
  parseWorkflowPolicy,
  removeNode,
  renameNodeId,
  serializeWorkflowGraph,
  serializeWorkflowPolicy,
  unreachableNodeIds,
  validateWorkflow,
  type GraphCondition,
  type WorkflowGraph,
  type WorkflowPolicy,
} from "@/lib/workflow-graph";
import {
  ALL_KINDS_GRAPH,
  ALL_KINDS_POLICY,
  FAIL_CLOSED_GRAPHS,
  FILE_HANDOFF_GRAPH,
  FILE_HANDOFF_POLICY,
  MINIMAL_GRAPH,
  referenceGraph,
} from "../fixtures/workflow-graphs";

function parsed(raw: unknown): WorkflowGraph {
  const result = parseWorkflowGraph(raw);
  if (!result.ok) throw new Error(`expected a parseable graph, got: ${result.reason}`);
  return result.value;
}

function policyOf(raw: unknown): WorkflowPolicy {
  const result = parseWorkflowPolicy(raw);
  if (!result.ok) throw new Error(`expected a parseable policy, got: ${result.reason}`);
  return result.value;
}

describe("round trip: Atlas payload → UI model → Atlas payload", () => {
  it("preserves a graph using all four native node kinds, field for field", () => {
    expect(serializeWorkflowGraph(parsed(ALL_KINDS_GRAPH))).toEqual(ALL_KINDS_GRAPH);
  });

  it("covers all four node kinds in that one fixture", () => {
    const kinds = new Set(parsed(ALL_KINDS_GRAPH).nodes.map((node) => node.type));
    expect([...kinds].sort()).toEqual(["human_gate", "join", "manager", "worker"]);
  });

  it("covers every condition type in that one fixture", () => {
    const types = new Set(parsed(ALL_KINDS_GRAPH).edges.map((edge) => edge.condition.type));
    expect([...types].sort()).toEqual([...CONDITION_TYPES].sort());
  });

  it("round-trips each node kind on its own", () => {
    for (const node of ALL_KINDS_GRAPH.nodes) {
      const single = { start: node.id, nodes: [node], edges: [] };
      expect(serializeWorkflowGraph(parsed(single))).toEqual(single);
    }
  });

  it("round-trips each condition type on its own", () => {
    for (const edge of ALL_KINDS_GRAPH.edges) {
      const single = {
        start: edge.from,
        nodes: ALL_KINDS_GRAPH.nodes.filter((node) => node.id === edge.from || node.id === edge.to),
        edges: [edge],
      };
      expect(serializeWorkflowGraph(parsed(single))).toEqual(single);
    }
  });

  it("round-trips the minimal graph and the file-handoff graph", () => {
    expect(serializeWorkflowGraph(parsed(MINIMAL_GRAPH))).toEqual(MINIMAL_GRAPH);
    expect(serializeWorkflowGraph(parsed(FILE_HANDOFF_GRAPH))).toEqual(FILE_HANDOFF_GRAPH);
  });

  it("round-trips instance-scoped worker and workspace references", () => {
    const graph = referenceGraph("wk_1", "ws_1");
    expect(serializeWorkflowGraph(parsed(graph))).toEqual(graph);
  });

  it("round-trips every policy key at its maximum", () => {
    expect(serializeWorkflowPolicy(policyOf(ALL_KINDS_POLICY))).toEqual(ALL_KINDS_POLICY);
  });

  it("is idempotent — a second round trip changes nothing", () => {
    const once = serializeWorkflowGraph(parsed(ALL_KINDS_GRAPH));
    expect(serializeWorkflowGraph(parsed(once))).toEqual(once);
  });
});

describe("normalising Atlas's executor defaults", () => {
  it("adds the join mode Atlas would have defaulted, so the next save carries it", () => {
    const graph = parsed({ start: "j", nodes: [{ id: "j", type: "join" }], edges: [] });
    expect(graph.nodes[0]).toMatchObject({ type: "join", mode: "all" });
    expect(serializeWorkflowGraph(graph).nodes).toEqual([{ id: "j", type: "join", mode: "all" }]);
  });

  it("adds the manager schema Atlas would have defaulted", () => {
    const graph = parsed({ start: "m", nodes: [{ id: "m", type: "manager" }], edges: [] });
    expect(serializeWorkflowGraph(graph).nodes).toEqual([
      { id: "m", type: "manager", schema: MANAGER_SCHEMA },
    ]);
  });

  it("adds the always condition Atlas would have defaulted onto a bare edge", () => {
    const graph = parsed({
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "b", type: "worker" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect(graph.edges[0]!.condition).toEqual({ type: "always" });
    expect(serializeWorkflowGraph(graph).edges).toEqual([
      { from: "a", to: "b", condition: { type: "always" } },
    ]);
  });

  it("emits a join mode even when it equals Atlas's own default", () => {
    const serialized = serializeWorkflowGraph({
      start: "j",
      nodes: [{ id: "j", type: "join", mode: "all" }],
      edges: [],
    });
    expect(serialized.nodes).toEqual([{ id: "j", type: "join", mode: "all" }]);
  });
});

describe("failing closed", () => {
  it.each(FAIL_CLOSED_GRAPHS)("refuses a graph with $why", ({ graph }) => {
    const result = parseWorkflowGraph(graph);
    expect(result.ok).toBe(false);
  });

  it("names the offending type so the UI can say what it could not read", () => {
    const result = parseWorkflowGraph({
      start: "a",
      nodes: [{ id: "a", type: "condition" }],
      edges: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("condition");
  });

  it("refuses a policy key Atlas does not declare", () => {
    expect(parseWorkflowPolicy({ max_jobs: 1, retries: 3 }).ok).toBe(false);
  });

  it("refuses a graph key Atlas does not declare, such as a stored viewport", () => {
    expect(
      parseWorkflowGraph({
        start: "a",
        nodes: [{ id: "a", type: "worker" }],
        edges: [],
        viewport: {},
      }).ok,
    ).toBe(false);
  });

  it("refuses a worker whose outputs are not exactly one artifact key", () => {
    expect(
      parseWorkflowGraph({
        start: "a",
        nodes: [{ id: "a", type: "worker", outputs: ["one", "two"] }],
        edges: [],
      }).ok,
    ).toBe(false);
  });

  it("refuses a quorum join with no quorum", () => {
    expect(
      parseWorkflowGraph({
        start: "j",
        nodes: [{ id: "j", type: "join", mode: "quorum" }],
        edges: [],
      }).ok,
    ).toBe(false);
  });

  it("refuses a human gate whose choice list is empty", () => {
    expect(
      parseWorkflowGraph({
        start: "g",
        nodes: [{ id: "g", type: "human_gate", choices: [] }],
        edges: [],
      }).ok,
    ).toBe(false);
  });

  it("refuses an empty node list rather than inventing a start node", () => {
    expect(parseWorkflowGraph({ start: "a", nodes: [], edges: [] }).ok).toBe(false);
  });

  it("refuses duplicate node ids, which React Flow would render as one node", () => {
    expect(
      parseWorkflowGraph({
        start: "a",
        nodes: [
          { id: "a", type: "worker" },
          { id: "a", type: "join", mode: "all" },
        ],
        edges: [],
      }).ok,
    ).toBe(false);
  });

  it("refuses a blank entry in a string list, which Atlas rejects on save", () => {
    expect(
      parseWorkflowGraph({
        start: "a",
        nodes: [{ id: "a", type: "worker", collect_files: ["ok.md", "  "] }],
        edges: [],
      }).ok,
    ).toBe(false);
  });

  /**
   * The other half of failing closed: refusing too much is its own defect.
   *
   * Atlas accepts any truthy artifact string and any `values` list, so a graph written by
   * another client can legally use `fast-result` or an empty list. Refusing to *open* such a
   * graph would leave it uneditable by the only tool that can fix it — so these open, and the
   * stricter rule shows up as a validation issue instead.
   */
  it("opens a graph whose artifact key is legal for Atlas but not an identifier", () => {
    const result = parseWorkflowGraph({
      start: "a",
      nodes: [
        { id: "a", type: "worker", outputs: ["fast-result"] },
        { id: "b", type: "worker" },
      ],
      edges: [
        {
          from: "a",
          to: "b",
          condition: { type: "artifact_equals", artifact: "fast-result", value: "ok" },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateWorkflow(result.value, {}).length).toBeGreaterThan(0);
  });

  it("opens a graph whose artifact_in list is empty", () => {
    const result = parseWorkflowGraph({
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "b", type: "worker" },
      ],
      edges: [
        { from: "a", to: "b", condition: { type: "artifact_in", artifact: "k", values: [] } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      validateWorkflow(result.value, {}).some((issue) =>
        issue.message.includes("at least one value"),
      ),
    ).toBe(true);
  });
});

describe("validation", () => {
  const graph = parsed(ALL_KINDS_GRAPH);

  it("accepts the all-kinds fixture with its guard", () => {
    expect(validateWorkflow(graph, {})).toEqual([]);
  });

  it("reports a start node that does not exist, against the graph", () => {
    const issues = validateWorkflow({ ...graph, start: "nowhere" }, {});
    expect(issues).toContainEqual({
      target: { kind: "graph", field: "start" },
      message: "Start references a node that does not exist: nowhere",
    });
  });

  it("reports a quorum higher than the distinct upstream count, against the join node", () => {
    const raised = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === "converge" ? { ...node, quorum: 5 } : node)),
    } as WorkflowGraph;
    const issues = validateWorkflow(raised, {});
    expect(
      issues.some((issue) => issue.target.kind === "node" && issue.target.nodeId === "converge"),
    ).toBe(true);
  });

  it("reports an unguarded cycle, against the edges", () => {
    const unguarded: WorkflowGraph = {
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.condition.type === "max_iterations_below"
          ? { ...edge, condition: { type: "always" } as GraphCondition }
          : edge,
      ),
    };
    expect(hasCycle(unguarded)).toBe(true);
    expect(hasLoopGuard(unguarded, {})).toBe(false);
    expect(validateWorkflow(unguarded, {})).toContainEqual({
      target: { kind: "graph", field: "edges" },
      message:
        "This graph loops. Set policy.max_iterations, or give the back-edge a max_iterations_below condition.",
    });
  });

  it("accepts the same cycle once policy.max_iterations guards it", () => {
    const unguarded: WorkflowGraph = {
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.condition.type === "max_iterations_below"
          ? { ...edge, condition: { type: "always" } as GraphCondition }
          : edge,
      ),
    };
    expect(validateWorkflow(unguarded, { max_iterations: 3 })).toEqual([]);
  });

  it("identifies the edge that closes a cycle, so its inspector can ask for a guard", () => {
    const guardedBackEdge = graph.edges.findIndex(
      (edge) => edge.condition.type === "max_iterations_below",
    );
    expect(edgeIsInCycle(graph, guardedBackEdge)).toBe(true);
    expect(edgeIsInCycle(graph, 6)).toBe(false);
    expect(edgeIsInCycle(graph, -1)).toBe(false);
  });

  it("requires manager_selected on every edge leaving a manager", () => {
    const broken: WorkflowGraph = {
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.from === "triage" && edge.to === "fast_path"
          ? { ...edge, condition: { type: "always" } as GraphCondition }
          : edge,
      ),
    };
    const issues = validateWorkflow(broken, {});
    expect(issues).toContainEqual({
      target: { kind: "edge", edgeIndex: 1, field: "condition" },
      message: "An edge from a manager must use the manager_selected condition.",
    });
  });

  it("requires the manager_selected target to be the edge's own target", () => {
    const broken: WorkflowGraph = {
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.from === "triage" && edge.to === "fast_path"
          ? { ...edge, condition: { type: "manager_selected", target: "slow_path" } }
          : edge,
      ),
    };
    expect(validateWorkflow(broken, {})).toContainEqual({
      target: { kind: "edge", edgeIndex: 1, field: "condition" },
      message: "manager_selected target must be the edge's own target node.",
    });
  });

  it("rejects manager_selected on an edge whose source is not a manager", () => {
    const broken: WorkflowGraph = {
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.from === "ingest"
          ? { ...edge, condition: { type: "manager_selected", target: "triage" } }
          : edge,
      ),
    };
    expect(validateWorkflow(broken, {})).toContainEqual({
      target: { kind: "edge", edgeIndex: 0, field: "condition" },
      message: "manager_selected is only valid on an edge whose source is a manager.",
    });
  });

  it("requires human_selected on every edge leaving a gate that declares choices", () => {
    const broken: WorkflowGraph = {
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.from === "review" && edge.to === "publish"
          ? { ...edge, condition: { type: "always" } as GraphCondition }
          : edge,
      ),
    };
    expect(validateWorkflow(broken, {})).toContainEqual({
      target: { kind: "edge", edgeIndex: 6, field: "condition" },
      message: "An edge from a gate with choices must use the human_selected condition.",
    });
  });

  it("rejects a human_selected choice the source gate never declared", () => {
    const broken: WorkflowGraph = {
      ...graph,
      edges: graph.edges.map((edge) =>
        edge.from === "review" && edge.to === "publish"
          ? { ...edge, condition: { type: "human_selected", choice: "escalate" } }
          : edge,
      ),
    };
    expect(validateWorkflow(broken, {})).toContainEqual({
      target: { kind: "edge", edgeIndex: 6, field: "condition" },
      message: "The source gate does not declare the choice escalate.",
    });
  });

  it("requires the file_handoff opt-in before an edge may push files", () => {
    const handoff = parsed(FILE_HANDOFF_GRAPH);
    expect(validateWorkflow(handoff, {})).toContainEqual({
      target: { kind: "edge", edgeIndex: 0, field: "push_files" },
      message: "Pushing files on an edge requires policy.file_handoff.",
    });
    expect(validateWorkflow(handoff, policyOf(FILE_HANDOFF_POLICY))).toEqual([]);
  });

  it("rejects a node id that is not an identifier", () => {
    const broken = parsed({
      start: "my node",
      nodes: [{ id: "my node", type: "worker" }],
      edges: [],
    });
    expect(
      validateWorkflow(broken, {}).some(
        (issue) => issue.target.kind === "node" && issue.target.field === "id",
      ),
    ).toBe(true);
  });

  it("bounds every policy integer at Atlas's own maximum", () => {
    const overMaximum: WorkflowPolicy = {
      max_jobs: 101,
      max_iterations: 101,
      max_attempts_per_node: 26,
      max_minutes: 1441,
      requires_human_after_iterations: 101,
      max_budget_units: 1_000_001,
    };
    const fields = validateWorkflow(parsed(MINIMAL_GRAPH), overMaximum)
      .filter((issue) => issue.target.kind === "policy")
      .map((issue) => (issue.target as { field: string }).field)
      .sort();
    expect(fields).toEqual([
      "max_attempts_per_node",
      "max_budget_units",
      "max_iterations",
      "max_jobs",
      "max_minutes",
      "requires_human_after_iterations",
    ]);
  });

  it("accepts every policy integer at exactly its maximum", () => {
    expect(validateWorkflow(parsed(MINIMAL_GRAPH), policyOf(ALL_KINDS_POLICY))).toEqual([]);
  });

  it("bounds collect_files the way Atlas does at save time", () => {
    const withPatterns = (patterns: string[]): WorkflowGraph => ({
      start: "a",
      nodes: [{ id: "a", type: "worker", collect_files: patterns }],
      edges: [],
    });

    // Every one of these is a 400 from Atlas's `_validate_collect_files`; catching them here is
    // what turns a round trip into an inline message on the field being typed in.
    for (const bad of [["/etc/passwd"], ["../secrets"], ["a/../../b"], ["C:\\Windows\\x"]]) {
      const issues = validateWorkflow(withPatterns(bad), {});
      expect(
        issues.some(
          (issue) => issue.target.kind === "node" && issue.target.field === "collect_files",
        ),
      ).toBe(true);
    }

    expect(validateWorkflow(withPatterns(["reports/*.md", "out/**/*.json"]), {})).toEqual([]);

    const tooMany = Array.from({ length: 257 }, (_, index) => `f${index}.txt`);
    expect(
      validateWorkflow(withPatterns(tooMany), {}).some((issue) =>
        issue.message.includes("At most"),
      ),
    ).toBe(true);
  });

  it("requires a whole-number limit on a loop guard, not just a node to count", () => {
    const guarded = (max: number): WorkflowGraph => ({
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "b", type: "worker" },
      ],
      edges: [
        { from: "a", to: "b", condition: { type: "always" } },
        { from: "b", to: "a", condition: { type: "max_iterations_below", node: "a", max } },
      ],
    });

    expect(validateWorkflow(guarded(3), {})).toEqual([]);
    // A NaN reaches here from an inspector field holding text; JSON.stringify would send it as
    // `null`, so it has to be stopped before the save button enables.
    for (const bad of [Number.NaN, 0, -1, 1.5]) {
      expect(
        validateWorkflow(guarded(bad), {}).some(
          (issue) => issue.target.kind === "edge" && issue.message.includes("whole number"),
        ),
      ).toBe(true);
    }
  });

  it("rejects a non-integer budget on a worker", () => {
    const graph: WorkflowGraph = {
      start: "a",
      nodes: [{ id: "a", type: "worker", budget_units: Number.NaN }],
      edges: [],
    };
    expect(
      validateWorkflow(graph, {}).some(
        (issue) => issue.target.kind === "node" && issue.target.field === "budget_units",
      ),
    ).toBe(true);
  });

  it("rejects a blank or duplicated gate choice", () => {
    const gate = (choices: Array<{ id: string; label: string }>): WorkflowGraph => ({
      start: "g",
      nodes: [{ id: "g", type: "human_gate", choices }],
      edges: [],
    });

    expect(
      validateWorkflow(gate([{ id: "", label: "Yes" }]), {}).some((issue) =>
        issue.message.includes("needs an id"),
      ),
    ).toBe(true);
    expect(
      validateWorkflow(gate([{ id: "a", label: "" }]), {}).some((issue) =>
        issue.message.includes("needs a label"),
      ),
    ).toBe(true);
    expect(
      validateWorkflow(
        gate([
          { id: "a", label: "Yes" },
          { id: "a", label: "Also yes" },
        ]),
        {},
      ).some((issue) => issue.message.includes("Duplicate choice id")),
    ).toBe(true);
  });

  it("rejects a non-identifier artifact key on a condition and on a worker output", () => {
    const graph: WorkflowGraph = {
      start: "a",
      nodes: [
        { id: "a", type: "worker", outputs: ["fast-result"] },
        { id: "b", type: "worker" },
      ],
      edges: [
        {
          from: "a",
          to: "b",
          condition: { type: "artifact_equals", artifact: "fast-result", value: "ok" },
        },
      ],
    };
    const issues = validateWorkflow(graph, {});
    expect(issues.some((issue) => issue.target.kind === "node")).toBe(true);
    expect(issues.some((issue) => issue.target.kind === "edge")).toBe(true);
  });

  it("finds nodes with no path from start", () => {
    const orphaned: WorkflowGraph = {
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "b", type: "worker" },
      ],
      edges: [],
    };
    expect(unreachableNodeIds(orphaned)).toEqual(["b"]);
    expect(unreachableNodeIds(parsed(ALL_KINDS_GRAPH))).toEqual([]);
  });
});

describe("rename", () => {
  const graph = parsed(ALL_KINDS_GRAPH);

  it("updates graph.start, both edge ends, and both node-referencing conditions at once", () => {
    const result = renameNodeId(graph, "ingest", "intake");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.graph.start).toBe("intake");
    expect(result.graph.nodes.some((node) => node.id === "intake")).toBe(true);
    expect(result.graph.nodes.some((node) => node.id === "ingest")).toBe(false);

    const outgoing = result.graph.edges.find((edge) => edge.from === "intake");
    expect(outgoing?.to).toBe("triage");

    const backEdge = result.graph.edges.find(
      (edge) => edge.condition.type === "max_iterations_below",
    );
    expect(backEdge?.to).toBe("intake");
    expect(backEdge?.condition).toEqual({ type: "max_iterations_below", node: "intake", max: 3 });

    // No *structural* reference to the old id survives. Deliberately not a substring sweep:
    // the artifact key `ingest_result` and the prompt text are a different namespace, and a
    // rename that rewrote them would corrupt the workflow rather than fix it.
    const references = [
      result.graph.start,
      ...result.graph.edges.flatMap((edge) => [edge.from, edge.to]),
      ...result.graph.edges.flatMap((edge) =>
        edge.condition.type === "manager_selected"
          ? [edge.condition.target]
          : edge.condition.type === "max_iterations_below"
            ? [edge.condition.node]
            : [],
      ),
      ...result.graph.nodes.map((node) => node.id),
    ];
    expect(references).not.toContain("ingest");
  });

  it("leaves artifact keys and prompt text alone", () => {
    const result = renameNodeId(graph, "ingest", "intake");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const renamed = result.graph.nodes.find((node) => node.id === "intake");
    expect(renamed).toMatchObject({ outputs: ["ingest_result"] });
    expect(result.graph.nodes.find((node) => node.id === "triage")).toMatchObject({
      prompt: "Choose the branch that fits {artifact.ingest_result}.",
    });
  });

  it("updates a manager_selected target", () => {
    const result = renameNodeId(graph, "fast_path", "quick_path");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.edges.find((edge) => edge.to === "quick_path")?.condition).toEqual({
      type: "manager_selected",
      target: "quick_path",
    });
  });

  it("leaves the renamed graph valid", () => {
    const result = renameNodeId(graph, "converge", "gather");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateWorkflow(result.graph, {})).toEqual([]);
  });

  it("refuses a rename that would collide", () => {
    expect(renameNodeId(graph, "ingest", "triage")).toMatchObject({ ok: false });
  });

  it("refuses an id that is not an identifier", () => {
    expect(renameNodeId(graph, "ingest", "my node")).toMatchObject({ ok: false });
    expect(renameNodeId(graph, "ingest", "9lives")).toMatchObject({ ok: false });
    expect(renameNodeId(graph, "ingest", "")).toMatchObject({ ok: false });
  });

  it("refuses to rename a node that is not there", () => {
    expect(renameNodeId(graph, "absent", "present")).toMatchObject({ ok: false });
  });

  it("does not mutate the original graph", () => {
    const before = JSON.stringify(serializeWorkflowGraph(graph));
    renameNodeId(graph, "ingest", "intake");
    expect(JSON.stringify(serializeWorkflowGraph(graph))).toBe(before);
  });
});

describe("removeNode", () => {
  it("never silently changes the workflow entry point", () => {
    const graph = parsed(ALL_KINDS_GRAPH);
    const after = removeNode(graph, "ingest");
    expect(after).toBe(graph);
  });

  it("drops incident and condition-referencing edges with a non-start node", () => {
    const graph: WorkflowGraph = {
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "b", type: "worker" },
        { id: "counter", type: "worker" },
      ],
      edges: [
        {
          from: "a",
          to: "b",
          condition: { type: "max_iterations_below", node: "counter", max: 3 },
        },
        { from: "counter", to: "a", condition: { type: "always" } },
      ],
    };

    expect(edgesRemovedWithNode(graph, "counter")).toHaveLength(2);
    const after = removeNode(graph, "counter");
    expect(after.start).toBe("a");
    expect(after.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(after.edges).toEqual([]);
  });
});

describe("connection guard", () => {
  it("blocks self-loops and duplicate freshly-drawn edges", () => {
    const graph = parsed(ALL_KINDS_GRAPH);
    expect(isConnectionAllowed(graph, "ingest", "ingest")).toBe(false);
    expect(isConnectionAllowed(graph, "ingest", "triage")).toBe(false);
    expect(isConnectionAllowed(graph, "publish", "ingest")).toBe(true);
  });
});

describe("edge captions", () => {
  it("derives a caption for every condition type", () => {
    const captions = parsed(ALL_KINDS_GRAPH).edges.map((edge) => describeCondition(edge.condition));
    expect(captions).toEqual([
      "always",
      "manager picks fast_path",
      "manager picks slow_path",
      'fast_result.verdict = "ok"',
      'slow_result.verdict in ["ok","warn"]',
      "always",
      "choice: approve",
      "choice: retry",
      "ingest run < 3×",
    ]);
  });
});

describe("layout keys", () => {
  it("separates one workflow's layout from another's, and one version from the next", () => {
    expect(layoutStorageKey("wf_1", 1)).not.toBe(layoutStorageKey("wf_2", 1));
    expect(layoutStorageKey("wf_1", 1)).not.toBe(layoutStorageKey("wf_1", 2));
  });

  it("is stable across saves, because an ordinary save does not move the version", () => {
    // This client never sends `version` and Atlas never increments it, so a save reuses the
    // arrangement rather than resetting it. The version component only bites for the writes
    // that genuinely replace the graph — a pack import or another client bumping it.
    expect(layoutStorageKey("wf_1", 1)).toBe(layoutStorageKey("wf_1", 1));
  });
});
