# Frontend engineering guide

## Module boundaries

```text
src/lib/atlas-types.ts       API and domain-facing TypeScript types
src/lib/atlas-mappers.ts     Atlas <-> UI view-model and graph adapters
src/lib/atlas-api.server.ts  server-only authenticated HTTP client
src/lib/auth.server.ts       server-only session/cookie helpers
src/lib/*.functions.ts       typed server functions used by routes/components
src/lib/query-keys.ts        stable TanStack Query keys
src/lib/workflow-graph.ts    semantic workflow graph: parse, serialize, validate, rename
```

There is no client-side domain store. The mock Zustand store was deleted in Phase 3 along with
the timer-based simulator; server state lives in TanStack Query, and the only local state is
UI-local (selection, panels, and the editor's node layout in `localStorage`).

### Import boundary

- `*.functions.ts` = `createServerFn` RPC wrappers. Routes, components, loaders, and hooks **may** statically import them. The bundler replaces the function body with a network call, so the server code never reaches the browser bundle.
- `*.server.ts` = server-only Atlas HTTP clients, session/cookie helpers, credentials, secrets. Client code must **never** import `*.server.ts`.
- Do **not** dynamically import server functions; keep them statically imported so the transform applies.
- Secrets and `process.env` reads happen only inside request-time server execution (server functions / `*.server.ts`), never at module top-level that a client could pull in.
- Each private server function must **validate the flow-designer session** (re-derive identity from the request cookie) and invoke a **typed, fixed Atlas operation** — never a generic pass-through/arbitrary Atlas proxy. A route `beforeLoad` is a UI navigation boundary only; the RPC endpoint is directly reachable, so authentication happens at the data boundary, not just the route.
- **Do not reimplement Atlas RBAC.** Atlas alone enforces endpoint permissions. Frontend role/permission data (see the role→permission table in `BACKEND_INTEGRATION.md`) is UX-only — hide/disable actions — and must never be the security boundary. Never treat a cookie-cached role as a security decision; it can be stale.

Client components may import types, mappers that have no secrets, and query hooks; and may import `*.functions.ts` (the RPC boundary). They may not import `*.server.ts`.

## Query rules

- Use stable keys containing resource ID and filter/pagination parameters.
- Set conservative stale times for inventory and long enough stale times for immutable run history.
- Invalidate the smallest affected resource after a mutation.
- Never use `Math.random()` for data, counts, IDs, or timestamps in production UI.
- Never use mock fallback data after a failed Atlas request; show an error state.
- Use server-provided totals for dashboard metrics.

## Mutation rules

- Disable duplicate-submit actions while a request is in flight.
- Treat Atlas `409` as a conflict, not a success.
- Retry only idempotent reads and explicitly retryable stream requests.
- After mutation success, use the response as the source of truth and invalidate related queries.
- For actions with irreversible effects, require confirmation and show the Atlas result.

## Workflow editor rules

- Model the canvas on the Atlas-native graph. The palette exposes **only** `worker`, `manager`, `join`, `human_gate`; “Approval” is the display label for internal kind `human_gate`, not a separate kind. Do not create `condition`/`loop`/`fanout`/`trigger` pseudo-nodes: conditions are edited in the **edge inspector**, fan-out is **multiple outgoing edges**, loops are **guarded back-edges**, and triggers are managed in a **separate trigger panel** outside `graph.nodes`.
- Keep layout state separate from semantic graph state, and store it **locally** — Atlas receives semantic JSON only and has no layout persistence endpoint. Persist node positions/viewport in localStorage keyed by workflow id + graph version, with an auto-layout fallback; local layout does not sync across devices/users.
- When an atomic save advances Atlas's workflow version, copy the current local layout and
  viewport to the returned version key before switching. A successful semantic save must not
  reposition the canvas.
- Treat nullable workflow `default_reply` as root metadata, not policy. Preserve unknown
  additive keys while editing known reply fields; run-level `_meta.reply` always wins.
- Serialize only supported node/edge fields; always emit `join.mode`/`quorum`, `manager.schema`, and an edge `condition`.
- Keep result and file semantics separate: `outputs[0]` names the worker reply artifact, while
  `collect_files` asks the worker to snapshot workspace files as downloadable `file_ref`
  artifacts. Edge `push_files` is only valid when workflow policy `file_handoff` is enabled.
- Treat `company` and `model` as Atlas runtime fields, not UI labels: `company` participates in
  workspace routing, and `model` is forwarded to the selected worker as the requested model.
- Fail closed on any unknown Atlas node or condition type — surface it, never silently drop it or send it to Atlas.
- Validate graph shape before save and before run.
- Use stable node IDs from Atlas; do not use array index as identity.
- Runtime node state comes from Atlas, never from a local timer.

## Live event rules

These follow the Atlas `82207f7` job SSE contract (see `BACKEND_INTEGRATION.md`): data frames
carry `id`/`seq`, a normal stream ends with `event: close`, and a quiet live connection sends
unsequenced keepalive comments plus a reconnect hint.

- Store only the latest bounded window in active component state.
- Deduplicate by the SSE `id`/payload `seq` (monotonic per job).
- Resume with `after=<last confirmed seq>` (exclusive lower bound). `after` is the only resume parameter — there is no `Last-Event-ID` support and no `limit`/`timeout` query param.
- A normal stream sends `event: close` with terminal `{state}`. EOF without `close` is a
  disconnect. Treat `: keepalive` or other received bytes as transport activity without
  rendering an event or moving the cursor; accept only a valid bounded `retry:` hint.
- If a resume gap cannot be closed from the stream, refetch the run/job detail and mark the gap.
- Workflow-run progress is not one live stream. Its persisted JSON history is cursor-paged by
  sequence; combine those pages with per-job SSE and run refetch.
- Ignore unknown event types safely while retaining a diagnostic marker.
- Stop reconnecting after a terminal `close` or an explicit user cancellation.
- Do not make every event invalidate the entire dashboard; update the narrowest query possible.

## Error states

Every server-backed screen needs distinct states for:

- loading
- empty
- unauthorized
- forbidden
- not found
- conflict
- transient backend failure
- disconnected live stream
- stale/recovered data

## Security rules

- Install `createCsrfMiddleware()` in the `src/start.ts` `requestMiddleware` before adding any auth or mutation server function. Because this repo defines its own `start.ts`, TanStack Start does **not** auto-install CSRF protection; it must be added explicitly. See the [TanStack Start server-functions guide](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions).
- The Atlas bearer token stays server-side in an httpOnly cookie. It must never reach browser code, `localStorage`, or a URL query string — including Atlas's `?token=` `EventSource` path. Stream through a same-origin server transport that attaches the `Authorization` header server-side.
- Never expose Atlas API tokens, worker tokens, callback secrets, or internal URLs unnecessarily.
- Do not log request headers, cookies, full prompts, artifact contents, or raw worker payloads.
- Render server error messages only after safe normalization.
- Treat URL params, query filters, and form input as untrusted.
- Download artifacts through Atlas authorization, not direct guessed storage paths.
