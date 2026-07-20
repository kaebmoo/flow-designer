/**
 * Read-only Atlas RPC boundary (Phase 2).
 *
 * `createServerFn` bodies are replaced by a network call in the browser bundle, so routes,
 * components, and hooks may import this module statically — the server-only code it calls
 * never ships. A dynamic import would defeat that transform.
 *
 * Three rules hold for every function below, and none of them may be relaxed:
 *
 *  1. It validates the flow-designer session itself, via `requireAtlasToken()`. These RPC
 *     endpoints are reachable directly over HTTP; a route `beforeLoad` proves nothing.
 *  2. It calls one *typed, fixed* Atlas operation. Neither the path, the method, nor a query
 *     key comes from the caller — only bounded values (an id, a limit) do.
 *  3. It authorises nothing. Atlas is the sole authorization authority and re-checks the real
 *     role on every call; a 403 is returned to the UI as a 403, not pre-empted here.
 *
 * Failures come back as data (`{ ok: false, error }`) rather than thrown exceptions, so an
 * Atlas failure keeps its normalised `kind` across the serialisation boundary instead of
 * arriving as an anonymous `Error`. `atlas-queries.ts` re-throws it into TanStack Query.
 */

import { createServerFn } from "@tanstack/react-start";

import {
  atlasGetJob,
  atlasGetMetrics,
  atlasGetUsage,
  atlasGetWorkflow,
  atlasGetWorkflowRun,
  atlasListApiTokens,
  atlasListAudit,
  atlasListConversations,
  atlasListJobs,
  atlasListUsers,
  atlasListWorkers,
  atlasListWorkflowRuns,
  atlasListWorkflows,
  atlasListWorkspaces,
} from "./atlas-api.server";
import { parseDateBoundary } from "./atlas-dates";
import { clampAtlasLimit } from "./atlas-limits";
import {
  toApiTokenView,
  toAuditEntryView,
  toClientAtlasError,
  toConversationView,
  toJobDetailView,
  toJobListView,
  toMetricsView,
  toRunDetailView,
  toRunView,
  toUsageView,
  toUserAdminView,
  toWorkerView,
  toWorkflowDetailView,
  toWorkflowView,
  toWorkspaceView,
  type ApiTokenView,
  type AuditEntryView,
  type ClientAtlasError,
  type ConversationView,
  type JobDetailView,
  type JobView,
  type MetricsView,
  type RunDetailView,
  type RunView,
  type UsageView,
  type UserAdminView,
  type WorkerView,
  type WorkflowDetailView,
  type WorkflowView,
  type WorkspaceView,
} from "./atlas-mappers";
import { clearSession, requireAtlasToken } from "./auth.server";

/** Every read resolves to data or to a normalised Atlas failure — never to a bare throw. */
export type AtlasResult<T> = { ok: true; data: T } | { ok: false; error: ClientAtlasError };

/**
 * A bounded window over an Atlas list.
 *
 * Atlas returns `{key: [...]}` with no total, cursor, or has-more flag, and truncates silently
 * at `limit`. `mayHaveMore` records the only inference available — the window came back full —
 * so the UI can say "this is the newest N" instead of implying it is everything.
 */
export interface AtlasWindow<T> {
  items: T[];
  limit: number;
  mayHaveMore: boolean;
}

function windowOf<T>(items: T[], limit: number): AtlasWindow<T> {
  return { items, limit, mayHaveMore: items.length >= limit };
}

/**
 * Runs a read, converting any Atlas failure into the serialisable result shape.
 *
 * A 401 also *clears the session*. Atlas returns 401 when the bearer is missing, expired,
 * revoked, or logged out elsewhere, and in every one of those cases the sealed cookie is now
 * useless. Leaving it in place would keep the browser presenting a dead credential on every
 * subsequent request, and — worse — would leave the app looking signed in while nothing loads.
 * This mirrors what `currentIdentity` already does for `/api/me`.
 */
async function read<T>(operation: (token: string) => Promise<T>): Promise<AtlasResult<T>> {
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
//
// Client input is untrusted even though the values are innocuous, and the messages describe
// the *rule* rather than echoing the submitted value.
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 128;

function validateId(data: unknown, field: string): string {
  const value =
    data === null || typeof data !== "object"
      ? undefined
      : (data as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(`${field} is too long.`);
  }
  return value;
}

/**
 * Normalises a caller-supplied `limit` to what Atlas will actually honour.
 *
 * Atlas silently substitutes its own default for a non-integer rather than rejecting it, so an
 * unclamped value would make the UI believe it asked for a window Atlas never applied.
 */
function validateLimit(data: unknown): number {
  const raw =
    data === null || typeof data !== "object" ? undefined : (data as Record<string, unknown>).limit;
  if (raw === undefined || raw === null) return clampAtlasLimit(undefined);
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error("limit must be a number.");
  }
  return clampAtlasLimit(parsed);
}

