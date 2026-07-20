# Atlas backend integration contract

Status: Phase 0 baseline

Date inspected: 2026-07-19

Atlas checkout: `/Users/seal/Documents/GitHub/atlas-control-plane`

Atlas commit inspected: `595ef62bcfa38c1135867807bfe2fae320e37b0c` (verified via `git rev-parse HEAD`; matches the review snapshot)

Primary backend references:

- `README.md`
- `docs/specs/openapi.yaml`
- `docs/specs/workflow-visual-builder-spec-en.md`
- `docs/specs/thclaws-worker-contract.md`
- `docs/architecture.md`
- `atlas/app.py`
- `atlas/db.py`
- `atlas/jobs.py`
- `atlas/workflows.py`

## Current frontend baseline

_Updated at the end of Phase 2 (2026-07-20). The original Phase 0 description of this section is preserved in git history at `c3d57b1`._

Read paths that now come from Atlas:

- `src/lib/atlas-api.server.ts` holds the typed, fixed Atlas operations; `src/lib/atlas-reads.functions.ts` is the `createServerFn` RPC boundary; `src/lib/atlas-mappers.ts` maps every response into a view model server-side.
- `dashboard.tsx`, `fleet.tsx`, `workspaces.tsx`, `workflows.index.tsx`, `workflows.$id.tsx`, `runs.index.tsx`, `runs.$id.tsx`, and `jobs.tsx` read Atlas through TanStack Query. None reads a mock collection.
- `/workflows/$id` and `/runs/$id` resolve through a route loader (SSR + a real Atlas 404); both define `errorComponent` and `notFoundComponent`.
- `src/routes/_app.tsx` is the authenticated layout and verifies the live Atlas identity on every navigation.

Mutation paths added at the end of Phase 3 (2026-07-20):

- `src/lib/atlas-api.server.ts` gained one typed, fixed operation per Atlas mutation route; `src/lib/atlas-mutations.functions.ts` is their RPC boundary and `src/lib/atlas-mutations.ts` holds the client hooks and the single invalidation table.
- `src/lib/workflow-graph.ts` is the semantic graph model — parser, serializer, validator, rename — shared by the editor, the server-side re-validation, and the tests.
- `workflows.$id.tsx` renders the Atlas-native editor; `workflows.index.tsx` creates; `triggers.tsx`, `runs.$id.tsx`, `fleet.tsx`, and `workspaces.tsx` mutate through Atlas.
- `src/routes/api.artifacts.$id.content.ts` is the one route handler: thin transport glue that streams artifact bytes with the bearer attached server-side.
- The mock store and the timer-based simulator (`workflow-scaffold-store.ts`, `workflow-simulator.ts`) are **deleted**, not disabled.

Still scaffold, with an owning phase:

- `artifacts.tsx`, `deliveries.tsx`, `conversations.tsx`, `usage.tsx`, `audit.tsx`, and `users.tsx` contain local static arrays — **Phase 5**.
- SSE is unimplemented — **Phase 4**. Live run progress is a refetch, not a stream.

## Backend capabilities confirmed

Atlas already owns:

- users, roles, bearer login, `/api/me`, API token management
- workers, worker polling and capability snapshots
- workspaces and conversations
- ad-hoc jobs, job state, job events, cancellation and artifacts
- workflow definitions, templates, validation and suggestions
- workflow runs, runtime nodes, runtime edges and approvals
- workflow triggers and trigger events
- artifacts, file content, deliveries, audit and usage
- workflow execution, pause/resume/cancel/recovery and worker calls

The thClaws worker contract used by Atlas includes `GET /healthz`, `GET /v1/agent/info`, and `POST /agent/run`. Worker streaming includes named events such as `session`, `text`, `usage`, `result`, and `error`, followed by `[DONE]`.

## UI-to-Atlas endpoint map

