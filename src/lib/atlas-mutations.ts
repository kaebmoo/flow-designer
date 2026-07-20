/**
 * The client half of every Atlas mutation: one hook, one invalidation table.
 *
 * Client-safe — it imports the `*.functions.ts` RPC wrappers, never a `*.server.ts` module.
 *
 * Why a table rather than an `onSuccess` per call site: a mutation that forgets to invalidate
 * leaves the UI showing state Atlas no longer has, and that bug is invisible until someone
 * reloads. Naming the affected key families next to the mutation makes the omission visible in
 * review, and means two call sites for the same mutation cannot disagree.
 *
 * There is no retry policy here on purpose. Atlas has no idempotency key, so retrying "start
 * this workflow" or "approve this gate" is how the action happens twice. Retry is a button.
 */

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";

import {
  cancelJobFn,
  createTriggerFn,
  createWorkflowFn,
  decideApprovalFn,
  deleteTriggerFn,
  deleteWorkerFn,
  deleteWorkflowFn,
  deleteWorkspaceFn,
  deliverRunFn,
  fireTriggerFn,
  pollAllWorkersFn,
  pollWorkerFn,
  retryDeliveryFn,
  runActionFn,
  saveWorkflowFn,
  setTriggerEnabledFn,
  startRunFn,
  updateTriggerFn,
  upsertWorkerFn,
  upsertWorkspaceFn,
  validateWorkflowFn,
  type GraphRejection,
  type SaveResult,
} from "./atlas-mutations.functions";
import type { AtlasResult } from "./atlas-reads.functions";
import type { ClientAtlasError } from "./atlas-mappers";
import { queryKeys } from "./query-keys";

/**
 * A mutation failure as the UI sees it.
 *
 * `rejection` is present only when the *server-side* re-validation of a graph refused it, and
 * carries the per-node/per-edge issues so the editor can anchor each one. An Atlas rejection
 * has no such structure — Atlas raises one `ValueError` and returns a single string.
 */
export interface MutationFailure {
  error: ClientAtlasError;
  rejection?: GraphRejection;
}

export class AtlasMutationError extends Error {
  readonly kind: ClientAtlasError["kind"];
  readonly rejection?: GraphRejection;

  constructor(failure: MutationFailure) {
    super(failure.error.message);
    this.name = "AtlasMutationError";
    this.kind = failure.error.kind;
    this.rejection = failure.rejection;
  }
}

function unwrapMutation<T>(result: AtlasResult<T> | SaveResult<T>): T {
  if (result.ok) return result.data;
  throw new AtlasMutationError({
    error: result.error,
    rejection: "rejection" in result ? result.rejection : undefined,
  });
}

/**
 * Every key family a mutation can invalidate.
 *
 * These are prefixes, so `["atlas", "runs"]` covers the run list, every run detail, and a
 * run's events and artifacts in one entry — which is exactly why the Phase 3 keys were nested
 * under their parent rather than given their own roots.
 */
const FAMILIES = {
  metrics: () => queryKeys.metrics(),
  workers: () => queryKeys.workers(),
  workspaces: () => queryKeys.workspaces(),
  workflows: () => queryKeys.workflows(),
  runs: () => queryKeys.runs(),
  jobs: () => queryKeys.jobs(),
  approvals: () => queryKeys.approvals(),
  deliveries: () => queryKeys.deliveries(),
  triggers: () => queryKeys.triggers(),
} as const;

export type MutationFamily = keyof typeof FAMILIES;

function keysFor(families: readonly MutationFamily[]): QueryKey[] {
  return families.map((family) => FAMILIES[family]());
}

/**
 * Wraps a server function so a failure arrives as a thrown `AtlasMutationError` and a success
 * invalidates the families named here.
 *
 * `invalidate` is awaited before the mutation settles, so a component that navigates or closes
 * a dialog in `onSuccess` cannot race the refetch.
 */
