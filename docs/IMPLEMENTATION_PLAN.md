# Atlas Control Plane Web UI completion plan

Status: implemented through Phase 3; Phase 4–6 remain planned

Date: 2026-07-20

## Objective

Turn the current Lovable scaffold into a production-usable operator UI by replacing mock data and browser simulations with the existing Atlas Control Plane API.

## Architecture constraints

- No Postgres, Drizzle, PocketBase, or frontend-owned domain persistence.
- No duplicate executor, scheduler, worker client, or auth/RBAC system.
- Atlas remains responsible for all durable state and execution.
- `flow-designer` may contain typed transport/server functions for auth, SSR, API forwarding, response mapping, and SSE, but not domain persistence or execution logic.
- Keep Atlas limitations documented and visible; do not claim horizontal scalability that Atlas does not currently provide.

## Phase 0 — Contract and preparation (current)

### Deliverables

- `docs/ARCHITECTURE.md`
- `docs/BACKEND_INTEGRATION.md` (incl. workflow node compatibility matrix + job SSE contract)
- `docs/CONFIGURATION.md`
- `docs/ATLAS_LIMITATIONS.md`
- `docs/FRONTEND_ENGINEERING.md`
- `docs/TESTING_AND_QA.md`
- `docs/CHECKLIST.md`
- ADR-0001 and runbooks
- Updated `CLAUDE.md`

### Gate (explicit user confirmation)

Before any Phase 1 code, the user must confirm: the Atlas private origin and frontend public origin; the httpOnly cookie/session strategy and key rotation (`CONFIGURATION.md`); the role mapping (`admin`/`operator`/`viewer`/`auditor`); the verified SSE `after=<seq>` contract; and the workflow node compatibility matrix. Every subsequent phase also ends with an explicit user-confirmation gate — do not start a phase until the prior gate is confirmed.

## Phase 1 — Typed Atlas transport and authentication

### Work

- **Security prerequisite:** install `createCsrfMiddleware()` in `src/start.ts` `requestMiddleware` before adding any auth or mutation server function. Because this repo defines its own `start.ts`, TanStack Start does not auto-install CSRF; add it explicitly and set the `origin` option to the frontend public origin if it differs from the request origin. Reference: the [TanStack Start server-functions guide](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions).
- Add `src/lib/atlas-types.ts` for API-facing types.
- Add `src/lib/atlas-mappers.ts` for UI view models and graph serialization.
- Add `src/lib/atlas-api.server.ts` for authenticated Atlas requests, timeouts, error normalization, and response parsing.
- Add `src/lib/auth.server.ts` and `src/lib/auth.functions.ts` for login/logout/current identity.
- Add query key/factory modules without introducing domain state.
- Add `/auth` and authenticated route layout.
- Establish secure session behavior with TanStack Start's session primitive (`useSession`, sealed via `SESSION_SECRET`; httpOnly; flow-designer-owned — Atlas issues no cookie). Verify the API for the installed `@tanstack/react-start` version before coding; never put Atlas tokens in `localStorage`.
- Make each private server function validate the session and call typed, fixed Atlas operations; Atlas enforces authorization (no second RBAC in the frontend). `beforeLoad` is UI-only.

### Exit criteria

- `createCsrfMiddleware()` is installed and covers mutation server functions.
- Login/logout/current identity work against a real Atlas instance.
- Unauthenticated and forbidden states are explicit.
- No client module imports `*.server.ts` (importing `*.functions.ts` is fine); no dynamic import of server functions.
- No Atlas/worker credentials are present in browser bundles or URLs.
- **Gate:** user confirms Phase 2 start.

## Phase 2 — Read-only data migration

### Work

Replace mock reads in this order:

1. Dashboard, Fleet, Workspaces
2. Workflows list and workflow detail
3. Runs list and run detail
4. Jobs
5. Mark Conversations, Artifacts, Deliveries, Usage, Audit, Users, and Settings explicitly
   unavailable until their Phase 5 integrations land.
6. Defer trigger CRUD to Phase 3, which owns its mutation contract and dedicated UI.

Use TanStack Query for caching, pagination, stale state, retry policy, and invalidation. Remove workers/jobs/workflows/runs from the Zustand domain store. Keep only UI-local state if required.

### Route requirements

- Add loaders only where they improve SSR/initial render.
- Every loader route must have `errorComponent` and `notFoundComponent`.
- Dynamic IDs must have a real Atlas not-found state, not an in-memory lookup.

### Exit criteria

- Reloading the page preserves data from Atlas.
- Two browser tabs see the same saved state.
- No route reads a mock array or mock Zustand domain collection.
- **Gate:** user confirms Phase 3 start.

## Phase 3 — Mutations and workflow editor

### Work

- **Entry requirement:** land round-trip graph fixtures (serialize → Atlas → parse back) for each of the four native node kinds before wiring save/run (see the compatibility matrix in `BACKEND_INTEGRATION.md`).
- Fleet add/edit/poll actions call Atlas.
- Workflow create/update/delete calls Atlas.
- Replace the legacy mock scaffold with the `human_gate` graph model. Keep “Approval” only as
  its display label and do not retain an `approval` API alias. No data migration is required:
  Phase 2 deleted the mock store before any persisted legacy value could reach Atlas.