| UI surface          | Atlas endpoint(s)                                                            | Notes                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth                | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`               | Atlas owns credentials and bearer issuance                                                                                                                                                      |
| Users               | `GET/POST /api/users`, `GET/PUT/DELETE /api/users/{id}`                      | Admin-only mutations                                                                                                                                                                            |
| API tokens          | `GET/POST /api/tokens`, token update/revoke endpoints                        | Raw token is returned once                                                                                                                                                                      |
| Dashboard           | `/api/metrics`, `/api/workers`, `/api/workflows`, `/api/workflow-runs`       | Prefer aggregate metrics for headline cards                                                                                                                                                     |
| Fleet               | `/api/workers`, `/api/workers/poll`, `/api/workers/{id}/poll`                | Worker tokens never reach the browser                                                                                                                                                           |
| Workspaces          | `/api/workspaces`, `/api/workspaces/{id}`                                    | Workspace directory is on the worker machine                                                                                                                                                    |
| Conversations       | `/api/conversations`                                                         | Session binding is Atlas-owned                                                                                                                                                                  |
| Jobs                | `/api/jobs`, `/api/jobs/{id}`, `/api/jobs/{id}/cancel`                       | Job response may include worker/workspace projections                                                                                                                                           |
| Job stream          | `GET /api/jobs/{job_id}/events?after=<seq>`                                  | SSE (`text/event-stream`). Resume with `after=<last seq>`; dedupe by `id`/`seq`; a normal stream ends with `event: close`. No `Last-Event-ID`, no heartbeat. See "Job event SSE contract" below |
| Workflows           | `/api/workflows`, `/api/workflow-templates`, `/api/workflows/{id}`           | Use the graph serializer below                                                                                                                                                                  |
| Workflow validation | `/api/workflows/{id}/validate`                                               | Validate before enabling/running                                                                                                                                                                |
| Workflow run        | `POST /api/workflow-runs`                                                    | Returns `202` for async start                                                                                                                                                                   |
| Run detail          | `GET /api/workflow-runs/{id}`                                                | Includes run, runtime nodes, edges, approvals                                                                                                                                                   |
| Run actions         | `/pause`, `/resume`, `/cancel`, `/deliver`                                   | Mutations must reconcile query state                                                                                                                                                            |
| Run events          | `GET /api/workflow-runs/{run_id}/events`                                     | Persisted JSON history `{ events: [...] }` (per-run `seq`, `limit` only, default 500). Not SSE, no `after` cursor. Poll/refetch; combine with per-job SSE for live progress                     |
| Approvals           | `/api/approvals`, `/api/approvals/{id}/approve`, `/reject`, `/choose`        | Required for human gates                                                                                                                                                                        |
| Run artifacts       | `/api/workflow-runs/{id}/artifacts`, `/files`, `/api/artifacts/{id}/content` | Download through Atlas authorization                                                                                                                                                            |
| Triggers            | `/api/workflow-triggers`, `/{id}`, `/{id}/fire`, `/{id}/events`              | Atlas owns schedule/webhook/internal trigger logic                                                                                                                                              |
| Deliveries          | `/api/deliveries`, `/api/deliveries/{id}/retry`                              | Return-path delivery ledger                                                                                                                                                                     |
| Audit               | `/api/audit`                                                                 | Filter and paginate; do not synthesize audit rows in UI                                                                                                                                         |
| Usage               | `/api/usage`                                                                 | Use server-provided aggregates and export actions                                                                                                                                               |
| Settings            | No complete generic settings endpoint confirmed                              | Keep deployment information read-only until Atlas exposes a safe contract                                                                                                                       |

## Data model adapters

### Worker

The UI mock combines worker and workspace data. Atlas separates them. The adapter must map:

- Atlas `last_seen_at` to a formatted `last_seen` display value.
- Atlas `agent_info` to version/capability display.
- Workspace relations to workspace keys; do not invent directories locally.
- Atlas worker state/error fields to the UI status vocabulary.

### Workflow definition

The canvas must serialize the Atlas semantic graph, not the React Flow layout object. Verified against `atlas/workflows.py` (`validate_workflow_graph`) and `docs/specs/workflow-definition.schema.json`, the graph requires:

- root `name`, `graph`, and `policy`
- graph `start`, `nodes`, and `edges`
- **every edge** carries a `condition`; the UI default is `{ "type": "always" }` (the executor defaults a missing one, but the JSON schema requires it, so always emit it)
- `join.mode` is **always** emitted (`all` | `any` | `quorum`); the schema requires it even though the executor defaults to `all`. For `quorum`, emit a positive integer `quorum` not exceeding the distinct incoming-edge count
- `manager.schema = "manager_decision_v1"` on every manager node
- no layout state or unknown UI fields in the API payload

Atlas's executor accepts **exactly four** node `type` strings — `worker`, `manager`, `join`, `human_gate` (`atlas/workflows.py:173` rejects anything else). Of the UI's eight `NodeKind`s, only these map to a native graph node; `condition`, `loop`, and `fanout` are graph/edge constructs (not nodes), and `trigger` is a separate resource. See the compatibility matrix below. Do not silently send unsupported node types.

## Workflow node compatibility matrix

Ground truth: `atlas/workflows.py` (`validate_workflow_graph` line 173, run loop lines 947–1090), `docs/specs/workflow-definition.schema.json` (`$defs/node`, `$defs/condition`), `docs/specs/workflow-visual-builder-spec-en.md` (§4.2, §9), and `docs/specs/workflow-trigger.schema.json`. Atlas commit `595ef62`.

| Editor concept                          | Atlas representation                                         | Status                          | Request fields (Atlas)                                                                                                                                                                                                   | Round-trip                                                                                                      | Validation (Atlas)                                                              | UI when unsupported                                            |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `worker`                                | node `type: "worker"`                                        | **Supported**                   | `prompt`, `worker_id`, `workspace_id`/`workspace_key`, `company`, `model`, `role`, `tags`, `outputs` (exactly 1 artifact key), `output_format:"json"`, `budget_units`, `execution:"stream"\|"callback"`, `collect_files` | 1:1 node                                                                                                        | required `id`,`type`; `outputs` exactly 1; `execution` enum                     | —                                                              |
| `manager`                               | node `type: "manager"`                                       | **Supported**                   | worker fields **plus required** `schema:"manager_decision_v1"`; output drives `manager_selected` edges                                                                                                                   | 1:1 node                                                                                                        | `schema` const `manager_decision_v1`; outgoing edges must be `manager_selected` | —                                                              |
| `join`                                  | node `type: "join"`                                          | **Supported**                   | `mode:"all"\|"any"\|"quorum"`, `quorum` (int, when quorum)                                                                                                                                                               | 1:1 node                                                                                                        | `mode` required by schema; `quorum` ≤ distinct incoming edges                   | —                                                              |
| `human_gate` (display label “Approval”) | node `type: "human_gate"`                                    | **Supported**                   | `label`, `reason`, `choices[]` (each unique `id`+`label`)                                                                                                                                                                | 1:1 node with the same internal type                                                                            | gate with `choices` requires outgoing `human_selected` edges                    | —                                                              |
| `condition`                             | **edge** `condition` object, not a node                      | **Unsupported as a node**       | edge `condition.type` ∈ `always`, `artifact_equals`, `artifact_in`, `manager_selected`, `human_selected`, `max_iterations_below`                                                                                         | Authored in the **edge inspector**; never a node, so nothing to round-trip as a node                            | any other `condition.type` rejected                                             | Edit conditions on edges; there is no `condition` palette node |
| `loop`                                  | **guarded graph cycle**, not a node                          | **Unsupported as a node**       | cycle guarded by `policy.max_iterations` (>0) or an edge `max_iterations_below` `{ node, max }`                                                                                                                          | Model as a cycle + guard; no `loop` node survives round-trip                                                    | an unguarded cycle is rejected                                                  | Express as a back-edge with a guard; do not emit a `loop` node |
| `fanout`                                | **emergent** (multiple matching outgoing edges), not a node  | **Unsupported as a node**       | none; Atlas schedules every matching outgoing edge                                                                                                                                                                       | Model as parallel edges (+ `join` to reconverge)                                                                | no `fanout` type in the allowed set                                             | Represent as parallel edges; do not emit a `fanout` node       |
| `trigger`                               | separate **workflow-trigger** resource, not in `graph.nodes` | **Unsupported as a graph node** | trigger `type` ∈ `manual`, `schedule`, `webhook`, `workflow_run_completed`, `artifact_created`, `worker_status_changed`; per `workflow-trigger.schema.json`                                                              | Export to the trigger CRUD endpoints / drafts array, never to `graph.nodes`; graph entry is the `start` node id | a `trigger` node in `graph.nodes` is rejected at `workflows.py:173`             | Route to the trigger inspector/resource, not the graph payload |

**The canvas palette exposes only the four native node types.** There are no `condition`/`loop`/`fanout`/`trigger` pseudo-nodes and no round-trip machinery to convert them: conditions are authored in the edge inspector, fan-out is multiple outgoing edges, loops are guarded back-edges, and triggers live in a separate trigger panel outside `graph.nodes`.

The current mock scaffold still contains `kind: "approval"`. Phase 3 performs a **one-time scaffold migration** to the internal `human_gate` kind before the Atlas adapter replaces mock domain state. `approval` is not a permanent API alias or a round-trip mapping.

**Round-trip fixtures were the entry requirement for Phase 3, and they exist.** `tests/fixtures/workflow-graphs.ts` holds one graph that uses all four native kinds and all six condition types together — deliberately one graph rather than four, because the interesting rules are the ones that relate kinds to each other. `tests/unit/workflow-graph.test.ts` asserts `parse → serialize` is identity for it, for each kind alone, for each condition alone, and for every policy key at its maximum; `tests/contract/mutations.contract.test.ts` posts the same fixtures to a real Atlas and reads them back.

Where the parser is strict and where it is not, and why the distinction matters:

- **Fails closed on parse** — an unknown node type, an unknown condition type, any field the schema does not declare (which is how a React Flow `position` or an edge `label` can never reach Atlas), duplicate node ids, and a blank entry in a string list. These make the workflow unopenable, and the UI says so instead of loading the part it understood and deleting the rest on the next save.
- **Opens, then flags** — rules the published schema adds but Atlas's runtime validator does not enforce: an artifact key that is not an identifier, an empty `artifact_in` list, a non-identifier node id. Atlas legitimately stores these (a pack import can write one), so refusing to open them would leave a workflow uneditable by the only tool that can fix it.

## Mutation endpoint map (verified against Atlas `595ef62`)

Every row was read out of `atlas/app.py`'s dispatcher and its handler, then re-checked by an independent pass. `PUT` and `DELETE` are genuinely routed (`atlas/app.py:164-174`); the complete `PUT` set is users, tokens, workflows, and workflow-triggers, and everything else updates by `POST` to the collection.

| Action               | Method and path                                   | Success | Response envelope        | Notes                                                                                                         |
| -------------------- | ------------------------------------------------- | ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Create workflow      | `POST /api/workflows`                             | 201     | `{workflow}`             | `graph` required; `name` optional server-side; a client-supplied `id` would be honoured, so we never send one |
| Update workflow      | `PUT /api/workflows/{id}`                         | 200     | `{workflow}`             | Re-validates the merged graph and policy; `version` is client-controlled and never incremented by Atlas       |
| Delete workflow      | `DELETE /api/workflows/{id}`                      | 200     | `{deleted: true}`        | Cascades triggers and runs                                                                                    |
| Validate workflow    | `POST /api/workflows/{id}/validate`               | 200     | `{ok: true}`             | Needs a **stored** workflow; the only path that resolves worker/workspace references                          |
| Start run            | `POST /api/workflow-runs`                         | 202     | `{run}`                  | `workflow_definition_id` required; `input` must be an object                                                  |
| Pause / cancel run   | `POST /api/workflow-runs/{id}/{pause\|cancel}`    | 200     | `{run}`                  | Pause only from `running`; cancel from any non-terminal state                                                 |
| Resume run           | `POST /api/workflow-runs/{id}/resume`             | 202     | `{run}`                  | `{retry_interrupted: true}` is **required** to resume `recovery_required`                                     |
| Deliver run          | `POST /api/workflow-runs/{id}/deliver`            | 202     | `{delivery}`             | Only a succeeded or failed run, and only with a `_meta.reply.callback_url`                                    |
| Approve / reject     | `POST /api/approvals/{id}/{approve\|reject}`      | 202/200 | `{approval, run}`        | Not nested further; `approve` is refused on a gate that declares choices                                      |
| Choose               | `POST /api/approvals/{id}/choose`                 | 202     | `{approval, run}`        | Body key is `choice`                                                                                          |
| Retry delivery       | `POST /api/deliveries/{id}/retry`                 | 202     | `{delivery}`             | Resets the row to pending and makes one attempt                                                               |
| Trigger CRUD         | `POST` / `PUT` / `DELETE /api/workflow-triggers…` | 201/200 | `{trigger}`              | `enabled` comes back as SQLite `1`/`0`; enable/disable is `PUT {enabled}`; `config` is replaced wholesale     |
| Fire trigger         | `POST /api/workflow-triggers/{id}/fire`           | 202     | `{trigger, event, run}`  | Manual, schedule, and webhook only                                                                            |
| Worker upsert        | `POST /api/workers`                               | 201     | `{worker}`               | **Upsert** matched on `id` **or** `base_url`; a blank `token` preserves the stored one                        |
| Worker delete / poll | `DELETE /api/workers/{id}`, `POST …/poll`         | 200     | `{deleted}` / `{worker}` | Delete cascades the worker's workspaces                                                                       |
| Workspace upsert     | `POST /api/workspaces`                            | 201     | `{workspace}`            | Upsert matched on `id` or `(worker_id, workspace_key)`                                                        |
| Cancel job           | `POST /api/jobs/{id}/cancel`                      | 200     | `{job}`                  | Resulting state is `cancel_requested`, not `cancelled`                                                        |
| Artifact bytes       | `GET /api/artifacts/{id}/content`                 | 200     | **raw bytes**            | `file_ref` only; the ASCII `filename` is the literal string `download`                                        |

Rejections are always a single `{"error": "<one sentence>"}` with status 400 — there is no error list and no field path. `mapAtlasValidationMessage` reads the subject back out of the sentence so a server rejection lands on the same node the local checks would have highlighted.

## Job event SSE contract

Verified against `atlas/app.py` (`_stream_job_events`, `_is_authorized`), `atlas/db.py` (`get_job_events_after`), and `docs/specs/openapi.yaml`. Atlas commit `595ef62`.

- **Endpoint:** `GET /api/jobs/{job_id}/events?after=<seq>` → `Content-Type: text/event-stream`, `Connection: close`.
- **Resume:** `after` is an **exclusive** lower bound (`seq > after`, default `0`) — resume from the last confirmed sequence. It is the only query parameter; there is **no** `Last-Event-ID`, `limit`, or `timeout`.
- **Frame shape:** each frame has `id: <seq>`, `event: <type>`, and `data:` JSON that also carries `seq` and (for data rows) `created_at`. Deduplicate by `id`/`seq`.
- **Normal end:** an explicit `event: close` with `data: { "state": <succeeded|failed|cancelled|missing> }` at `seq = last+1` once the job is terminal. Treat `close` as the terminal marker (`missing` = job row absent).
- **Disconnect:** EOF **without** a `close` frame is a mid-stream disconnect — reconnect with `after=<last seq>` and bounded exponential backoff.
- **No heartbeat:** Atlas emits no keepalive/ping, so an idle stream is exposed to proxy idle-timeouts; the reverse proxy must allow long-lived SSE (see the release runbook) and the client should treat prolonged silence conservatively.
- **Auth:** Atlas accepts the bearer as an `Authorization` header **or** a `?token=<token>` query param on GET `/events` paths (its `queryToken` scheme, for browser `EventSource`). flow-designer does **not** use the query-token path from the browser — the Atlas bearer never leaves the server. Stream through a same-origin server transport that adds the `Authorization` header server-side. The events route requires only the `read` permission, so any authenticated role can stream.
- **Run-level:** there is no unified live run stream. `GET /api/workflow-runs/{run_id}/events` is persisted JSON history; `GET /api/workflow-runs/{run_id}` returns `{ run, nodes (runtime nodes with `job_id`), edges, approvals }`. Combine per-job SSE (per node `job_id`) with run refetch.

### Workflow run

Do not recreate the UI `run.log` field. Read run metadata, runtime nodes, approvals, artifacts, and job event streams from their Atlas endpoints and combine them in a view model.

## Role and permission matrix (UI gating only)

Atlas enforces these centrally in `_dispatch`; the frontend mirrors them **only** to hide/disable actions (UX). Never use this as the security boundary — Atlas is authoritative, and a role can change server-side. Verified against `atlas/app.py` `ROLE_PERMISSIONS` (lines 70–75) and `_required_permission` (lines 1184–1211), Atlas `595ef62`.

Role → permissions:

| Role       | Permissions                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`    | all: `read`, `audit.read`, `jobs.run`, `workflows.run`, `approvals.decide`, `workflows.manage`, `workers.poll`, `resources.manage`, `deliveries.read`, `admin`   |
| `operator` | `read`, `jobs.run`, `workflows.run`, `approvals.decide`, `workflows.manage`, `workers.poll`, `resources.manage`, `deliveries.read` (no `admin`, no `audit.read`) |
| `auditor`  | `read`, `audit.read`, `deliveries.read`                                                                                                                          |
| `viewer`   | `read`                                                                                                                                                           |

