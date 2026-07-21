# Atlas `82207f7` adoption plan

Status: **planned; no flow-designer implementation has landed yet**

Discovery date: 2026-07-21 (Asia/Bangkok)

Frontend baseline: `78f0b41`. Atlas baseline previously certified by Phase 7: `595ef62`.
Atlas target inspected: `82207f7` (`main`, clean), containing commits `70d7489` through
`ebf0ab4`.

## Evidence and release meaning

- Atlas `./scripts/gate.sh` completed GREEN at `82207f7`.
- The existing flow-designer real-Atlas contract suite passed unchanged: 136 passed, 3 skipped.
- That pass proves backward compatibility only. It does **not** exercise the new session
  metadata, `Retry-After`, token lifecycle fields, workflow `default_reply`, atomic
  `expected_version`, run-event cursor pages, or SSE keepalive/retry controls.
- Atlas now implements the three backend controls that formed Phase 7's token-lifecycle P0:
  expiring dashboard sessions, bounded active sessions, and login rate limiting. Production is
  still **not approved** until flow-designer adopts the new contract, the full release matrix is
  rerun against `82207f7`, deployment inputs are supplied, and the release decision is updated.

## Atlas delta and flow-designer impact

| Atlas capability                    | Current flow-designer state                                                                                                     | Required adoption                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow `default_reply`            | Field is absent from API types, editable view, dirty baseline, create/update payloads, inspector, and tests                     | Round-trip nullable default reply without dropping unknown extension keys; edit/clear known fields; prove inheritance, run override, trigger inheritance, allowlist rejection, and inherited delivery |
| Session expiry/cap                  | Login and `/api/me` discard `session.token_id`/`expires_at`; shell cannot warn before expiry                                    | Validate session metadata, retain safe metadata separately from the bearer, warn before expiry, keep server `401` authoritative, and explain expiry/session-cap/logout outcomes                       |
| Login `429 Retry-After`             | Status maps to `rate_limited`, but response headers are discarded and the form cannot count down                                | Parse a bounded integer `Retry-After`, carry it through the safe client error, disable submit for that period, and never retry credentials automatically                                              |
| Token lifecycle metadata            | Token models/UI omit immutable `purpose` and nullable `expires_at`; create cannot request expiry                                | Show purpose, expiry and derived active/expired/revoked state; mark the current session by public token id; allow optional future expiry for API-token creation                                       |
| Atomic workflow save                | UI performs GET + timestamp compare + unconditional PUT; a race remains                                                         | Send `expected_version`, remove the preflight GET guard, retain the local graph on `409`, fetch server state for comparison, and never send both `version` and `expected_version`                     |
| Server-incremented workflow version | Local canvas layout is keyed by workflow id + version; every successful conditional save now increments version                 | Copy/migrate the current local layout and viewport to the returned version before switching keys, so an ordinary save never repositions the canvas                                                    |
| Workflow-event cursor pages         | Client requests a first-N `limit` window and prints an obsolete truncation caveat                                               | Model `{events, after, next_after, has_more}` and page forward by exclusive sequence cursor with bounded rendering and dedupe                                                                         |
| SSE `retry` + keepalive             | Parser ignores both controls; comment-only keepalives do not reset the idle watchdog because only data frames count as activity | Treat any received stream bytes/comment as transport activity without adding a timeline event; accept a valid bounded retry hint; preserve event cursor/dedupe semantics                              |
| Rejected-body/HTTP fix              | Production client forces `Connection: close` on every POST/PUT as a workaround                                                  | Remove the forced header and stale comments; retain JSON/content-type fail-closed handling and the repeated rejected-POST regression test                                                             |
| `HEAD`/`PATCH` behavior             | No flow route depends on either method                                                                                          | Documentation-only; fixed-operation clients continue using their declared methods                                                                                                                     |

## Product and safety decisions for this pass

1. **Default reply belongs to the workflow root, not policy.** The editor exposes three states:
   absent (inherit nothing), explicit `mode: none`, and `mode: webhook`. Webhook requires a
   callback URL; correlation id is optional. Atlas remains authoritative for the outbound
   allowlist.
2. **Preserve extensions.** Atlas permits extra `default_reply` keys. The form may edit known
   keys, but serialization must merge them into the original object or refuse editing; it must
   never silently drop them.
3. **Run input wins.** A run-level `_meta.reply` is never overwritten by the workflow default.
   The current one-click Run sends `{}`, so it inherits automatically. Do not invent a second
   delivery implementation in the frontend.
