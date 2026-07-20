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

**Found while implementing Phase 4 (2026-07-21):** the job stream costs Atlas one handler
thread _per connected client_ for the stream's whole lifetime, and each such thread polls
SQLite every 0.4 s (`atlas/app.py:948-977`: a `while True` over `get_job_events_after` with
`time.sleep(0.4)`). There is no shared fan-out — ten open browser tabs on one job are ten
threads running ten identical queries. The 0.4 s poll is also the stream's latency floor.

Frontend mitigation:

- Subscribe to per-job streams (per runtime-node `job_id`) for text/output.
- Refetch run detail after state-changing events; guard idle streams against proxy timeouts since there is no heartbeat.
- Show a reconnecting/gap state instead of claiming complete live history.
- Bound concurrent streams per page (the run detail page holds at most 4) and close every
  stream on unmount and on terminal `close`, so abandoned tabs never pin Atlas threads. The
  same-origin proxy route propagates a browser disconnect to Atlas as an upstream abort.

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

### P0 — Keep-alive connection desync after a rejected POST

**Found during Phase 1 implementation (2026-07-20) and reproduced against Atlas `595ef62`.** This is a new finding, not carried over from Phase 0.

Atlas advertises HTTP/1.1 with keep-alive (`protocol_version = "HTTP/1.1"`, `atlas/app.py:156`) but rejects unauthorized and forbidden requests **before reading the request body** (`atlas/app.py:237-242`). The undrained body stays in the socket, so the next request reused on that connection is parsed starting at the leftover bytes. Its request line becomes something like `{}POST /api/auth/login`, and Python's `BaseHTTPRequestHandler` answers **501 "Unsupported method"** with an **HTML** body — no `{"error": ...}` envelope.

The damage lands on the _wrong_ request: the rejected POST returns a correct 401, and an unrelated later request on the pooled connection fails instead. Observed rate in a plain sequence of `POST /api/auth/logout` (401) followed by `POST /api/auth/login`: roughly two failures in five iterations under Node's default connection pooling.

Related: because `do_PATCH`/`do_HEAD` are not defined either, any `PATCH` or `HEAD` to `/api/*` also returns a 501 HTML body rather than the JSON error envelope.

Frontend mitigation (in place):

- `src/lib/atlas-api.server.ts` sends `Connection: close` on every POST, so no connection is reused after a request that may be rejected pre-body-read. Verified to eliminate the failure entirely; `GET` needs no such treatment because it carries no body.
- The client validates `content-type` before parsing, so a 501 HTML page is normalised to an `AtlasError` rather than crashing a JSON parse.
- Regression coverage: `tests/contract/auth.contract.test.ts` ("survives repeated rejected POSTs"), which fails without the workaround.

Cost of the mitigation: one extra TCP handshake per mutation on a private network. Remove the header once Atlas is fixed.

Backend follow-up:

- Drain (or refuse with `Connection: close`) the request body on the 401/403 rejection paths in `_handle_api`.
- Define `do_PATCH`/`do_HEAD`, or return the JSON error envelope for unsupported methods.

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

### P1 — No time-windowed aggregate is reachable by a `read` role

Found while wiring the Phase 2 dashboard. `/api/metrics` is the only aggregate endpoint the `read` permission reaches (`atlas/app.py:1195`), and every figure in it is a lifetime `COUNT(*)`/`SUM` over the whole table (`atlas/db.py:753-786`) — there is no "last 24 hours" variant, no per-workflow success rate, and no `runs_24h` on a workflow definition. The only time-bounded aggregate is `GET /api/usage?from=&to=`, which requires `audit.read` (`atlas/app.py:1189-1190`) and is therefore unavailable to `operator` and `viewer` — the two roles most likely to be watching a dashboard.

Frontend mitigation:

- Show lifetime totals and label them as such. The scaffold's hardcoded "98.1% success · 24h" card was removed rather than re-derived, and the dashboard states that Atlas provides no 24-hour aggregate to this role.
- Never compute a headline rate from the rows a bounded list request happened to return; that is a page total presented as a fleet total.

