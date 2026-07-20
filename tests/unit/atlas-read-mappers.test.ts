/**
 * Unit tests for the read-path view models.
 *
 * These cover the decisions a contract test cannot force a real Atlas to produce on demand:
 * a state Atlas has not been taught to this UI, a run that started but never finished, a
 * graph written by another client, a `GROUP BY` map missing every state.
 */

import { describe, expect, it } from "vitest";

import {
  atlasDurationMs,
  formatAtlasTimestamp,
  formatDurationMs,
  toApprovalView,
  toJobDetailView,
  toJobListView,
  toMetricsView,
  toRunDetailView,
  toRunView,
  toRuntimeEdgeView,
  toStatusView,
  toWorkerView,
  toWorkflowDetailView,
  toWorkflowView,
  toWorkspaceView,
} from "@/lib/atlas-mappers";
import type {
  AtlasApproval,
  AtlasJob,
  AtlasJobListRow,
  AtlasMetrics,
  AtlasWorker,
  AtlasWorkflowDefinition,
  AtlasWorkflowRun,
  AtlasWorkspaceListRow,
} from "@/lib/atlas-types";

const worker: AtlasWorker = {
  id: "wrk_1",
  name: "Reporter",
  base_url: "http://127.0.0.1:4317",
  role: "reporter",
  tags: ["local"],
  status: "online",
  last_seen_at: "2026-07-20T09:00:00Z",
  agent_info: { agent: { version: "1.4.2" } },
  last_error: null,
  created_at: "2026-07-19T08:00:00Z",
  updated_at: "2026-07-20T09:00:00Z",
  sync_mode: "disabled",
  token_set: true,
};

const run: AtlasWorkflowRun = {
  id: "wfr_1",
  workflow_definition_id: "wfd_1",
  name: "Ingest",
  state: "succeeded",
  input: {},
  current_nodes: [],
  counters: {},
  error: null,
  created_at: "2026-07-20T09:00:00Z",
  started_at: "2026-07-20T09:00:01Z",
  finished_at: "2026-07-20T09:00:13Z",
  updated_at: "2026-07-20T09:00:13Z",
  graph_snapshot: { start: "n1", nodes: [{ id: "n1" }], edges: [] },
  policy_snapshot: { max_jobs: 20 },
};

const job: AtlasJob = {
  id: "job_1",
  conversation_id: "cnv_1",
  worker_id: "wrk_1",
  workspace_id: "wsp_1",
  parent_job_id: null,
  state: "succeeded",
  prompt: "Summarise the logs.",
  model: "sonnet",
  route_reason: "explicit worker",
  thclaws_session_id: "sess_1",
  assistant_text: "Done.",
  error: null,
  cancel_requested: 0,
  execution: "stream",
  callback_deadline_at: null,
  created_at: "2026-07-20T09:00:00Z",
  started_at: "2026-07-20T09:00:01Z",
  finished_at: "2026-07-20T09:00:09Z",
  updated_at: "2026-07-20T09:00:09Z",
  collect_files: [],
};

describe("toStatusView", () => {
  it.each([
    ["online", "success"],
    ["healthy", "success"],
    ["offline", "danger"],
    ["running", "primary"],
    ["succeeded", "success"],
    ["failed", "danger"],
    ["paused", "warning"],
    ["waiting_for_human", "warning"],
    ["recovery_required", "danger"],
    ["queued", "muted"],
    ["draft", "muted"],
    ["active", "success"],
    ["disabled", "warning"],
  ])("maps %s to the %s tone", (state, tone) => {
    expect(toStatusView(state)).toEqual({ label: state, tone });
  });

  /**
   * Atlas stores states as free TEXT with no CHECK constraint, so it can introduce one without
   * a migration. The UI must show the real state rather than hide or rename it.
   */
  it("shows an unrecognised Atlas state verbatim in a neutral tone", () => {
    expect(toStatusView("quarantined")).toEqual({ label: "quarantined", tone: "muted" });
  });
});

describe("formatAtlasTimestamp", () => {
  it("renders an absolute UTC value, never a relative or locale-formatted one", () => {
    // A relative label would differ between the SSR render and hydration; a locale format
    // would differ per machine. Both are reproducibility problems, not cosmetic ones.
    expect(formatAtlasTimestamp("2026-07-20T09:00:00Z")).toBe("2026-07-20 09:00:00 UTC");
  });

  it.each([null, undefined, ""])("renders %p as an em dash rather than an empty cell", (value) => {
    expect(formatAtlasTimestamp(value)).toBe("—");
  });
});