Route → required permission (used to decide which UI actions to show):

| Route (method)                                          | Permission         |
| ------------------------------------------------------- | ------------------ |
| any `GET`, plus `/api/me`, `POST /api/auth/logout`      | `read`             |
| `/api/users`, `/api/tokens`                             | `admin`            |
| `/api/workers` mutations                                | `admin`            |
| `POST /api/workers/poll`, `POST /api/workers/{id}/poll` | `workers.poll`     |
| `/api/audit`, `/api/usage`                              | `audit.read`       |
| `/api/jobs` (non-GET), `/api/routes/resolve`            | `jobs.run`         |
| `/api/approvals` (non-GET)                              | `approvals.decide` |
| `/api/workflows` (non-GET)                              | `workflows.manage` |
| `/api/workflow-runs`, `/api/artifacts` (non-GET)        | `workflows.run`    |
| `/api/workflow-triggers/{id}/fire`                      | `workflows.run`    |
| `/api/workflow-triggers` (other non-GET)                | `workflows.manage` |
| `/api/deliveries` (non-GET)                             | `workflows.run`    |
| `/api/packs` `POST`                                     | `workflows.manage` |
| everything else (non-GET)                               | `resources.manage` |

## Error and auth contract

- `401`: clear/revalidate the flow-designer session and redirect to `/auth`.
- `403`: render a forbidden state and keep the user on the page when possible.
- `404`: use route-level not-found handling for missing workflow/run/job IDs.
- `409`: show a conflict/retry action; do not blindly retry mutations.
- `429`/`5xx`: bounded exponential backoff for reads/streams only; mutations require idempotency or explicit user retry.
- Every request must preserve Atlas error text for diagnostics without exposing credentials.

