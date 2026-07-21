# Testing and QA strategy

Status: Atlas `82207f7` adoption and requalification completed on 2026-07-21; production remains
blocked on deployment/operator inputs.

## Runners and scripts

- **Unit, contract, and future stream tests:** Vitest.
- **Browser acceptance:** Playwright against an isolated local Atlas instance.

| Script                  | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `bun run typecheck`     | TypeScript (`tsc --noEmit`)                            |
| `bun run lint`          | ESLint                                                 |
| `bun run format:check`  | Prettier                                               |
| `bun run test`          | Unit tests                                             |
| `bun run test:contract` | Contract tests against real isolated Atlas             |
| `bun run test:stream`   | Phase 4 SSE adapter/transport tests (fails when empty) |
| `bun run test:e2e`      | Playwright acceptance suite                            |
| `bun run test:remote`   | Built-Node remote-like HTTPS/private-origin acceptance |
| `bun run scan:bundle`   | Client bundle symbol + optional real-canary scan       |

The package manager is Bun 1.3.14, as pinned by `package.json` and `bun.lock`. Production
runtime selection remains a deployment decision in `CONFIGURATION.md`.

## Test layers

### Static checks

- TypeScript typecheck/build
- ESLint
- Prettier check
- No import of `*.server.ts` from client code (`*.functions.ts` is the RPC boundary and is allowed)
- No dynamic import of server functions
- No edits to `src/routeTree.gen.ts`

### Adapter/unit tests

Test `atlas-mappers.ts` with fixtures for:

- worker with missing/partial `agent_info`
- workflow graph with conditions, joins, human gates, and manager nodes
- run with missing optional fields
- runtime nodes and approvals
- unknown Atlas fields and unknown event types
- Atlas error response normalization

### Contract tests

Run against a real Atlas instance or a fixture server generated from the Atlas OpenAPI contract:

- login/logout/me
- list/get/create/update/delete for supported resources
- 401 and 403 behavior
- 404 for missing IDs
- 409 mutation conflicts
- pagination and limits
- artifact content authorization
- delivery retry and approval actions

Mock-only tests are not sufficient for the release gate.

### Stream tests

- initial event replay
- text and terminal events
- unknown event type
- duplicate sequence
- out-of-order sequence
- disconnect and reconnect
- expired auth during stream
- terminal event followed by late event
- bounded memory when a stream is long

### Browser acceptance tests

- login, refresh, logout
- viewer cannot see or execute forbidden mutations
- dashboard loads with zero workers/runs
- worker offline/degraded states
- workflow create/save/reload
- workflow validation errors
- manual run and persisted-state canvas progress
- pause/resume/cancel
- approval decision
- artifact download
- delivery retry
- audit and usage filters
- two tabs observe a mutation
- Atlas restart while the UI is open

## Performance checks

- No unbounded log DOM growth.
- No refetch loop faster than the documented interval.
- Dashboard uses aggregate endpoints rather than loading every historical record.
- Large workflow graphs remain editable without re-rendering unrelated panels.
- Query cancellation occurs on navigation.

## Release evidence

Record the following for each release:

- Atlas version/commit tested
- frontend commit
- API origin
- role/permission matrix result
- stream behavior result
- known Atlas limitations exercised
- build/lint/test output

## Phase 7 evidence and strategy additions (2026-07-21)

The Phase 7 matrix is recorded in `RELEASE_READINESS.md`. The new remote-like suite builds the
production Node artifact and runs three distinct origins: browser-facing HTTPS proxy, internal
flow-designer HTTP server, and private Atlas. It asserts production cookie attributes, CSRF
origin matching, the absence of direct browser→Atlas requests, and successful artifact/CSV/SSE
same-origin routes. The harness rejects non-24 Node runtimes; the recorded rerun executed the
artifact on Node v24.14.0. A clean temporary archive of Atlas `595ef62` supplied a second real-Atlas
contract run so an existing dirty Atlas checkout could not be misreported as a pristine commit.

The restart browser test now warms two query windows, kills the real isolated Atlas process, and
asserts the shell's cached-data warning after the background refetch reaches the dead socket. Unit
coverage keeps terminal authorization/validation/conflict failures out of that outage signal.

Full results: typecheck/lint/format/build exit 0; unit 391; real-Atlas contract 136 + 3 skipped;
stream 24; browser 94; remote-like 1 on Node v24.14.0; canary bundle scan clean across 57 public
files.

## Atlas `82207f7` adoption evidence (2026-07-21)

