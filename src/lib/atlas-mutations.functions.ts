/**
 * The Atlas mutation RPC boundary (Phase 3).
 *
 * Everything the read boundary promises holds here too, and one thing more:
 *
 *  1. Every function validates the flow-designer session itself, via `requireAtlasToken()`.
 *     These endpoints are reachable directly over HTTP; a route `beforeLoad` proves nothing.
 *  2. Every function calls one *typed, fixed* Atlas operation. No path, method, or query key
 *     comes from the caller.
 *  3. Nothing here authorises. Atlas re-checks the real role on every call and a 403 comes
 *     back to the UI as a 403.
 *  4. **New for mutations:** the semantic payload is re-validated *server-side* before it
 *     reaches Atlas. The editor validates too, but the editor is not the trust boundary — a
 *     direct POST to this endpoint bypasses it entirely. Re-parsing here is what actually
 *     guarantees the "unknown node or condition type is never sent to Atlas" rule, because it
 *     is the last code that runs before the request leaves.
 *
 * CSRF is covered by `createCsrfMiddleware()` in `src/start.ts`, which filters on
 * `handlerType === "serverFn"` and therefore applies to every function below.
 *
 * Nothing here retries. Atlas has no idempotency key, so an automatic retry of "start this
 * workflow" is how a run happens twice. Retry is the user's explicit choice.
 */

import { createServerFn } from "@tanstack/react-start";

import {
  atlasCancelJob,
  atlasCreateApiToken,
  atlasCreateConversation,
  atlasCreateUser,
  atlasCreateWorkflow,
  atlasCreateWorkflowTrigger,
  atlasDecideApproval,
  atlasDeleteUser,
  atlasDeleteWorkflow,
  atlasDeleteWorkflowTrigger,
  atlasDeleteWorker,
  atlasDeleteWorkspace,
  atlasDeliverRun,
  atlasFireWorkflowTrigger,
  atlasGetWorkflow,
  atlasListApprovals,
  atlasListDeliveries,
  atlasListRunArtifacts,
  atlasListRunEvents,
  atlasListWorkflowTriggers,
  atlasPollAllWorkers,
  atlasPollWorker,
  atlasRenameApiToken,
  atlasRetryDelivery,
  atlasRevokeApiToken,
  atlasRunAction,
  atlasStartWorkflowRun,
  atlasUpdateUser,
  atlasUpdateWorkflow,
  atlasUpdateWorkflowTrigger,
  atlasUpsertWorker,
  atlasUpsertWorkspace,
  atlasValidateWorkflow,
  AtlasError,
  type AtlasRunAction,
} from "./atlas-api.server";
import { clampAtlasLimit } from "./atlas-limits";
import {
  toApiTokenView,
  toApprovalView,
  toArtifactView,
  toClientAtlasError,
  toConversationView,
  toDeliveryView,
  toRunEventPageView,
  toRunView,
  toTriggerView,
  toWorkerView,
  toWorkflowEditableView,
  toWorkflowView,
  toWorkspaceView,
  TRIGGER_TYPES,
  type ApiTokenView,
  type ApprovalView,
  type ClientAtlasError,
  type ArtifactView,
  type ConversationView,
  type DeliveryView,
  type RunEventPageView,
  type RunView,
  type TriggerView,
  type WorkerView,
  type WorkflowEditableView,
  type WorkflowView,
  type WorkspaceView,
} from "./atlas-mappers";
import { ATLAS_ROLES, ATLAS_USER_STATUSES } from "./atlas-types";
import { clearSession, requireAtlasToken } from "./auth.server";
import { currentRequestSignal } from "./request-signal.server";
import type { AtlasResult } from "./atlas-reads.functions";
import {
  parseWorkflowGraph,
  parseWorkflowPolicy,
  serializeWorkflowGraph,
  serializeWorkflowPolicy,
  validateWorkflow,
  type ValidationIssue,
} from "./workflow-graph";

/**
 * Runs a mutation, converting any Atlas failure into the serialisable result shape.
 *
 * Identical in spirit to the read boundary's `read()`, including clearing the session on 401 —
 * a mutation is just as likely to be the request that discovers a revoked bearer.
 */
async function mutate<T>(operation: (token: string) => Promise<T>): Promise<AtlasResult<T>> {
  try {
    const token = await requireAtlasToken();
    return { ok: true, data: await operation(token) };
  } catch (error) {
    const clientError = toClientAtlasError(error);
    if (clientError.kind === "unauthorized") {
      await clearSession();
    }
    return { ok: false, error: clientError };
  }
}