## Contract questions resolved by source inspection

Verified against Atlas `595ef62`; these were open questions and are now settled facts (not reasons to create a second backend):

- **Browser session cookie:** Atlas issues none (bearer-token only). flow-designer owns the browser session cookie and holds the Atlas bearer server-side.
- **SSE resume:** no `Last-Event-ID`; resume via `after=<seq>` (exclusive), dedupe by `id`/`seq`, terminal `event: close`. See the Job event SSE contract above.
- **Run-level live stream:** none. Combine per-job SSE with run refetch.
- **Roles:** exactly `admin`, `operator`, `viewer`, `auditor` (`atlas/db.py` `ROLES`); permissions per role in `atlas/app.py` `ROLE_PERMISSIONS`. The UI hides/disables by role but always relies on Atlas for enforcement.
- **List pagination:** `?limit` only (clamped 1..10000), newest-first, no offset/cursor and no total counts; aggregates live at `/api/metrics` and `/api/usage`. Treat lists as a bounded window, not true pagination (tracked in `ATLAS_LIMITATIONS.md`).

## Deployment decisions to resolve before coding

These depend on how Atlas and flow-designer are deployed and are the user's to make. They are enumerated with recommendations in `CONFIGURATION.md`:

- deployed Atlas private origin and the frontend public origin
- CORS/reverse-proxy topology (same-origin BFF vs split-origin)
- httpOnly cookie/session strategy, signing/encryption, and key rotation
- behavior across multiple stateless frontend replicas
- retention/pagination policy the UI should assume for run/job events
