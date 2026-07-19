# Atlas limitations and future backend backlog

This document records limitations that belong to Atlas Control Plane, not to the frontend. The frontend must mitigate them where possible without creating a second source of truth.

## Current limitations

### P0 — Single-node persistence and runtime

Atlas currently uses SQLite persistence with an in-process lock and WAL connection setup in `atlas/db.py`. The HTTP server is threaded and workflow/job execution uses in-process background threads. This is suitable for a single active Atlas instance, but it is not a transparent active-active cluster.

Consequences:

- Do not run multiple Atlas writers against independent databases behind a load balancer.
- A shared network filesystem is not a substitute for a database cluster.
- There is no native read-replica/failover contract for live run state.
- Runtime ownership and recovery are local to an Atlas process.

Frontend mitigation:

- Treat Atlas as one primary origin.
- Cache reads with TanStack Query and use bounded pagination.
- Avoid polling every page aggressively.
- Use Atlas metrics for aggregates.
- Reconnect streams and refetch authoritative state after a disconnect.

Backend follow-up:

- Define a database abstraction and migrate durable state to a server database when required.
- Add distributed leases/ownership for workflow runners and callback/delivery workers.
- Separate durable event storage from ephemeral stream transport.
- Add a tested leader election or queue consumer model.

### P0 — Event streaming is asymmetric

Confirmed: the only `text/event-stream` handler is per-**job** (`GET /api/jobs/{job_id}/events`), with an `after=<seq>` replay cursor and a terminal `event: close` — but **no heartbeat**. Workflow-**run** events are poll-only persisted JSON (`GET /api/workflow-runs/{run_id}/events`, `limit`-only, no `after`/cursor). There is no unified live stream for a whole workflow graph.

Frontend mitigation:

- Subscribe to per-job streams (per runtime-node `job_id`) for text/output.
- Refetch run detail after state-changing events; guard idle streams against proxy timeouts since there is no heartbeat.
- Show a reconnecting/gap state instead of claiming complete live history.

Backend follow-up:

- Add a versioned run-event stream with sequence, replay, heartbeat, and terminal semantics.
- Add a heartbeat/keepalive to the job stream and an `after` cursor to run events.

### P1 — No explicit API version namespace

The current contract uses `/api/...` routes and an OpenAPI document rather than a versioned URL namespace. A backend change can therefore break the UI if response fields or state names change silently.

Frontend mitigation:

- Centralize all calls in `atlas-api.server.ts`.
- Keep mappers at the boundary.
- Pin the Atlas commit/version tested in release notes.
- Add contract fixtures and fail closed on unsupported graph/node states.

Backend follow-up:

- Publish compatibility policy and schema version headers.
- Version breaking API changes.
- Expose the Atlas build/schema version in `/api/health` or a safe metadata endpoint.

### P1 — Multi-tenancy boundary is not a frontend concern

The current Atlas architecture describes the instance as the tenant and does not make a pooled multi-tenant database boundary the UI can enforce by itself.

Frontend mitigation:

- Do not add a fake `tenant_id` to UI-only models.
- Display the current Atlas instance identity.
- Do not claim cross-tenant isolation.

Backend follow-up:

- Decide instance-per-tenant versus pooled multi-tenancy.
- Add tenant-scoped authorization, audit, quotas, and tests before exposing shared hosting.

### P1 — Worker contract evolution

The worker contract documents outstanding needs such as a capabilities endpoint and protocol/schema version. Worker status, model catalog, event names, and cancellation semantics can evolve.

Frontend mitigation:

- Render unknown capabilities/events safely.
- Use Atlas-provided capability snapshots.
- Do not hardcode model lists or assume every worker supports every node.

Backend follow-up:

- Add a versioned capabilities contract.
- Add native job status/cancel and stream resume where supported.
- Surface worker compatibility warnings in API responses.

### P1 — Backpressure and event volume

Long-running jobs can produce large event histories. A frontend cannot solve unbounded backend retention or write pressure.

Frontend mitigation:

- Window/virtualize logs.
- Fetch history in pages.
- Throttle UI updates while preserving event sequence.
- Avoid refetching dashboard aggregates for every text event.

Backend follow-up:

- Define retention/compaction rules.
- Add event pagination by sequence.
- Add stream backpressure and per-client limits.
- Consider a dedicated event broker for high-volume deployments.

### P2 — Settings and operational configuration surface

The UI scaffold has a Settings page, but a complete safe Atlas settings API is not established for every displayed value.

Frontend mitigation:

- Keep unavailable values read-only or mark them unavailable.
- Never create a fake local settings store that implies it controls Atlas.

Backend follow-up:

- Publish safe read-only configuration metadata.
- Add authenticated, audited mutation endpoints for settings that are intended to be operator-controlled.

### P0 (security) — Auth token lifecycle: non-expiring tokens, orphan accumulation, no login rate limiting

**Production release blocker** for anything beyond local/demo use. Confirmed in Atlas source:

- The `api_tokens` table has **no `expires_at`** column (`atlas/db.py:172`). Login/session tokens never expire; they are valid until explicitly revoked.
- `POST /api/auth/login` mints a **new** token named `"dashboard login"` on every successful login (`atlas/app.py:263`), so repeated logins accumulate orphaned but still-valid tokens.
- No login brute-force protection / rate limiting was found on `verify_user_password`.