Atlas's own `./scripts/gate.sh` completed GREEN at clean commit `82207f7`. The adoption pass then
added and ran the new assertions: full unit `414 passed`, real-Atlas contract `143 passed and 3
skipped`, stream `27 passed`, browser `98 passed`, and remote-like Node `v24.14.0` `1 passed`.
The canary bundle scan covered 57 public files and was clean. The historical 136 + 3 result is
backward-compatibility evidence only; the new tests require session metadata, Retry-After, token
purpose/expiry, `default_reply`, `expected_version`, cursor pages, keepalive activity, and the
safe rejected-body transport behavior.

The mandatory additions and mutation targets are now implemented in the adoption commits recorded
in `RELEASE_READINESS.md`. Real Atlas remains required for wire/inheritance/conflict/stream claims;
fixtures remain limited to malformed-boundary and clock-controlled unit cases.

## Phase 6 evidence and strategy additions (2026-07-21)

Phase 6 added four test strategies worth keeping:

- **Production-middleware CSRF testing** (`tests/e2e/phase6-security.spec.ts`): capture a real
  RPC the app issues (URL, body, functional headers), then replay it with crafted
  `Sec-Fetch-Site`/`Origin`/`Referer` through Playwright's request API. This drives the actual
  middleware in `src/start.ts` — never a re-implementation of its rules — and can present a
  live session cookie cross-site, which is the attack CSRF exists to stop.
- **Socket-level cancellation proof** (`tests/unit/cancellation-retry.test.ts`): a real local
  HTTP server (not a stubbed `fetch`) observes its connection close when a read is aborted, so
  "cancellation propagates to Atlas" is proven at the layer Atlas experiences it. The same
  fixture server supplies the statuses a real Atlas cannot be made to emit (429, 5xx with
  exception text, proxy HTML) through the production fetch path — permitted at the Atlas HTTP
  boundary precisely because the real-Atlas contract suite still passes in full beside it.
- **Atlas-restart recovery** (`tests/e2e/zz-resilience.spec.ts`, runs last by name): the
  suite's shared Atlas is killed by pid and respawned on the same port against the same SQLite
  file via `respawnAtlas` (`tests/contract/atlas-instance.ts`), asserting a truthful outage
  state (no `/auth` redirect), recovery via the page's own retry control, and no lost
  persisted state. Restart info travels in the e2e seed file (`atlasRestart`).
- **Static design-token regression scan** (`tests/unit/design-tokens.test.ts`): fails the unit
  suite on any new literal colour class or hex/rgb/oklch value outside token definitions,
  distinguishing colour arbitraries from dimension arbitraries and carrying the two deliberate
  exemptions (the standalone error page's declared token block; `chart.tsx`'s Recharts
  attribute selectors). Paired with computed-style e2e checks
  (`tests/e2e/phase6-tokens.spec.ts`) so a token that resolves to nothing cannot pass.

Accessibility acceptance (`tests/e2e/phase6-a11y.spec.ts`) asserts on real DOM: dialog focus
containment/Escape/restore, keyboard-operable table rows, pane focus management, duplicate-
submit guards against a genuinely slow (delayed, not mocked) RPC, `aria-current`, and the auth
error's `aria-describedby` association. `scripts/scan-client-bundle.mjs` makes the credential
bundle scan reproducible with a positive control. Full command results are in `CHECKLIST.md`.

## Phase 5 evidence (2026-07-21)

The operational pages added unit coverage for their view models (including the structural
raw-token exclusion and the date-boundary validator), 25 real-Atlas contract tests
(`tests/contract/phase5.contract.test.ts`: the fixed latest-100 conversation window, absent
conversation item routes, no global artifact list, delivery filters and bounded retry to
`failed`, audit/usage date bounds and CSV headers, user/token lifecycle with the raw token
returned once, and the four-role permission matrix — the harness now seeds an `auditor`), and
11 browser tests (`tests/e2e/phase5.spec.ts`: forbidden states, reload-persistent creates,
Atlas-side filters, same-origin CSV downloads, the one-time token lifecycle swept across DOM
and storage, and a no-scaffold-data sweep). Full command results are in `CHECKLIST.md`.

## Phase 3 audit evidence (2026-07-20)

The editor audit re-ran typecheck, lint, formatting, focused graph/layout units, the full unit
suite, real-Atlas contract suite, and the browser suite. The browser suite completed **63 passed**
tests, including unsaved-navigation blocking, start-node deletion protection, confirmed node
deletion, semantic save/reload, and the real Atlas validation/run paths. The full command results
are recorded in `CHECKLIST.md`.
