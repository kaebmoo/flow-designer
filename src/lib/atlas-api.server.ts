/**
 * Server-only Atlas HTTP client.
 *
 * SERVER ONLY. Client code must never import this module — it holds the bearer token, the
 * private Atlas origin, and the timeout/retry policy. The browser reaches Atlas only through
 * `*.functions.ts` RPC wrappers.
 *
 * Design constraints (CLAUDE.md, docs/ARCHITECTURE.md):
 *  - Every export is a *typed, fixed operation*. `atlasRequest` is module-private on purpose:
 *    exporting it would turn this into a generic Atlas proxy, which is exactly the thing the
 *    architecture forbids, because it would let any caller reach any Atlas route.
 *  - Nothing here logs. Not the token, not the password, not the response body. There is no
 *    `console.*` call in this file, so there is no path by which a credential reaches a log.
 *  - Every failure becomes an `AtlasError` with a closed-union `kind`, so callers branch on
 *    meaning rather than re-deriving it from a status code.
 */

import {
  isAtlasRowEnvelope,
  isAtlasRowListEnvelope,
  isAtlasUser,
  readAtlasErrorMessage,
  type AtlasApproval,
  type AtlasApprovalDecision,
  type AtlasArtifact,
  type AtlasDelivery,
  type AtlasErrorKind,
  type AtlasJob,
  type AtlasJobListRow,
  type AtlasLoginResponse,
  type AtlasLogoutResponse,
  type AtlasMeResponse,
  type AtlasMetrics,
  type AtlasUser,
  type AtlasWorker,
  type AtlasWorkflowDefinition,
  type AtlasWorkflowEvent,
  type AtlasWorkflowRun,
  type AtlasWorkflowRunDetail,
  type AtlasWorkflowTrigger,
  type AtlasWorkspace,
  type AtlasWorkspaceListRow,
} from "./atlas-types";
import { clampAtlasLimit } from "./atlas-limits";
import { getServerEnv } from "./env.server";

/** Atlas is on a private network; 10s is generous for it and still bounds a hung socket. */
export const DEFAULT_ATLAS_TIMEOUT_MS = 10_000;

export class AtlasError extends Error {
  readonly kind: AtlasErrorKind;
  /** HTTP status when Atlas answered; undefined for timeout/network failures. */
  readonly status?: number;
  /** True when Atlas's own `{"error": "..."}` text produced this message. */
  readonly fromAtlas: boolean;

  constructor(
    kind: AtlasErrorKind,
    message: string,
    options: { status?: number; fromAtlas?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AtlasError";
    this.kind = kind;
    this.status = options.status;
    this.fromAtlas = options.fromAtlas ?? false;
  }
}

export function isAtlasError(value: unknown): value is AtlasError {
  return value instanceof AtlasError;
}

/** Maps an HTTP status onto the normalised kind. */
export function atlasErrorKindForStatus(status: number): AtlasErrorKind {
  if (status === 400 || status === 422) return "validation";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  // Any other 4xx is still a rejected request; validation is the honest bucket.
  if (status >= 400) return "validation";
  return "protocol";
}

/** Fallback copy used when Atlas gives us no usable `{"error": "..."}` text. */
function defaultMessageForKind(kind: AtlasErrorKind): string {
  switch (kind) {
    case "validation":
      return "Atlas rejected the request.";
    case "unauthorized":
      return "Atlas rejected the credentials.";
    case "forbidden":
      return "Your Atlas role does not allow this action.";
    case "not_found":
      return "Atlas has no such resource.";
    case "conflict":
      return "Atlas reported a conflict with the current state.";
    case "rate_limited":
      return "Atlas is rate limiting this client.";
    case "server":
      return "Atlas failed to process the request.";
    case "timeout":
      return "Atlas did not respond in time.";
    case "network":
      return "Atlas is unreachable.";
    case "protocol":
      return "Atlas returned an unexpected response.";
  }
}

interface AtlasRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: `/api/${string}`;
  /**
   * Fixed query parameters for this operation.
   *
   * Each exported operation supplies literal keys it knows Atlas accepts. Nothing here is
   * forwarded from a client-chosen key/value pair — that would be the generic proxy the
   * architecture forbids. `undefined` values are omitted rather than sent as "undefined".
   */
  query?: Record<string, string | number | undefined>;
  /** Server-side only. Never accept this from client input; it comes from the sealed session. */
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Caller cancellation, e.g. a navigation aborting an in-flight load. */
  signal?: AbortSignal;
}

/**
 * The single place an HTTP request to Atlas is made.
 *
 * Module-private by design — see the file header. Exported operations below wrap it with a
 * fixed method, a fixed path, and a typed response guard.
 */
