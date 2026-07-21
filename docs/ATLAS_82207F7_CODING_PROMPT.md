# Coding prompt — adopt Atlas `82207f7`

Use the following prompt for the implementation session.

---

Start from flow-designer `main` at current HEAD after the Atlas `82207f7` planning-doc commit.
The branch is already ahead of `origin/main`; preserve every existing commit. This repository is
connected to Lovable: do not amend, rebase, squash, force-push, or otherwise rewrite published
history. Do not push until explicitly instructed.

Target Atlas is `/Users/seal/Documents/GitHub/atlas-control-plane` at clean commit `82207f7`.
Treat Atlas as read-only for this task. Before editing, read both repositories' `AGENTS.md`, then
read:

- `docs/ATLAS_82207F7_ADOPTION_PLAN.md`
- `docs/BACKEND_INTEGRATION.md`
- `docs/ATLAS_LIMITATIONS.md`
- `docs/FRONTEND_ENGINEERING.md`
- `docs/TESTING_AND_QA.md`
- Atlas `docs/plans/atlas-ux-enablement.md`
- Atlas OpenAPI and visual-builder sections referenced by the plan

Inspect both git statuses and do not overwrite user changes. Work as small logical commits and
do not mix unrelated cleanup into the adoption.

Objective: adopt every additive Atlas contract introduced in `595ef62..82207f7` that affects
flow-designer:

1. Typed session metadata (`session.token_id`, `session.expires_at`), five-minute expiry warning,
   authoritative 401 sign-out, and per-tab unsaved semantic draft recovery.
2. Login 429 `Retry-After` countdown with disabled submit and no automatic credential retry.
3. Token immutable `purpose`, nullable `expires_at`, derived lifecycle/current-session display,
   and optional future expiry on API-token creation without weakening copy-once secret handling.
4. Nullable workflow `default_reply` authoring/clearing with unknown-key preservation; prove
   create/read/update, POST/PUT allowlist rejection, inherited new runs, run-level override,
   trigger inheritance, run-time revalidation after allowlist drift, override bypass of a stale
   stored default, and delivery from persisted inherited input. Do not claim the separate
   graph/policy validate endpoint checks this field.
5. Replace the GET + `updated_at` lost-update guard with Atlas `expected_version`; keep the local
   draft on 409, fetch server state for comparison, never auto-merge/retry, and never send both
   `version` and `expected_version`.
6. Preserve local canvas layout and viewport when Atlas increments workflow version after a
   successful conditional save. Add a regression test that node positions do not jump.
7. Adopt workflow-run event cursor pages (`after`, `next_after`, `has_more`) with ordered,
   non-overlapping incremental loading, sequence dedupe, and bounded rendering.
8. Make job SSE keepalive comments count as transport activity without becoming timeline events
   or advancing the cursor; honor only valid bounded `retry:` hints while preserving current
   close/gap/backoff semantics.
9. Remove the obsolete POST/PUT `Connection: close` workaround now that Atlas closes unread-body
   rejects safely. Keep content-type/protocol fail-closed behavior and the repeated rejected-POST
   regression.

Follow the slice order, file routing, product decisions, non-goals, and acceptance matrix in
`docs/ATLAS_82207F7_ADOPTION_PLAN.md`. In particular:

- Atlas remains the only source of truth and authorization authority.
- The Atlas bearer stays server-only; never put it in browser state, storage, logs, or URLs.
- `default_reply` is workflow-root data, not policy. Run input wins. Packs omit it.
- Preserve additive unknown default-reply keys or refuse editing; never silently delete them.
- `updated_at` becomes display-only; Atlas `version` is the save precondition.
- Keepalive/retry controls are transport metadata, never persisted domain events.
- Do not add a generic proxy, second backend, shared layout store, unified fake run stream, or
  automatic mutation retry.

For every claim, provide command or source evidence. Add unit, real-Atlas contract, stream, and
browser coverage before calling a slice complete. Mutation-test the important assertions where
practical: disabling default inheritance, dropping `expected_version`, failing to migrate layout,
ignoring heartbeat activity, or discarding `Retry-After` must make a targeted test fail.

If localhost/Atlas execution is sandbox-blocked, request escalation correctly. Final gate:

- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run test`
- `bun run test:contract`
- `bun run test:stream`
- `bun run test:e2e`
- Node 24 `bun run test:remote`
- production `bun run build`
- `bun run scan:bundle` with throwaway canary secret/private-origin values
- `git diff --check`
- verify `src/routeTree.gen.ts` only changes if route generation genuinely requires it

Update release-readiness evidence from the actual outputs. Atlas `82207f7` closes the old backend
token-lifecycle P0, but do not declare production shipment until adoption tests pass and exact
deployment origins, secret store, proxy, backup/restore drill, and log sink are recorded. End with
a ship/no-ship decision and remaining blockers. Do not push.

---
