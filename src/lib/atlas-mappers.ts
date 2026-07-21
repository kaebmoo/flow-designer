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

import {
  parseWorkflowGraph,
  parseWorkflowPolicy,
  type JsonObject,
  type WorkflowGraph,
  type WorkflowPolicy,
} from "./workflow-graph";
import type {
  AtlasApiToken,
  AtlasApproval,
  AtlasArtifact,
  AtlasAuditEntry,
  AtlasConversation,
  AtlasDelivery,
  AtlasErrorKind,
  AtlasJob,
  AtlasJobListRow,
  AtlasMetrics,
  AtlasRole,
  AtlasSession,
  AtlasRuntimeEdge,
  AtlasRuntimeNode,
  AtlasUsageEvent,
  AtlasUsageResponse,
  AtlasUsageTotals,
  AtlasUser,
  AtlasUserListRow,
  AtlasWorker,
  AtlasWorkflowDefinition,
  AtlasWorkflowEvent,
  AtlasWorkflowEventPage,
  AtlasWorkflowGraph,
  AtlasWorkflowRun,
  AtlasWorkflowRunDetail,
  AtlasWorkflowTrigger,
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
  retryAfterSeconds?: number;
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
  sessionTokenId?: string;
  sessionExpiresAt?: string;
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

export function toIdentityView(user: AtlasUser, session?: AtlasSession): IdentityView {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    roleLabel: roleLabel(user.role),
    initials: user.username.slice(0, 2).toUpperCase(),
    ...(session ? { sessionTokenId: session.token_id, sessionExpiresAt: session.expires_at } : {}),
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
    const retryAfterSeconds =
      typeof value.retryAfterSeconds === "number" &&
      Number.isInteger(value.retryAfterSeconds) &&
      value.retryAfterSeconds > 0 &&
      value.retryAfterSeconds <= 3_600
        ? value.retryAfterSeconds
        : undefined;
    return {
      kind: value.kind,
      message: value.message,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
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

/**
 * One node Atlas found in flight when it restarted (`counters.recovery.interrupted[]`,
 * `atlas/workflows.py:546-552`).
 *
 * `callbackPending` is the entry that decides whether a retry is merely a re-run or a
 * duplication: Atlas sets it when the node's job is a callback job that is still executing on
 * the remote worker, so authorizing a retry submits a *second* job for work already underway.
 */
export interface RunInterruptedNodeView {
  nodeKey: string;
  jobId: string | null;
  attempt: number | null;
  callbackPending: boolean;
}

/** `counters.recovery`, present only once Atlas has marked a run `recovery_required`. */
export interface RunRecoveryView {
  reason: string | null;
  /** Atlas's own operator guidance. Shown verbatim rather than paraphrased. */
  warning: string | null;
  interrupted: RunInterruptedNodeView[];
  /** True once a previous resume authorized a retry, so a second one would duplicate again. */
  retryAuthorizedAt: string | null;
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
  /**
   * `input._meta.reply.callback_url`, read exactly as Atlas's `_reply_of` reads it
   * (`atlas/outbound.py:457-459`). Its absence is why `POST /deliver` 400s, so the UI can name
   * the reason instead of offering a button that cannot succeed.
   */
  replyCallbackUrl: string | null;
  recovery: RunRecoveryView | null;
}

function readRecoveryCounters(counters: Record<string, unknown>): RunRecoveryView | null {
  const recovery = counters.recovery;
  if (recovery === null || typeof recovery !== "object") return null;
  const record = recovery as Record<string, unknown>;
  const interrupted = Array.isArray(record.interrupted) ? record.interrupted : [];
  return {
    reason: typeof record.reason === "string" ? record.reason : null,
    warning: typeof record.warning === "string" ? record.warning : null,
    retryAuthorizedAt:
      typeof record.retry_authorized_at === "string"
        ? formatAtlasTimestamp(record.retry_authorized_at)
        : null,
    interrupted: interrupted.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.node_key !== "string") return [];
      return [
        {
          nodeKey: item.node_key,
          jobId: typeof item.job_id === "string" ? item.job_id : null,
          attempt: typeof item.attempt === "number" ? item.attempt : null,
          callbackPending: item.callback_pending === true,
        },
      ];
    }),
  };
}