async function atlasRequest(options: AtlasRequestOptions): Promise<unknown> {
  const { atlasApiOrigin } = getServerEnv();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATLAS_TIMEOUT_MS;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  // Atlas reads bodies by Content-Length, so a POST/PUT always carries an explicit JSON body —
  // `{}` when there is nothing to send — rather than no body at all. DELETE carries none,
  // which is also why it needs no desync workaround: there are no leftover bytes to strand.
  const hasBody = options.method === "POST" || options.method === "PUT";
  if (hasBody) {
    headers["content-type"] = "application/json";
    /**
     * Works around an Atlas connection-desync bug (docs/ATLAS_LIMITATIONS.md).
     *
     * Atlas speaks HTTP/1.1 with keep-alive (`atlas/app.py:156`) but answers 401/403 *before*
     * reading the request body (`atlas/app.py:237-242`). The undrained body then sits in the
     * socket, so the next request reused on that connection is parsed starting at the leftover
     * bytes and comes back as a 501 HTML page — corrupting an unrelated later request rather
     * than the rejected one. Reproduced against Atlas 595ef62; closing the connection after
     * every POST removes it entirely.
     *
     * Phase 3 widened the exposure rather than narrowing it: several mutation routes never
     * read the body **on the success path** either — `pause`, `cancel`, `deliver`, `approve`,
     * `reject`, and `delivery retry` all skip `_read_json()` (`atlas/app.py:718-751, 839-843`)
     * — so the `{}` this client must send by Content-Length is stranded on a *200*, not only
     * on a rejection. The same header covers both.
     *
     * ponytail: costs one TCP handshake per mutation on a private network. Drop this header
     * once Atlas drains the request body on its rejection paths.
     */
    headers.connection = "close";
  }

  let search = "";
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const encoded = params.toString();
    if (encoded) search = `?${encoded}`;
  }

  let response: Response;
  try {
    response = await fetch(`${atlasApiOrigin}${options.path}${search}`, {
      method: options.method,
      headers,
      body: hasBody ? JSON.stringify(options.body ?? {}) : undefined,
      signal,
      redirect: "error",
    });
  } catch (cause) {
    if (timeoutSignal.aborted) {
      throw new AtlasError("timeout", defaultMessageForKind("timeout"), { cause });
    }
    if (options.signal?.aborted) {
      // A caller-initiated cancel is not a failure to report; let it propagate untouched.
      throw cause;
    }
    // `cause` may name the private Atlas origin, so it is attached for server-side debugging
    // but never used to build the message that can travel to a browser.
    throw new AtlasError("network", defaultMessageForKind("network"), { cause });
  }

  // Atlas answers every `/api/*` route with `application/json`. Anything else means we hit a
  // proxy error page, or one of Atlas's non-JSON paths (an undefined HTTP method yields a
  // 501 HTML body from the stdlib handler), and must not be parsed as our contract.
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.split(";")[0]!.trim().toLowerCase() === "application/json";

  let payload: unknown;
  let parsed = false;
  if (isJson) {
    try {
      payload = await response.json();
      parsed = true;
    } catch {
      parsed = false;
    }
  }

  if (!response.ok) {
    const kind = atlasErrorKindForStatus(response.status);
    const atlasMessage = parsed ? readAtlasErrorMessage(payload) : undefined;
    throw new AtlasError(kind, atlasMessage ?? defaultMessageForKind(kind), {
      status: response.status,
      fromAtlas: atlasMessage !== undefined,
    });
  }

  if (!parsed) {
    throw new AtlasError("protocol", defaultMessageForKind("protocol"), {
      status: response.status,
    });
  }

  return payload;
}

/** Rejects a 2xx body that does not match the contract, rather than letting it flow onward. */
function expectShape<T>(payload: unknown, guard: (value: unknown) => boolean): T {
  if (!guard(payload)) {
    throw new AtlasError("protocol", defaultMessageForKind("protocol"));
  }
  return payload as T;
}

function hasUser(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    isAtlasUser((payload as Record<string, unknown>).user)
  );
}

// ---------------------------------------------------------------------------
// Typed, fixed Atlas operations. Phase 1 exposes authentication only.
// ---------------------------------------------------------------------------

/** Per-call knobs every operation accepts. Deliberately excludes anything URL- or auth-shaped. */
export interface AtlasCallOptions {
  /** Cancellation, e.g. a route change aborting an in-flight load. */
  signal?: AbortSignal;
  /** Overrides the default deadline for a call known to be slower or faster than usual. */
  timeoutMs?: number;
}

/**
 * `POST /api/auth/login`.
 *
 * Unauthenticated by definition — this is where a bearer is obtained. Atlas mints a fresh
 * `"dashboard login"` token per call and never expires it; see docs/ATLAS_LIMITATIONS.md,
 * where token lifecycle remains a production-release blocker.
 */
export async function atlasLogin(
  credentials: { username: string; password: string },
  options: AtlasCallOptions = {},
): Promise<AtlasLoginResponse> {
  const payload = await atlasRequest({
    method: "POST",
    path: "/api/auth/login",
    body: { username: credentials.username, password: credentials.password },
    ...options,
  });

  return expectShape<AtlasLoginResponse>(
    payload,
    (value) =>
      hasUser(value) &&
      typeof (value as Record<string, unknown>).token === "string" &&
      ((value as Record<string, unknown>).token as string).length > 0,
  );
}

/**
 * `GET /api/me` — the current Atlas identity for the supplied bearer.
 *
 * Throws `AtlasError("unauthorized")` when the token is missing, invalid, expired, or
 * revoked (Atlas returns 401 for all four).
 */
export async function atlasGetMe(
  token: string,
  options: AtlasCallOptions = {},
): Promise<AtlasUser> {
  const payload = await atlasRequest({
    method: "GET",
    path: "/api/me",
    token,
    ...options,
  });

  return expectShape<AtlasMeResponse>(payload, hasUser).user;
}

/**
 * `POST /api/auth/logout` — revokes the bearer that authenticates this very request.
 *
 * Callers must treat this as best-effort: the local session is cleared whether or not Atlas
 * confirms the revocation.
 */
export async function atlasLogout(
  token: string,
  options: AtlasCallOptions = {},
): Promise<AtlasLogoutResponse> {
  const payload = await atlasRequest({
    method: "POST",
    path: "/api/auth/logout",
    token,
    body: {},
    ...options,
  });

  /**
   * `logged_out: true` is required, not merely an object.
   *
   * Atlas answers a successful revocation with exactly `{"logged_out": true}`
   * (`atlas/app.py:282`). Accepting any object meant a `{}` — from a proxy, a future Atlas
   * that reports a *failed* revocation in the body, or the keep-alive desync this client
   * already works around — would be reported to the caller as a confirmed revocation. The
   * caller then records `atlasRevoked: true` for a bearer that is still live.
   */
  return expectShape<AtlasLogoutResponse>(
    payload,
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).logged_out === true,
  );
}