// ---------------------------------------------------------------------------
// Input validation at the trust boundary.
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4_000;
/** Bounds the JSON a single request may carry, so a malformed client cannot post a novel. */
const MAX_GRAPH_BYTES = 512_000;

function field(data: unknown, key: string): unknown {
  return data === null || typeof data !== "object"
    ? undefined
    : (data as Record<string, unknown>)[key];
}

function requiredId(data: unknown, key: string): string {
  const value = field(data, key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required.`);
  }
  if (value.length > MAX_ID_LENGTH) throw new Error(`${key} is too long.`);
  return value;
}

function optionalId(data: unknown, key: string): string | undefined {
  const value = field(data, key);
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  if (value.length > MAX_ID_LENGTH) throw new Error(`${key} is too long.`);
  return value;
}

function requiredName(data: unknown, key: string): string {
  const value = field(data, key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required.`);
  }
  if (value.length > MAX_NAME_LENGTH) throw new Error(`${key} is too long.`);
  return value.trim();
}

function optionalText(data: unknown, key: string, max: number): string {
  const value = field(data, key);
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  if (value.length > max) throw new Error(`${key} is too long.`);
  return value;
}

function requiredLimit(data: unknown): number {
  const raw = field(data, "limit");
  if (raw === undefined || raw === null) return clampAtlasLimit(undefined);
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) throw new Error("limit must be a number.");
  return clampAtlasLimit(parsed);
}

