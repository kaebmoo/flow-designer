/**
 * API-facing Atlas types.
 *
 * These mirror what Atlas actually returns (verified against the Atlas checkout at
 * 595ef62), not what would be convenient for the UI. Components consume the view models in
 * `atlas-mappers.ts` instead of these shapes, so an Atlas response change is absorbed in one
 * place. This module is import-safe from client code: it contains types and pure guards only.
 *
 * Phase 2 adds the read-only domain entities. Every field below was read out of the Atlas
 * checkout at `595ef62` (`atlas/db.py` schema + `atlas/app.py` handlers), not out of the
 * OpenAPI document — where the two disagree, the code is what ships.
 */

/** The four roles Atlas recognises. Atlas is the only authority that enforces them. */
export const ATLAS_ROLES = ["admin", "operator", "viewer", "auditor"] as const;
export type AtlasRole = (typeof ATLAS_ROLES)[number];

export const ATLAS_USER_STATUSES = ["active", "disabled"] as const;
export type AtlasUserStatus = (typeof ATLAS_USER_STATUSES)[number];

/**
 * A user as returned by `POST /api/auth/login` and `GET /api/me`.
 *
 * `id` is nullable on purpose: Atlas's loopback bypass (`ATLAS_LOOPBACK_NO_AUTH`) and its
 * legacy shared-token identity both return `{"id": null, "role": "admin"}` with username
 * `local` / `legacy`. Treating `id` as a guaranteed string would crash the BFF against a
 * loopback-configured Atlas. `created_at`/`updated_at` are present on login but *absent*
 * from `/api/me`, so both are optional.
 */
export interface AtlasUser {
  id: string | null;
  username: string;
  role: AtlasRole;
  status?: AtlasUserStatus;
  created_at?: string;
  updated_at?: string;
}

/** `POST /api/auth/login` — 200. `token` is the raw bearer, shown exactly once. */
export interface AtlasLoginResponse {
  token: string;
  user: AtlasUser;
}

/** `GET /api/me` — 200. */
export interface AtlasMeResponse {
  user: AtlasUser;
}

/** `POST /api/auth/logout` — 200. */
export interface AtlasLogoutResponse {
  logged_out: boolean;
}

/**
 * Every Atlas error body is this single-key envelope (`atlas/app.py` `_json` error paths,
 * normative as `schemas.Error` in the Atlas OpenAPI document).
 */
export interface AtlasErrorBody {
  error: string;
}

/**
 * Normalised failure kinds. Every Atlas call funnels into exactly one of these so callers
 * branch on a closed union instead of re-deriving meaning from status codes.
 *
 * `conflict` and `rate_limited` are carried because the integration contract requires them,
 * but note: the Atlas build at 595ef62 never emits 409 or 429 — a duplicate username, for
 * example, surfaces as 400. They are kept so a future Atlas can adopt them without a client
 * change, not because they fire today.
 */
export type AtlasErrorKind =
  | "validation" // 400/422 — request rejected
  | "unauthorized" // 401 — no session, or the bearer is expired/revoked
  | "forbidden" // 403 — authenticated but the role lacks the permission
  | "not_found" // 404
  | "conflict" // 409
  | "rate_limited" // 429
  | "server" // 5xx
  | "timeout" // the request deadline elapsed
  | "network" // DNS/TCP/TLS failure — Atlas was never reached
  | "protocol"; // reached Atlas, but the response was not the JSON we require

export function isAtlasRole(value: unknown): value is AtlasRole {
  return typeof value === "string" && (ATLAS_ROLES as readonly string[]).includes(value);
}

/**
 * Structural guard for an Atlas user. Deliberately permissive about unknown extra fields
 * (Atlas may add some) and strict about the ones we actually depend on.
 */
export function isAtlasUser(value: unknown): value is AtlasUser {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const idOk = candidate.id === null || typeof candidate.id === "string";
  return idOk && typeof candidate.username === "string" && isAtlasRole(candidate.role);
}

/** Extracts Atlas's `{"error": "..."}` message, or undefined if the body is not that shape. */
export function readAtlasErrorMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>).error;
  return typeof candidate === "string" ? candidate : undefined;
}

// ---------------------------------------------------------------------------
// Domain entities (read-only, Phase 2)
// ---------------------------------------------------------------------------

/**
 * Atlas state vocabularies are deliberately typed as plain `string`.
 *
 * `atlas/db.py` stores them as free TEXT with no CHECK constraint, and the executor can add a
 * state without a schema migration. Narrowing them to a union here would make an unrecognised
 * Atlas state a *type* error the compiler cannot see and a *runtime* value the UI would drop
 * on the floor. Instead the UI renders whatever Atlas said and falls back to a neutral tone.
 */

