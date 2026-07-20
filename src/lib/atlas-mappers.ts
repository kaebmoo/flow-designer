/**
 * Adapters between raw Atlas shapes and UI view models.
 *
 * Client-safe: this module imports no `*.server.ts` and holds no secrets. It exists so that
 * components never see a raw Atlas response, and so an Atlas field rename is absorbed here
 * instead of across every component.
 *
 * Phase 2 adds the read-only domain view models. Workflow graph *serialization* (UI → Atlas)
 * lands with the editor work in Phase 3; nothing here writes.
 */

import type {
  AtlasApproval,
  AtlasErrorKind,
  AtlasJob,
  AtlasJobListRow,
  AtlasMetrics,
  AtlasRole,
  AtlasRuntimeEdge,
  AtlasRuntimeNode,
  AtlasUser,
  AtlasWorker,
  AtlasWorkflowDefinition,
  AtlasWorkflowGraph,
  AtlasWorkflowRun,
  AtlasWorkflowRunDetail,
  AtlasWorkspaceListRow,
} from "./atlas-types";

/**
 * An Atlas failure after it has crossed the server-function boundary.
 *
 * A thrown `AtlasError` is *serialised* on its way to the browser, so it arrives as plain
 * data and `instanceof` no longer holds. Everything the UI needs must therefore live in
 * these two fields — and nothing else may, because whatever is here reaches the browser.
 */
export interface ClientAtlasError {
  kind: AtlasErrorKind;
  message: string;
}

/** Identity for UI rendering. */
export interface IdentityView {
  id: string | null;
  username: string;
  /**
   * UX ONLY. Use this to hide or disable controls, never to authorise an action. Atlas is
   * the sole authorization authority and re-checks the real role on every call; a role
   * cached here can be stale the moment an admin changes it.
   */
  role: AtlasRole;
  roleLabel: string;
  initials: string;
}

const ROLE_LABELS: Record<AtlasRole, string> = {
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
  auditor: "Auditor",
};

export function roleLabel(role: AtlasRole): string {
  return ROLE_LABELS[role];
}

export function toIdentityView(user: AtlasUser): IdentityView {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    roleLabel: roleLabel(user.role),
    initials: user.username.slice(0, 2).toUpperCase(),
  };
}

/**
 * Recognises an Atlas failure both as a live `AtlasError` instance on the server and as its
 * serialised twin on the client, hence the structural check rather than `instanceof`.
 */
export function isClientAtlasError(value: unknown): value is ClientAtlasError {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.name === "AtlasError" || typeof candidate.kind === "string") &&
    typeof candidate.kind === "string" &&
    typeof candidate.message === "string"
  );
}

/**
 * Narrows any thrown value to the two fields that are safe to send to a browser.
 *
 * This is the redaction point. An `AtlasError` carries a `cause` that can name the private
 * Atlas origin or embed a socket error; copying only `kind` and `message` guarantees none of
 * that, and no credential, leaves the server.
 */
/** Copy substituted for a `server` failure, in place of Atlas's own 5xx text. */
const SERVER_FAILURE_MESSAGE = "Atlas failed to process the request.";

export function toClientAtlasError(value: unknown): ClientAtlasError {
  if (isClientAtlasError(value)) {
    /**
     * A 5xx message is dropped rather than forwarded.
     *
     * Atlas's dispatcher ends in an unfiltered `except Exception as exc: {"error": str(exc)}`
     * (`atlas/app.py:256`), so the `error` field of a 500 is a raw Python exception string — a
     * `sqlite3.OperationalError` naming the database file, a `KeyError` naming an internal
     * field, a filesystem path. That is server-internal detail an unprivileged browser session
     * should not receive, and it tells the operator nothing actionable either. Every other kind
     * (validation, forbidden, not_found, conflict) carries a message Atlas wrote *for* the
     * caller, so those pass through unchanged.
     */
    if (value.kind === "server") {
      return { kind: "server", message: SERVER_FAILURE_MESSAGE };
    }
    return { kind: value.kind, message: value.message };
  }
  return { kind: "server", message: SERVER_FAILURE_MESSAGE };
}