describe("atlasDurationMs", () => {
  it("computes the elapsed milliseconds between two timestamps", () => {
    expect(atlasDurationMs("2026-07-20T09:00:01Z", "2026-07-20T09:00:13Z")).toBe(12_000);
  });

  /** Null, not zero: "0.0s" would read as "finished instantly" rather than "still running". */
  it.each([
    ["not started", null, "2026-07-20T09:00:13Z"],
    ["not finished", "2026-07-20T09:00:01Z", null],
    ["neither", null, null],
  ])("returns null when the run is %s", (_case, started, finished) => {
    expect(atlasDurationMs(started, finished)).toBeNull();
  });

  it("returns null rather than a negative duration for out-of-order timestamps", () => {
    expect(atlasDurationMs("2026-07-20T09:00:13Z", "2026-07-20T09:00:01Z")).toBeNull();
  });

  it("returns null for an unparseable timestamp instead of NaN", () => {
    expect(atlasDurationMs("not-a-date", "2026-07-20T09:00:13Z")).toBeNull();
  });
});

describe("formatDurationMs", () => {
  it("formats a known duration in seconds", () => {
    expect(formatDurationMs(12_400)).toBe("12.4s");
  });

  it("renders an unknown duration as an em dash", () => {
    expect(formatDurationMs(null)).toBe("—");
  });
});

describe("toWorkerView", () => {
  it("maps a polled worker, including its agent version", () => {
    const view = toWorkerView(worker);
    expect(view).toMatchObject({
      id: "wrk_1",
      name: "Reporter",
      baseUrl: "http://127.0.0.1:4317",
      agentVersion: "1.4.2",
      tokenSet: true,
    });
    expect(view.status.tone).toBe("success");
  });

  /** `agent_info` is the worker's own payload, so every access has to be defensive. */
  it("reports a null agent version rather than inventing one", () => {
    expect(toWorkerView({ ...worker, agent_info: {} }).agentVersion).toBeNull();
    expect(toWorkerView({ ...worker, agent_info: { agent: "nonsense" } }).agentVersion).toBeNull();
    expect(toWorkerView({ ...worker, agent_info: { agent: {} } }).agentVersion).toBeNull();
  });

  it("accepts a top-level version as a fallback shape", () => {
    expect(toWorkerView({ ...worker, agent_info: { version: "9.9" } }).agentVersion).toBe("9.9");
  });

  it("never exposes a token field, because Atlas never sends one", () => {
    expect(toWorkerView(worker)).not.toHaveProperty("token");
  });
});

describe("toWorkspaceView", () => {
  it("carries the joined worker name and status", () => {
    const row: AtlasWorkspaceListRow = {
      id: "wsp_1",
      worker_id: "wrk_1",
      workspace_key: "thclaws",
      workspace_dir: "/srv/thclaws",
      company: "NT",
      tags: [],
      created_at: "2026-07-19T08:00:00Z",
      updated_at: "2026-07-19T08:00:00Z",
      worker_name: "Reporter",
      worker_status: "offline",
    };

    expect(toWorkspaceView(row)).toMatchObject({
      workspaceKey: "thclaws",
      workspaceDir: "/srv/thclaws",
      workerName: "Reporter",
    });
    expect(toWorkspaceView(row).workerStatus.tone).toBe("danger");
  });
});