/**
 * `GET /api/workers` / `GET /api/workers/{id}` (`atlas/app.py:399,417`).
 *
 * `token` is never present: the handler runs every worker through `_public_worker`
 * (`atlas/app.py:1226-1230`), which pops the token and substitutes `token_set`.
 */
export interface AtlasWorker {
  id: string;
  name: string;
  base_url: string;
  role: string;
  tags: string[];
  status: string;
  last_seen_at: string | null;
  agent_info: Record<string, unknown>;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sync_mode: string;
  token_set: boolean;
}

/** `GET /api/workspaces/{id}` (`atlas/app.py:471`). */
export interface AtlasWorkspace {
  id: string;
  worker_id: string;
  workspace_key: string;
  workspace_dir: string;
  company: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/**
 * `GET /api/workspaces` (`atlas/app.py:458`).
 *
 * The list SQL joins `workers` (`atlas/db.py:2202-2212`); the by-id route does not. The two
 * shapes genuinely differ, so they are two types rather than one optional-field type.
 */
export interface AtlasWorkspaceListRow extends AtlasWorkspace {
  worker_name: string;
  worker_status: string;
}

/** The semantic graph Atlas stores. Only the fields the read-only UI needs are named. */
export interface AtlasWorkflowGraph {
  start?: string;
  nodes?: unknown[];
  edges?: unknown[];
}

/**
 * `GET /api/workflows` / `GET /api/workflows/{id}` (`atlas/app.py:541,590`).
 *
 * There is no `enabled` column on a definition (`atlas/db.py:312-322`) — `enabled` belongs to
 * triggers. `graph`/`policy` decode to `{}` rather than null when the column is SQL NULL.
 */
export interface AtlasWorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  status: string;
  graph: AtlasWorkflowGraph;
  policy: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * `GET /api/workflow-runs` (envelope key `runs`) and the `run` of `GET /api/workflow-runs/{id}`
 * (`atlas/app.py:643,668`).
 *
 * `graph_snapshot`/`policy_snapshot` are returned by `SELECT *` on both routes even though the
 * Atlas OpenAPI schema omits them. They are typed here so the mapper can drop them explicitly
 * rather than forwarding an unbounded blob to the browser on every list row.
 */
export interface AtlasWorkflowRun {
  id: string;
  workflow_definition_id: string | null;
  name: string;
  state: string;
  input: Record<string, unknown>;
  current_nodes: string[];
  counters: Record<string, unknown>;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  /** Nullable defensively: rows written before Atlas migration 004 have no snapshot. */
  graph_snapshot: AtlasWorkflowGraph | null;
  policy_snapshot: Record<string, unknown> | null;
}

/** A runtime node of a run (`atlas/app.py:669`, `atlas/db.py:340-356`). Ordered oldest-first. */
export interface AtlasRuntimeNode {
  id: string;
  run_id: string;
  node_key: string;
  state: string;
  job_id: string | null;
  attempt: number;
  input_artifacts: string[];
  output_artifacts: string[];
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

/** A runtime edge of a run (`atlas/app.py:670`, `atlas/db.py:358-366`). Has no `updated_at`. */
export interface AtlasRuntimeEdge {
  id: string;
  run_id: string;
  from_node: string;
  to_node: string;
  condition_result: Record<string, unknown>;
  created_at: string;
}

/** A human-gate approval attached to a run (`atlas/app.py:671`, `atlas/db.py:380-397`). */
export interface AtlasApproval {
  id: string;
  run_id: string;
  workflow_node_id: string | null;
  node_key: string;
  approval_key: string;
  label: string;
  reason: string;
  choices: Array<{ id?: string; label?: string }>;
  selected_choice: string | null;
  state: string;
  created_at: string;
  decided_at: string | null;
  updated_at: string;
}

/** `GET /api/workflow-runs/{id}` (`atlas/app.py:666-673`). */
export interface AtlasWorkflowRunDetail {
  run: AtlasWorkflowRun;
  nodes: AtlasRuntimeNode[];
  edges: AtlasRuntimeEdge[];
  approvals: AtlasApproval[];
}

/** `GET /api/jobs/{id}` (`atlas/app.py:515`). A plain `SELECT *`, so no joined columns. */
export interface AtlasJob {
  id: string;
  conversation_id: string | null;
  worker_id: string;
  workspace_id: string | null;
  parent_job_id: string | null;
  state: string;
  prompt: string;
  model: string;
  route_reason: string;
  thclaws_session_id: string | null;
  assistant_text: string;
  error: string | null;
  /** SQLite integer, not a JSON boolean. */
  cancel_requested: number;
  execution: string;
  callback_deadline_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  collect_files: string[];
}

/**
 * `GET /api/jobs` (`atlas/app.py:503`).
 *
 * The list SQL joins worker and workspace (`atlas/db.py:2605-2618`); the by-id route does not.
 * `workspace_key` is null when the job has no workspace (LEFT JOIN).
 */
export interface AtlasJobListRow extends AtlasJob {
  worker_name: string;
  workspace_key: string | null;
}

/**
 * `GET /api/metrics` (`atlas/app.py:376-380`, `atlas/db.py:753-786`).
 *
 * The three maps are SQL `GROUP BY` results, so a state with zero rows is *absent*, not zero.
 * Callers must default a missing key rather than assume every state is present.
 *
 * These are lifetime totals. Atlas exposes no windowed (24h) run aggregate outside
 * `/api/usage`, which requires the `audit.read` permission — see `docs/ATLAS_LIMITATIONS.md`.
 */
export interface AtlasMetrics {
  workers: Record<string, number>;
  jobs: Record<string, number>;
  workflow_runs: Record<string, number>;
  workflow_definitions: number;
  triggers_enabled: number;
  approvals_pending: number;
  artifacts: number;
  usage_events: number;
  usage_units: number;
  schema_version: number;
  version: string;
  time: string;
}

// ---------------------------------------------------------------------------
// Mutation-era entities (Phase 3)
// ---------------------------------------------------------------------------

/**
 * `GET/POST/PUT /api/workflow-triggers…` (`atlas/app.py:759-814`, `atlas/db.py:413-425`).
 *
 * `enabled` is the SQLite integer 1/0, **not** a JSON boolean — the column is `INTEGER` and
 * `row_to_dict` decodes only `config` (`atlas/db.py:134-156`). Typing it as `boolean` here
 * would make `enabled === true` silently false for an enabled trigger.
 *
 * The three `last_event_*` fields are present on the **list** route only; the by-id, create,
 * and update routes are a plain `SELECT *` and omit them (`atlas/db.py:1493-1496`).
 */
export interface AtlasWorkflowTrigger {
  id: string;
  workflow_definition_id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: number;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
  last_event_state?: string | null;
  last_event_error?: string | null;
  last_event_at?: string | null;
}

/** `GET /api/workflow-triggers/{id}/events` (`atlas/db.py:427-435`). */
export interface AtlasTriggerEvent {
  id: string;
  trigger_id: string;
  run_id: string | null;
  payload: Record<string, unknown>;
  state: string;
  error: string | null;
  created_at: string;
}

/** `GET /api/deliveries`, `POST /api/deliveries/{id}/retry` (`atlas/db.py:520-533`). */
export interface AtlasDelivery {
  id: string;
  run_id: string;
  url: string;
  correlation_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

/**
 * `GET /api/artifacts/{id}`, `GET /api/workflow-runs/{id}/artifacts` (`atlas/db.py:399-411`).
 *
 * `content` is a decoded JSON value when `kind === "json"` and a plain string otherwise
 * (`_public_artifact`, `atlas/app.py:1239-1243`). For `kind === "file_ref"` it is the opaque
 * upload id — the bytes come from `GET /api/artifacts/{id}/content`, which is the only Atlas
 * route in this client that does not answer with JSON.
 */
export interface AtlasArtifact {
  id: string;
  run_id: string | null;
  job_id: string | null;
  key: string;
  kind: string;
  content: unknown;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** The artifact kinds Atlas accepts (`atlas/db.py:22`). */
export const ARTIFACT_KINDS = [
  "text",
  "json",
  "markdown",
  "file_ref",
  "summary",
  "decision",
] as const;

/** `POST /api/approvals/{id}/…` — the runner's return value *is* the whole body. */
export interface AtlasApprovalDecision {
  approval: AtlasApproval;
  run: AtlasWorkflowRun;
}

/**
 * `GET /api/workflow-runs/{id}/events` (`atlas/app.py:709-714`). Persisted history, not SSE.
 *
 * `id` is an `INTEGER PRIMARY KEY AUTOINCREMENT` (`atlas/db.py:369`), so unlike every other
 * Atlas row it is a number — which is why these rows do not satisfy `isAtlasRow`.
 */
export interface AtlasWorkflowEvent {
  id: number;
  run_id: string;
  seq: number;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Operational-page entities (Phase 5)
// ---------------------------------------------------------------------------

/**
 * `GET /api/conversations`, `POST /api/conversations` (`atlas/app.py:479-486`,
 * `atlas/db.py:214-226`).
 *
 * The list is a **fixed window of the 100 most recently updated rows** — `list_conversations`
 * hardcodes `LIMIT 100` and accepts no parameter (`atlas/db.py:2245-2248`). There is no
 * get-by-id, update, or delete route: anything but the two operations above 404s.
 */
export interface AtlasConversation {
  id: string;
  title: string;
  preferred_worker_id: string | null;
  preferred_workspace_id: string | null;
  workspace_key: string;
  company: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** `GET /api/users/{id}` and the `user` of create/update (`atlas/db.py:896-902`). */
export interface AtlasUserRow {
  id: string;
  username: string;
  /** Constrained by Atlas (`_validate_role_status`), but typed open for forward safety. */
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * `GET /api/users` (`atlas/db.py:912-922`).
 *
 * The list SQL joins a live (un-revoked) token count per user; the by-id route does not.
 */
export interface AtlasUserListRow extends AtlasUserRow {
  token_count: number;
}

/**
 * Token **metadata** — `GET /api/tokens`, `GET/PUT /api/tokens/{id}` (`atlas/db.py:988-1014`).
 *
 * Never contains the token value: the SELECT lists columns explicitly and excludes
 * `token_hash`. The raw token exists in exactly one response — the create's `api_token`.
 */
export interface AtlasApiToken {
  id: string;
  user_id: string;
  name: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  username: string;
}

/**
 * `POST /api/tokens` — 201 (`atlas/app.py:329-337`).
 *
 * `api_token` is the raw bearer, returned **once**; no later route can recover it (Atlas
 * stores only its hash). It must never enter a query cache, storage, a URL, or a log.
 */
export interface AtlasTokenCreated {
  token: AtlasApiToken;
  api_token: string;
}

/**
 * `GET /api/audit` rows (`atlas/db.py:452-460`, `727-751`). Newest first, bounded by `limit`;
 * `from`/`to` are inclusive created_at bounds. `id` is an autoincrement integer, so these rows
 * do not satisfy `isAtlasRow`.
 */
export interface AtlasAuditEntry {
  id: number;
  action: string;
  actor: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, unknown>;
  created_at: string;
}

/** One row of the usage ledger (`atlas/db.py:842-859`; fields per `usage.py` CSV order). */
export interface AtlasUsageEvent {
  id: string;
  idempotency_key: string;
  run_id: string | null;
  job_id: string | null;
  node_key: string | null;
  worker_id: string | null;
  actor: string;
  kind: string;
  status: string | null;
  units: number;
  seconds: number | null;
  started_at: string | null;
  finished_at: string | null;
  model: string | null;
  tokens_prompt: number | null;
  tokens_output: number | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

/**
 * `summarize_usage` (`atlas/usage.py:52-70`).
 *
 * `estimated_cost_usd` is a per-event visibility **estimate** Atlas froze at write time — the
 * ledger is mediation/CDR source data, not an invoice, and nothing here is a billable charge.
 */
export interface AtlasUsageTotals {
  workflow_runs: number;
  successful_workflow_runs: number;
  jobs: number;
  budget_units: number;
  wall_seconds: number;
  job_wall_seconds: number;
  tokens_prompt: number;
  tokens_output: number;
  estimated_cost_usd: number;
}

/**
 * `GET /api/usage?format=json` (`atlas/app.py:382-395`).
 *
 * No `limit` and no pagination exist on this route: the range decides the size, and the whole
 * ledger for that range comes back in one response.
 */
export interface AtlasUsageResponse {
  usage: AtlasUsageEvent[];
  totals: AtlasUsageTotals;
  from: string | null;
  to: string | null;
}

/** Structural guard for any Atlas row: an object carrying a non-empty string `id`. */
export function isAtlasRow(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0;
}

/** Guards `{ "<key>": [ …rows ] }`, the envelope every Atlas list route returns. */
export function isAtlasRowListEnvelope(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object") return false;
  const rows = (value as Record<string, unknown>)[key];
  return Array.isArray(rows) && rows.every(isAtlasRow);
}

/** Guards `{ "<key>": { …row } }`, the envelope every Atlas by-id route returns. */
export function isAtlasRowEnvelope(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object") return false;
  return isAtlasRow((value as Record<string, unknown>)[key]);
}