export interface ErrorPresentation {
  title: string;
  description: string;
  /** Whether a retry could plausibly succeed without the user changing something. */
  retryable: boolean;
}

/** Single source of UI copy for every failure kind, so states stay explicit and consistent. */
export function describeAtlasError(error: ClientAtlasError): ErrorPresentation {
  switch (error.kind) {
    case "unauthorized":
      return {
        title: "Signed out",
        description: "Your Atlas session is no longer valid. Sign in again to continue.",
        retryable: false,
      };
    case "forbidden":
      return {
        title: "Not allowed",
        description:
          error.message ||
          "Your Atlas role does not permit this action. Ask an administrator if you need access.",
        retryable: false,
      };
    case "not_found":
      return {
        title: "Not found",
        description: "Atlas has no record of the thing you asked for.",
        retryable: false,
      };
    case "validation":
      return { title: "Rejected", description: error.message, retryable: false };
    case "conflict":
      return {
        title: "Conflict",
        description: `${error.message} Reload to see the current state before retrying.`,
        retryable: false,
      };
    case "rate_limited":
      return {
        title: "Slow down",
        description: "Atlas is rate limiting this client. Wait a moment and try again.",
        retryable: true,
      };
    case "timeout":
      return {
        title: "Atlas timed out",
        description: "Atlas did not respond in time. It may be busy or restarting.",
        retryable: true,
      };
    case "network":
      return {
        title: "Atlas unreachable",
        description: "The server could not reach Atlas. Check that Atlas is running.",
        retryable: true,
      };
    case "protocol":
      return {
        title: "Unexpected response",
        description: "Atlas replied with something this UI does not understand.",
        retryable: true,
      };
    case "server":
      return {
        title: "Atlas error",
        description: "Atlas failed to process the request.",
        retryable: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Domain view models (read-only, Phase 2)
//
// Components consume these, never a raw Atlas row. Two consequences that matter:
//   - An Atlas field rename is absorbed here instead of in every table cell.
//   - Mapping happens server-side inside the RPC handler, so fields the UI does not render
//     (a run's whole `graph_snapshot`, a job's `assistant_text` on a list row) never cross the
//     wire at all.
// ---------------------------------------------------------------------------

/** The tones `StatusPill` understands. A view model names the tone; components do not guess. */
export type StatusTone = "primary" | "success" | "warning" | "danger" | "muted";

export interface StatusView {
  /** Exactly what Atlas said. Never a substituted or prettified state name. */
  label: string;
  tone: StatusTone;
}

/**
 * One tone table for every Atlas state vocabulary.
 *
 * ponytail: worker status, job state, run state, node state, and workflow status use disjoint
 * words, so per-entity tables would be four copies of the same mapping. Split them the day two
 * vocabularies disagree about a word.
 *
 * An unrecognised state is deliberately not an error: `atlas/db.py` stores these as free TEXT
 * with no CHECK constraint, so Atlas can add one without a migration. The UI shows the real
 * state in a neutral tone rather than hiding a state it has not been taught.
 */
const STATE_TONES: Record<string, StatusTone> = {
  // workers
  online: "success",
  healthy: "success",
  offline: "danger",
  unknown: "muted",
  // jobs, runs, and runtime nodes
  queued: "muted",
  running: "primary",
  succeeded: "success",
  failed: "danger",
  cancelled: "muted",
  cancel_requested: "warning",
  skipped: "muted",
  paused: "warning",
  waiting_for_human: "warning",
  recovery_required: "danger",
  pending: "warning",
  approved: "success",
  rejected: "danger",
  // workflow definitions
  draft: "muted",
  active: "success",
  disabled: "warning",
};

export function toStatusView(state: string): StatusView {
  return { label: state, tone: STATE_TONES[state] ?? "muted" };
}

/**
 * Formats an Atlas timestamp for display without inventing precision or drifting.
 *
 * Atlas emits second-resolution UTC (`atlas/db.py:32-33`). This deliberately does *not*
 * produce a relative label ("12s ago") or a locale-formatted local time: both differ between
 * the server render and the client hydration, which React reports as a hydration mismatch and
 * which makes a screenshot impossible to reproduce. The value stays UTC and absolute.
 */
export function formatAtlasTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  return (
    value
      .replace("T", " ")
      .replace(/\.\d+Z?$/, "")
      .replace(/Z$/, "") + " UTC"
  );
}

/**
 * Elapsed milliseconds between two Atlas timestamps, or null when it cannot be known.
 *
 * Null — not zero — when the row has not started or has not finished. Zero would render as
 * "0.0s", which reads as "finished instantly" rather than "still running".
 */
export function atlasDurationMs(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const elapsed = end - start;
  return elapsed >= 0 ? elapsed : null;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

export interface WorkerView {
  id: string;
  name: string;
  baseUrl: string;
  role: string;
  tags: string[];
  status: StatusView;
  lastSeenAt: string;
  /** The worker's self-reported agent version, or null when Atlas has never polled it. */
  agentVersion: string | null;
  lastError: string | null;
  syncMode: string;
  /** Whether Atlas holds a worker token. The token itself never leaves Atlas. */
  tokenSet: boolean;
}

/**
 * Reads the agent version out of the poll-owned `agent_info` blob.
 *
 * `agent_info` is whatever the worker's own `/v1/agent/info` returned (`atlas/jobs.py:481-509`),
 * so its shape is the worker's contract, not Atlas's. Every access is therefore defensive, and
 * a worker that has never been polled reports null rather than a fabricated version.
 */
function readAgentVersion(agentInfo: Record<string, unknown>): string | null {
  const agent = agentInfo.agent;
  if (agent !== null && typeof agent === "object") {
    const version = (agent as Record<string, unknown>).version;
    if (typeof version === "string" && version.length > 0) return version;
  }
  const direct = agentInfo.version;
  return typeof direct === "string" && direct.length > 0 ? direct : null;
}

export function toWorkerView(worker: AtlasWorker): WorkerView {
  return {
    id: worker.id,
    name: worker.name,
    baseUrl: worker.base_url,
    role: worker.role,
    tags: worker.tags ?? [],
    status: toStatusView(worker.status),
    lastSeenAt: formatAtlasTimestamp(worker.last_seen_at),
    agentVersion: readAgentVersion(worker.agent_info ?? {}),
    lastError: worker.last_error,
    syncMode: worker.sync_mode,
    tokenSet: worker.token_set,
  };
}

export interface WorkspaceView {
  id: string;
  workspaceKey: string;
  /** The directory *on the worker machine*. Atlas never resolves it locally. */
  workspaceDir: string;
  company: string;
  tags: string[];
  workerId: string;
  workerName: string;
  workerStatus: StatusView;
}

export function toWorkspaceView(workspace: AtlasWorkspaceListRow): WorkspaceView {
  return {
    id: workspace.id,
    workspaceKey: workspace.workspace_key,
    workspaceDir: workspace.workspace_dir,
    company: workspace.company,
    tags: workspace.tags ?? [],
    workerId: workspace.worker_id,
    workerName: workspace.worker_name,
    workerStatus: toStatusView(workspace.worker_status),
  };
}

export interface WorkflowView {
  id: string;
  name: string;
  description: string;
  status: StatusView;
  version: number;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

function countGraph(graph: AtlasWorkflowGraph | undefined): { nodes: number; edges: number } {
  return {
    nodes: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
    edges: Array.isArray(graph?.edges) ? graph.edges.length : 0,
  };
}

export function toWorkflowView(workflow: AtlasWorkflowDefinition): WorkflowView {
  const counts = countGraph(workflow.graph);
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    status: toStatusView(workflow.status),
    version: workflow.version,
    nodeCount: counts.nodes,
    edgeCount: counts.edges,
    createdAt: formatAtlasTimestamp(workflow.created_at),
    updatedAt: formatAtlasTimestamp(workflow.updated_at),
  };
}

/** A graph node reduced to what a read-only view renders. Editing is Phase 3. */
export interface WorkflowGraphNodeView {
  id: string;
  /** The Atlas node type verbatim: `worker`, `manager`, `join`, or `human_gate`. */
  type: string;
  label: string;
  isStart: boolean;
}

export interface WorkflowGraphEdgeView {
  id: string;
  from: string;
  to: string;
  /** The edge condition type Atlas stored, defaulted to `always` only when absent. */
  condition: string;
}

export interface WorkflowDetailView extends WorkflowView {
  startNodeId: string | null;
  graphNodes: WorkflowGraphNodeView[];
  graphEdges: WorkflowGraphEdgeView[];
  /** Atlas's policy object, rendered as key/value rows rather than interpreted. */
  policy: Array<{ key: string; value: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Maps Atlas's stored graph into read-only rows.
 *
 * The graph is validated by Atlas on write, but this UI also reads graphs written by other
 * clients and by older Atlas versions, so nothing is assumed: a node without a usable `id` is
 * dropped rather than rendered as an empty row, and an unknown `type` is displayed as-is.
 */
export function toWorkflowDetailView(workflow: AtlasWorkflowDefinition): WorkflowDetailView {
  const graph = workflow.graph ?? {};
  const start = typeof graph.start === "string" && graph.start ? graph.start : null;

  const graphNodes: WorkflowGraphNodeView[] = (Array.isArray(graph.nodes) ? graph.nodes : [])
    .map((raw) => {
      const node = asRecord(raw);
      const id = node && typeof node.id === "string" ? node.id : "";
      if (!id) return null;
      const type = typeof node!.type === "string" ? node!.type : "unknown";
      const label = typeof node!.label === "string" && node!.label ? node!.label : id;
      return { id, type, label, isStart: id === start };
    })
    .filter((node): node is WorkflowGraphNodeView => node !== null);

  const graphEdges: WorkflowGraphEdgeView[] = (Array.isArray(graph.edges) ? graph.edges : [])
    .map((raw, index) => {
      const edge = asRecord(raw);
      const from = edge && typeof edge.from === "string" ? edge.from : "";
      const to = edge && typeof edge.to === "string" ? edge.to : "";
      if (!from || !to) return null;
      const condition = asRecord(edge!.condition);
      const type = condition && typeof condition.type === "string" ? condition.type : "always";
      return { id: `${from}->${to}#${index}`, from, to, condition: type };
    })
    .filter((edge): edge is WorkflowGraphEdgeView => edge !== null);

  const policy = Object.entries(workflow.policy ?? {}).map(([key, value]) => ({
    key,
    value: typeof value === "object" && value !== null ? JSON.stringify(value) : String(value),
  }));

  return { ...toWorkflowView(workflow), startNodeId: start, graphNodes, graphEdges, policy };
}

export interface RunView {
  id: string;
  name: string;
  state: StatusView;
  workflowDefinitionId: string | null;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number | null;
  error: string | null;
  currentNodes: string[];
}

/**
 * Maps a run row. Note what is *not* copied: `graph_snapshot` and `policy_snapshot`.
 *
 * `GET /api/workflow-runs` is a `SELECT *`, so every list row carries the entire snapshotted
 * graph. Dropping them here keeps a page of runs from shipping several graphs' worth of JSON
 * to a browser that renders none of it.
 */
export function toRunView(run: AtlasWorkflowRun): RunView {
  return {
    id: run.id,
    name: run.name,
    state: toStatusView(run.state),
    workflowDefinitionId: run.workflow_definition_id,
    createdAt: formatAtlasTimestamp(run.created_at),
    startedAt: formatAtlasTimestamp(run.started_at),
    finishedAt: formatAtlasTimestamp(run.finished_at),
    durationMs: atlasDurationMs(run.started_at, run.finished_at),
    error: run.error,
    currentNodes: run.current_nodes ?? [],
  };
}

export interface RuntimeNodeView {
  id: string;
  nodeKey: string;
  state: StatusView;
  jobId: string | null;
  attempt: number;
  outputArtifacts: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number | null;
}

export function toRuntimeNodeView(node: AtlasRuntimeNode): RuntimeNodeView {
  return {
    id: node.id,
    nodeKey: node.node_key,
    state: toStatusView(node.state),
    jobId: node.job_id,
    attempt: node.attempt,
    outputArtifacts: node.output_artifacts ?? [],
    error: node.error,
    startedAt: formatAtlasTimestamp(node.started_at),
    finishedAt: formatAtlasTimestamp(node.finished_at),
    durationMs: atlasDurationMs(node.started_at, node.finished_at),
  };
}

export interface RuntimeEdgeView {
  id: string;
  from: string;
  to: string;
  /** Whether the recorded condition evaluation let this edge fire, or null when unrecorded. */
  matched: boolean | null;
}

export function toRuntimeEdgeView(edge: AtlasRuntimeEdge): RuntimeEdgeView {
  const result = edge.condition_result ?? {};
  const matched = result.matched;
  return {
    id: edge.id,
    from: edge.from_node,
    to: edge.to_node,
    matched: typeof matched === "boolean" ? matched : null,
  };
}

export interface ApprovalView {
  id: string;
  nodeKey: string;
  label: string;
  reason: string;
  state: StatusView;
  choices: Array<{ id: string; label: string }>;
  selectedChoice: string | null;
  createdAt: string;
  decidedAt: string;
}

export function toApprovalView(approval: AtlasApproval): ApprovalView {
  return {
    id: approval.id,
    nodeKey: approval.node_key,
    label: approval.label,
    reason: approval.reason,
    state: toStatusView(approval.state),
    choices: (approval.choices ?? [])
      .filter((choice) => typeof choice?.id === "string")
      .map((choice) => ({ id: choice.id!, label: choice.label ?? choice.id! })),
    selectedChoice: approval.selected_choice,
    createdAt: formatAtlasTimestamp(approval.created_at),
    decidedAt: formatAtlasTimestamp(approval.decided_at),
  };
}

export interface RunDetailView {
  run: RunView;
  nodes: RuntimeNodeView[];
  edges: RuntimeEdgeView[];
  approvals: ApprovalView[];
  /**
   * True when Atlas returned exactly its un-overridable 100-approval cap for this run, which
   * is the only signal available that the list may be truncated — the response carries no
   * total. See `docs/ATLAS_LIMITATIONS.md`.
   */
  approvalsMayBeTruncated: boolean;
}

/** Atlas's hard cap on the approvals embedded in a run detail response (`atlas/app.py:671`). */
export const RUN_DETAIL_APPROVALS_CAP = 100;

export function toRunDetailView(detail: AtlasWorkflowRunDetail): RunDetailView {
  return {
    run: toRunView(detail.run),
    nodes: detail.nodes.map(toRuntimeNodeView),
    edges: detail.edges.map(toRuntimeEdgeView),
    approvals: detail.approvals.map(toApprovalView),
    approvalsMayBeTruncated: detail.approvals.length >= RUN_DETAIL_APPROVALS_CAP,
  };
}

export interface JobView {
  id: string;
  prompt: string;
  state: StatusView;
  workerId: string;
  /** Present only on list rows; the by-id route does not join `workers`. */
  workerName: string | null;
  workspaceKey: string | null;
  model: string;
  execution: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number | null;
  error: string | null;
  sessionId: string | null;
  conversationId: string | null;
  routeReason: string;
  cancelRequested: boolean;
}

function toJobViewBase(job: AtlasJob): Omit<JobView, "workerName" | "workspaceKey"> {
  return {
    id: job.id,
    prompt: job.prompt,
    state: toStatusView(job.state),
    workerId: job.worker_id,
    model: job.model,
    execution: job.execution,
    createdAt: formatAtlasTimestamp(job.created_at),
    startedAt: formatAtlasTimestamp(job.started_at),
    finishedAt: formatAtlasTimestamp(job.finished_at),
    durationMs: atlasDurationMs(job.started_at, job.finished_at),
    error: job.error,
    sessionId: job.thclaws_session_id,
    conversationId: job.conversation_id,
    routeReason: job.route_reason,
    // Atlas stores this as an INTEGER column, not a JSON boolean.
    cancelRequested: job.cancel_requested === 1,
  };
}

export function toJobListView(job: AtlasJobListRow): JobView {
  return {
    ...toJobViewBase(job),
    workerName: job.worker_name,
    workspaceKey: job.workspace_key,
  };
}

export interface JobDetailView extends JobView {
  assistantText: string;
  collectFiles: string[];
}

/**
 * Maps `GET /api/jobs/{id}`.
 *
 * `workerName`/`workspaceKey` are null rather than guessed: that route returns the un-joined
 * row, and inventing a name from a stale list would show data Atlas did not send.
 */
export function toJobDetailView(job: AtlasJob): JobDetailView {
  return {
    ...toJobViewBase(job),
    workerName: null,
    workspaceKey: null,
    assistantText: job.assistant_text,
    collectFiles: job.collect_files ?? [],
  };
}

export interface MetricsView {
  workersTotal: number;
  workersOnline: number;
  workersByStatus: Array<{ state: string; count: number }>;
  runsByState: Array<{ state: string; count: number }>;
  runsActive: number;
  runsTotal: number;
  jobsByState: Array<{ state: string; count: number }>;
  jobsTotal: number;
  workflowDefinitions: number;
  triggersEnabled: number;
  approvalsPending: number;
  artifacts: number;
  /** Atlas's own version string, useful when a UI/Atlas mismatch is suspected. */
  atlasVersion: string;
  /** When Atlas produced the snapshot, so a stale card is visibly stale. */
  generatedAt: string;
}

function tally(
  counts: Record<string, number> | undefined,
): Array<{ state: string; count: number }> {
  return Object.entries(counts ?? {})
    .map(([state, count]) => ({ state, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state));
}

function sum(counts: Record<string, number> | undefined): number {
  return Object.values(counts ?? {}).reduce((total, value) => total + (Number(value) || 0), 0);
}

function pick(counts: Record<string, number> | undefined, states: string[]): number {
  return states.reduce((total, state) => total + (Number(counts?.[state]) || 0), 0);
}

/**
 * Maps `GET /api/metrics`.
 *
 * These are Atlas's own lifetime totals, computed with `COUNT(*) … GROUP BY` over the whole
 * table — they are not derived from whichever page of rows the UI happens to be showing. A
 * state with no rows is absent from the map, so every lookup defaults to zero.
 */
export function toMetricsView(metrics: AtlasMetrics): MetricsView {
  return {
    workersTotal: sum(metrics.workers),
    workersOnline: pick(metrics.workers, ["online", "healthy"]),
    workersByStatus: tally(metrics.workers),
    runsByState: tally(metrics.workflow_runs),
    runsActive: pick(metrics.workflow_runs, [
      "running",
      "queued",
      "paused",
      "waiting_for_human",
      "recovery_required",
    ]),
    runsTotal: sum(metrics.workflow_runs),
    jobsByState: tally(metrics.jobs),
    jobsTotal: sum(metrics.jobs),
    workflowDefinitions: Number(metrics.workflow_definitions) || 0,
    triggersEnabled: Number(metrics.triggers_enabled) || 0,
    approvalsPending: Number(metrics.approvals_pending) || 0,
    artifacts: Number(metrics.artifacts) || 0,
    atlasVersion: metrics.version,
    generatedAt: formatAtlasTimestamp(metrics.time),
  };
}