// ---------------------------------------------------------------------------
// Read operations (Phase 2).
//
// One exported function per Atlas route, each with the method and path baked in. A caller
// cannot choose a path, a method, or a query key — that is what keeps this a set of fixed
// operations rather than an Atlas proxy. Every one of these requires only the `read`
// permission in Atlas (`atlas/app.py:1195`), but Atlas re-checks that on every call: nothing
// here decides whether the caller is allowed to see the data.
// ---------------------------------------------------------------------------

/** `GET /api/metrics` — lifetime aggregates. The only aggregate endpoint open to `read`. */
export async function atlasGetMetrics(
  token: string,
  options: AtlasCallOptions = {},
): Promise<AtlasMetrics> {
  const payload = await atlasRequest({ method: "GET", path: "/api/metrics", token, ...options });

  return expectShape<{ metrics: AtlasMetrics }>(
    payload,
    (value) =>
      value !== null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).metrics === "object" &&
      (value as Record<string, unknown>).metrics !== null,
  ).metrics;
}

/**
 * `GET /api/workers` — the whole table.
 *
 * Atlas accepts no `limit` and no filter on this route (`atlas/db.py:2029-2035`), so there is
 * deliberately no pagination parameter to pass through.
 */
export async function atlasListWorkers(
  token: string,
  options: AtlasCallOptions = {},
): Promise<AtlasWorker[]> {
  const payload = await atlasRequest({ method: "GET", path: "/api/workers", token, ...options });

  return expectShape<{ workers: AtlasWorker[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "workers"),
  ).workers;
}

