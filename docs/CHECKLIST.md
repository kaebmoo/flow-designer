# Delivery checklist

Use this checklist with the phase gate in `docs/IMPLEMENTATION_PLAN.md`. Check items only after verifying them against a real Atlas instance where applicable.

## Global rules

- [ ] `src/routeTree.gen.ts` was not edited.
- [ ] No Postgres, Drizzle, PocketBase, duplicate auth, or duplicate executor was added.
- [ ] No browser code calls thClaws directly.
- [ ] No client code imports `*.server.ts` (importing `*.functions.ts` RPC wrappers is allowed).
- [ ] No dynamic import of server functions.
- [ ] Server-only Atlas clients, session helpers, and secrets are in `*.server.ts`; `createServerFn` RPC wrappers are in `*.functions.ts`.
- [ ] Each private server function validates the flow-designer session and calls a typed, fixed Atlas operation; Atlas alone authorizes it (a route `beforeLoad` is UI-only).
- [ ] The Atlas bearer token is never in browser code, `localStorage`, or a URL query string.
- [ ] Thin stream route glue contains no domain logic or secrets.
- [ ] Design tokens are used; no new hardcoded color classes.
- [ ] Loader routes have `errorComponent` and `notFoundComponent`.
- [ ] Existing user changes and Lovable history are preserved.

## Phase 0 — Contract

- [ ] Atlas checkout path and tested commit are recorded (`595ef62`).
- [ ] Atlas origin is recorded.
- [ ] SSE contract verified against source: `after=<seq>`, `id`/`seq` dedupe, `event: close`, no `Last-Event-ID`.
- [ ] Workflow node compatibility matrix verified against Atlas source (`BACKEND_INTEGRATION.md`).
- [ ] Config decisions enumerated for the user (`CONFIGURATION.md`).
- [ ] CSRF-middleware requirement for Phase 1 is documented (`start.ts` defined).
- [ ] Role set recorded: `admin`, `operator`, `viewer`, `auditor`.
- [ ] Missing backend capabilities are documented, not mocked as real (`ATLAS_LIMITATIONS.md`).
- [ ] Auth/session strategy and role mapping are approved by the user.
- [ ] **Gate:** user confirms Phase 1 start.

## Phase 1 — Transport and auth

- [ ] `createCsrfMiddleware()` is installed in `src/start.ts` `requestMiddleware` before any auth/mutation server function.
- [ ] Typed Atlas API client exists.
- [ ] Atlas errors normalize consistently.
- [ ] Login/logout/me work against real Atlas.
- [ ] Session cookie/token handling is secure for the target runtime (httpOnly, signed/encrypted, flow-designer-owned).
- [ ] Each private server function validates the request session and calls a typed, fixed Atlas operation; no generic proxy or duplicate frontend RBAC exists.
- [ ] 401 clears session and redirects correctly.
- [ ] 403 renders a forbidden state.
- [ ] Atlas/worker credentials are absent from browser output (no bearer in bundle, `localStorage`, or query string).
- [ ] **Gate:** user confirms Phase 2 start.

## Phase 2 — Read-only UI

- [ ] Dashboard reads Atlas metrics/resources.
- [ ] Fleet reads Atlas workers and capabilities.
- [ ] Workspaces reads Atlas workspaces.
- [ ] Workflows and runs survive reload.
- [ ] Jobs reads real job state.
- [ ] Static arrays are removed or explicitly documented as unavailable.
- [ ] Pagination/filter state is URL-safe where appropriate.
- [ ] Lists are treated as a bounded `limit` window (no assumed offset/cursor/total).
- [ ] **Gate:** user confirms Phase 3 start.

## Phase 3 — Mutations/editor

