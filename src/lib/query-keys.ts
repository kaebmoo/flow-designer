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

  /**
   * Phase 3 families.
   *
   * Nested under `runs` where the data belongs to a run, so cancelling a run invalidates its
   * events and artifacts with the same `["atlas", "runs"]` prefix rather than needing three
   * separate invalidations that could drift apart.
   */
  runEvents: (runId: string, params: { limit: number; after: number }) =>
    ["atlas", "runs", "events", runId, params] as const,
  /** Prefix over every event window of one run — Phase 4's narrowest live invalidation. */
  runEventsAll: (runId: string) => ["atlas", "runs", "events", runId] as const,
  runArtifacts: (runId: string) => ["atlas", "runs", "artifacts", runId] as const,

  approvals: () => ["atlas", "approvals"] as const,
  approvalList: (params: { limit: number; state?: string; runId?: string }) =>
    ["atlas", "approvals", "list", params] as const,

  /** `GET /api/artifacts` — the global windowed listing; every Atlas filter is in the key. */
  artifacts: () => ["atlas", "artifacts"] as const,
  artifactList: (params: {
    limit: number;
    runId?: string;
    jobId?: string;
    key?: string;
    kind?: string;
  }) => ["atlas", "artifacts", "list", params] as const,
  /** On-demand by-id content; never part of a list query or its cache entry. */
  artifactPreview: (artifactId: string) => ["atlas", "artifacts", "preview", artifactId] as const,

  deliveries: () => ["atlas", "deliveries"] as const,
  deliveryList: (params: { limit: number; runId?: string; status?: string }) =>
    ["atlas", "deliveries", "list", params] as const,

  triggers: () => ["atlas", "triggers"] as const,
  triggerList: (params: { limit: number; workflowDefinitionId?: string }) =>
    ["atlas", "triggers", "list", params] as const,

  /**
   * Phase 5 families.
   *
   * Conversations take no parameters because Atlas's list is a fixed latest-100 window.
   * Audit and usage carry their date range in the key: two ranges are two different windows,
   * and serving one for the other would silently lie about the period shown.
   */
  conversations: () => ["atlas", "conversations"] as const,
  users: () => ["atlas", "users"] as const,
  tokens: () => ["atlas", "tokens"] as const,
  audit: () => ["atlas", "audit"] as const,
  auditList: (params: { limit: number; from?: string; to?: string }) =>
    ["atlas", "audit", "list", params] as const,
  usage: () => ["atlas", "usage"] as const,
  usageRange: (params: { from?: string; to?: string }) =>
    ["atlas", "usage", "range", params] as const,
} as const;

export type QueryKeys = typeof queryKeys;