4. **Packs deliberately omit `default_reply`.** Do not claim that an Atlas solution-pack
   export/import carries deployment-specific callback URLs.
5. **The validate endpoint remains graph/policy-only.** `POST /api/workflows/{id}/validate`
   does not validate `default_reply`; POST/PUT validates it on save, and a run that inherits a
   stored default re-validates it against the current allowlist. The UI must not label graph
   validation as reply validation.
6. **Server version is the concurrency token.** `updated_at` remains display metadata only.
   Preserve a dirty local draft on `409`; never auto-merge or blindly retry a mutation.
7. **Unsaved drafts survive credential loss per tab.** Store only the semantic workflow draft
   in `sessionStorage`, keyed by workflow id and baseline version; never store the bearer. After
   re-authentication offer Restore/Discard and let `expected_version` protect the server copy.
8. **Atlas decides expiry.** Warn five minutes before `session.expires_at`, but do not redirect
   solely from the browser clock. The next Atlas `401` clears the sealed session and redirects.
9. **Heartbeat is transport activity, not domain data.** `: keepalive` never appears in the log,
   never advances `lastConfirmedSeq`, and never invalidates run state.
10. **Keep current topology.** Browser → same-origin flow-designer BFF → private Atlas. Session
    metadata and token ids are safe to display; raw Atlas bearer values remain server-only.

## Coding slices

### Slice 1 — Contract pin and transport cleanup

Primary files:

- `src/lib/atlas-types.ts`
- `src/lib/atlas-api.server.ts`
- `src/lib/atlas-mappers.ts`
- `tests/unit/atlas-api.test.ts`
- `tests/unit/atlas-mappers.test.ts`
- `tests/contract/auth.contract.test.ts`

Work:

- Pin source comments and fixtures to Atlas `82207f7`.
- Add typed/guarded session metadata, token `purpose`/`expires_at`, workflow
  `default_reply`, and workflow-event page envelopes.
- Preserve a safe, bounded `retryAfterSeconds` on `AtlasError`/`ClientAtlasError` when a 429
  carries a valid `Retry-After` delta-seconds value; never forward arbitrary headers.
- Remove the POST/PUT `Connection: close` workaround. Keep protocol/content-type checks.
- Make guards fail closed when required new fields are malformed while remaining permissive
  about unrelated additive fields.

Acceptance:

- Repeated rejected POSTs followed by login pass without the workaround against real Atlas.
- Malformed session, cursor, purpose, expiry, and `Retry-After` values fail safely.
- No token/header/private-origin value crosses the client boundary or appears in logs.

### Slice 2 — Authentication and token lifecycle UX

Primary files:

- `src/lib/auth.server.ts`
- `src/lib/auth.functions.ts`
- `src/routes/auth.tsx`
- `src/routes/_app.tsx`
- `src/components/atlas/sidebar.tsx` or a focused session-warning component
- `src/routes/_app/users.tsx`
- auth/token unit, contract, accessibility, and browser tests

Work:

- Carry Atlas session id/expiry in the sealed flow-designer session and safe identity view.
- Render a non-blocking five-minute expiry warning with an accessible live status. A 401 remains
  the only automatic sign-out authority.
- On login 429, disable submit and show a second-by-second countdown from `Retry-After`; do not
  preserve the password or auto-submit when the timer ends.
- Explain that an existing browser session can be revoked by logout, expiry, or the five-session
  cap.
- Add token purpose, expiry, current-session marker, and lifecycle state to the admin token
  table. Add an optional future UTC expiry to API-token creation while preserving copy-once raw
  token handling.

Acceptance:

- Real Atlas produces 429 and the form honors its header.
- Expiry warning appears at the boundary; expired/revoked/cap-evicted sessions clear and route
  to `/auth` on the next authoritative request.
- Session-purpose tokens are never inferred from mutable display names.
- Raw API tokens remain transient and absent from cache/storage/URL/logs.

### Slice 3 — Workflow default reply and atomic editing

Primary files:

- `src/lib/atlas-api.server.ts`
- `src/lib/atlas-mutations.functions.ts`
- `src/lib/atlas-mutations.ts`
- `src/lib/atlas-mappers.ts`
- `src/components/atlas/workflow-editor.tsx`
- `src/components/atlas/workflow-inspector.tsx`
- `src/components/atlas/workflow-layout.ts`
- `src/routes/_app/workflows.$id.tsx`
- workflow unit, contract, and browser tests

Work:

