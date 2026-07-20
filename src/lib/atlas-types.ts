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
  graph_snapshot: AtlasWorkflowGraph;
  policy_snapshot: Record<string, unknown>;
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