- Canvas palette exposes **only** the four Atlas-native node types (`worker`, `manager`, `join`, `human_gate`). Conditions are edited in the **edge inspector**; fan-out is **multiple outgoing edges**; loops are **guarded back-edges**; triggers are managed in a **separate trigger panel**, never in `graph.nodes`. Do not introduce `condition`/`loop`/`fanout`/`trigger` pseudo-nodes or round-trip machinery to convert them.
- Validate before save/enable/run.
- Implement trigger enable/disable with Atlas trigger/workflow APIs.
- Implement job cancel, run pause/resume/cancel, approval decisions, delivery retry, artifact download.
- Add conflict handling and query invalidation for every mutation (Atlas has no ETag/If-Match; guard against lost updates client-side).

### Important editor rules

- React Flow `position`, viewport, selection, and panel state are UI state.
- Only the four native node types (`worker`, `manager`, `join`, `human_gate`) and Atlas-supported semantic fields are sent to Atlas; any unknown node/condition type **fails closed** in the UI (not sent to Atlas).
- Always emit `join.mode`/`quorum`, `manager.schema`, and an edge `condition`.
- **Layout ownership:** Atlas receives semantic JSON only and has no layout persistence endpoint (`workflow-visual-builder-spec-en.md` §13). Store node positions/viewport **locally** (localStorage), keyed by workflow id + graph version, with an auto-layout fallback when no local layout exists. Local layout does **not** sync across devices/users.
- Do not treat array order as execution order.
- Do not simulate execution with timers.

### Exit criteria

- Round-trip fixtures pass for each of the four native node kinds. — **met** (`tests/fixtures/workflow-graphs.ts`, asserted in unit tests and against a real Atlas).
- A workflow saved in one session opens correctly after a full reload. — **met** (browser test; semantics come back from Atlas, layout from `localStorage`).
- Atlas validation errors appear at the relevant node/edge/form field. — **met**; note that Atlas returns one sentence with no field path, so the subject is parsed back out of it (`mapAtlasValidationMessage`) and anything unrecognised stays a graph-level message rather than being attached to a guess.
- Run starts through `POST /api/workflow-runs` and returns a real run ID. — **met** (browser test asserts an Atlas `wfr_…` id in the URL).
- **Gate:** user confirms Phase 4 start.

## Phase 4 — Live execution and event UX

### Work

- Add a typed SSE stream adapter for Atlas job events, consumed through the same-origin authenticated transport (server attaches `Authorization`; no bearer in the browser/query string).
- Resume with `after=<last confirmed seq>`; treat `event: close` as the terminal marker and EOF-without-close as a disconnect; reconnect with bounded backoff and account for the absence of a heartbeat.
- Dedupe events by SSE `id`/payload `seq`.
- Keep the live log bounded and virtualized/incremental.
- Combine per-job SSE (per runtime-node `job_id`) with run refetch; run events are persisted JSON history, not a live stream.
- Highlight canvas nodes from runtime node state, not timer state.
- Surface stream disconnect, stale data, terminal state, and retry controls.

### Exit criteria

- Refreshing a running job does not lose persisted events.
- Duplicate/reordered events do not duplicate log lines or regress state.
- A terminated stream still leaves a correct historical run view.
- **Gate:** user confirms Phase 5 start.

## Phase 5 — Domain pages and operational UX

### Work

- Replace all static arrays in Artifacts, Deliveries, Conversations, Usage, Audit, and Users.
  Trigger CRUD was completed in Phase 3.
- Add pagination, filters, empty states, loading states, and permission-aware actions.
- Use Atlas metrics for dashboard aggregates rather than counting only the current page.
- Add downloads and exports through Atlas endpoints.
- Keep Settings read-only until Atlas exposes safe settings APIs.

### Exit criteria

- Every listed page has a real API source or is explicitly marked as an unavailable Atlas capability.
- No UI claims a setting/action exists when Atlas has no endpoint for it.
- **Gate:** user confirms Phase 6 start.

## Phase 6 — Security, resilience, and visual cleanup

### Work

- Fix hardcoded color classes and use design tokens.
- Remove credentials and sensitive payloads from logs/errors.
- Add request cancellation on route changes.
- Add bounded retries only for safe reads/streams.
- Add 401/403/404/409/429/5xx handling.
- Add keyboard and focus behavior for editor, dialogs, filters, and approval actions.
- Add audit-friendly confirmation for destructive actions.

### Exit criteria

- Security and accessibility checklist passes.
- Browser bundle contains no Atlas service token or worker token.
- All destructive actions have correct permission and confirmation behavior.
- **Gate:** user confirms Phase 7 start.

## Phase 7 — Verification and release

### Work

- Run typecheck/build/lint and contract tests.
- Test against a real local Atlas instance and at least one remote-like origin.
- Test reload, two tabs, expired auth, slow worker, worker offline, stream disconnect, duplicate event, and Atlas restart.
- Document deployment topology: frontend replicas are allowed; Atlas remains the single primary until backend scaling work lands.

### Release gate

- All phase checklists checked.
- No generated file edited by hand.
- No unreviewed contract assumptions.
- **Production blocker:** the Atlas auth-token lifecycle (expiring login tokens, orphan `"dashboard login"` token cleanup, login rate limiting — see `ATLAS_LIMITATIONS.md`) is fixed in Atlas or explicitly risk-accepted for this release.
- No published history rewrite.
- User confirms release/commit step.