describe("toWorkflowView / toWorkflowDetailView", () => {
  const workflow: AtlasWorkflowDefinition = {
    id: "wfd_1",
    name: "Ingest",
    description: "",
    version: 3,
    status: "active",
    graph: {
      start: "n1",
      nodes: [
        { id: "n1", type: "worker", label: "Reporter" },
        { id: "n2", type: "join", mode: "all" },
      ],
      edges: [{ from: "n1", to: "n2", condition: { type: "artifact_equals" } }],
    },
    policy: { max_jobs: 20, retry: { attempts: 3 } },
    created_at: "2026-07-19T08:00:00Z",
    updated_at: "2026-07-20T09:00:00Z",
  };

  it("counts graph nodes and edges", () => {
    expect(toWorkflowView(workflow)).toMatchObject({ nodeCount: 2, edgeCount: 1, version: 3 });
  });

  it("treats a missing graph as empty rather than throwing", () => {
    const empty = toWorkflowView({ ...workflow, graph: {} });
    expect(empty.nodeCount).toBe(0);
    expect(empty.edgeCount).toBe(0);
  });

  it("marks the start node and keeps the Atlas node type verbatim", () => {
    const view = toWorkflowDetailView(workflow);
    expect(view.startNodeId).toBe("n1");
    expect(view.graphNodes[0]).toEqual({
      id: "n1",
      type: "worker",
      label: "Reporter",
      isStart: true,
    });
    // A node without a label falls back to its id, not to an empty cell.
    expect(view.graphNodes[1]).toEqual({ id: "n2", type: "join", label: "n2", isStart: false });
  });

  it("preserves the stored edge condition and defaults only an absent one", () => {
    const view = toWorkflowDetailView(workflow);
    expect(view.graphEdges[0]!.condition).toBe("artifact_equals");

    const bare = toWorkflowDetailView({
      ...workflow,
      graph: {
        start: "n1",
        nodes: [{ id: "n1", type: "worker" }],
        edges: [{ from: "n1", to: "n1" }],
      },
    });
    expect(bare.graphEdges[0]!.condition).toBe("always");
  });

  /**
   * This UI also reads graphs written by other clients and older Atlas versions, so a
   * malformed entry must be dropped rather than rendered as a blank row.
   */
  it("drops malformed nodes and edges instead of rendering empty rows", () => {
    const view = toWorkflowDetailView({
      ...workflow,
      graph: {
        start: "n1",
        nodes: [{ id: "n1", type: "worker" }, { type: "worker" }, "nonsense", null],
        edges: [{ from: "n1", to: "n1" }, { from: "n1" }, { to: "n1" }, 42],
      },
    });
    expect(view.graphNodes).toHaveLength(1);
    expect(view.graphEdges).toHaveLength(1);
  });

  it("renders a nested policy value as JSON rather than [object Object]", () => {
    const view = toWorkflowDetailView(workflow);
    expect(view.policy).toContainEqual({ key: "retry", value: '{"attempts":3}' });
  });

  it("gives each edge row a stable, unique key even when two edges share endpoints", () => {
    const view = toWorkflowDetailView({
      ...workflow,
      graph: {
        start: "n1",
        nodes: [
          { id: "n1", type: "worker" },
          { id: "n2", type: "join" },
        ],
        edges: [
          { from: "n1", to: "n2", condition: { type: "always" } },
          { from: "n1", to: "n2", condition: { type: "artifact_in" } },
        ],
      },
    });
    const ids = view.graphEdges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("toRunView", () => {
  it("maps a finished run and computes its duration", () => {
    const view = toRunView(run);
    expect(view).toMatchObject({ id: "wfr_1", name: "Ingest", durationMs: 12_000 });
    expect(view.state.tone).toBe("success");
  });

  /**
   * `GET /api/workflow-runs` is a `SELECT *`, so every list row carries the whole snapshotted
   * graph. Forwarding it would ship several graphs' worth of JSON per page to a browser that
   * renders none of it.
   */
  it("drops graph and policy snapshots so they never reach the browser", () => {
    const view = toRunView(run);
    expect(view).not.toHaveProperty("graph_snapshot");
    expect(view).not.toHaveProperty("policy_snapshot");
  });

  it("keeps a null workflow definition id, which Atlas sets when a definition is deleted", () => {
    expect(toRunView({ ...run, workflow_definition_id: null }).workflowDefinitionId).toBeNull();
  });
});

describe("toRunDetailView", () => {
  const approval: AtlasApproval = {
    id: "apr_1",
    run_id: "wfr_1",
    workflow_node_id: "wfn_1",
    node_key: "gate",
    approval_key: "gate",
    label: "Ops sign-off",
    reason: "",
    choices: [{ id: "yes", label: "Ship it" }, { id: "no" }, { label: "no id" }],
    selected_choice: null,
    state: "pending",
    created_at: "2026-07-20T09:00:00Z",
    decided_at: null,
    updated_at: "2026-07-20T09:00:00Z",
  };

  it("maps choices, falling back to the id when Atlas stored no label", () => {
    const view = toApprovalView(approval);
    // The third entry has no id, so there is nothing stable to key or act on: it is dropped.
    expect(view.choices).toEqual([
      { id: "yes", label: "Ship it" },
      { id: "no", label: "no" },
    ]);
  });

  /**
   * Atlas caps embedded approvals at 100 with no total and no truncation flag, so a full list
   * is the only available hint — and it is genuinely ambiguous, which the flag name admits.
   */
  it("flags a possibly-truncated approval list only when the cap is reached", () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...approval, id: `apr_${i}` }));
    expect(
      toRunDetailView({ run, nodes: [], edges: [], approvals: full }).approvalsMayBeTruncated,
    ).toBe(true);
    expect(
      toRunDetailView({ run, nodes: [], edges: [], approvals: full.slice(0, 99) })
        .approvalsMayBeTruncated,
    ).toBe(false);
  });

  it("distinguishes an unrecorded edge condition from a false one", () => {
    const base = {
      id: "wfe_1",
      run_id: "wfr_1",
      from_node: "n1",
      to_node: "n2",
      created_at: "2026-07-20T09:00:00Z",
    };
    expect(toRuntimeEdgeView({ ...base, condition_result: {} }).matched).toBeNull();
    expect(toRuntimeEdgeView({ ...base, condition_result: { matched: false } }).matched).toBe(
      false,
    );
    expect(toRuntimeEdgeView({ ...base, condition_result: { matched: true } }).matched).toBe(true);
  });
});

