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
  listArtifactsFn,
  listDeliveriesFn,
  listRunArtifactsFn,
  listRunEventsFn,
  listTriggersFn,
} from "./atlas-mutations.functions";
import {
  getJobFn,
  getMetricsFn,
  getRunFn,
  getUsageFn,
  getWorkflowFn,
  listApiTokensFn,
  listAuditFn,
  listConversationsFn,
  listJobsFn,
  listRunsFn,
  listUsersFn,
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
export function retryRead(failureCount: number, error: unknown): boolean {
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

/**
 * Exponential backoff between read retries, stated rather than inherited: 1s, 2s, 4s, ...
 * capped at 30s. With `retryRead` allowing at most 2 retries, the worst case is one request
 * plus two more spaced 1s and 2s apart — a bounded recovery probe, never a hammer.
 */
export function readRetryDelayMs(attemptIndex: number): number {
  return Math.min(1_000 * 2 ** attemptIndex, 30_000);
}

const shared = {
  retry: retryRead,
  retryDelay: readRetryDelayMs,
  staleTime: STALE_TIME_MS,
} as const;

export function metricsQuery() {
  return queryOptions({
    queryKey: queryKeys.metrics(),
    queryFn: async ({ signal }) => unwrap(await getMetricsFn({ signal })),
    ...shared,
  });
}

export function workersQuery() {
  return queryOptions({
    queryKey: queryKeys.workers(),
    queryFn: async ({ signal }) => unwrap(await listWorkersFn({ signal })),
    ...shared,
  });
}

export function workspacesQuery() {
  return queryOptions({
    queryKey: queryKeys.workspaces(),
    queryFn: async ({ signal }) => unwrap(await listWorkspacesFn({ signal })),
    ...shared,
  });
}

export function workflowsQuery(params: { limit: number }) {
  return queryOptions({
    queryKey: queryKeys.workflowList(params),
    queryFn: async ({ signal }) =>
      unwrap(await listWorkflowsFn({ data: { limit: params.limit }, signal })),
    ...shared,
  });
}

export function workflowQuery(workflowId: string) {
  return queryOptions({
    queryKey: queryKeys.workflowDetail(workflowId),
    queryFn: async ({ signal }) => unwrap(await getWorkflowFn({ data: { workflowId }, signal })),
    ...shared,
  });
}

export function runsQuery(params: { limit: number; workflowDefinitionId?: string }) {
  return queryOptions({
    queryKey: queryKeys.runList(params),
    queryFn: async ({ signal }) =>
      unwrap(
        await listRunsFn({
          data: { limit: params.limit, workflowDefinitionId: params.workflowDefinitionId },
          signal,
        }),
      ),
    ...shared,
  });
}

export function runQuery(runId: string) {
  return queryOptions({
    queryKey: queryKeys.runDetail(runId),
    queryFn: async ({ signal }) => unwrap(await getRunFn({ data: { runId }, signal })),
    ...shared,
  });
}

export function jobsQuery(params: { limit: number }) {
  return queryOptions({
    queryKey: queryKeys.jobList(params),
    queryFn: async ({ signal }) =>
      unwrap(await listJobsFn({ data: { limit: params.limit }, signal })),
    ...shared,
  });
}

export function jobQuery(jobId: string) {
  return queryOptions({
    queryKey: queryKeys.jobDetail(jobId),
    queryFn: async ({ signal }) => unwrap(await getJobFn({ data: { jobId }, signal })),
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
    queryFn: async ({ signal }) =>
      unwrap(await getEditableWorkflowFn({ data: { workflowId }, signal })),
    retry: retryRead,
    retryDelay: readRetryDelayMs,
    staleTime: 0,
  });
}

export function triggersQuery(params: { limit: number; workflowDefinitionId?: string }) {
  return queryOptions({
    queryKey: queryKeys.triggerList(params),
    queryFn: async ({ signal }) => unwrap(await listTriggersFn({ data: params, signal })),
    ...shared,
  });
}

export function approvalsQuery(params: { limit: number; state?: string; runId?: string }) {
  return queryOptions({
    queryKey: queryKeys.approvalList(params),
    queryFn: async ({ signal }) => unwrap(await listApprovalsFn({ data: params, signal })),
    ...shared,
  });
}

export function deliveriesQuery(params: { limit: number; runId?: string; status?: string }) {
  return queryOptions({
    queryKey: queryKeys.deliveryList(params),
    queryFn: async ({ signal }) => unwrap(await listDeliveriesFn({ data: params, signal })),
    ...shared,
  });
}

/** The global artifact listing — a windowed read, so every Atlas filter lives in the key. */
export function artifactsQuery(params: {
  limit: number;
  runId?: string;
  jobId?: string;
  kind?: string;
}) {
  return queryOptions({
    queryKey: queryKeys.artifactList(params),
    queryFn: async ({ signal }) => unwrap(await listArtifactsFn({ data: params, signal })),
    ...shared,
  });
}

export function runArtifactsQuery(runId: string) {
  return queryOptions({
    queryKey: queryKeys.runArtifacts(runId),
    queryFn: async ({ signal }) => unwrap(await listRunArtifactsFn({ data: { runId }, signal })),
    ...shared,
  });
}

export function runEventsQuery(runId: string, params: { limit: number; after: number }) {
  return queryOptions({
    queryKey: queryKeys.runEvents(runId, params),
    queryFn: async ({ signal }) =>
      unwrap(
        await listRunEventsFn({
          data: { runId, limit: params.limit, after: params.after },
          signal,
        }),
      ),
    // Cursor pages have distinct keys. Keep the completed page visible while the next exclusive
    // cursor fetch is in flight, so loading another page appends instead of blanking the table.
    //
    // `keepPreviousData` alone would do this for *any* key change on this observer, not just a
    // cursor advance — switching the run or the window-size selection is a different query
    // entirely and should show a real loading state, not the previous run/window's rows passed
    // off as a placeholder. Only reuse data when the previous query was the same run and the
    // same page size; otherwise fall through to the normal pending state.
    placeholderData: (previousData, previousQuery) => {
      const previousParams = previousQuery?.queryKey[4] as
        | { limit: number; after: number }
        | undefined;
      if (
        !previousQuery ||
        previousQuery.queryKey[3] !== runId ||
        previousParams?.limit !== params.limit
      ) {
        return undefined;
      }
      return previousData;
    },
    ...shared,
  });
}

// ---------------------------------------------------------------------------
// Phase 5 reads: the operational pages.
//
// The shared retry policy already refuses to retry a 403, so the admin/auditor-only reads
// (users, tokens, audit, usage) surface a forbidden state once instead of hammering Atlas.
// ---------------------------------------------------------------------------

export function conversationsQuery() {
  return queryOptions({
    queryKey: queryKeys.conversations(),
    queryFn: async ({ signal }) => unwrap(await listConversationsFn({ signal })),
    ...shared,
  });
}

export function usersQuery() {
  return queryOptions({
    queryKey: queryKeys.users(),
    queryFn: async ({ signal }) => unwrap(await listUsersFn({ signal })),
    ...shared,
  });
}

export function apiTokensQuery() {
  return queryOptions({
    queryKey: queryKeys.tokens(),
    queryFn: async ({ signal }) => unwrap(await listApiTokensFn({ signal })),
    ...shared,
  });
}

export function auditQuery(params: { limit: number; from?: string; to?: string }) {
  return queryOptions({
    queryKey: queryKeys.auditList(params),
    queryFn: async ({ signal }) => unwrap(await listAuditFn({ data: params, signal })),
    ...shared,
  });
}

export function usageQuery(params: { from?: string; to?: string }) {
  return queryOptions({
    queryKey: queryKeys.usageRange(params),
    queryFn: async ({ signal }) => unwrap(await getUsageFn({ data: params, signal })),
    ...shared,
  });
}