function readReplyCallbackUrl(input: Record<string, unknown>): string | null {
  const meta = input._meta;
  if (meta === null || typeof meta !== "object") return null;
  const reply = (meta as Record<string, unknown>).reply;
  if (reply === null || typeof reply !== "object") return null;
  const url = (reply as Record<string, unknown>).callback_url;
  return typeof url === "string" && url.length > 0 ? url : null;
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
    replyCallbackUrl: readReplyCallbackUrl(run.input ?? {}),
    recovery: readRecoveryCounters(run.counters ?? {}),
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

/**
 * The graph a run started on, parsed for the run canvas — or a stated refusal.
 *
 * Sourced from the run row's `graph_snapshot`, not from the current workflow definition: the
 * definition may have been edited or deleted since, and highlighting runtime state onto a
 * different graph would be a lie. Parsed with the same fail-closed parser the editor uses; an
 * unparseable snapshot renders as its reason, never as the fraction that parsed.
 */
export type RunGraphSnapshot =
  | { ok: true; graph: WorkflowGraph }
  | { ok: false; reason: string }
  | null;

export interface RunDetailView {
  run: RunView;
  nodes: RuntimeNodeView[];
  edges: RuntimeEdgeView[];
  approvals: ApprovalView[];
  graphSnapshot: RunGraphSnapshot;
  /**
   * True when Atlas returned exactly its un-overridable 100-approval cap for this run, which
   * is the only signal available that the list may be truncated — the response carries no
   * total. See `docs/ATLAS_LIMITATIONS.md`.
   */
  approvalsMayBeTruncated: boolean;
}

/** Atlas's hard cap on the approvals embedded in a run detail response (`atlas/app.py:671`). */
export const RUN_DETAIL_APPROVALS_CAP = 100;

function toRunGraphSnapshot(run: AtlasWorkflowRun): RunGraphSnapshot {
  if (run.graph_snapshot === null || run.graph_snapshot === undefined) return null;
  const parsed = parseWorkflowGraph(run.graph_snapshot);
  return parsed.ok ? { ok: true, graph: parsed.value } : { ok: false, reason: parsed.reason };
}

export function toRunDetailView(detail: AtlasWorkflowRunDetail): RunDetailView {
  return {
    run: toRunView(detail.run),
    nodes: detail.nodes.map(toRuntimeNodeView),
    edges: detail.edges.map(toRuntimeEdgeView),
    approvals: detail.approvals.map(toApprovalView),
    graphSnapshot: toRunGraphSnapshot(detail.run),
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
  /** Atlas's applied database schema version, from the same metrics snapshot. */
  schemaVersion: number;
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
    schemaVersion: Number(metrics.schema_version) || 0,
    generatedAt: formatAtlasTimestamp(metrics.time),
  };
}

// ---------------------------------------------------------------------------
// Phase 3 view models: the editable workflow, triggers, deliveries, artifacts, events.
// ---------------------------------------------------------------------------

/**
 * A workflow as the *editor* needs it, rather than as the read-only detail page renders it.
 *
 * `graph` is a result, not a value. Atlas stores whatever any client wrote — including graphs
 * with fields this editor's model has no place for — and the correct response to one of those
 * is to refuse to edit it, not to load the parts that parsed and `PUT` the remainder back,
 * silently deleting the rest. Carrying the refusal as data means the reason survives the
 * server-function boundary and can be shown to the user.
 */
export type WorkflowEditableGraph =
  | { ok: true; graph: WorkflowGraph; policy: WorkflowPolicy }
  | { ok: false; reason: string };

export interface WorkflowEditableView {
  id: string;
  name: string;
  description: string;
  version: number;
  status: string;
  /**
   * Atlas's raw `updated_at`, not a formatted one.
   *
   * This is the lost-update guard. Atlas has no ETag and no `If-Match`, and `version` is a
   * client-controlled column it never increments, so the server-set `updated_at` is the only
   * value that actually changes when someone else writes. It has to stay in wire form to be
   * comparable.
   */
  updatedAt: string;
  updatedAtLabel: string;
  /** Nullable workflow-root reply configuration; unknown extension keys remain intact. */
  defaultReply?: JsonObject | null;
  graph: WorkflowEditableGraph;
}

export function toWorkflowEditableView(workflow: AtlasWorkflowDefinition): WorkflowEditableView {
  const graph = parseWorkflowGraph(workflow.graph ?? {});
  const policy = parseWorkflowPolicy(workflow.policy ?? {});

  const editable: WorkflowEditableGraph = !graph.ok
    ? { ok: false, reason: graph.reason }
    : !policy.ok
      ? { ok: false, reason: policy.reason }
      : { ok: true, graph: graph.value, policy: policy.value };

  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? "",
    version: Number(workflow.version) || 1,
    status: workflow.status ?? "draft",
    updatedAt: workflow.updated_at,
    updatedAtLabel: formatAtlasTimestamp(workflow.updated_at),
    ...(workflow.default_reply === undefined
      ? {}
      : { defaultReply: workflow.default_reply as JsonObject | null }),
    graph: editable,
  };
}

