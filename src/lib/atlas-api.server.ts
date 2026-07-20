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
  type AtlasWorkflowRun,
  type AtlasWorkflowRunDetail,
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
  method: "GET" | "POST";
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

  // Atlas reads bodies by Content-Length, so a POST always carries an explicit JSON body —
  // `{}` when there is nothing to send — rather than no body at all.
  const hasBody = options.method === "POST";
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
