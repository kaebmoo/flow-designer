/**
 * Graph fixtures shared by the unit round-trip tests and the real-Atlas contract tests.
 *
 * `ALL_KINDS_GRAPH` is deliberately one graph rather than four, because the interesting rules
 * are the ones that relate node kinds to each other: a manager's edges must be
 * `manager_selected`, a gate with choices routes only by `human_selected`, a quorum join must
 * not out-count its distinct upstreams, and a cycle needs a guard. Four isolated fixtures
 * would each pass while the combination failed.
 *
 * Every fixture here is written as the JSON Atlas stores — not as the UI model — so a contract
 * test can `POST` it verbatim and the round-trip test can assert
 * `parse(fixture)` → `serialize` → deep-equals `fixture`.
 *
 * Deliberately absent: `worker_id`, `workspace_id`, and `policy.allowed_*_ids`. Atlas resolves
 * those against its own tables (`validate_workflow_references`, `atlas/workflows.py:304`), so a
 * fixture carrying them could only be posted to an instance that already had those exact rows.
 * `REFERENCE_GRAPH` covers their shape for the parser; only the contract test that seeds a
 * worker uses it against a live Atlas.
 */

export const ALL_KINDS_GRAPH = {
  start: "ingest",
  nodes: [
    {
      id: "ingest",
      type: "worker",
      prompt: "Collect the source material for {input.topic}.",
      company: "acme",
      model: "sonnet",
      role: "researcher",
      tags: ["research", "intake"],
      outputs: ["ingest_result"],
      output_format: "json",
      budget_units: 5,
      execution: "stream",
      collect_files: ["reports/*.md"],
    },
    {
      id: "triage",
      type: "manager",
      prompt: "Choose the branch that fits {artifact.ingest_result}.",
      schema: "manager_decision_v1",
      role: "manager",
      budget_units: 2,
      execution: "stream",
    },
    {
      id: "fast_path",
      type: "worker",
      prompt: "Summarise quickly.",
      outputs: ["fast_result"],
      output_format: "json",
    },
    {
      id: "slow_path",
      type: "worker",
      prompt: "Investigate thoroughly.",
      outputs: ["slow_result"],
      output_format: "json",
    },
    { id: "converge", type: "join", mode: "quorum", quorum: 2 },
    {
      id: "review",
      type: "human_gate",
      label: "Editorial review",
      reason: "A person signs off before anything is published.",
      choices: [
        { id: "approve", label: "Approve" },
        { id: "retry", label: "Send back" },
      ],
    },
    { id: "recheck", type: "join", mode: "any" },
    { id: "publish", type: "worker", prompt: "Publish the result.", outputs: ["published"] },
  ],
  edges: [
    { from: "ingest", to: "triage", condition: { type: "always" } },
    {
      from: "triage",
      to: "fast_path",
      condition: { type: "manager_selected", target: "fast_path" },
    },
    {
      from: "triage",
      to: "slow_path",
      condition: { type: "manager_selected", target: "slow_path" },
    },
    {
      from: "fast_path",
      to: "converge",
      condition: {
        type: "artifact_equals",
        artifact: "fast_result",
        path: "verdict",
        value: "ok",
      },
    },
    {
      from: "slow_path",
      to: "converge",
      condition: {
        type: "artifact_in",
        artifact: "slow_result",
        path: "verdict",
        values: ["ok", "warn"],
      },
    },
    { from: "converge", to: "review", condition: { type: "always" } },
    { from: "review", to: "publish", condition: { type: "human_selected", choice: "approve" } },
    { from: "review", to: "recheck", condition: { type: "human_selected", choice: "retry" } },
    // The guarded back-edge. This is what a "loop" is in Atlas: a cycle plus a guard. Without
    // the `max_iterations_below` condition (or `policy.max_iterations`) Atlas rejects the save.
    {
      from: "recheck",
      to: "ingest",
      condition: { type: "max_iterations_below", node: "ingest", max: 3 },
    },
  ],
} as const satisfies Record<string, unknown>;