describe("job view models", () => {
  it("carries the joined worker name and workspace key on a list row", () => {
    const row: AtlasJobListRow = { ...job, worker_name: "Reporter", workspace_key: "thclaws" };
    expect(toJobListView(row)).toMatchObject({
      workerName: "Reporter",
      workspaceKey: "thclaws",
      durationMs: 8_000,
    });
  });

  it("keeps a null workspace key, which Atlas returns for a job with no workspace", () => {
    const row: AtlasJobListRow = { ...job, worker_name: "Reporter", workspace_key: null };
    expect(toJobListView(row).workspaceKey).toBeNull();
  });

  /**
   * The by-id route does not join, so guessing a name from a stale list row would display
   * data Atlas did not send.
   */
  it("leaves worker name and workspace key null on a detail row rather than guessing", () => {
    const view = toJobDetailView(job);
    expect(view.workerName).toBeNull();
    expect(view.workspaceKey).toBeNull();
    expect(view.assistantText).toBe("Done.");
  });

  it("converts Atlas's integer cancel_requested column to a boolean", () => {
    expect(toJobDetailView(job).cancelRequested).toBe(false);
    expect(toJobDetailView({ ...job, cancel_requested: 1 }).cancelRequested).toBe(true);
  });
});

describe("toMetricsView", () => {
  const metrics: AtlasMetrics = {
    workers: { online: 3, offline: 1, unknown: 2 },
    jobs: { succeeded: 10, failed: 2 },
    workflow_runs: { running: 1, paused: 2, succeeded: 7 },
    workflow_definitions: 4,
    triggers_enabled: 1,
    approvals_pending: 2,
    artifacts: 9,
    usage_events: 12,
    usage_units: 34,
    schema_version: 12,
    version: "0.1.0",
    time: "2026-07-20T09:00:00Z",
  };

  it("totals each GROUP BY map", () => {
    const view = toMetricsView(metrics);
    expect(view.workersTotal).toBe(6);
    expect(view.workersOnline).toBe(3);
    expect(view.jobsTotal).toBe(12);
    expect(view.runsTotal).toBe(10);
  });

  it("counts every non-terminal run state as active", () => {
    expect(toMetricsView(metrics).runsActive).toBe(3);
  });

  it("counts a healthy worker as online, since Atlas uses both words", () => {
    expect(toMetricsView({ ...metrics, workers: { healthy: 2, online: 1 } }).workersOnline).toBe(3);
  });

  /** Absent keys are the normal case: a `GROUP BY` emits no row for a state with no rows. */
  it("reads zero for absent states rather than NaN or undefined", () => {
    const empty = toMetricsView({
      ...metrics,
      workers: {},
      jobs: {},
      workflow_runs: {},
    });
    expect(empty.workersTotal).toBe(0);
    expect(empty.workersOnline).toBe(0);
    expect(empty.runsActive).toBe(0);
    expect(empty.workersByStatus).toEqual([]);
  });

  it("orders a state tally by count so the largest bucket reads first", () => {
    expect(toMetricsView(metrics).workersByStatus).toEqual([
      { state: "online", count: 3 },
      { state: "unknown", count: 2 },
      { state: "offline", count: 1 },
    ]);
  });
});
