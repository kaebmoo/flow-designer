# Testing and QA strategy

Status: implemented through Phase 3 and reconciled on 2026-07-20.

## Runners and scripts

- **Unit, contract, and future stream tests:** Vitest.
- **Browser acceptance:** Playwright against an isolated local Atlas instance.

| Script                  | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `bun run typecheck`     | TypeScript (`tsc --noEmit`)                                       |
| `bun run lint`          | ESLint                                                            |
| `bun run format:check`  | Prettier                                                          |
| `bun run test`          | Unit tests                                                        |
| `bun run test:contract` | Contract tests against real isolated Atlas                        |
| `bun run test:stream`   | Reserved for Phase 4; passes with no tests until streaming exists |
| `bun run test:e2e`      | Playwright acceptance suite                                       |

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

### Stream tests (Phase 4)

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

## Phase 3 audit evidence (2026-07-20)

The editor audit re-ran typecheck, lint, formatting, focused graph/layout units, the full unit
suite, real-Atlas contract suite, and the browser suite. The browser suite completed **63 passed**
tests, including unsaved-navigation blocking, start-node deletion protection, confirmed node
deletion, semantic save/reload, and the real Atlas validation/run paths. The full command results
are recorded in `CHECKLIST.md`.