/** Exercises every policy key Atlas bounds, at its documented maximum. */
export const ALL_KINDS_POLICY = {
  max_jobs: 100,
  max_iterations: 100,
  max_attempts_per_node: 25,
  max_minutes: 1440,
  requires_human_after_iterations: 100,
  max_budget_units: 1_000_000,
  stop_on_first_failure: true,
  file_handoff: false,
} as const satisfies Record<string, unknown>;

/** The smallest graph Atlas accepts: one node, no edges. */
export const MINIMAL_GRAPH = {
  start: "only",
  nodes: [{ id: "only", type: "worker", prompt: "Do the thing." }],
  edges: [],
} as const satisfies Record<string, unknown>;

/** `push_files` is only legal with the `file_handoff` opt-in (`atlas/workflows.py:243`). */
export const FILE_HANDOFF_GRAPH = {
  start: "produce",
  nodes: [
    { id: "produce", type: "worker", prompt: "Write the files.", outputs: ["produced"] },
    { id: "consume", type: "worker", prompt: "Read the files." },
  ],
  edges: [
    {
      from: "produce",
      to: "consume",
      condition: { type: "always" },
      push_files: ["handoff/*.json"],
    },
  ],
} as const satisfies Record<string, unknown>;

export const FILE_HANDOFF_POLICY = { file_handoff: true } as const satisfies Record<
  string,
  unknown
>;

/** Carries the instance-scoped reference fields, for parser coverage and a seeded contract run. */
export function referenceGraph(workerId: string, workspaceId: string) {
  return {
    start: "only",
    nodes: [
      {
        id: "only",
        type: "worker",
        prompt: "Run on a specific worker.",
        worker_id: workerId,
        workspace_id: workspaceId,
        workspace_key: "primary",
        outputs: ["only_result"],
      },
    ],
    edges: [],
  };
}

/** Graphs the editor must refuse rather than silently repair. Each fails closed on parse. */
export const FAIL_CLOSED_GRAPHS: Array<{ why: string; graph: unknown }> = [
  {
    why: "a node type Atlas does not have",
    graph: {
      start: "a",
      nodes: [{ id: "a", type: "condition", expr: "payload.ok" }],
      edges: [],
    },
  },
  {
    why: "a trigger smuggled into graph.nodes",
    graph: {
      start: "t",
      nodes: [{ id: "t", type: "trigger", mode: "webhook" }],
      edges: [],
    },
  },
  {
    why: "an edge condition type Atlas does not have",
    graph: {
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "b", type: "worker" },
      ],
      edges: [{ from: "a", to: "b", condition: { type: "expression", expr: "x == 1" } }],
    },
  },
  {
    why: "a UI field on a node that Atlas's schema forbids",
    graph: {
      start: "a",
      nodes: [{ id: "a", type: "worker", position: { x: 10, y: 20 } }],
      edges: [],
    },
  },
  {
    why: "a label on an edge, which Atlas has no field for",
    graph: {
      start: "a",
      nodes: [
        { id: "a", type: "worker" },
        { id: "b", type: "worker" },
      ],
      edges: [{ from: "a", to: "b", condition: { type: "always" }, label: "true" }],
    },
  },
  {
    why: "a manager schema Atlas would not recognise",
    graph: {
      start: "m",
      nodes: [{ id: "m", type: "manager", schema: "manager_decision_v2" }],
      edges: [],
    },
  },
  {
    why: "a join mode outside the enum",
    graph: {
      start: "j",
      nodes: [{ id: "j", type: "join", mode: "majority" }],
      edges: [],
    },
  },
  {
    why: "an execution mode outside the enum",
    graph: {
      start: "a",
      nodes: [{ id: "a", type: "worker", execution: "batch" }],
      edges: [],
    },
  },
];