- [ ] Worker/workspace mutations call Atlas.
- [ ] Round-trip fixtures exist for the four native node types (serialize → Atlas → parse back) before wiring save/run.
- [ ] Palette exposes only `worker`/`manager`/`join`/`human_gate`; conditions are edited on edges, fan-out is multiple edges, loops are guarded back-edges, triggers live outside `graph.nodes`. No `condition`/`loop`/`fanout`/`trigger` pseudo-nodes.
- [ ] The internal node kind is `human_gate` (display label “Approval”); legacy mock `approval` values receive a one-time scaffold migration only. `join.mode`/`quorum` and `manager.schema` are always emitted.
- [ ] Any unknown Atlas node/condition type fails closed in the UI (not sent to Atlas).
- [ ] Node layout is stored locally (keyed by workflow id + graph version) with auto-layout fallback; only semantic JSON goes to Atlas.
- [ ] Validation runs before save/enable/run.
- [ ] Save/reload preserves graph semantics and UI layout separately.
- [ ] Run calls Atlas and returns a real run ID.
- [ ] Pause/resume/cancel/approval/delivery actions work.
- [ ] Mutation conflicts are visible and do not silently overwrite data (no ETag/If-Match in Atlas; guard client-side).
- [ ] **Gate:** user confirms Phase 4 start.

## Phase 4 — Live events

- [ ] SSE connects through a same-origin authenticated transport (no bearer in the browser/query string).
- [ ] Resume uses `after=<last seq>`; `event: close` ends normal streams; EOF-without-close reconnects with bounded backoff.
- [ ] Event dedupe by `id`/`seq` is tested (duplicate and out-of-order).
- [ ] Idle-stream handling accounts for Atlas having no heartbeat.
- [ ] Run progress combines per-job SSE (per node `job_id`) with run refetch (no assumed unified stream).
- [ ] Long logs remain bounded/virtualized.
- [ ] Run state is authoritative after refresh.
- [ ] Canvas highlights runtime state from Atlas.
- [ ] **Gate:** user confirms Phase 5 start.

## Phase 5 — Operational pages

- [ ] Artifacts use Atlas metadata/content endpoints.
- [ ] Triggers use Atlas trigger endpoints.
- [ ] Deliveries use Atlas delivery endpoints.
- [ ] Conversations use Atlas session bindings.
- [ ] Usage uses Atlas aggregates.
- [ ] Audit uses Atlas audit data.
- [ ] Users/tokens use Atlas admin endpoints.
- [ ] Settings does not imply unsupported mutations.
- [ ] **Gate:** user confirms Phase 6 start.

## Phase 6 — Security, resilience, accessibility, tokens

### Security

- [ ] CSRF middleware verified active for all mutation server functions.
- [ ] No Atlas/worker token in the browser bundle, logs, `localStorage`, or URLs.
- [ ] Server error messages are normalized before display.
- [ ] Destructive actions require permission checks and confirmation.

### Resilience

- [ ] 401/403/404/409/429/5xx are all handled.
- [ ] Bounded retries/backoff apply only to safe reads and streams.
- [ ] Requests cancel on route change.
- [ ] Reconnect/refetch recovers from stream and Atlas restarts.

### Accessibility

- [ ] Keyboard and focus behavior work for editor, dialogs, filters, and approval actions.
- [ ] Live regions/announcements for stream and mutation results where appropriate.
- [ ] Color is not the only signal for node/run state.

### Design-token cleanup

- [ ] Hardcoded color classes (`bg-black`, `text-white`, `bg-[#...]`) are replaced with `src/styles.css` tokens.
- [ ] Loading/empty/error/forbidden/not-found/conflict/disconnected states use tokens consistently.
- [ ] **Gate:** user confirms Phase 7 start.

## Phase 7 — Verification and release

- [ ] `typecheck`, `build`, and `lint` pass.
- [ ] Contract tests pass against a real/fixture Atlas.
- [ ] Stream tests pass (replay, dedupe, reconnect, terminal `close`).
- [ ] Browser acceptance tests pass (login, two tabs, expired auth, worker offline, disconnect, Atlas restart).
- [ ] Local Atlas restart behavior is verified.
- [ ] Deployment origin/CORS/HTTPS/cookie attributes are verified.
- [ ] Known Atlas limitations are included in release notes.
- [ ] **Production blocker:** Atlas token lifecycle (expiring tokens, orphan token cleanup, login rate limiting) is fixed or explicitly risk-accepted (`ATLAS_LIMITATIONS.md`).
- [ ] Backup and rollback procedure is documented.
- [ ] `src/routeTree.gen.ts` and Lovable history are untouched.
- [ ] Commit message identifies the completed phase.
- [ ] **Gate:** user confirms release/commit.
