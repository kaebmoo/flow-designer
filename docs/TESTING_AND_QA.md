# Testing and QA strategy

## Proposed test runners and scripts (Phase 0 planning only)

No test tooling is installed yet, and Phase 0 installs nothing and changes no application code. This section fixes the intended choices so Phase 1+ can add them in one reviewed step.

- **Adapter / unit / contract / stream tests → Vitest.** This is already a Vite project (`vite`, `@vitejs/plugin-react`), so Vitest reuses the existing config and TS paths with near-zero setup and runs `*.functions.ts`/mapper/adapter logic natively. No competing runner is justified.
- **Browser / end-to-end tests → Playwright.** Drives real login, SSE reconnect, canvas, and two-tab flows against a running frontend + local Atlas.

Intended `package.json` scripts (to be added in Phase 1, not now):

| Script          | Purpose                                | Tool       |
| --------------- | -------------------------------------- | ---------- |
| `typecheck`     | `tsc --noEmit`                         | TypeScript |
| `test`          | adapter/unit tests                     | Vitest     |
| `test:contract` | contract tests vs a real/fixture Atlas | Vitest     |
| `test:stream`   | SSE replay/dedupe/reconnect            | Vitest     |
| `test:e2e`      | browser acceptance                     | Playwright |
| `format:check`  | `prettier --check .`                   | Prettier   |

`lint` and `build`/`dev` already exist in `package.json` and are unchanged.

### Runtime note — package manager vs production runtime

These are separate choices (see `CONFIGURATION.md` §1):

- **Package manager: Bun 1.3.14 (pinned).** `bun.lock` exists and `package.json` records `"packageManager": "bun@1.3.14"`. The Bun binary is **not installed on this machine** (only Node `v25.2.1` is present) — do not install it without approval.
- **Production runtime: Node 24 LTS** for Node-based deployments. As of July 2026, Node 24 is Active LTS; Node 20 is EOL and Node 25 is a short-lived non-LTS line — target neither. Cloudflare Workers, if chosen, is a separate runtime.

Pin both so contributors and CI match; the `test`/`test:*` scripts run under the pinned package manager regardless of production runtime.

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
- manual run and live canvas progress
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