/** `GET /api/workers/{id}`. Throws `AtlasError("not_found")` when Atlas has no such worker. */
export async function atlasGetWorker(
  token: string,
  workerId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasWorker> {
  const payload = await atlasRequest({
    method: "GET",
    path: `/api/workers/${encodeURIComponent(workerId)}`,
    token,
    ...options,
  });

  return expectShape<{ worker: AtlasWorker }>(payload, (value) =>
    isAtlasRowEnvelope(value, "worker"),
  ).worker;
}

/** `GET /api/workspaces` — the whole table, joined with worker name/status. No `limit`. */
export async function atlasListWorkspaces(
  token: string,
  options: AtlasCallOptions = {},
): Promise<AtlasWorkspaceListRow[]> {
  const payload = await atlasRequest({ method: "GET", path: "/api/workspaces", token, ...options });

  return expectShape<{ workspaces: AtlasWorkspaceListRow[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "workspaces"),
  ).workspaces;
}

/** `GET /api/workspaces/{id}`. Returns the un-joined row: no `worker_name`/`worker_status`. */
export async function atlasGetWorkspace(
  token: string,
  workspaceId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasWorkspace> {
  const payload = await atlasRequest({
    method: "GET",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    token,
    ...options,
  });

  return expectShape<{ workspace: AtlasWorkspace }>(payload, (value) =>
    isAtlasRowEnvelope(value, "workspace"),
  ).workspace;
}

/**
 * `GET /api/workflows?limit=` — newest-updated first.
 *
 * `limit` is the only parameter Atlas accepts here, and the response carries no total, cursor,
 * or has-more flag. Treat the result as a bounded window, never as "all workflows".
 */
export async function atlasListWorkflows(
  token: string,
  params: { limit?: number } = {},
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowDefinition[]> {
  const payload = await atlasRequest({
    method: "GET",
    path: "/api/workflows",
    token,
    query: { limit: clampAtlasLimit(params.limit) },
    ...options,
  });

  return expectShape<{ workflows: AtlasWorkflowDefinition[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "workflows"),
  ).workflows;
}

/** `GET /api/workflows/{id}`. Throws `AtlasError("not_found")` for an unknown id. */
export async function atlasGetWorkflow(
  token: string,
  workflowId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowDefinition> {
  const payload = await atlasRequest({
    method: "GET",
    path: `/api/workflows/${encodeURIComponent(workflowId)}`,
    token,
    ...options,
  });

  return expectShape<{ workflow: AtlasWorkflowDefinition }>(payload, (value) =>
    isAtlasRowEnvelope(value, "workflow"),
  ).workflow;
}

/**
 * `GET /api/workflow-runs?limit=&workflow_definition_id=` — newest-created first.
 *
 * Atlas exposes no state filter on this route, so a state filter is necessarily applied to the
 * returned window in the UI rather than pushed down to the server. The envelope key is `runs`,
 * not `workflow_runs`.
 */
export async function atlasListWorkflowRuns(
  token: string,
  params: { limit?: number; workflowDefinitionId?: string } = {},
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowRun[]> {
  const payload = await atlasRequest({
    method: "GET",
    path: "/api/workflow-runs",
    token,
    query: {
      limit: clampAtlasLimit(params.limit),
      workflow_definition_id: params.workflowDefinitionId || undefined,
    },
    ...options,
  });

  return expectShape<{ runs: AtlasWorkflowRun[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "runs"),
  ).runs;
}

/**
 * `GET /api/workflow-runs/{id}` — run, runtime nodes, runtime edges, approvals.
 *
 * Atlas caps the embedded `approvals` at its default 100 with no truncation signal
 * (`atlas/app.py:671`); a run with more approvals needs `GET /api/approvals?run_id=`, which is
 * mutation-era work and out of Phase 2 scope.
 */
export async function atlasGetWorkflowRun(
  token: string,
  runId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowRunDetail> {
  const payload = await atlasRequest({
    method: "GET",
    path: `/api/workflow-runs/${encodeURIComponent(runId)}`,
    token,
    ...options,
  });

  return expectShape<AtlasWorkflowRunDetail>(
    payload,
    (value) =>
      isAtlasRowEnvelope(value, "run") &&
      isAtlasRowListEnvelope(value, "nodes") &&
      isAtlasRowListEnvelope(value, "edges") &&
      isAtlasRowListEnvelope(value, "approvals"),
  );
}

/**
 * `GET /api/jobs?limit=` — newest-created first.
 *
 * `limit` is the only parameter; Atlas has no state, worker, or workspace filter here.
 */
export async function atlasListJobs(
  token: string,
  params: { limit?: number } = {},
  options: AtlasCallOptions = {},
): Promise<AtlasJobListRow[]> {
  const payload = await atlasRequest({
    method: "GET",
    path: "/api/jobs",
    token,
    query: { limit: clampAtlasLimit(params.limit) },
    ...options,
  });

  return expectShape<{ jobs: AtlasJobListRow[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "jobs"),
  ).jobs;
}

/** `GET /api/jobs/{id}`. Returns the un-joined row: no `worker_name`/`workspace_key`. */
export async function atlasGetJob(
  token: string,
  jobId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasJob> {
  const payload = await atlasRequest({
    method: "GET",
    path: `/api/jobs/${encodeURIComponent(jobId)}`,
    token,
    ...options,
  });

  return expectShape<{ job: AtlasJob }>(payload, (value) => isAtlasRowEnvelope(value, "job")).job;
}

// ---------------------------------------------------------------------------
// Read operations added in Phase 3, for the surfaces mutations act on.
// ---------------------------------------------------------------------------

/**
 * `GET /api/approvals?limit=&state=&run_id=` — newest-first.
 *
 * Needed as its own call because `GET /api/workflow-runs/{id}` truncates its embedded
 * `approvals` at Atlas's default 100 with no truncation signal (`atlas/app.py:671`).
 */
export async function atlasListApprovals(
  token: string,
  params: { limit?: number; state?: string; runId?: string } = {},
  options: AtlasCallOptions = {},
): Promise<AtlasApproval[]> {
  const payload = await atlasRequest({
    method: "GET",
    path: "/api/approvals",
    token,
    query: {
      limit: clampAtlasLimit(params.limit),
      state: params.state || undefined,
      run_id: params.runId || undefined,
    },
    ...options,
  });

  return expectShape<{ approvals: AtlasApproval[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "approvals"),
  ).approvals;
}

/** `GET /api/deliveries?limit=&run_id=&status=`. Requires the `deliveries.read` permission. */
export async function atlasListDeliveries(
  token: string,
  params: { limit?: number; runId?: string; status?: string } = {},
  options: AtlasCallOptions = {},
): Promise<AtlasDelivery[]> {
  const payload = await atlasRequest({
    method: "GET",
    path: "/api/deliveries",
    token,
    query: {
      limit: clampAtlasLimit(params.limit),
      run_id: params.runId || undefined,
      status: params.status || undefined,
    },
    ...options,
  });

  return expectShape<{ deliveries: AtlasDelivery[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "deliveries"),
  ).deliveries;
}

/**
 * `GET /api/workflow-runs/{id}/artifacts` — every artifact of the run.
 *
 * Deliberately unbounded on Atlas's side: the route iterates the full set by rowid keyset so a
 * run whose nodes collected more than a page is not silently truncated (`atlas/app.py:679-681`).
 */
export async function atlasListRunArtifacts(
  token: string,
  runId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasArtifact[]> {
  const payload = await atlasRequest({
    method: "GET",
    path: `/api/workflow-runs/${encodeURIComponent(runId)}/artifacts`,
    token,
    ...options,
  });

  return expectShape<{ artifacts: AtlasArtifact[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "artifacts"),
  ).artifacts;
}

/** `GET /api/artifacts/{id}` — metadata plus inline content for every kind but `file_ref`. */
export async function atlasGetArtifact(
  token: string,
  artifactId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasArtifact> {
  const payload = await atlasRequest({
    method: "GET",
    path: `/api/artifacts/${encodeURIComponent(artifactId)}`,
    token,
    ...options,
  });

  return expectShape<{ artifact: AtlasArtifact }>(payload, (value) =>
    isAtlasRowEnvelope(value, "artifact"),
  ).artifact;
}

/**
 * `GET /api/workflow-runs/{id}/events?limit=` — persisted run history.
 *
 * Not SSE and not resumable: there is no `after` cursor, only `limit` (default 500). Live
 * progress is Phase 4's per-job SSE; this is the durable record that survives a reload.
 *
 * These rows carry an integer `id`, so the row-envelope guards that require a string id do not
 * apply and the shape is checked directly.
 */
export async function atlasListRunEvents(
  token: string,
  runId: string,
  params: { limit?: number } = {},
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowEvent[]> {
  const payload = await atlasRequest({
    method: "GET",
    path: `/api/workflow-runs/${encodeURIComponent(runId)}/events`,
    token,
    query: { limit: clampAtlasLimit(params.limit) },
    ...options,
  });

  return expectShape<{ events: AtlasWorkflowEvent[] }>(
    payload,
    (value) =>
      value !== null &&
      typeof value === "object" &&
      Array.isArray((value as Record<string, unknown>).events),
  ).events;
}

/** `GET /api/workflow-triggers?limit=&workflow_definition_id=`. */
export async function atlasListWorkflowTriggers(
  token: string,
  params: { limit?: number; workflowDefinitionId?: string } = {},
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowTrigger[]> {
  const payload = await atlasRequest({
    method: "GET",
    path: "/api/workflow-triggers",
    token,
    query: {
      limit: clampAtlasLimit(params.limit),
      workflow_definition_id: params.workflowDefinitionId || undefined,
    },
    ...options,
  });

  return expectShape<{ triggers: AtlasWorkflowTrigger[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "triggers"),
  ).triggers;
}

// ---------------------------------------------------------------------------
// Mutations (Phase 3).
//
// Same rule as the reads: one exported function per Atlas route, method and path baked in.
// Nothing here retries — a retried mutation against an API with no idempotency key is how a
// workflow gets started twice. Retry is the user's explicit choice, made in the UI.
// ---------------------------------------------------------------------------

/** What Atlas persists for a workflow definition. Layout state is structurally absent. */
export interface AtlasWorkflowWrite {
  name: string;
  description?: string;
  graph: Record<string, unknown>;
  policy: Record<string, unknown>;
}

/**
 * `POST /api/workflows` — 201.
 *
 * `id` is deliberately never sent even though Atlas would honour a client-supplied primary key
 * (`atlas/db.py:1065`): the id is Atlas's to mint, and letting the browser choose one invites a
 * collision the UI cannot detect. `triggers` is likewise not sent — Atlas validates the key but
 * never persists it (`atlas/app.py:1277`), so sending it would look like it worked.
 */
export async function atlasCreateWorkflow(
  token: string,
  workflow: AtlasWorkflowWrite,
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowDefinition> {
  const payload = await atlasRequest({
    method: "POST",
    path: "/api/workflows",
    token,
    body: {
      name: workflow.name,
      description: workflow.description ?? "",
      graph: workflow.graph,
      policy: workflow.policy,
    },
    ...options,
  });

  return expectShape<{ workflow: AtlasWorkflowDefinition }>(payload, (value) =>
    isAtlasRowEnvelope(value, "workflow"),
  ).workflow;
}

/**
 * `PUT /api/workflows/{id}` — 200.
 *
 * Atlas re-validates the merged graph and policy, then persists whichever keys the body
 * carries (`atlas/app.py:592-599`).
 *
 * `version` is deliberately **not** sent. It is a client-controlled column that Atlas never
 * increments on its own (`atlas/db.py:1102-1123`), so it is not a concurrency token and
 * bumping it on every save would only invalidate the locally stored layout, which is keyed by
 * it. Atlas offers no ETag and no `If-Match`, so the lost-update guard lives in the caller and
 * compares the server-set `updated_at` instead.
 */
export async function atlasUpdateWorkflow(
  token: string,
  workflowId: string,
  workflow: AtlasWorkflowWrite,
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowDefinition> {
  const payload = await atlasRequest({
    method: "PUT",
    path: `/api/workflows/${encodeURIComponent(workflowId)}`,
    token,
    body: {
      name: workflow.name,
      description: workflow.description ?? "",
      graph: workflow.graph,
      policy: workflow.policy,
    },
    ...options,
  });

  return expectShape<{ workflow: AtlasWorkflowDefinition }>(payload, (value) =>
    isAtlasRowEnvelope(value, "workflow"),
  ).workflow;
}

/** `DELETE /api/workflows/{id}` — 200 `{"deleted": true}`; 404 when it was already gone. */
export async function atlasDeleteWorkflow(
  token: string,
  workflowId: string,
  options: AtlasCallOptions = {},
): Promise<void> {
  const payload = await atlasRequest({
    method: "DELETE",
    path: `/api/workflows/${encodeURIComponent(workflowId)}`,
    token,
    ...options,
  });

  expectShape<{ deleted: true }>(
    payload,
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).deleted === true,
  );
}

/**
 * `POST /api/workflows/{id}/validate` — 200 `{"ok": true}`, or 400 with one message.
 *
 * The workflow must already exist: the handler looks it up first and 404s otherwise
 * (`atlas/app.py:608-610`). This is the *only* way to get Atlas's reference checks —
 * `validate_workflow_references` resolves `worker_id`/`workspace_id`/`allowed_*_ids` against
 * Atlas's own tables (`atlas/workflows.py:304`), which no client can reproduce.
 *
 * Atlas raises one `ValueError` at a time, so a rejection is a single string, never a list.
 */
export async function atlasValidateWorkflow(
  token: string,
  workflowId: string,
  candidate: { graph: Record<string, unknown>; policy: Record<string, unknown> },
  options: AtlasCallOptions = {},
): Promise<void> {
  const payload = await atlasRequest({
    method: "POST",
    path: `/api/workflows/${encodeURIComponent(workflowId)}/validate`,
    token,
    body: { graph: candidate.graph, policy: candidate.policy },
    ...options,
  });

  expectShape<{ ok: true }>(
    payload,
    (value) =>
      value !== null && typeof value === "object" && (value as Record<string, unknown>).ok === true,
  );
}

/** `POST /api/workflow-runs` — 202 with the persisted run, including its real Atlas id. */
export async function atlasStartWorkflowRun(
  token: string,
  params: { workflowDefinitionId: string; input?: Record<string, unknown> },
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowRun> {
  const payload = await atlasRequest({
    method: "POST",
    path: "/api/workflow-runs",
    token,
    body: {
      workflow_definition_id: params.workflowDefinitionId,
      input: params.input ?? {},
    },
    ...options,
  });

  return expectShape<{ run: AtlasWorkflowRun }>(payload, (value) =>
    isAtlasRowEnvelope(value, "run"),
  ).run;
}

/** The run lifecycle actions Atlas exposes under `POST /api/workflow-runs/{id}/{action}`. */
export type AtlasRunAction = "pause" | "resume" | "cancel";

/**
 * `POST /api/workflow-runs/{id}/{pause|resume|cancel}` — returns the updated run.
 *
 * `retryInterrupted` matters only for `resume`, and only for a run in `recovery_required`:
 * Atlas refuses with "workflow run requires explicit retry_interrupted authorization" unless
 * the flag is `true` (`atlas/workflows.py:480-482`). It is a deliberate authorization step —
 * retrying an interrupted node can duplicate work that a remote worker may still be doing —
 * so it is never defaulted on.
 */
export async function atlasRunAction(
  token: string,
  runId: string,
  action: AtlasRunAction,
  params: { retryInterrupted?: boolean } = {},
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowRun> {
  const payload = await atlasRequest({
    method: "POST",
    path: `/api/workflow-runs/${encodeURIComponent(runId)}/${action}`,
    token,
    body: action === "resume" ? { retry_interrupted: params.retryInterrupted === true } : {},
    ...options,
  });

  return expectShape<{ run: AtlasWorkflowRun }>(payload, (value) =>
    isAtlasRowEnvelope(value, "run"),
  ).run;
}

/** `POST /api/workflow-runs/{id}/deliver` — 202. Only a succeeded/failed run is deliverable. */
export async function atlasDeliverRun(
  token: string,
  runId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasDelivery> {
  const payload = await atlasRequest({
    method: "POST",
    path: `/api/workflow-runs/${encodeURIComponent(runId)}/deliver`,
    token,
    body: {},
    ...options,
  });

  return expectShape<{ delivery: AtlasDelivery }>(payload, (value) =>
    isAtlasRowEnvelope(value, "delivery"),
  ).delivery;
}

/**
 * `POST /api/approvals/{id}/{approve|reject|choose}`.
 *
 * The runner's return value is the whole body — `{approval, run}` — rather than a nested
 * envelope (`atlas/workflows.py:652`, emitted directly at `atlas/app.py:747`).
 *
 * Atlas splits the decision by whether the gate declares choices: `approve` is rejected with
 * "approval requires a branch choice" when it does (`atlas/workflows.py:628-629`), and
 * `choose` with "approval does not declare branch choices" when it does not
 * (`atlas/workflows.py:657-658`). The caller picks the right one from the approval row.
 */
export async function atlasDecideApproval(
  token: string,
  approvalId: string,
  decision: { kind: "approve" } | { kind: "reject" } | { kind: "choose"; choice: string },
  options: AtlasCallOptions = {},
): Promise<AtlasApprovalDecision> {
  const payload = await atlasRequest({
    method: "POST",
    path: `/api/approvals/${encodeURIComponent(approvalId)}/${decision.kind}`,
    token,
    body: decision.kind === "choose" ? { choice: decision.choice } : {},
    ...options,
  });

  return expectShape<AtlasApprovalDecision>(
    payload,
    (value) => isAtlasRowEnvelope(value, "approval") && isAtlasRowEnvelope(value, "run"),
  );
}

/** `POST /api/deliveries/{id}/retry` — 202. Atlas resets the row to pending and tries once. */
export async function atlasRetryDelivery(
  token: string,
  deliveryId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasDelivery> {
  const payload = await atlasRequest({
    method: "POST",
    path: `/api/deliveries/${encodeURIComponent(deliveryId)}/retry`,
    token,
    body: {},
    ...options,
  });

  return expectShape<{ delivery: AtlasDelivery }>(payload, (value) =>
    isAtlasRowEnvelope(value, "delivery"),
  ).delivery;
}

/** What a trigger write carries. `workflow_definition_id` is required on create. */
export interface AtlasTriggerWrite {
  workflowDefinitionId: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** `POST /api/workflow-triggers` — 201. */
export async function atlasCreateWorkflowTrigger(
  token: string,
  trigger: AtlasTriggerWrite,
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowTrigger> {
  const payload = await atlasRequest({
    method: "POST",
    path: "/api/workflow-triggers",
    token,
    body: {
      workflow_definition_id: trigger.workflowDefinitionId,
      name: trigger.name,
      type: trigger.type,
      enabled: trigger.enabled,
      config: trigger.config,
    },
    ...options,
  });

  return expectShape<{ trigger: AtlasWorkflowTrigger }>(payload, (value) =>
    isAtlasRowEnvelope(value, "trigger"),
  ).trigger;
}

/**
 * `PUT /api/workflow-triggers/{id}` — 200. Partial: only the keys sent are persisted.
 *
 * Two Atlas behaviours the caller has to know about:
 *  - `config` is replaced wholesale, never deep-merged (`atlas/db.py:1511-1512`).
 *  - `next_fire_at` is recomputed only when the body carries `type` or `config`
 *    (`atlas/app.py:802-806`), so a bare enable/disable keeps the existing schedule slot.
 *
 * There is no dedicated enable/disable route: `{ enabled }` alone is how it is done, which is
 * also why `enabled` is separable from the rest of the write here.
 */
export async function atlasUpdateWorkflowTrigger(
  token: string,
  triggerId: string,
  patch: { name?: string; type?: string; enabled?: boolean; config?: Record<string, unknown> },
  options: AtlasCallOptions = {},
): Promise<AtlasWorkflowTrigger> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.type !== undefined) body.type = patch.type;
  if (patch.enabled !== undefined) body.enabled = patch.enabled;
  if (patch.config !== undefined) body.config = patch.config;

  const payload = await atlasRequest({
    method: "PUT",
    path: `/api/workflow-triggers/${encodeURIComponent(triggerId)}`,
    token,
    body,
    ...options,
  });

  return expectShape<{ trigger: AtlasWorkflowTrigger }>(payload, (value) =>
    isAtlasRowEnvelope(value, "trigger"),
  ).trigger;
}

/** `DELETE /api/workflow-triggers/{id}` — 200. Cascades the trigger's event history. */
export async function atlasDeleteWorkflowTrigger(
  token: string,
  triggerId: string,
  options: AtlasCallOptions = {},
): Promise<void> {
  const payload = await atlasRequest({
    method: "DELETE",
    path: `/api/workflow-triggers/${encodeURIComponent(triggerId)}`,
    token,
    ...options,
  });

  expectShape<{ deleted: true }>(
    payload,
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).deleted === true,
  );
}

/**
 * `POST /api/workflow-triggers/{id}/fire` — 202.
 *
 * Only `manual`, `schedule`, and `webhook` may be fired by hand; Atlas rejects the three
 * event-driven types with "<type> triggers are fired by Atlas events" (`atlas/app.py:774-775`).
 * The response is the trigger service's own result object, not a row envelope.
 */
export async function atlasFireWorkflowTrigger(
  token: string,
  triggerId: string,
  params: { payload?: Record<string, unknown>; dedupeKey?: string } = {},
  options: AtlasCallOptions = {},
): Promise<Record<string, unknown>> {
  const result = await atlasRequest({
    method: "POST",
    path: `/api/workflow-triggers/${encodeURIComponent(triggerId)}/fire`,
    token,
    body: {
      payload: params.payload ?? {},
      ...(params.dedupeKey === undefined ? {} : { dedupe_key: params.dedupeKey }),
    },
    ...options,
  });

  return expectShape<Record<string, unknown>>(
    result,
    (value) => value !== null && typeof value === "object",
  );
}

/**
 * `POST /api/workers` — 201. An **upsert**, not a create.
 *
 * Atlas matches on `id` OR `base_url` (`atlas/db.py:1966`) and answers 201 either way, so this
 * one route is both "add worker" and "edit worker" — there is no `PUT /api/workers/{id}`. The
 * conflict target being `base_url` matters: adding a worker at a URL that already exists
 * silently edits that worker rather than creating a second one.
 *
 * A blank `token` leaves the stored credential untouched (`atlas/db.py:1972-1974`), which is
 * what lets the UI edit a worker without ever handling its secret.
 */
export async function atlasUpsertWorker(
  token: string,
  worker: {
    id?: string;
    name: string;
    base_url: string;
    role?: string;
    tags?: string[];
    token?: string;
  },
  options: AtlasCallOptions = {},
): Promise<AtlasWorker> {
  const payload = await atlasRequest({
    method: "POST",
    path: "/api/workers",
    token,
    body: {
      ...(worker.id === undefined ? {} : { id: worker.id }),
      name: worker.name,
      base_url: worker.base_url,
      role: worker.role ?? "",
      tags: worker.tags ?? [],
      // Omitted rather than sent empty, so an edit cannot blank an existing credential.
      ...(worker.token ? { token: worker.token } : {}),
    },
    ...options,
  });

  return expectShape<{ worker: AtlasWorker }>(payload, (value) =>
    isAtlasRowEnvelope(value, "worker"),
  ).worker;
}

/**
 * `DELETE /api/workers/{id}` — 200.
 *
 * Atlas refuses a worker that has job history, but a worker with workspaces and no jobs
 * deletes silently and takes every workspace row with it
 * (`workspaces.worker_id … ON DELETE CASCADE`, `atlas/db.py:211`). The caller must say so
 * before asking for confirmation.
 */
export async function atlasDeleteWorker(
  token: string,
  workerId: string,
  options: AtlasCallOptions = {},
): Promise<void> {
  const payload = await atlasRequest({
    method: "DELETE",
    path: `/api/workers/${encodeURIComponent(workerId)}`,
    token,
    ...options,
  });

  expectShape<{ deleted: true }>(
    payload,
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).deleted === true,
  );
}

/** `POST /api/workers/{id}/poll` — refreshes one worker's capability snapshot. */
export async function atlasPollWorker(
  token: string,
  workerId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasWorker> {
  const payload = await atlasRequest({
    method: "POST",
    path: `/api/workers/${encodeURIComponent(workerId)}/poll`,
    token,
    body: {},
    // A poll dials the worker itself, so it inherits that machine's latency, not Atlas's.
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: options.signal,
  });

  return expectShape<{ worker: AtlasWorker }>(payload, (value) =>
    isAtlasRowEnvelope(value, "worker"),
  ).worker;
}

/** `POST /api/workers/poll` — polls every worker, sequentially, on Atlas's side. */
export async function atlasPollAllWorkers(
  token: string,
  options: AtlasCallOptions = {},
): Promise<AtlasWorker[]> {
  const payload = await atlasRequest({
    method: "POST",
    path: "/api/workers/poll",
    token,
    body: {},
    timeoutMs: options.timeoutMs ?? 60_000,
    signal: options.signal,
  });

  return expectShape<{ workers: AtlasWorker[] }>(payload, (value) =>
    isAtlasRowListEnvelope(value, "workers"),
  ).workers;
}

/**
 * `POST /api/workspaces` — 201. Also an upsert: Atlas matches on `id`, or on the
 * `(worker_id, workspace_key)` pair (`atlas/db.py:2162-2165`). There is no `PUT`.
 */
export async function atlasUpsertWorkspace(
  token: string,
  workspace: {
    id?: string;
    worker_id: string;
    workspace_key: string;
    workspace_dir: string;
    company?: string;
    tags?: string[];
  },
  options: AtlasCallOptions = {},
): Promise<AtlasWorkspace> {
  const payload = await atlasRequest({
    method: "POST",
    path: "/api/workspaces",
    token,
    body: {
      ...(workspace.id === undefined ? {} : { id: workspace.id }),
      worker_id: workspace.worker_id,
      workspace_key: workspace.workspace_key,
      workspace_dir: workspace.workspace_dir,
      company: workspace.company ?? "",
      tags: workspace.tags ?? [],
    },
    ...options,
  });

  return expectShape<{ workspace: AtlasWorkspace }>(payload, (value) =>
    isAtlasRowEnvelope(value, "workspace"),
  ).workspace;
}

/** `DELETE /api/workspaces/{id}` — 200. Jobs that referenced it keep a null `workspace_id`. */
export async function atlasDeleteWorkspace(
  token: string,
  workspaceId: string,
  options: AtlasCallOptions = {},
): Promise<void> {
  const payload = await atlasRequest({
    method: "DELETE",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    token,
    ...options,
  });

  expectShape<{ deleted: true }>(
    payload,
    (value) =>
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).deleted === true,
  );
}

/**
 * `POST /api/jobs/{id}/cancel` — 200 with the job row.
 *
 * The returned `state` is the literal `"cancel_requested"`, not `"cancelled"`
 * (`atlas/db.py:2412` writes both the flag and the state in one statement). Cancelling an
 * already-terminal job is a silent no-op that returns the row unchanged.
 */
export async function atlasCancelJob(
  token: string,
  jobId: string,
  options: AtlasCallOptions = {},
): Promise<AtlasJob> {
  const payload = await atlasRequest({
    method: "POST",
    path: `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    token,
    body: {},
    ...options,
  });

  return expectShape<{ job: AtlasJob }>(payload, (value) => isAtlasRowEnvelope(value, "job")).job;
}

/**
 * `GET /api/artifacts/{id}/content` — the only Atlas route here that is not JSON.
 *
 * Atlas serves raw bytes with a `Content-Disposition` whose ASCII `filename` is the literal
 * string `download` (`atlas/app.py:939`), and it serves them only for `kind === "file_ref"`.
 * The bytes are returned rather than parsed, so a route handler can stream them to the browser
 * with a filename taken from the artifact's own metadata.
 *
 * This bypasses `atlasRequest` because that function's contract is "the response is JSON or it
 * is a protocol error" — which is exactly right for every other route and exactly wrong here.
 */
export async function atlasDownloadArtifact(
  token: string,
  artifactId: string,
  options: AtlasCallOptions = {},
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const { atlasApiOrigin } = getServerEnv();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(
      `${atlasApiOrigin}/api/artifacts/${encodeURIComponent(artifactId)}/content`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal,
        redirect: "error",
      },
    );
  } catch (cause) {
    if (timeoutSignal.aborted) {
      throw new AtlasError("timeout", defaultMessageForKind("timeout"), { cause });
    }
    if (options.signal?.aborted) throw cause;
    throw new AtlasError("network", defaultMessageForKind("network"), { cause });
  }

  if (!response.ok) {
    // A failure on this route still answers with Atlas's JSON error envelope.
    const kind = atlasErrorKindForStatus(response.status);
    let atlasMessage: string | undefined;
    try {
      atlasMessage = readAtlasErrorMessage(await response.json());
    } catch {
      atlasMessage = undefined;
    }
    throw new AtlasError(kind, atlasMessage ?? defaultMessageForKind(kind), {
      status: response.status,
      fromAtlas: atlasMessage !== undefined,
    });
  }

  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

/**
 * `GET /api/jobs/{job_id}/events?after=<seq>` — the per-job SSE stream (Phase 4).
 *
 * A typed, fixed operation like every other export: the path and the single query parameter
 * Atlas accepts are decided here, not by the caller. It bypasses `atlasRequest` because the
 * response is a long-lived `text/event-stream`, not JSON, and it must not carry an overall
 * timeout — a healthy stream is *supposed* to stay open. The timeout below bounds only the
 * connect phase (dial + status + headers) and is disarmed the moment headers arrive; from
 * then on the caller's `signal` (the browser client going away) is the only thing that ends
 * the request from our side. Atlas itself sends `Connection: close` on this route.
 */
export async function atlasOpenJobEventStream(
  token: string,
  jobId: string,
  after: number,
  signal?: AbortSignal,
): Promise<Response> {
  const { atlasApiOrigin } = getServerEnv();

  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    // The listener stays for the stream's lifetime: a client disconnect must cancel the
    // upstream Atlas read, or every abandoned tab would hold an Atlas thread open.
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const connectTimer = setTimeout(() => controller.abort(), DEFAULT_ATLAS_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(
      `${atlasApiOrigin}/api/jobs/${encodeURIComponent(jobId)}/events?after=${after}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: controller.signal,
        redirect: "error",
      },
    );
  } catch (cause) {
    clearTimeout(connectTimer);
    if (signal?.aborted) throw cause;
    if (controller.signal.aborted) {
      throw new AtlasError("timeout", defaultMessageForKind("timeout"), { cause });
    }
    throw new AtlasError("network", defaultMessageForKind("network"), { cause });
  }
  clearTimeout(connectTimer);

  if (!response.ok) {
    const kind = atlasErrorKindForStatus(response.status);
    let atlasMessage: string | undefined;
    try {
      atlasMessage = readAtlasErrorMessage(await response.json());
    } catch {
      atlasMessage = undefined;
    }
    throw new AtlasError(kind, atlasMessage ?? defaultMessageForKind(kind), {
      status: response.status,
      fromAtlas: atlasMessage !== undefined,
    });
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (contentType.toLowerCase() !== "text/event-stream") {
    throw new AtlasError("protocol", defaultMessageForKind("protocol"), {
      status: response.status,
    });
  }
  return response;
}
