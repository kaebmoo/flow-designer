/**
 * TanStack Query key factory.
 *
 * Keys only — no fetching, no domain state, no cached entities. Centralising them here keeps
 * invalidation honest and makes every cache-affecting parameter visible in one place.
 *
 * Two rules the keys follow:
 *  - Every parameter that changes the Atlas request is *in* the key. A `limit` or a workflow
 *    filter that lived outside the key would serve one window's data for another window's
 *    request.
 *  - Keys are hierarchical, so `["atlas", "runs"]` invalidates every run query regardless of
 *    its parameters. Mutations in Phase 3 depend on that prefix.
 */

export const queryKeys = {
  /** The current Atlas identity behind the active session. */
  identity: () => ["atlas", "identity"] as const,

  /** `GET /api/metrics` — Atlas's lifetime aggregates. */
  metrics: () => ["atlas", "metrics"] as const,

  /** `GET /api/workers` — unparameterised: Atlas accepts no limit or filter. */
  workers: () => ["atlas", "workers"] as const,

  /** `GET /api/workspaces` — unparameterised for the same reason. */
  workspaces: () => ["atlas", "workspaces"] as const,

  workflows: () => ["atlas", "workflows"] as const,
  workflowList: (params: { limit: number }) => ["atlas", "workflows", "list", params] as const,
  workflowDetail: (workflowId: string) => ["atlas", "workflows", "detail", workflowId] as const,

  runs: () => ["atlas", "runs"] as const,
  runList: (params: { limit: number; workflowDefinitionId?: string }) =>
    ["atlas", "runs", "list", params] as const,
  runDetail: (runId: string) => ["atlas", "runs", "detail", runId] as const,

  jobs: () => ["atlas", "jobs"] as const,
  jobList: (params: { limit: number }) => ["atlas", "jobs", "list", params] as const,
  jobDetail: (jobId: string) => ["atlas", "jobs", "detail", jobId] as const,
} as const;

export type QueryKeys = typeof queryKeys;