Backend follow-up:

- Add windowed run/job aggregates (success rate, throughput, p50/p95 duration) to `/api/metrics`, reachable with `read`.
- Consider per-definition counters on `GET /api/workflows` so a workflow list can show activity without N extra requests.

### P1 — List endpoints have no state or entity filters

Confirmed: `GET /api/jobs` accepts `limit` and nothing else (`atlas/db.py:2605-2618`), and `GET /api/workflow-runs` accepts `limit` plus `workflow_definition_id` only (`atlas/db.py:1176-1185`). There is no `state`, `worker_id`, `workspace_id`, `conversation_id`, or time-range filter on either.

Consequence: any state filter is necessarily applied to the window already returned. "No failed jobs" then means "none in the newest N", which is a materially different claim.

Frontend mitigation:

- Apply state filters client-side over the fetched window and say so in the UI, so an empty table is not read as "no such rows exist".
- Push `workflow_definition_id` down to Atlas, since that one filter is real.

Backend follow-up:

- Add `state` and time-range filters to the job and run list endpoints, and a total or `has_more` so a filtered empty result is unambiguous.

### P1 — Run list rows carry the whole graph snapshot

Confirmed: `list_workflow_runs` is `SELECT *` (`atlas/db.py:1178`, `1181`), and migration 004 added `graph_snapshot`/`policy_snapshot` to the row (`atlas/db.py:504-511`). Every list row therefore carries a full copy of the workflow graph the run started on — fields the Atlas OpenAPI `WorkflowRun` schema does not even list. A 500-row window can be several megabytes of graph JSON for a table that renders none of it.

Frontend mitigation:

- Map runs server-side and drop both snapshots before the response crosses to the browser (`toRunView`). The run detail page reads the snapshot-free view too; nothing in Phase 2 needs the snapshot.

Backend follow-up:

- Select explicit columns for the list route, or gate the snapshots behind an opt-in query parameter.

### P2 — Run detail truncates approvals silently at 100

Confirmed: `GET /api/workflow-runs/{id}` calls `list_approvals(run_id=…)` positionally, so the default `limit=100` applies (`atlas/app.py:671`, `atlas/db.py:1396-1413`). A run with more than 100 approvals returns only the newest 100, with no total and no truncation flag. The embedded `nodes` and `edges` have no limit at all, so the inconsistency is easy to miss.

Frontend mitigation:

- Treat exactly 100 approvals as "may be truncated" and say so; it is the only signal available, and it is genuinely ambiguous.

Backend follow-up:

- Accept a `limit` on the run detail route, or return a total alongside the embedded list.

### P2 — By-id and list responses have different shapes for the same entity

Confirmed for two entities: `GET /api/workspaces` joins `workers.name`/`workers.status` onto each row (`atlas/db.py:2202-2212`) while `GET /api/workspaces/{id}` is a plain `SELECT *` (`atlas/db.py:2197-2200`); `GET /api/jobs` joins `worker_name`/`workspace_key` (`atlas/db.py:2605-2618`) while `GET /api/jobs/{id}` does not (`atlas/db.py:2600-2603`). The Atlas OpenAPI document models each entity with a single schema, so the asymmetry is invisible from the spec alone.

Frontend mitigation:

- Type the two shapes separately and map them separately. The job detail pane reports a null worker name rather than borrowing one from a stale list row, which would display data Atlas never sent.

Backend follow-up:

- Make the by-id routes return the same joined shape as their list counterparts, or document the difference in the OpenAPI schema.

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

### P1 — Workflow validation reports one problem at a time, as prose

Confirmed: every rule in `validate_workflow_graph`, `validate_workflow_references`, and
`validate_workflow_policy` raises a bare `ValueError`, which the dispatcher turns into
`{"error": "<one sentence>"}` with status 400 (`atlas/app.py:250-251`). There is no error list,
no field path, and no machine-readable code — so a graph with five problems takes five round
trips to fix, and the client cannot tell which node a message is about except by reading it.