Consequence for the frontend: a flow-designer session cookie expiring does **not** revoke the underlying Atlas token.

Frontend mitigation (bounded, not a fix):

- Call Atlas `POST /api/auth/logout` on logout (it revokes the current token).
- Keep the session cookie short-lived; accept that re-login re-mints tokens until backend cleanup exists.
- A reverse-proxy rate limit in front of `POST /api/auth/login` is a temporary brute-force mitigation.

Backend follow-up (**required before production release**):

- Add `expires_at`/TTL to login/session tokens and expire them.
- Add cleanup/revocation of orphaned `"dashboard login"` tokens (reuse-or-cap per user).
- Add login brute-force/rate limiting in Atlas.

### P1 — No mutation idempotency or optimistic concurrency

Confirmed in Atlas source: no mutation endpoint accepts `Idempotency-Key`, `ETag`, or `If-Match` (no matches across `atlas/` or the OpenAPI spec). The `workflow_definitions.version` column is stored and returned but never checked or incremented on update (`atlas/db.py` `update_workflow_definition`), so concurrent `PUT`s are last-write-wins. Idempotency that exists is internal and per-write-type (usage-event unique key, delivery deterministic id, worker-callback replay) plus state-guarded conditional updates (approvals, run finalization) — not a caller-facing contract.

Frontend mitigation:

- Disable duplicate submits; treat `409` as a conflict.
- Re-read after mutation and reconcile; surface conflicts instead of silently overwriting.
- Do not fabricate an idempotency guarantee the backend does not provide.

Backend follow-up:

- Add caller-supplied `Idempotency-Key` for non-idempotent POSTs.
- Add `ETag`/`If-Match` (or enforce the `version` column) for workflow and resource updates.

### P1 — Pagination and aggregate contracts are limit-only

Confirmed: list endpoints take `?limit` only (clamped 1..10000, newest-first); there is no offset, cursor, or page parameter, and list responses return a bare array with no total/count (`atlas/app.py` `_parse_limit`; `atlas/db.py` `list_*`). Aggregate counts exist only at `/api/metrics` and `/api/usage`.

Frontend mitigation:

- Treat lists as a bounded most-recent window, not true pagination; do not imply "page 2" the backend cannot serve.
- Use `/api/metrics` and `/api/usage` for headline totals.

Backend follow-up:

- Add a consistent pagination contract (cursor or offset + total) across list endpoints.

### P1 — Artifact storage and retention

Confirmed: artifact content is stored inline in the SQLite `artifacts.content` column for text/json/markdown/summary/decision kinds; only `file_ref` artifacts point to bytes in a flat local upload directory (`atlas/db.py`; `atlas/app.py` upload path). There is no S3/object storage (stdlib-only, no dependency manifest). Retention exists only as a manual operator CLI, `atlas admin purge-artifacts --older-than-days N` — no automatic/scheduled policy, compaction, or size cap.

Frontend mitigation:

- Download through Atlas authorization; never guess storage paths.
- Do not assume unlimited history; page artifact/event lists.

Backend follow-up:

- Move large/binary artifacts to object storage; add automatic retention/compaction and size caps.

### P2 — Build/schema metadata present, readiness probe absent

Confirmed: version/schema metadata IS exposed — `GET /healthz` returns `{ ok, service, version }` and `GET /api/metrics` includes `version` and `schema_version`. But `GET /api/health` is shallow (`{ ok, service, db, workers }`, no version/schema), and `/healthz` is liveness-only (always ok while the process runs); there is no dependency-gated readiness probe.

Frontend mitigation:

- Pin and display the tested Atlas commit/version (from `/api/metrics`).
- Do not treat `/healthz` as readiness.

Backend follow-up:

- Add a dependency-gated readiness endpoint and expose build/schema/API version consistently.

### P2 — Operational observability is minimal

Confirmed: structured request logging is opt-in via `ATLAS_REQUEST_LOG` (off by default; query strings deliberately omitted so `?token=` is not logged); modules use stdlib `logging` with no configured pipeline; `/api/metrics` is a JSON counter snapshot, not Prometheus exposition; and there is no tracing (no OpenTelemetry).

Frontend mitigation:

- Do not rely on backend traces for UI diagnostics; keep client-side error/latency instrumentation self-contained and privacy-safe.

Backend follow-up:

- Add structured logging, a metrics/exposition endpoint, and request tracing/correlation IDs.

### P2 — No workflow layout persistence endpoint

Confirmed: Atlas stores the semantic graph only, and the visual-builder spec keeps layout separate (`docs/specs/workflow-visual-builder-spec-en.md` §13). There is no Atlas endpoint to persist node positions/viewport.

Frontend mitigation:

- Store layout locally (localStorage), keyed by workflow id + graph version, with an auto-layout fallback.
- Do not claim cross-device/user layout synchronization.

Backend follow-up:

- If shared layout across users/devices is required, add a layout persistence capability in Atlas, kept separate from the semantic graph JSON.

## Exit criteria for revisiting scale

Move the architecture discussion back to Atlas before claiming higher scale when any of these become true:

- multiple Atlas replicas are required
- workflow runs must survive host loss without instance-local recovery
- event volume causes noticeable write contention or stream lag
- shared multi-tenant hosting is required
- run/event retention exceeds practical single-file backup windows
- job scheduling needs distributed fairness or global concurrency limits