function validateOptionalId(data: unknown, field: string): string | undefined {
  const value =
    data === null || typeof data !== "object"
      ? undefined
      : (data as Record<string, unknown>)[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(`${field} is too long.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * `GET /api/metrics` — Atlas's own lifetime aggregates.
 *
 * The dashboard headline numbers come from here rather than from counting whichever rows a
 * list request happened to return, which would be a page total presented as a fleet total.
 */
export const getMetricsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AtlasResult<MetricsView>> =>
    read(async (token) => toMetricsView(await atlasGetMetrics(token))),
);

/** `GET /api/workers` — the whole table; Atlas accepts no limit or filter on this route. */
export const listWorkersFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AtlasResult<WorkerView[]>> =>
    read(async (token) => (await atlasListWorkers(token)).map(toWorkerView)),
);

/** `GET /api/workspaces` — the whole table, joined with each workspace's worker. */
export const listWorkspacesFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AtlasResult<WorkspaceView[]>> =>
    read(async (token) => (await atlasListWorkspaces(token)).map(toWorkspaceView)),
);

/** `GET /api/workflows?limit=` — a bounded, newest-updated-first window. */
export const listWorkflowsFn = createServerFn({ method: "GET" })
  .validator(validateLimit)
  .handler(
    async ({ data: limit }): Promise<AtlasResult<AtlasWindow<WorkflowView>>> =>
      read(async (token) =>
        windowOf((await atlasListWorkflows(token, { limit })).map(toWorkflowView), limit),
      ),
  );

/** `GET /api/workflows/{id}` — resolves to a `not_found` error when Atlas has no such row. */
export const getWorkflowFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => validateId(data, "workflowId"))
  .handler(
    async ({ data: workflowId }): Promise<AtlasResult<WorkflowDetailView>> =>
      read(async (token) => toWorkflowDetailView(await atlasGetWorkflow(token, workflowId))),
  );

/** `GET /api/workflow-runs?limit=&workflow_definition_id=` — a bounded, newest-first window. */
export const listRunsFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => ({
    limit: validateLimit(data),
    workflowDefinitionId: validateOptionalId(data, "workflowDefinitionId"),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<AtlasWindow<RunView>>> =>
      read(async (token) =>
        windowOf((await atlasListWorkflowRuns(token, data)).map(toRunView), data.limit),
      ),
  );

/** `GET /api/workflow-runs/{id}` — run, runtime nodes, runtime edges, and approvals. */
export const getRunFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => validateId(data, "runId"))
  .handler(
    async ({ data: runId }): Promise<AtlasResult<RunDetailView>> =>
      read(async (token) => toRunDetailView(await atlasGetWorkflowRun(token, runId))),
  );

/** `GET /api/jobs?limit=` — a bounded, newest-first window. Atlas has no state filter here. */
export const listJobsFn = createServerFn({ method: "GET" })
  .validator(validateLimit)
  .handler(
    async ({ data: limit }): Promise<AtlasResult<AtlasWindow<JobView>>> =>
      read(async (token) =>
        windowOf((await atlasListJobs(token, { limit })).map(toJobListView), limit),
      ),
  );

/** `GET /api/jobs/{id}` — the un-joined row, so worker name and workspace key are null. */
export const getJobFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => validateId(data, "jobId"))
  .handler(
    async ({ data: jobId }): Promise<AtlasResult<JobDetailView>> =>
      read(async (token) => toJobDetailView(await atlasGetJob(token, jobId))),
  );

// ---------------------------------------------------------------------------
// Operational-page reads (Phase 5)
// ---------------------------------------------------------------------------

/**
 * A window the caller cannot size: Atlas's conversation list is a fixed latest-100.
 *
 * `mayHaveMore` mirrors the list windows above — exactly 100 rows back means older
 * conversations may exist and are unreachable through the API.
 */
export interface ConversationWindow {
  items: ConversationView[];
  limit: 100;
  mayHaveMore: boolean;
}

/** `GET /api/conversations` — the 100 most recently updated rows; any role can read. */
export const listConversationsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AtlasResult<ConversationWindow>> =>
    read(async (token) => {
      const items = (await atlasListConversations(token)).map(toConversationView);
      return { items, limit: 100 as const, mayHaveMore: items.length >= 100 };
    }),
);

/** `GET /api/users` — admin only; a non-admin receives Atlas's 403 as a forbidden result. */
export const listUsersFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AtlasResult<UserAdminView[]>> =>
    read(async (token) => (await atlasListUsers(token)).map(toUserAdminView)),
);

/** `GET /api/tokens` — admin only. Metadata rows only; a token value never appears here. */
export const listApiTokensFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AtlasResult<ApiTokenView[]>> =>
    read(async (token) => (await atlasListApiTokens(token)).map(toApiTokenView)),
);

/**
 * The audit window the UI asked for, echoed back with the rows so the page can state what it
 * shows: newest-first, bounded by `limit`, optionally date-bounded (inclusive, per Atlas).
 */
export interface AuditWindow {
  items: AuditEntryView[];
  limit: number;
  mayHaveMore: boolean;
}

/** `GET /api/audit?limit=&from=&to=` — requires `audit.read` (admin/auditor). */
export const listAuditFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => ({
    limit: validateLimit(data),
    from: parseDateBoundary(
      data === null || typeof data !== "object"
        ? undefined
        : (data as Record<string, unknown>).from,
      "from",
    ),
    to: parseDateBoundary(
      data === null || typeof data !== "object" ? undefined : (data as Record<string, unknown>).to,
      "to",
    ),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<AuditWindow>> =>
      read(async (token) => {
        const items = (await atlasListAudit(token, data)).map(toAuditEntryView);
        return { items, limit: data.limit, mayHaveMore: items.length >= data.limit };
      }),
  );

/**
 * `GET /api/usage?from=&to=` — requires `audit.read` (admin/auditor).
 *
 * The range goes to Atlas; totals are Atlas's own `summarize_usage` output, never re-derived
 * from the rows here.
 */
export const getUsageFn = createServerFn({ method: "GET" })
  .validator((data: unknown) => ({
    from: parseDateBoundary(
      data === null || typeof data !== "object"
        ? undefined
        : (data as Record<string, unknown>).from,
      "from",
    ),
    to: parseDateBoundary(
      data === null || typeof data !== "object" ? undefined : (data as Record<string, unknown>).to,
      "to",
    ),
  }))
  .handler(
    async ({ data }): Promise<AtlasResult<UsageView>> =>
      read(async (token) => toUsageView(await atlasGetUsage(token, data))),
  );