function useAtlasMutation<TVariables, TData>(
  run: (variables: TVariables) => Promise<AtlasResult<TData> | SaveResult<TData>>,
  families: readonly MutationFamily[],
) {
  const queryClient = useQueryClient();
  return useMutation<TData, AtlasMutationError, TVariables>({
    mutationFn: async (variables) => unwrapMutation(await run(variables)),
    onSuccess: async () => {
      await Promise.all(
        keysFor(families).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

/** Creating a workflow changes the list and the definition count on the dashboard. */
export function useCreateWorkflow() {
  return useAtlasMutation(
    (data: { name: string; description?: string; graph: unknown; policy: unknown }) =>
      createWorkflowFn({ data }),
    ["workflows", "metrics"],
  );
}

/**
 * Saving invalidates runs as well as workflows.
 *
 * A run's detail view renders against the definition it was started from, so a graph change
 * that is not reflected there would show an operator a node layout the run never had.
 */
export function useSaveWorkflow() {
  return useAtlasMutation(
    (data: {
      workflowId: string;
      name: string;
      description?: string;
      expectedUpdatedAt?: string;
      graph: unknown;
      policy: unknown;
    }) => saveWorkflowFn({ data }),
    ["workflows", "runs"],
  );
}

/** Deleting a workflow cascades its triggers and runs in Atlas, so all three are invalidated. */
export function useDeleteWorkflow() {
  return useAtlasMutation(
    (data: { workflowId: string }) => deleteWorkflowFn({ data }),
    ["workflows", "runs", "triggers", "metrics"],
  );
}

/** Validation writes nothing, so it invalidates nothing. */
export function useValidateWorkflow() {
  return useAtlasMutation(
    (data: { workflowId: string; graph: unknown; policy: unknown }) => validateWorkflowFn({ data }),
    [],
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Starting a run also creates jobs, and moves the dashboard's run counters. */
export function useStartRun() {
  return useAtlasMutation(
    (data: { workflowDefinitionId: string; input?: Record<string, unknown> }) =>
      startRunFn({ data }),
    ["runs", "jobs", "metrics"],
  );
}

/**
 * Pause, resume, and cancel.
 *
 * Approvals are invalidated too: cancelling a run that sits at a human gate resolves that
 * gate, so a pending-approval list that was not refreshed would offer a decision on a run that
 * is already finished.
 */
export function useRunAction() {
  return useAtlasMutation(
    (data: { runId: string; action: "pause" | "resume" | "cancel"; retryInterrupted?: boolean }) =>
      runActionFn({ data }),
    ["runs", "jobs", "approvals", "metrics"],
  );
}

export function useDeliverRun() {
  return useAtlasMutation(
    (data: { runId: string }) => deliverRunFn({ data }),
    ["deliveries", "runs"],
  );
}

/** A decision resumes the run, so the run, its jobs, and the approval list all move. */
export function useDecideApproval() {
  return useAtlasMutation(
    (data: { approvalId: string; decision: "approve" | "reject" | "choose"; choice?: string }) =>
      decideApprovalFn({ data }),
    ["approvals", "runs", "jobs", "metrics"],
  );
}

export function useRetryDelivery() {
  return useAtlasMutation(
    (data: { deliveryId: string }) => retryDeliveryFn({ data }),
    ["deliveries"],
  );
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export function useCreateTrigger() {
  return useAtlasMutation(
    (data: {
      workflowDefinitionId: string;
      name: string;
      type: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }) => createTriggerFn({ data }),
    ["triggers", "metrics"],
  );
}

export function useUpdateTrigger() {
  return useAtlasMutation(
    (data: {
      triggerId: string;
      name: string;
      type: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }) => updateTriggerFn({ data }),
    ["triggers", "metrics"],
  );
}

/** Enable/disable moves the dashboard's `triggers_enabled` metric as well as the list. */
export function useSetTriggerEnabled() {
  return useAtlasMutation(
    (data: { triggerId: string; enabled: boolean }) => setTriggerEnabledFn({ data }),
    ["triggers", "metrics"],
  );
}

export function useDeleteTrigger() {
  return useAtlasMutation(
    (data: { triggerId: string }) => deleteTriggerFn({ data }),
    ["triggers", "metrics"],
  );
}

/** Firing a trigger starts a run, which is why this touches the run families too. */
export function useFireTrigger() {
  return useAtlasMutation(
    (data: { triggerId: string; payload?: Record<string, unknown> }) => fireTriggerFn({ data }),
    ["triggers", "runs", "jobs", "metrics"],
  );
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

/**
 * Workspaces are invalidated too: Atlas's workspace list joins `workers.name` and
 * `workers.status` (`atlas/db.py:2206`), so renaming a worker leaves every workspace row
 * showing the old name until that query refetches.
 */
export function useUpsertWorker() {
  return useAtlasMutation(
    (data: {
      workerId?: string;
      name: string;
      baseUrl: string;
      role?: string;
      tags?: string[];
      token?: string;
    }) => upsertWorkerFn({ data }),
    ["workers", "workspaces", "metrics"],
  );
}

/** Deleting a worker cascades its workspaces in Atlas, so workspaces are invalidated too. */
export function useDeleteWorker() {
  return useAtlasMutation(
    (data: { workerId: string }) => deleteWorkerFn({ data }),
    ["workers", "workspaces", "metrics"],
  );
}

/** A poll writes `status`, which the workspace list also renders through its worker join. */
export function usePollWorker() {
  return useAtlasMutation(
    (data: { workerId: string }) => pollWorkerFn({ data }),
    ["workers", "workspaces", "metrics"],
  );
}

export function usePollAllWorkers() {
  return useAtlasMutation(() => pollAllWorkersFn(), ["workers", "workspaces", "metrics"]);
}

/**
 * Jobs are invalidated as well: the job list joins `workspaces.workspace_key`
 * (`atlas/db.py:2609`), so re-keying a workspace changes what every job of that workspace
 * displays.
 */
export function useUpsertWorkspace() {
  return useAtlasMutation(
    (data: {
      workspaceId?: string;
      workerId: string;
      workspaceKey: string;
      workspaceDir: string;
      company?: string;
      tags?: string[];
    }) => upsertWorkspaceFn({ data }),
    ["workspaces", "jobs"],
  );
}

/** `jobs.workspace_id` is `ON DELETE SET NULL` (`atlas/db.py:269`), so job rows change here. */
export function useDeleteWorkspace() {
  return useAtlasMutation(
    (data: { workspaceId: string }) => deleteWorkspaceFn({ data }),
    ["workspaces", "jobs"],
  );
}

/** Cancelling a job moves the job and, if it belongs to a run, that run's node state. */
export function useCancelJob() {
  return useAtlasMutation(
    (data: { jobId: string }) => cancelJobFn({ data }),
    ["jobs", "runs", "metrics"],
  );
}
