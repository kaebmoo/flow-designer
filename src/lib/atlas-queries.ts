/**
 * TanStack Query options for every Atlas read.
 *
 * Client-safe: it imports the `*.functions.ts` RPC wrappers (whose bodies the bundler replaces
 * with a network call), never a `*.server.ts` module. Routes and components import the option
 * factories below rather than calling a server function directly, so key, retry policy, and
 * error handling stay identical everywhere the same data is read.
 */

import { queryOptions } from "@tanstack/react-query";

import { isClientAtlasError, type ClientAtlasError } from "./atlas-mappers";
import {
  getEditableWorkflowFn,
  listApprovalsFn,
  listDeliveriesFn,
  listRunArtifactsFn,
  listRunEventsFn,
  listTriggersFn,
} from "./atlas-mutations.functions";
import {
  getJobFn,
  getMetricsFn,
  getRunFn,
  getWorkflowFn,
  listJobsFn,
  listRunsFn,
  listWorkersFn,
  listWorkflowsFn,
  listWorkspacesFn,
  type AtlasResult,
} from "./atlas-reads.functions";
import { queryKeys } from "./query-keys";

/**
 * Turns the server function's result union back into TanStack Query's success/error contract.
 *
 * The union exists so the normalised `kind` survives serialisation; re-throwing here means
 * components branch on `query.error` exactly as they would for any other query, and the
 * retry policy below can read the kind.
 */
function unwrap<T>(result: AtlasResult<T>): T {
  if (result.ok) return result.data;
  throw result.error;
}

/** Failure kinds where retrying without the user changing something cannot help. */
const TERMINAL_KINDS = new Set<ClientAtlasError["kind"]>([
  "unauthorized",
  "forbidden",
  "not_found",
  "validation",
  "conflict",
]);

/**
 * Bounded retry for reads only.
 *
 * Retrying a 403 would hammer Atlas to be told "no" three times and delay the forbidden
 * screen; retrying a timeout or a restart is worth one or two attempts. Mutations get no
 * retry policy here at all — they arrive in Phase 3 and need explicit user retry.
 */
function retryRead(failureCount: number, error: unknown): boolean {
  if (isClientAtlasError(error) && TERMINAL_KINDS.has(error.kind)) return false;
  return failureCount < 2;
}

/**
 * Operational data goes stale quickly, but not instantly.
 *
 * Ten seconds keeps a tab switch or a back-navigation from re-hitting Atlas for every table
 * while still making a fleet page that has been open for a minute refetch on focus. Live
 * progress is Phase 4's job (SSE), not a tight polling interval here.
 */
const STALE_TIME_MS = 10_000;

const shared = { retry: retryRead, staleTime: STALE_TIME_MS } as const;

export function metricsQuery() {
  return queryOptions({
    queryKey: queryKeys.metrics(),
    queryFn: async () => unwrap(await getMetricsFn()),
    ...shared,
  });
}

export function workersQuery() {
  return queryOptions({
    queryKey: queryKeys.workers(),
    queryFn: async () => unwrap(await listWorkersFn()),
    ...shared,
  });
}

export function workspacesQuery() {
  return queryOptions({
    queryKey: queryKeys.workspaces(),
    queryFn: async () => unwrap(await listWorkspacesFn()),
    ...shared,
  });
}

export function workflowsQuery(params: { limit: number }) {
  return queryOptions({
    queryKey: queryKeys.workflowList(params),
    queryFn: async () => unwrap(await listWorkflowsFn({ data: { limit: params.limit } })),
    ...shared,
  });
}

export function workflowQuery(workflowId: string) {
  return queryOptions({
    queryKey: queryKeys.workflowDetail(workflowId),
    queryFn: async () => unwrap(await getWorkflowFn({ data: { workflowId } })),
    ...shared,
  });
}

export function runsQuery(params: { limit: number; workflowDefinitionId?: string }) {
  return queryOptions({
    queryKey: queryKeys.runList(params),
    queryFn: async () =>
      unwrap(
        await listRunsFn({
          data: { limit: params.limit, workflowDefinitionId: params.workflowDefinitionId },
        }),
      ),
    ...shared,
  });
}

export function runQuery(runId: string) {
  return queryOptions({
    queryKey: queryKeys.runDetail(runId),
    queryFn: async () => unwrap(await getRunFn({ data: { runId } })),
    ...shared,
  });
}

export function jobsQuery(params: { limit: number }) {
  return queryOptions({
    queryKey: queryKeys.jobList(params),
    queryFn: async () => unwrap(await listJobsFn({ data: { limit: params.limit } })),
    ...shared,
  });
}

export function jobQuery(jobId: string) {
  return queryOptions({
    queryKey: queryKeys.jobDetail(jobId),
    queryFn: async () => unwrap(await getJobFn({ data: { jobId } })),
    ...shared,
  });
}

// ---------------------------------------------------------------------------
// Phase 3 reads: the surfaces mutations act on.
// ---------------------------------------------------------------------------

/**
 * The workflow as the editor needs it — the parsed semantic graph, or a stated refusal.
 *
 * `staleTime: 0` on purpose, unlike every other read here. This query is the editor's baseline
 * for the lost-update guard: serving a cached row that is ten seconds old would make the guard
 * compare against a stale `updated_at` and report a conflict that is not one.
 */
export function editableWorkflowQuery(workflowId: string) {
  return queryOptions({
    queryKey: queryKeys.workflowDetail(workflowId),
    queryFn: async () => unwrap(await getEditableWorkflowFn({ data: { workflowId } })),
    retry: retryRead,
    staleTime: 0,
  });
}

export function triggersQuery(params: { limit: number; workflowDefinitionId?: string }) {
  return queryOptions({
    queryKey: queryKeys.triggerList(params),
    queryFn: async () => unwrap(await listTriggersFn({ data: params })),
    ...shared,
  });
}

export function approvalsQuery(params: { limit: number; state?: string; runId?: string }) {
  return queryOptions({
    queryKey: queryKeys.approvalList(params),
    queryFn: async () => unwrap(await listApprovalsFn({ data: params })),
    ...shared,
  });
}

export function deliveriesQuery(params: { limit: number; runId?: string; status?: string }) {
  return queryOptions({
    queryKey: queryKeys.deliveryList(params),
    queryFn: async () => unwrap(await listDeliveriesFn({ data: params })),
    ...shared,
  });
}

export function runArtifactsQuery(runId: string) {
  return queryOptions({
    queryKey: queryKeys.runArtifacts(runId),
    queryFn: async () => unwrap(await listRunArtifactsFn({ data: { runId } })),
    ...shared,
  });
}

export function runEventsQuery(runId: string, params: { limit: number }) {
  return queryOptions({
    queryKey: queryKeys.runEvents(runId, params),
    queryFn: async () => unwrap(await listRunEventsFn({ data: { runId, limit: params.limit } })),
    ...shared,
  });
}