Frontend mitigation:

- Validate locally against the same rule set before saving, so the user sees every problem at
  once with each one anchored to its node, edge, or policy field.
- Parse the subject back out of Atlas's sentence (`mapAtlasValidationMessage`) for the checks
  only Atlas can do, and fall back to a graph-level message rather than guessing.

Backend follow-up:

- Return a list of `{code, message, path}` from `/validate` (and from create/update rejections)
  instead of the first exception.

### P1 — Worker and workspace writes are upserts keyed on a natural key

Confirmed: there is no `PUT /api/workers/{id}` or `PUT /api/workspaces/{id}` (the only `PUT`
routes are users, tokens, workflows, and workflow-triggers). `POST /api/workers` matches
`WHERE id = ? OR base_url = ?` (`atlas/db.py:1966`) and `POST /api/workspaces` matches
`WHERE id = ? OR (worker_id = ? AND workspace_key = ?)` (`atlas/db.py:2162-2165`); both answer
`201` whether they inserted or updated. So "add a worker" at an existing `base_url` silently
edits that worker, and the response cannot be used to tell which happened.

Separately, `DELETE /api/workers/{id}` refuses a worker with job history but deletes one with
workspaces and no jobs — cascading every workspace row with it
(`workspaces.worker_id … ON DELETE CASCADE`, `atlas/db.py:211`), with no warning in the response.

Frontend mitigation:

- Detect the natural-key collision before submitting and say which worker will be edited.
- Never offer "overwrite" while editing a different row; the two-row match is ambiguous in Atlas
  and can violate the `base_url` unique constraint as a 500.
- List the workspaces a worker delete will take with it, before confirming.

Backend follow-up:

- Add explicit `PUT` routes, or distinguish created-vs-updated in the response.
- Reject or explicitly confirm a cascading worker delete.

### P2 — A human gate has no approver and no deadline

Confirmed: `humanGateNode` in `docs/specs/workflow-definition.schema.json` is
`additionalProperties: false` with only `id`, `type`, `label`, `reason`, and `choices` — there is
no assignee, role, or timeout field — and `atlas/workflows.py:986-999` parks the run in
`waiting_for_human` with no deadline. Any identity holding `approvals.decide` (admin or
operator) can decide any pending approval, and a gate waits indefinitely.

Frontend mitigation:

- Say so in the gate inspector rather than offering an approver or timeout field that would be
  accepted by the form and dropped on save.
- Present `policy.max_minutes` as the only time bound that exists.

Backend follow-up:

- Add per-gate assignment and expiry if approvals need to be routed or time-bounded.

### P2 — Only a `file_ref` artifact has downloadable bytes, and its filename is not in the header

Confirmed: `GET /api/artifacts/{id}/content` rejects any artifact whose `kind` is not
`file_ref` with `400 artifact is not a file_ref` (`atlas/app.py:931-932`), and the
`Content-Disposition` it sets uses the literal ASCII filename `download` with the real name only
in the RFC 5987 `filename*` parameter (`atlas/app.py:939`). The whole file is read into memory
with a fixed `Content-Length` and no range support (`atlas/app.py:936-946`).

Frontend mitigation:

- Offer a download only for `file_ref`; render the other kinds inline from the metadata route.
- Build the `Content-Disposition` from the artifact's own `metadata.filename` when proxying.

Backend follow-up:

- Set a correct ASCII `filename`, and stream rather than buffer, if large artifacts are expected.

### P2 — A trigger's workflow cannot be changed, and its config is replaced wholesale

Confirmed: `update_workflow_trigger` persists only `name`, `type`, `config`, `enabled`,
`last_fired_at`, and `next_fire_at` (`atlas/db.py:1499-1506`), so a `workflow_definition_id` in
the body is silently ignored — but `_prepare_workflow_trigger` still validates it against the
merged row, so sending an unknown one is a 400 for a field that would not have been saved. The
`config` object is replaced, never deep-merged (`atlas/db.py:1511-1512`), and `next_fire_at` is
recomputed only when the body carries `type` or `config` (`atlas/app.py:802-806`).