function optionalPositiveInteger(data: unknown, key: string): number | undefined {
  const value = field(data, key);
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${key} must be a non-negative integer.`);
  return parsed;
}

function optionalFutureUtc(data: unknown, key: string): string | undefined {
  const value = field(data, key);
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${key} must be an ISO timestamp with an explicit UTC offset.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error(`${key} must be in the future.`);
  }
  return value;
}

function plainObject(data: unknown, key: string): Record<string, unknown> {
  const value = field(data, key);
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * The one place a client-supplied graph becomes a payload Atlas may see.
 *
 * Parsing rejects any node type, condition type, or field Atlas's schema does not declare;
 * validating then applies every rule Atlas's own validator applies. Only the re-serialised
 * result is sent — so even a caller that hand-crafts a request cannot slip a React Flow
 * `position`, an editor colour, or a `condition` pseudo-node past this line.
 */
interface AcceptedGraph {
  graph: Record<string, unknown>;
  policy: Record<string, unknown>;
}

class GraphRejected extends Error {
  readonly issues: ValidationIssue[];
  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "GraphRejected";
    this.issues = issues;
  }
}

/**
 * Runs in the *handler*, not the validator.
 *
 * That placement is load-bearing. `createServerFn`'s validator runs before the handler and
 * outside it, so a throw from a validator is serialised by the framework as a 500 — it never
 * reaches `saveMutation`, and therefore never becomes the `{kind: "validation", rejection}`
 * result the editor needs to anchor each problem to its node. Validating here keeps the trust
 * boundary exactly as strong (this is still the last code that runs before the request leaves,
 * and it is still server-side) while letting the rejection travel back as data.
 */
function acceptGraph(rawGraph: unknown, rawPolicy: unknown): AcceptedGraph {
  if (JSON.stringify(rawGraph ?? null).length > MAX_GRAPH_BYTES) {
    throw new GraphRejected("The workflow graph is too large.");
  }

  const graph = parseWorkflowGraph(rawGraph);
  if (!graph.ok) throw new GraphRejected(graph.reason);

  const policy = parseWorkflowPolicy(rawPolicy ?? {});
  if (!policy.ok) throw new GraphRejected(policy.reason);

  const issues = validateWorkflow(graph.value, policy.value);
  if (issues.length > 0) {
    throw new GraphRejected(issues[0]!.message, issues);
  }

  return {
    graph: serializeWorkflowGraph(graph.value),
    policy: serializeWorkflowPolicy(policy.value),
  };
}

/**
 * Turns a rejected graph into a `validation` failure the UI can anchor to a node or edge.
 *
 * Atlas raises one `ValueError` at a time and returns it as a single string, so if this ran
 * server-side only the user would fix one problem per round trip. Local validation returns the
 * whole list, and the issue targets travel back so each lands on the thing that is wrong.
 */
export interface GraphRejection {
  message: string;
  issues: ValidationIssue[];
}

export type SaveResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { kind: "validation"; message: string }; rejection: GraphRejection }
  | { ok: false; error: ClientAtlasError; rejection?: undefined };

async function saveMutation<T>(build: (token: string) => Promise<T>): Promise<SaveResult<T>> {
  try {
    const token = await requireAtlasToken();
    return { ok: true, data: await build(token) };
  } catch (error) {
    if (error instanceof GraphRejected) {
      return {
        ok: false,
        error: { kind: "validation", message: error.message },
        rejection: { message: error.message, issues: error.issues },
      };
    }
    const clientError = toClientAtlasError(error);
    if (clientError.kind === "unauthorized") {
      await clearSession();
    }
    return { ok: false, error: clientError };
  }
}

// ---------------------------------------------------------------------------
// Reads the mutation surfaces depend on.
//
// These are safe reads, so like the read boundary they carry the incoming request's abort
// signal (Phase 6): a navigation that cancels the RPC cancels the Atlas fetch too. The
// mutations below deliberately do NOT — Atlas may have accepted a side effect already, and
// an auto-cancelled response would report the action as not-taken.
// ---------------------------------------------------------------------------

/** `GET /api/workflows/{id}`, parsed into the editor's semantic model (or a refusal). */
export const getEditableWorkflowFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => requiredId(data, "workflowId"))
  .handler(
    async ({ data: workflowId }): Promise<AtlasResult<WorkflowEditableView>> =>
      mutate(async (token) =>
        toWorkflowEditableView(
          await atlasGetWorkflow(token, workflowId, { signal: currentRequestSignal() }),
        ),
      ),
  );

/** `GET /api/workflow-triggers?limit=&workflow_definition_id=`. */
export const listTriggersFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => ({
    limit: requiredLimit(data),
    workflowDefinitionId: optionalId(data, "workflowDefinitionId"),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<TriggerView[]>> =>
      mutate(async (token) =>
        (await atlasListWorkflowTriggers(token, data, { signal: currentRequestSignal() })).map(
          toTriggerView,
        ),
      ),
  );

/** `GET /api/approvals?limit=&state=&run_id=` — the untruncated list a run detail cannot give. */
export const listApprovalsFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const state = field(data, "state");
    if (state !== undefined && state !== null && typeof state !== "string") {
      throw new Error("state must be a string.");
    }
    return {
      limit: requiredLimit(data),
      state: (state as string | undefined) || undefined,
      runId: optionalId(data, "runId"),
    };
  })
  .handler(
    async ({ data }): Promise<AtlasResult<ApprovalView[]>> =>
      mutate(async (token) =>
        (await atlasListApprovals(token, data, { signal: currentRequestSignal() })).map(
          toApprovalView,
        ),
      ),
  );

/** `GET /api/deliveries?limit=&run_id=&status=`. Requires the `deliveries.read` permission. */
export const listDeliveriesFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    const status = field(data, "status");
    if (status !== undefined && status !== null && typeof status !== "string") {
      throw new Error("status must be a string.");
    }
    return {
      limit: requiredLimit(data),
      runId: optionalId(data, "runId"),
      status: (status as string | undefined) || undefined,
    };
  })
  .handler(
    async ({ data }): Promise<AtlasResult<DeliveryView[]>> =>
      mutate(async (token) =>
        (await atlasListDeliveries(token, data, { signal: currentRequestSignal() })).map(
          toDeliveryView,
        ),
      ),
  );

/** `GET /api/workflow-runs/{id}/artifacts` — the full set; Atlas does not truncate this one. */
export const listRunArtifactsFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => requiredId(data, "runId"))
  .handler(
    async ({ data: runId }): Promise<AtlasResult<ArtifactView[]>> =>
      mutate(async (token) =>
        (await atlasListRunArtifacts(token, runId, { signal: currentRequestSignal() })).map(
          toArtifactView,
        ),
      ),
  );

/** `GET /api/workflow-runs/{id}/events?after=&limit=` — persisted history cursor page. */
export const listRunEventsFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => ({
    runId: requiredId(data, "runId"),
    limit: requiredLimit(data),
    after: optionalPositiveInteger(data, "after") ?? 0,
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<RunEventPageView>> =>
      mutate(async (token) =>
        toRunEventPageView(
          await atlasListRunEvents(
            token,
            data.runId,
            { limit: data.limit, after: data.after },
            { signal: currentRequestSignal() },
          ),
        ),
      ),
  );

// ---------------------------------------------------------------------------
// Workflow definition mutations.
// ---------------------------------------------------------------------------

export const createWorkflowFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    name: requiredName(data, "name"),
    description: optionalText(data, "description", MAX_DESCRIPTION_LENGTH),
    graph: field(data, "graph"),
    policy: field(data, "policy"),
  }))
  .handler(
    async ({ data }): Promise<SaveResult<WorkflowView>> =>
      saveMutation(async (token) => {
        const accepted = acceptGraph(data.graph, data.policy);
        return toWorkflowView(
          await atlasCreateWorkflow(token, {
            name: data.name,
            description: data.description,
            graph: accepted.graph,
            policy: accepted.policy,
          }),
        );
      }),
  );

/**
 * `PUT /api/workflows/{id}` with a lost-update guard.
 *
 * Atlas has no ETag, no `If-Match`, and no server-incremented version — a plain PUT is
 * last-writer-wins, so two operators editing the same workflow silently lose one edit. The
 * guard is the best a client can do without backend support: re-read the row inside the same
 * request and refuse when its server-set `updated_at` has moved since the editor loaded it.
 *
 * ponytail: there is still a millisecond-scale window between the re-read and the PUT. Closing
 * it properly needs a conditional write in Atlas (tracked in `docs/ATLAS_LIMITATIONS.md`);
 * this turns the common case — a tab left open for minutes — from silent loss into a visible
 * conflict, which is the failure mode that actually happens.
 */
export const saveWorkflowFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    workflowId: requiredId(data, "workflowId"),
    name: requiredName(data, "name"),
    description: optionalText(data, "description", MAX_DESCRIPTION_LENGTH),
    expectedUpdatedAt: optionalId(data, "expectedUpdatedAt"),
    graph: field(data, "graph"),
    policy: field(data, "policy"),
  }))
  .handler(
    async ({ data }): Promise<SaveResult<WorkflowEditableView>> =>
      saveMutation(async (token) => {
        const accepted = acceptGraph(data.graph, data.policy);
        if (data.expectedUpdatedAt !== undefined) {
          const current = await atlasGetWorkflow(token, data.workflowId);
          if (current.updated_at !== data.expectedUpdatedAt) {
            throw new AtlasError(
              "conflict",
              "This workflow changed in Atlas since you opened it. Reload to see the current version before saving.",
              { status: 409 },
            );
          }
        }
        return toWorkflowEditableView(
          await atlasUpdateWorkflow(token, data.workflowId, {
            name: data.name,
            description: data.description,
            graph: accepted.graph,
            policy: accepted.policy,
          }),
        );
      }),
  );

export const deleteWorkflowFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "workflowId"))
  .handler(
    async ({ data: workflowId }): Promise<AtlasResult<{ deleted: true }>> =>
      mutate(async (token) => {
        await atlasDeleteWorkflow(token, workflowId);
        return { deleted: true as const };
      }),
  );

/**
 * `POST /api/workflows/{id}/validate` — the checks only Atlas can do.
 *
 * Local validation covers every structural rule; what it cannot cover is
 * `validate_workflow_references`, which resolves `worker_id`, `workspace_id`, and the policy
 * allow-lists against Atlas's own tables. That is why this exists as a separate action and why
 * it needs a *saved* workflow id — Atlas looks the row up before validating the candidate.
 */
export const validateWorkflowFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    workflowId: requiredId(data, "workflowId"),
    graph: field(data, "graph"),
    policy: field(data, "policy"),
  }))
  .handler(
    async ({ data }): Promise<SaveResult<{ valid: true }>> =>
      saveMutation(async (token) => {
        const accepted = acceptGraph(data.graph, data.policy);
        await atlasValidateWorkflow(token, data.workflowId, {
          graph: accepted.graph,
          policy: accepted.policy,
        });
        return { valid: true as const };
      }),
  );

// ---------------------------------------------------------------------------
// Run lifecycle.
// ---------------------------------------------------------------------------

/** `POST /api/workflow-runs` — 202 with a real Atlas run id. No timers, no simulation. */
export const startRunFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    workflowDefinitionId: requiredId(data, "workflowDefinitionId"),
    input: plainObject(data, "input"),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<RunView>> =>
      mutate(async (token) => toRunView(await atlasStartWorkflowRun(token, data))),
  );

const RUN_ACTIONS: readonly AtlasRunAction[] = ["pause", "resume", "cancel"];

/**
 * `POST /api/workflow-runs/{id}/{pause|resume|cancel}`.
 *
 * `retryInterrupted` is required to resume a run in `recovery_required` and is never defaulted
 * on: Atlas marks a run that way when the control plane restarted mid-node, and a retry can
 * duplicate work a remote worker may still be doing. The UI has to ask, and this endpoint only
 * forwards an explicit `true`.
 */
export const runActionFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const action = field(data, "action");
    if (typeof action !== "string" || !RUN_ACTIONS.includes(action as AtlasRunAction)) {
      throw new Error("action must be pause, resume, or cancel.");
    }
    return {
      runId: requiredId(data, "runId"),
      action: action as AtlasRunAction,
      retryInterrupted: field(data, "retryInterrupted") === true,
    };
  })
  .handler(
    async ({ data }): Promise<AtlasResult<RunView>> =>
      mutate(async (token) =>
        toRunView(
          await atlasRunAction(token, data.runId, data.action, {
            retryInterrupted: data.retryInterrupted,
          }),
        ),
      ),
  );

/** `POST /api/workflow-runs/{id}/deliver` — only a succeeded or failed run is deliverable. */
export const deliverRunFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "runId"))
  .handler(
    async ({ data: runId }): Promise<AtlasResult<DeliveryView>> =>
      mutate(async (token) => toDeliveryView(await atlasDeliverRun(token, runId))),
  );

/**
 * `POST /api/approvals/{id}/{approve|reject|choose}`.
 *
 * Atlas rejects `approve` on a gate that declares choices, and `choose` on one that does not,
 * so the caller picks from the approval row rather than guessing.
 */
export const decideApprovalFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const decision = field(data, "decision");
    const approvalId = requiredId(data, "approvalId");
    if (decision === "approve" || decision === "reject") {
      return { approvalId, decision: { kind: decision } as const };
    }
    if (decision === "choose") {
      const choice = field(data, "choice");
      if (typeof choice !== "string" || choice.trim().length === 0) {
        throw new Error("choice is required.");
      }
      if (choice.length > MAX_ID_LENGTH) throw new Error("choice is too long.");
      return { approvalId, decision: { kind: "choose", choice } as const };
    }
    throw new Error("decision must be approve, reject, or choose.");
  })
  .handler(
    async ({ data }): Promise<AtlasResult<{ approval: ApprovalView; run: RunView }>> =>
      mutate(async (token) => {
        const result = await atlasDecideApproval(token, data.approvalId, data.decision);
        return { approval: toApprovalView(result.approval), run: toRunView(result.run) };
      }),
  );

/** `POST /api/deliveries/{id}/retry` — Atlas resets the row to pending and attempts once. */
export const retryDeliveryFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "deliveryId"))
  .handler(
    async ({ data: deliveryId }): Promise<AtlasResult<DeliveryView>> =>
      mutate(async (token) => toDeliveryView(await atlasRetryDelivery(token, deliveryId))),
  );

// ---------------------------------------------------------------------------
// Triggers.
// ---------------------------------------------------------------------------

/**
 * Validates a trigger draft against Atlas's rules *before* it is sent.
 *
 * The one rule Atlas states twice and the UI must not get wrong: a schedule config carries
 * `interval_minutes` **or** `daily_time`, never both and never neither. Atlas's own validator
 * accepts both keys and silently prefers `interval_minutes` (`atlas/workflows.py:1860-1891`),
 * while the published schema declares them a `oneOf`. The schema is the contract, so a config
 * with both is rejected here rather than saved with a field that will never take effect.
 */
function acceptTriggerConfig(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (type !== "schedule") return config;

  const hasInterval = config.interval_minutes !== undefined && config.interval_minutes !== null;
  const hasDaily = config.daily_time !== undefined && config.daily_time !== null;

  if (hasInterval && hasDaily) {
    throw new Error("A schedule uses either an interval or a daily time, not both.");
  }
  if (!hasInterval && !hasDaily) {
    throw new Error("A schedule needs either an interval or a daily time.");
  }
  if (hasInterval) {
    const minutes = Number(config.interval_minutes);
    // Atlas's floor: below 1/60 the next fire time never advances past its 1-second resolution.
    if (!Number.isFinite(minutes) || minutes < 1 / 60) {
      throw new Error("The interval must be at least one second (1/60 of a minute).");
    }
    return { interval_minutes: minutes };
  }
  const daily = config.daily_time;
  if (typeof daily !== "string" || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(daily)) {
    throw new Error("The daily time must be HH:MM, between 00:00 and 23:59.");
  }
  return { daily_time: daily };
}

function acceptTriggerType(data: unknown): string {
  const type = field(data, "type");
  if (typeof type !== "string" || !(TRIGGER_TYPES as readonly string[]).includes(type)) {
    throw new Error("type must be one of the trigger types Atlas supports.");
  }
  return type;
}

export const createTriggerFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const type = acceptTriggerType(data);
    return {
      workflowDefinitionId: requiredId(data, "workflowDefinitionId"),
      name: requiredName(data, "name"),
      type,
      enabled: field(data, "enabled") === true,
      config: acceptTriggerConfig(type, plainObject(data, "config")),
    };
  })
  .handler(
    async ({ data }): Promise<AtlasResult<TriggerView>> =>
      mutate(async (token) => toTriggerView(await atlasCreateWorkflowTrigger(token, data))),
  );

/**
 * `PUT /api/workflow-triggers/{id}` — the full-edit path.
 *
 * Enable/disable has its own function below, because Atlas treats the two differently: sending
 * `type` or `config` makes it recompute `next_fire_at`, whereas a bare `{enabled}` preserves
 * the schedule slot the trigger already holds (`atlas/app.py:802-806`). Flipping a switch must
 * not silently reschedule a daily trigger.
 */
export const updateTriggerFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const type = acceptTriggerType(data);
    return {
      triggerId: requiredId(data, "triggerId"),
      name: requiredName(data, "name"),
      type,
      enabled: field(data, "enabled") === true,
      config: acceptTriggerConfig(type, plainObject(data, "config")),
    };
  })
  .handler(
    async ({ data }): Promise<AtlasResult<TriggerView>> =>
      mutate(async (token) =>
        toTriggerView(
          await atlasUpdateWorkflowTrigger(token, data.triggerId, {
            name: data.name,
            type: data.type,
            enabled: data.enabled,
            config: data.config,
          }),
        ),
      ),
  );

/** `PUT /api/workflow-triggers/{id}` with `{enabled}` only — Atlas has no dedicated route. */
export const setTriggerEnabledFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const enabled = field(data, "enabled");
    if (typeof enabled !== "boolean") throw new Error("enabled must be true or false.");
    return { triggerId: requiredId(data, "triggerId"), enabled };
  })
  .handler(
    async ({ data }): Promise<AtlasResult<TriggerView>> =>
      mutate(async (token) =>
        toTriggerView(
          await atlasUpdateWorkflowTrigger(token, data.triggerId, { enabled: data.enabled }),
        ),
      ),
  );

export const deleteTriggerFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "triggerId"))
  .handler(
    async ({ data: triggerId }): Promise<AtlasResult<{ deleted: true }>> =>
      mutate(async (token) => {
        await atlasDeleteWorkflowTrigger(token, triggerId);
        return { deleted: true as const };
      }),
  );

/** `POST /api/workflow-triggers/{id}/fire` — manual, schedule, and webhook triggers only. */
export const fireTriggerFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    triggerId: requiredId(data, "triggerId"),
    payload: plainObject(data, "payload"),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<{ fired: true }>> =>
      mutate(async (token) => {
        await atlasFireWorkflowTrigger(token, data.triggerId, { payload: data.payload });
        return { fired: true as const };
      }),
  );

// ---------------------------------------------------------------------------
// Fleet: workers and workspaces.
// ---------------------------------------------------------------------------

/**
 * `POST /api/workers` — an upsert, so this is both "add" and "edit".
 *
 * Atlas matches on `id` **or** `base_url` (`atlas/db.py:1966`), which means adding a worker at
 * a URL that already exists edits that worker instead of creating a second one. The UI says so
 * before submitting rather than letting the operator discover it afterwards.
 *
 * `token` is forwarded only when non-empty: Atlas preserves the stored credential for a blank
 * one, which is what lets an operator rename a worker without ever seeing its secret.
 */
export const upsertWorkerFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const baseUrl = field(data, "baseUrl");
    if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
      throw new Error("baseUrl is required.");
    }
    let parsed: URL;
    try {
      parsed = new URL(baseUrl.trim());
    } catch {
      throw new Error("baseUrl must be a URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("baseUrl must be http or https.");
    }
    const tags = field(data, "tags");
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) {
      throw new Error("tags must be an array of strings.");
    }
    const workerToken = field(data, "token");
    if (workerToken !== undefined && workerToken !== null && typeof workerToken !== "string") {
      throw new Error("token must be a string.");
    }
    return {
      id: optionalId(data, "workerId"),
      name: requiredName(data, "name"),
      base_url: parsed.toString(),
      role: optionalText(data, "role", MAX_NAME_LENGTH),
      tags: (tags as string[] | undefined) ?? [],
      token: (workerToken as string | undefined) || undefined,
    };
  })
  .handler(
    async ({ data }): Promise<AtlasResult<WorkerView>> =>
      mutate(async (token) => toWorkerView(await atlasUpsertWorker(token, data))),
  );

/**
 * `DELETE /api/workers/{id}`.
 *
 * Atlas refuses a worker with job history, but a worker with workspaces and no jobs deletes
 * silently and cascades every workspace row with it (`atlas/db.py:211`). The caller must have
 * shown that consequence before reaching here.
 */
export const deleteWorkerFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "workerId"))
  .handler(
    async ({ data: workerId }): Promise<AtlasResult<{ deleted: true }>> =>
      mutate(async (token) => {
        await atlasDeleteWorker(token, workerId);
        return { deleted: true as const };
      }),
  );

/** `POST /api/workers/{id}/poll` — refreshes one worker's capability snapshot. */
export const pollWorkerFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "workerId"))
  .handler(
    async ({ data: workerId }): Promise<AtlasResult<WorkerView>> =>
      mutate(async (token) => toWorkerView(await atlasPollWorker(token, workerId))),
  );

/** `POST /api/workers/poll` — Atlas polls every worker sequentially, so this is slow by nature. */
export const pollAllWorkersFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<AtlasResult<WorkerView[]>> =>
    mutate(async (token) => (await atlasPollAllWorkers(token)).map(toWorkerView)),
);

/** `POST /api/workspaces` — also an upsert, matched on id or `(worker_id, workspace_key)`. */
export const upsertWorkspaceFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const tags = field(data, "tags");
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) {
      throw new Error("tags must be an array of strings.");
    }
    return {
      id: optionalId(data, "workspaceId"),
      worker_id: requiredId(data, "workerId"),
      workspace_key: requiredName(data, "workspaceKey"),
      workspace_dir: requiredName(data, "workspaceDir"),
      company: optionalText(data, "company", MAX_NAME_LENGTH),
      tags: (tags as string[] | undefined) ?? [],
    };
  })
  .handler(
    async ({ data }): Promise<AtlasResult<WorkspaceView>> =>
      mutate(async (token) => {
        const workspace = await atlasUpsertWorkspace(token, data);
        // The by-id shape has no joined worker name/status, so those render as unknown until
        // the workspace list refetches. Inventing them here would be a lie about Atlas state.
        return toWorkspaceView({ ...workspace, worker_name: "", worker_status: "unknown" });
      }),
  );

/** `DELETE /api/workspaces/{id}` — jobs that referenced it keep a null `workspace_id`. */
export const deleteWorkspaceFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "workspaceId"))
  .handler(
    async ({ data: workspaceId }): Promise<AtlasResult<{ deleted: true }>> =>
      mutate(async (token) => {
        await atlasDeleteWorkspace(token, workspaceId);
        return { deleted: true as const };
      }),
  );

/** `POST /api/jobs/{id}/cancel` — the returned state is `cancel_requested`, not `cancelled`. */
export const cancelJobFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "jobId"))
  .handler(
    async ({ data: jobId }): Promise<AtlasResult<{ state: string }>> =>
      mutate(async (token) => ({ state: (await atlasCancelJob(token, jobId)).state })),
  );

// ---------------------------------------------------------------------------
// Operational-page mutations (Phase 5).
//
// Atlas alone authorises these: conversations need `resources.manage`, users and tokens need
// `admin`. The UI hides the buttons for other roles as a UX courtesy, but a direct call still
// lands here, goes to Atlas, and comes back 403.
// ---------------------------------------------------------------------------

/** `POST /api/conversations` — 201. Requires `resources.manage` (admin/operator). */
export const createConversationFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    title: requiredName(data, "title"),
    workspaceKey: optionalText(data, "workspaceKey", MAX_NAME_LENGTH),
    company: optionalText(data, "company", MAX_NAME_LENGTH),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<ConversationView>> =>
      mutate(async (token) =>
        toConversationView(
          await atlasCreateConversation(token, {
            title: data.title,
            workspace_key: data.workspaceKey,
            company: data.company,
          }),
        ),
      ),
  );

/** Validates a role/status pair against Atlas's closed sets before anything leaves. */
function requiredRole(data: unknown): string {
  const value = field(data, "role");
  if (typeof value !== "string" || !(ATLAS_ROLES as readonly string[]).includes(value)) {
    throw new Error(`role must be one of: ${ATLAS_ROLES.join(", ")}.`);
  }
  return value;
}

function requiredUserStatus(data: unknown): string {
  const value = field(data, "status");
  if (typeof value !== "string" || !(ATLAS_USER_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`status must be one of: ${ATLAS_USER_STATUSES.join(", ")}.`);
  }
  return value;
}

/**
 * Password input: required or optional, bounded, and never echoed.
 *
 * The error text names the rule only — a password must never appear in a thrown message, a
 * log, or a serialised response.
 */
const MAX_PASSWORD_LENGTH = 1024;

function requiredPassword(data: unknown): string {
  const value = field(data, "password");
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("password is required.");
  }
  if (value.length > MAX_PASSWORD_LENGTH) throw new Error("password is too long.");
  return value;
}

function optionalPassword(data: unknown): string | undefined {
  const value = field(data, "password");
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("password must be a string.");
  if (value.length > MAX_PASSWORD_LENGTH) throw new Error("password is too long.");
  return value;
}

/** `POST /api/users` — 201, admin only. "Create user": Atlas has no invitation contract. */
export const createUserFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    username: requiredName(data, "username"),
    password: requiredPassword(data),
    role: requiredRole(data),
    status: requiredUserStatus(data),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<{ id: string; username: string }>> =>
      mutate(async (token) => {
        const user = await atlasCreateUser(token, data);
        return { id: user.id, username: user.username };
      }),
  );

/**
 * `PUT /api/users/{id}` — a partial update, admin only. Only the fields the caller supplied
 * are sent, matching Atlas's own partial-PUT semantics.
 */
export const updateUserFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const patch: {
      userId: string;
      username?: string;
      password?: string;
      role?: string;
      status?: string;
    } = { userId: requiredId(data, "userId") };
    if (field(data, "username") !== undefined) patch.username = requiredName(data, "username");
    const password = optionalPassword(data);
    if (password !== undefined) patch.password = password;
    if (field(data, "role") !== undefined) patch.role = requiredRole(data);
    if (field(data, "status") !== undefined) patch.status = requiredUserStatus(data);
    return patch;
  })
  .handler(
    async ({ data }): Promise<AtlasResult<{ id: string; username: string }>> =>
      mutate(async (token) => {
        const { userId, ...patch } = data;
        const user = await atlasUpdateUser(token, userId, patch);
        return { id: user.id, username: user.username };
      }),
  );

/** `DELETE /api/users/{id}` — admin only. Cascades the user's API tokens; the UI says so. */
export const deleteUserFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "userId"))
  .handler(
    async ({ data: userId }): Promise<AtlasResult<{ deleted: true }>> =>
      mutate(async (token) => {
        await atlasDeleteUser(token, userId);
        return { deleted: true as const };
      }),
  );

/**
 * `POST /api/tokens` — 201, admin only. Returns the metadata view **and** the raw token.
 *
 * The raw value is allowed to reach the browser here, and only here, as the direct result of
 * an explicit admin action — Atlas can never show it again. The client keeps it in transient
 * dialog state only: this function's result must not be fed into a TanStack Query or mutation
 * cache, storage, a URL, or anything persisted (see `useMintApiToken` in `atlas-mutations.ts`).
 */
export const createApiTokenFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    userId: requiredId(data, "userId"),
    name: requiredName(data, "name"),
    expiresAt: optionalFutureUtc(data, "expiresAt"),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<{ token: ApiTokenView; apiToken: string }>> =>
      mutate(async (token) => {
        const created = await atlasCreateApiToken(token, data);
        return { token: toApiTokenView(created.token), apiToken: created.api_token };
      }),
  );

/** `PUT /api/tokens/{id}` — rename, admin only. */
export const renameApiTokenFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => ({
    tokenId: requiredId(data, "tokenId"),
    name: requiredName(data, "name"),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<ApiTokenView>> =>
      mutate(async (token) =>
        toApiTokenView(await atlasRenameApiToken(token, data.tokenId, data.name)),
      ),
  );

/**
 * `DELETE /api/tokens/{id}` — revoke, admin only. The one fixed revocation operation this
 * client uses; Atlas's `POST …/revoke` alias is deliberately not wired.
 */
export const revokeApiTokenFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => requiredId(data, "tokenId"))
  .handler(
    async ({ data: tokenId }): Promise<AtlasResult<{ revoked: true }>> =>
      mutate(async (token) => {
        await atlasRevokeApiToken(token, tokenId);
        return { revoked: true as const };
      }),
  );