export interface TriggerView {
  id: string;
  workflowDefinitionId: string;
  name: string;
  type: string;
  typeLabel: string;
  /** Atlas stores this as SQLite 1/0, so it is coerced here rather than at every call site. */
  enabled: boolean;
  /** The raw config object, kept intact so the trigger form can round-trip it. */
  config: JsonObject;
  /** A one-line human summary of `config`, derived and stored nowhere. */
  summary: string;
  lastFiredAt: string;
  nextFireAt: string;
  /** Present on the list route only; the by-id, create, and update routes omit it. */
  lastEventState: StatusView | null;
  lastEventError: string | null;
}

/** The six trigger types Atlas accepts (`atlas/workflows.py:59`). */
export const TRIGGER_TYPES = [
  "manual",
  "schedule",
  "webhook",
  "workflow_run_completed",
  "artifact_created",
  "worker_status_changed",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** The three types an operator may fire by hand (`atlas/app.py:774`). */
export const MANUALLY_FIREABLE_TRIGGER_TYPES: readonly string[] = ["manual", "schedule", "webhook"];

const TRIGGER_TYPE_LABELS: Record<string, string> = {
  manual: "Manual",
  schedule: "Schedule",
  webhook: "Webhook",
  workflow_run_completed: "Workflow run completed",
  artifact_created: "Artifact created",
  worker_status_changed: "Worker status changed",
};

function describeTriggerConfig(type: string, config: JsonObject): string {
  switch (type) {
    case "schedule": {
      if (typeof config.interval_minutes === "number") {
        return `Every ${config.interval_minutes} minute(s)`;
      }
      if (typeof config.daily_time === "string") return `Daily at ${config.daily_time}`;
      return "No schedule configured";
    }
    case "workflow_run_completed": {
      const parts = [
        typeof config.source_workflow_definition_id === "string"
          ? `from ${config.source_workflow_definition_id}`
          : null,
        typeof config.state === "string" ? `state ${config.state}` : null,
      ].filter(Boolean);
      return parts.length > 0 ? `Any run ${parts.join(", ")}` : "Any completed run";
    }
    case "artifact_created": {
      const parts = [
        typeof config.key === "string" ? `key ${config.key}` : null,
        typeof config.kind === "string" ? `kind ${config.kind}` : null,
        typeof config.source_workflow_definition_id === "string"
          ? `from ${config.source_workflow_definition_id}`
          : null,
      ].filter(Boolean);
      return parts.length > 0 ? `Artifact ${parts.join(", ")}` : "Any artifact";
    }
    case "worker_status_changed": {
      const parts = [
        typeof config.worker_id === "string" ? `worker ${config.worker_id}` : null,
        typeof config.status === "string" ? `status ${config.status}` : null,
      ].filter(Boolean);
      return parts.length > 0 ? parts.join(", ") : "Any worker status change";
    }
    case "webhook":
      return "Fired by POST to its Atlas fire endpoint";
    default:
      return "Fired by hand";
  }
}

export function toTriggerView(trigger: AtlasWorkflowTrigger): TriggerView {
  const config: JsonObject =
    trigger.config !== null && typeof trigger.config === "object"
      ? (trigger.config as JsonObject)
      : {};
  return {
    id: trigger.id,
    workflowDefinitionId: trigger.workflow_definition_id,
    name: trigger.name,
    type: trigger.type,
    typeLabel: TRIGGER_TYPE_LABELS[trigger.type] ?? trigger.type,
    enabled: Boolean(trigger.enabled),
    config,
    summary: describeTriggerConfig(trigger.type, config),
    lastFiredAt: formatAtlasTimestamp(trigger.last_fired_at),
    nextFireAt: formatAtlasTimestamp(trigger.next_fire_at),
    lastEventState: trigger.last_event_state ? toStatusView(trigger.last_event_state) : null,
    lastEventError: trigger.last_event_error ?? null,
  };
}

export interface DeliveryView {
  id: string;
  runId: string;
  url: string;
  status: StatusView;
  attempts: number;
  maxAttempts: number;
  /** True once Atlas will not retry on its own; the UI only then offers a manual retry. */
  attemptsExhausted: boolean;
  lastError: string | null;
  correlationId: string | null;
  createdAt: string;
  deliveredAt: string;
}

export function toDeliveryView(delivery: AtlasDelivery): DeliveryView {
  const attempts = Number(delivery.attempts) || 0;
  const maxAttempts = Number(delivery.max_attempts) || 0;
  return {
    id: delivery.id,
    runId: delivery.run_id,
    url: delivery.url,
    status: toStatusView(delivery.status),
    attempts,
    maxAttempts,
    attemptsExhausted: maxAttempts > 0 && attempts >= maxAttempts,
    lastError: delivery.last_error,
    correlationId: delivery.correlation_id,
    createdAt: formatAtlasTimestamp(delivery.created_at),
    deliveredAt: formatAtlasTimestamp(delivery.delivered_at),
  };
}

export interface ArtifactView {
  id: string;
  key: string;
  kind: string;
  /** Only a `file_ref` artifact has bytes behind `GET /api/artifacts/{id}/content`. */
  downloadable: boolean;
  filename: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  /** Inline content for the text-shaped kinds, already stringified. Null for `file_ref`. */
  preview: string | null;
  jobId: string | null;
  createdAt: string;
}

export function toArtifactView(artifact: AtlasArtifact): ArtifactView {
  const metadata =
    artifact.metadata !== null && typeof artifact.metadata === "object" ? artifact.metadata : {};
  const isFile = artifact.kind === "file_ref";
  return {
    id: artifact.id,
    key: artifact.key,
    kind: artifact.kind,
    downloadable: isFile,
    filename: typeof metadata.filename === "string" ? metadata.filename : null,
    mediaType: typeof metadata.media_type === "string" ? metadata.media_type : null,
    sizeBytes: typeof metadata.size === "number" ? metadata.size : null,
    preview: isFile
      ? null
      : typeof artifact.content === "string"
        ? artifact.content
        : JSON.stringify(artifact.content, null, 2),
    jobId: artifact.job_id,
    createdAt: formatAtlasTimestamp(artifact.created_at),
  };
}

export interface RunEventView {
  /** `run_id:seq` — stable and unique, unlike the autoincrement id across runs. */
  id: string;
  seq: number;
  type: string;
  nodeKey: string | null;
  detail: string | null;
  createdAt: string;
}

/**
 * Atlas's persisted run history, rendered as rows.
 *
 * The UI does not author narrative text for these: it shows Atlas's own `event_type` and the
 * payload it recorded. Inventing a sentence per event type is how a log stops matching what
 * actually happened.
 */
export function toRunEventView(event: AtlasWorkflowEvent): RunEventView {
  const payload = event.payload !== null && typeof event.payload === "object" ? event.payload : {};
  const keys = Object.keys(payload);
  return {
    id: `${event.run_id}:${event.seq}`,
    seq: Number(event.seq) || 0,
    type: event.event_type,
    nodeKey: event.node_key,
    detail: keys.length === 0 ? null : JSON.stringify(payload),
    createdAt: formatAtlasTimestamp(event.created_at),
  };
}

export interface RunEventPageView {
  events: RunEventView[];
  after: number;
  nextAfter: number;
  hasMore: boolean;
}

export function toRunEventPageView(page: AtlasWorkflowEventPage): RunEventPageView {
  return {
    events: page.events.map(toRunEventView),
    after: page.after,
    nextAfter: page.next_after,
    hasMore: page.has_more,
  };
}

// ---------------------------------------------------------------------------
// Operational-page view models (Phase 5)
// ---------------------------------------------------------------------------

export interface ConversationView {
  id: string;
  title: string;
  workspaceKey: string;
  company: string;
  preferredWorkerId: string | null;
  preferredWorkspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toConversationView(conversation: AtlasConversation): ConversationView {
  return {
    id: conversation.id,
    title: conversation.title || "Untitled",
    workspaceKey: conversation.workspace_key || "",
    company: conversation.company || "",
    preferredWorkerId: conversation.preferred_worker_id ?? null,
    preferredWorkspaceId: conversation.preferred_workspace_id ?? null,
    createdAt: formatAtlasTimestamp(conversation.created_at),
    updatedAt: formatAtlasTimestamp(conversation.updated_at),
  };
}

export interface UserAdminView {
  id: string;
  username: string;
  /** Raw Atlas value, kept for the edit form; `roleLabel` is the display form. */
  role: string;
  roleLabel: string;
  status: StatusView;
  disabled: boolean;
  /** Live (un-revoked) API tokens Atlas counts for this user. */
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toUserAdminView(user: AtlasUserListRow): UserAdminView {
  const role = String(user.role ?? "");
  return {
    id: user.id,
    username: user.username,
    role,
    // A role outside the known four renders as itself rather than crashing the lookup.
    roleLabel: (ROLE_LABELS as Record<string, string>)[role] ?? role,
    status: toStatusView(String(user.status ?? "")),
    disabled: user.status === "disabled",
    tokenCount: Number(user.token_count) || 0,
    createdAt: formatAtlasTimestamp(user.created_at),
    updatedAt: formatAtlasTimestamp(user.updated_at),
  };
}

/**
 * Token **metadata** only.
 *
 * Deliberately no field for a token value exists on this type, so the raw `api_token` a create
 * returns cannot ride along into the token list, the query cache, or anything persisted. The
 * raw value lives solely in the create dialog's transient component state.
 */
export interface ApiTokenView {
  id: string;
  userId: string;
  username: string;
  name: string;
  revoked: boolean;
  lastUsedAt: string;
  createdAt: string;
  revokedAt: string;
  purpose: "api" | "session";
  expiresAt: string | null;
  lifecycle: "active" | "expired" | "revoked";
}

export function toApiTokenView(token: AtlasApiToken): ApiTokenView {
  const revoked = token.revoked_at !== null && token.revoked_at !== undefined;
  const expired = token.expires_at !== null && Date.parse(token.expires_at) <= Date.now();
  return {
    id: token.id,
    userId: token.user_id,
    username: token.username,
    name: token.name || "(unnamed)",
    revoked,
    lastUsedAt: formatAtlasTimestamp(token.last_used_at),
    createdAt: formatAtlasTimestamp(token.created_at),
    revokedAt: formatAtlasTimestamp(token.revoked_at),
    purpose: token.purpose,
    expiresAt: token.expires_at,
    lifecycle: revoked ? "revoked" : expired ? "expired" : "active",
  };
}

export interface AuditEntryView {
  /** Atlas's integer autoincrement id, stringified for React keys. */
  id: string;
  action: string;
  actor: string;
  resourceType: string;
  resourceId: string;
  /** The row's `details` object as compact JSON, or null when Atlas recorded none. */
  detail: string | null;
  createdAt: string;
}

/** Rendered exactly as Atlas recorded it — the UI never synthesises an audit narrative. */
export function toAuditEntryView(entry: AtlasAuditEntry): AuditEntryView {
  const details = entry.details !== null && typeof entry.details === "object" ? entry.details : {};
  return {
    id: String(entry.id),
    action: entry.action,
    actor: entry.actor,
    resourceType: entry.resource_type,
    resourceId: entry.resource_id,
    detail: Object.keys(details).length === 0 ? null : JSON.stringify(details),
    createdAt: formatAtlasTimestamp(entry.created_at),
  };
}

export interface UsageEventView {
  id: string;
  kind: string;
  status: string;
  units: number;
  seconds: number | null;
  runId: string | null;
  jobId: string | null;
  nodeKey: string | null;
  workerId: string | null;
  actor: string;
  model: string;
  tokensPrompt: number | null;
  tokensOutput: number | null;
  /** Atlas's frozen per-event estimate, or null when the event carries none. Not a charge. */
  estimatedCostUsd: number | null;
  createdAt: string;
}

export function toUsageEventView(event: AtlasUsageEvent): UsageEventView {
  const metadata =
    event.metadata !== null && typeof event.metadata === "object" ? event.metadata : {};
  const estimated = metadata.estimated_cost_usd;
  return {
    id: event.id,
    kind: event.kind,
    status: event.status ?? "",
    units: Number(event.units) || 0,
    seconds: typeof event.seconds === "number" ? event.seconds : null,
    runId: event.run_id ?? null,
    jobId: event.job_id ?? null,
    nodeKey: event.node_key ?? null,
    workerId: event.worker_id ?? null,
    actor: event.actor ?? "",
    model: event.model ?? "",
    tokensPrompt: typeof event.tokens_prompt === "number" ? event.tokens_prompt : null,
    tokensOutput: typeof event.tokens_output === "number" ? event.tokens_output : null,
    estimatedCostUsd: typeof estimated === "number" ? estimated : null,
    createdAt: formatAtlasTimestamp(event.created_at),
  };
}

/** Period totals as Atlas computed them; every figure is Atlas's own, never re-derived. */
export interface UsageTotalsView {
  workflowRuns: number;
  successfulWorkflowRuns: number;
  jobs: number;
  budgetUnits: number;
  wallSeconds: number;
  jobWallSeconds: number;
  tokensPrompt: number;
  tokensOutput: number;
  estimatedCostUsd: number;
}

function toUsageTotalsView(totals: AtlasUsageTotals): UsageTotalsView {
  return {
    workflowRuns: Number(totals.workflow_runs) || 0,
    successfulWorkflowRuns: Number(totals.successful_workflow_runs) || 0,
    jobs: Number(totals.jobs) || 0,
    budgetUnits: Number(totals.budget_units) || 0,
    wallSeconds: Number(totals.wall_seconds) || 0,
    jobWallSeconds: Number(totals.job_wall_seconds) || 0,
    tokensPrompt: Number(totals.tokens_prompt) || 0,
    tokensOutput: Number(totals.tokens_output) || 0,
    estimatedCostUsd: Number(totals.estimated_cost_usd) || 0,
  };
}

/**
 * `GET /api/usage` for the UI.
 *
 * Events come back **newest first** (Atlas orders the ledger ascending; the reversal happens
 * here, once) so the page's bounded rendering shows the most recent slice of the range.
 */
export interface UsageView {
  events: UsageEventView[];
  eventCount: number;
  totals: UsageTotalsView;
  from: string | null;
  to: string | null;
}

export function toUsageView(response: AtlasUsageResponse): UsageView {
  const events = response.usage.map(toUsageEventView).reverse();
  return {
    events,
    eventCount: events.length,
    totals: toUsageTotalsView(response.totals),
    from: response.from ?? null,
    to: response.to ?? null,
  };
}