Frontend mitigation:

- Do not offer to move a trigger between workflows; state that Atlas cannot.
- Send the whole config on every edit, and send `{enabled}` alone for enable/disable so a bare
  toggle does not reschedule a daily trigger.

Backend follow-up:

- Either honour `workflow_definition_id` on update or reject it explicitly.

### P2 — No global artifact listing

**Confirmed while wiring Phase 5 (2026-07-21).** Artifacts are reachable only through their
scope: `GET /api/workflow-runs/{id}/artifacts`, `GET /api/jobs/{id}/artifacts`, and by-id
metadata/content. `GET /api/artifacts` is not a route at all (the dispatcher only handles
`POST` there, which _creates_ an inline artifact) — confirmed 404 by contract test. There is
no cross-run listing, search, or deletion.

Frontend mitigation:

- The `/artifacts` page states the limitation, shows the lifetime count from `/api/metrics`,
  and routes the user to run detail. It does not simulate a ledger by sweeping every run.

Backend follow-up:

- Add a bounded, filterable `GET /api/artifacts` (by run, kind, key, date) if a global view is
  wanted.

### P2 — Conversations are a fixed latest-100 window with no item routes

Confirmed: `list_conversations` hardcodes `LIMIT 100 ORDER BY updated_at DESC` and takes no
parameter (`atlas/db.py:2245-2248`); the dispatcher has no conversation get-by-id, update, or
delete route (all 404, contract-tested). Rows older than the newest 100 are unreachable
through the API.

Frontend mitigation:

- The page states the fixed window, filters client-side over the loaded rows only (and says
  so), and offers no Edit/Delete.

Backend follow-up:

- Add `limit`/pagination and item routes if conversations need management.

### P2 — Both CSV exports are named `atlas-usage.csv`, and `GET /api/usage` is unbounded

Confirmed: the shared `_csv` helper hardcodes `Content-Disposition: attachment;
filename="atlas-usage.csv"` for **both** the usage and the audit export
(`atlas/app.py:1133-1141`), so an audit export saves under a usage filename. Separately,
`GET /api/usage` accepts no `limit` — the inclusive date range is the only size control, and a
wide range returns the whole ledger in one JSON/CSV response.

Frontend mitigation:

- The same-origin export routes set their own correct filenames (`atlas-audit.csv` /
  `atlas-usage.csv`) when relaying.
- The usage page renders at most 200 rows, states the cap, and points to the CSV for the
  complete range; the Atlas call uses a wider timeout.

Backend follow-up:

- Name the audit export correctly; add a `limit` or pagination to `/api/usage`.

### P2 — A `blocked` delivery can only arise from allowlist drift

Confirmed while writing the Phase 5 contract tests: `validate_run_input_envelope` fail-closes
a non-allowlisted `_meta.reply.callback_url` at run **start** (`atlas/workflows.py:94-131`),
and delivery attempts re-validate against the **current** allowlist. So with a stable
`ATLAS_OUTBOUND_ALLOWLIST`, no run that could produce a `blocked` delivery can be created; a
row becomes `blocked` only when the allowlist shrinks (or the secret key disappears) between
run creation and delivery. Also note `_META_REPLY_MODES` is exactly `{webhook, none}`.

Frontend consequence:

- The deliveries UI still offers retry on `blocked` (Atlas re-validates against the current
  allowlist, which is exactly the fix-then-retry flow), but tests prove the retry path on
  `failed` and assert the fail-closed start rejection, because a blocked row cannot be
  manufactured against a fixed-allowlist instance.

## Exit criteria for revisiting scale

Move the architecture discussion back to Atlas before claiming higher scale when any of these become true:

- multiple Atlas replicas are required
- workflow runs must survive host loss without instance-local recovery
- event volume causes noticeable write contention or stream lag
- shared multi-tenant hosting is required
- run/event retention exceeds practical single-file backup windows
- job scheduling needs distributed fairness or global concurrency limits