- Add nullable `default_reply` to create/update/editable models and the dirty baseline.
- Add a workflow-level inspector that can set absent/none/webhook, callback URL, and correlation
  id, preserves unknown keys, and sends explicit `null` to clear an existing default.
- Send `expected_version` on every editor save. Delete the GET + `updated_at` preflight and its
  stale documentation.
- Keep the local draft visible on Atlas 409 and provide Reload server state / keep local draft
  choices. Never auto-retry.
- Before the route adopts the returned incremented version, copy the current local layout and
  viewport to that version's storage key. Preserve the current per-browser layout policy.
- Add per-tab semantic draft recovery in `sessionStorage`; clear it after a confirmed save or
  explicit discard.

Acceptance:

- Two truly concurrent saves result in one success and one Atlas 409 with no overwrite.
- A successful save increments version exactly once and does not move nodes or reset viewport.
- Existing unknown default-reply keys survive a known-field edit.
- Create/read/update/clear, POST and PUT allowlist rejection, run inheritance, run override,
  trigger inheritance, current-allowlist revalidation after configuration drift, override of an
  otherwise-undeliverable stored default, and inherited delivery are proven against real Atlas.

### Slice 4 — Cursor history and heartbeat-aware streaming

Primary files:

- `src/lib/atlas-api.server.ts`
- `src/lib/atlas-mutations.functions.ts` or a read-focused server-function module
- `src/lib/atlas-queries.ts`
- `src/lib/query-keys.ts`
- `src/routes/_app/runs.$id.tsx`
- `src/lib/job-stream.ts`
- stream unit/contract/browser tests

Work:

- Return the full workflow-event page envelope and use an infinite/cursor query keyed by run
  and page size.
- Request each page with the previous `next_after`; append only events newer than the last
  rendered sequence, dedupe by sequence, expose Load more while `has_more`, and keep the
  existing DOM cap/virtualization discipline.
- Replace the obsolete first-N caveat with exact cursor/page status.
- Count keepalive comments/received bytes as transport activity while continuing to ignore them
  as events. Parse only valid positive bounded `retry:` values into reconnect scheduling.
- Preserve exclusive `after`, close-frame, gap-probe, and confirmed-sequence rules.

Acceptance:

- Multiple workflow-event pages are ordered, non-overlapping, and resume from `next_after`.
- A quiet live Atlas stream remains healthy across at least two 15-second keepalives.
- Comments never render or advance sequence; malformed retry hints are ignored; disconnects
  still resume without duplicates.

### Slice 5 — Requalification and handoff

Work:

- Update every stale `595ef62` current-contract comment that the implementation touches.
- Run typecheck, lint, format, unit, Atlas contract, stream, browser, remote-like Node 24,
  production build, and bundle-value scan.
- Repeat the contract suite against a clean archive of Atlas `82207f7` if the working checkout
  is no longer clean.
- Update `RELEASE_READINESS.md`, release notes, checklist, and operator runbook with actual
  command output. Do not mark production ready merely because Atlas's gate is green.

## Required test matrix additions

| Layer          | New evidence                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit           | response guards; Retry-After parsing; default-reply parse/serialize/unknown-key preservation; session warning/countdown; token lifecycle derivation; layout version copy; cursor aggregation; heartbeat activity                |
| Atlas contract | session metadata and expiry; real 429 header; purpose/expiry token metadata and create expiry; atomic 409; default-reply CRUD/inheritance/override/trigger/delivery/allowlist; cursor page envelopes; retry/keepalive bytes     |
| Browser        | countdown with disabled submit; pre-expiry warning; draft recovery after auth loss; default-reply edit/clear; concurrent editor conflict; layout stable across version increment; Load more run events; quiet stream stays live |
| Remote-like    | secure cookie plus Atlas session metadata, same-origin SSE heartbeat, no direct Atlas/token exposure, Node 24 runtime                                                                                                           |

## Non-goals

- No Atlas source changes in this pass.
- No shared/collaborative canvas-layout persistence; the product decision remains open.
- No unified workflow-run SSE; run progress remains per-job SSE plus run refetch and paged
  persisted run events.
- No automatic conflict merge, credential retry, or mutation retry.
- No claim that solution packs carry `default_reply`.
- No active-active Atlas topology.

## Completion gate

The adoption pass is complete only when all slices and their real-Atlas tests pass, current docs
name Atlas `82207f7`, the previous auth/HTTP/event limitations are reclassified with evidence,
and the release owner makes a new production decision. Exact deployment origins, secret store,
proxy, backup/restore drill, and log sink remain separate operator inputs.
