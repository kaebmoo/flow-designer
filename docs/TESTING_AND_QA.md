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

## Workflow Test Run and observed contract — Milestone A evidence (2026-07-31)

Scope: `docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md` §6. Atlas was read only; neither Atlas
nor thClaws was modified.

Three claims needed evidence that ordinary unit tests cannot give.

**The grammar is Atlas's, not ours.** `tests/unit/workflow-run-contract.test.ts` drives a table of
templates whose expected results were produced by running Atlas's own compiled `_FIELD_RE`
(`atlas/workflows.py:31`) over the same strings — including the cases where JavaScript and Python
would otherwise diverge (`{input.a_ก}` matches, `{input.ชื่อ}` does not, because Python's `\w` is
Unicode-aware while JavaScript's is ASCII-only). A divergence there is a divergence from the
executor, not a style difference.

**The manager finding is behavioural.** Prompt inspection alone would have reported `{input.x}` in
a manager prompt as a run input. Reading the executable path instead
(`_prepare_worker_node_payload`, `atlas/workflows.py:1614-1618`) showed manager prompts never
reach `render_prompt`. The tests assert the _absence_ of such a path from `inputPaths` and from
the preflight, which is the assertion that would fail if someone "fixed" the extractor to include
manager prompts. Recorded as an Atlas follow-up in `ATLAS_LIMITATIONS.md`.

**Input round-trips through a real Atlas.** `tests/contract/mutations.contract.test.ts` posts one
payload covering nested objects, arrays, every JSON scalar, `null`, empty containers, Unicode
keys, and escapes, then reads the persisted row back and asserts equality after removing exactly
`_meta` — the single documented exception, Atlas's `default_reply` merge. A fixture could not have
caught a coercion introduced anywhere in the chain.

Browser coverage lives in `tests/e2e/test-run.spec.ts`. Two harness constraints shaped it, both
documented in the file: it must sort **after** `reads.spec.ts`, whose 25-row window assertion only
holds while the instance has few workflows, and it signs in **once** for the whole file, because
Atlas revokes a user's oldest dashboard sessions beyond `max_active_sessions` (default 5) and a
login-per-test eventually invalidates the token `globalSetup` handed to `zz-live.spec.ts`.
`zz-live.spec.ts` gained the artifact-without-reload case, which needs the stub worker: it asserts
the table is empty while the node runs and populated after it succeeds, with no `page.reload()`.

Mutation-tested: dropping `input` from the start call, submitting on dialog open, removing the
terminal artifact invalidation, putting input on `RunView`, and deleting the observed/advisory
label each make a specific targeted test fail. Every mutation was reverted before the final gate.

Results: `format:check`, `lint`, `typecheck`, `build`, `scan:bundle` exit 0 (57 public files
clean); unit `528 passed`; real-Atlas contract `146 passed, 3 skipped`; stream `27 passed`;
browser `119 passed`.

**`test:remote` did not run.** Its `globalSetup` requires Node 24.x and the recording machine has
only Node v25.2.1 (plus an nvm-managed v20.17.0); the run failed with
`Phase 7 requires Node 24.x, got v25.2.1`. The guard was left in place rather than relaxed — it
exists so the remote-like artifact is exercised on the runtime `engines` pins, and disabling it to
produce a green line would report the opposite of what happened. Re-run this milestone's gate with
`PHASE7_NODE_BINARY` pointing at a Node 24 executable before treating the remote-like evidence as
current. Nothing in this milestone touches the transport, cookie, or CSRF behaviour that suite
covers, but that is an argument about likelihood, not evidence.

## Milestone A correction pass (2026-07-31)

A review of the first Milestone A candidate found six defects. Each was reproduced with a focused
test that went red before any fix.

**Prototype pollution (release blocker).** `{input.__proto__.atlasPolluted}` in a worker prompt
made `buildSkeleton` read `Object.prototype`, treat it as the nested branch, and write the leaf
onto it — one saved workflow poisoning every object in the running app. The path itself is
legitimate: Python has no prototype chain, so `__proto__` is an ordinary dict key Atlas would
substitute. Fixed with `Object.create(null)` containers and `hasOwnProperty` reads throughout, so
the key survives as an own property and still serialises. Covered as leaf, intermediate, repeated,
and `constructor.prototype`, each asserting `Object.prototype` is untouched afterwards.

**A false collision.** The module reported `{input.user}` and `{input.user.name}` as unsatisfiable
and refused to generate an example. Atlas renders both from `{"user":{"name":"Alice"}}` —
`_prompt_value` JSON-encodes the dict for the parent. Now one nested skeleton serves both, in
either authoring order, with an informational note rather than an error. Test plan item A-U02 now
records this runtime-backed expectation.

**Wrong response envelopes in generated examples.** The TypeScript and Python examples read the
run row off the top level, but Atlas wraps every relevant body. The TypeScript poll loop would
never terminate and the Python equivalent would `KeyError`. The access paths are now exported as
`SNIPPET_ENVELOPE`, rendered into the snippets from that constant, checked against representative
bodies in unit tests, and walked against a **live** Atlas in the contract suite — string-presence
assertions could not have caught this.

**Truncation blinded the preflight.** `inputPaths` was capped at 200 before preflight ran, so a
start worker referencing 201 paths became startable once the visible 200 were supplied. Bounding
now applies only to rendering; the contract keeps every path. Regression test uses 201 fields.

**Submission was not single-flight.** The guard was React `pending`, which only exists on a later
render, so two clicks in one task both dispatched. A synchronous ref latch now flips inside the
first handler. The browser test issues two `HTMLElement.click()` calls from one page evaluation
while the request is held, and asserts one request left the browser and Atlas created one run.

**Canvas and contract could disagree.** The editor is keyed on workflow id so a background refetch
cannot discard a draft — which let another tab's save reach the contract while the canvas kept
drawing the old graph. The route now compares the live version against the one the editor mounted
on, shows a banner, and withholds Test run until an explicit reload. Reproduced with two real
tabs, tab B saving through its own editor.

### Acceptance closure

- `PERMIT_APPLICATION_CONTRACT_V1`: a two-node permit workflow driven through the real dialog
  against the stub worker. Four Thai-language fields block when absent, persist byte-identically,
  and both `intake_review` and `assessment_result` appear with no reload.
- **Manager placeholder, captured from the wire.** The stub fixture now records every `/agent/run`
  prompt. On Atlas `4b837cc` an authored `{input.routing_hint}` arrives _literally_, and a value
  supplied for it never reaches the model — executable evidence for the discrepancy recorded in
  `ATLAS_LIMITATIONS.md`, replacing an argument from reading source.
- Production boundary: a non-object `input` is refused by the server function for a caller who
  never touched the dialog, an anonymous caller cannot start a run, and a viewer's identical
  well-formed request is refused by Atlas. Note that a `createServerFn` validator rejection is
  transported as **HTTP 200** with an error envelope — asserting on status would have been wrong
  in both directions, so these assert on the refusal text and the absence of any `wfr_` id.
- Viewer UX: the Test run button is disabled with a reason. UX only — the RPC assertion above is
  what proves a viewer cannot start one.
- Entered input is cleared on close and proven absent from the DOM and both web storages.
- Run-list responses are read **off the wire** and asserted not to contain the payload, rather
  than only checking the rendered DOM.
- Bounded preview cuts Thai text and emoji ZWJ clusters without stranding a surrogate.
- The terminal artifact refresh is counted: zero further refetches after the run settles.
- Every Copy (5) and Download (2) variant is checked for the entered value, the bearer, and the
  private origin.

Results: `format:check`, `lint`, `typecheck`, `build`, `scan:bundle` exit 0 (57 public files
clean); unit `549 passed`; real-Atlas contract `147 passed, 3 skipped`; stream `27 passed`;
browser `126 passed`; remote-like `1 passed` on Node `v24.14.0` supplied through
`PHASE7_NODE_BINARY`.

## Milestone C — authoritative workflow.interface adoption evidence (2026-07-31)

Scope: `docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md` §8. Flow Designer HEAD `ab61f5b`
(accepted Milestone A baseline); Atlas inspected and run for contract tests, never edited, at
`15c4876aa4f86e109a3cc52d6a299f46791053a2` (the commit that merges Milestone B's `workflow.interface`
v1, migration 015, packs, and the manager-prompt-parity fix — verified clean, exact HEAD match,
before any code was touched). thClaws was not touched.

**A real-Atlas fixture surprise, which is exactly the kind of evidence a description of the code
cannot give.** The first cut of `tests/contract/workflow-interface.contract.test.ts` used a
single-node Permit graph whose one worker referenced both `applicant_name`/`detail` (required)
and `review_context` (declared but optional). Every case failed identically: `workflow node
'intake' is the graph start node; input.review_context must be declared and required at every
object segment`. That is Atlas's `cross_check_against_graph` correctly refusing a start node that
renders an optional path — proof the rule this client's `pathRequiredAndTyped` mirrors is real,
not a misreading of the source. The fixture was split into the two-node shape the canonical
`PERMIT_APPLICATION_CONTRACT_V1` already uses for exactly this reason (start node renders only
required fields; the optional field is downstream-only), and every case passed.

**Manager-prompt substitution, captured from the wire, for the _opposite_ claim Milestone A
recorded.** `tests/e2e/zz-live.spec.ts`'s manager-placeholder probe previously proved
`{input.routing_hint}` reached the stub worker literally. Requalified against `15c4876`, the same
probe (same graph fixture, same stub) now proves the opposite: the rendered instruction line
contains the substituted value and not the placeholder syntax, while the JSON context Atlas
appends afterward still legitimately carries the node's stored, unrendered `prompt` field as
_data_ — a first version of this assertion treated that data dump as a substitution failure and
had to be narrowed to the rendered instruction segment. `tests/unit/workflow-run-contract.test.ts`
was requalified the same way: the old "never lists a manager reference as a run input" and "never
blocks on a manager-only reference" tests asserted the pre-parity behavior and are now replaced
with tests asserting the opposite (manager and worker prompts identical; a start-manager missing
path blocks preflight exactly like a start-worker's).

**Interface CRUD, run validation, version pin, snapshots, and packs against the real server.**
`tests/contract/workflow-interface.contract.test.ts` covers interface create/read/edit/explicit-clear,
a stale `expected_version` 409 that leaves the stored interface unchanged, a rejected bounded-profile
violation with no partial apply, valid/invalid Permit starts (400 naming the field), matching/stale
`expected_workflow_version` (409, no run, re-fetch confirms no side effect), an interface-absent
workflow's unaffected legacy behavior, trigger-fire semantics for both an object payload that fails
validation (202, `run: null`, `event.state: "failed"`) and a non-object payload (400, no event), run
snapshots surviving a live interface edit, the exact 1 MiB effective-input boundary (accepted at the
byte, rejected one byte over, using a Python-canonical-JSON-exact test helper — not the client's own
advisory estimator), a `default_reply` merge pushing an otherwise-tiny business input over that
boundary, and a graph edit that would make a stored interface's declared output impossible (rejected,
no partial apply). **Not run:** a real smoke test against the recorded pre-interface Atlas baseline —
doing so would require checking the one permitted-to-inspect Atlas working tree out to a different
commit, which is out of this suite's isolation boundary; the absent-field mapper case (an Atlas
response that omits `interface`/`interface_snapshot` entirely, not merely `null`) is covered instead
at the unit level. **Accepted as residual risk (2026-07-31): legacy pre-interface Atlas
compatibility is explicitly _not_ an acceptance criterion of this milestone.** The supported target
is the current Atlas (`15c4876`); interface-absent behavior is qualified against that Atlas with
`interface: null` plus the unit-level absent-key mapper case. If a requirement to support a
pre-interface Atlas checkout ever lands, this gap must be reopened and closed with a real smoke run
against a second, older checkout in a separate directory.

**Mutation-tested**, each producing the required test category's red before being reverted (verified
by `grep -rn "MUTATION-TEST" src/` returning nothing at final gate):

- Dropping `interface` from the save payload in `atlas-mutations.functions.ts` → the browser
  reload-survival test (`authors a declared interface, saves it, and it survives a reload`) failed
  on the reopened panel's schema field.
- Making `toWorkflowEditableInterface` ignore `schema_version` and always treat a stored interface
  as editable v1 → the unit boundary-guard test failed.
- Letting the Test Run dialog's `canStart` ignore declared-schema diagnostics in authoritative mode
  → the browser test asserting the Start button stays disabled on a schema violation failed.
- Omitting `expected_workflow_version` from the route's `startRun.mutate` call → the browser 409
  test failed (Atlas started the run instead of refusing it, since it had nothing to compare).
- Reverting `executablePrompt` to worker-only → four targeted manager-prompt unit tests failed.
- Making the run-detail mapper stop reading `run.interface_snapshot` (the same observable failure
  as reading a live/current source instead: the frozen contract silently changes once the live one
  does) → both the unit mapper test and the browser historical-snapshot test failed.
- Writing entered Test Run text to `sessionStorage` on every keystroke → both the pre-existing
  Milestone A no-persistence test and the new declared-mode equivalent failed.
- Widening `isExactlyObjectType` to accept any type list containing `"object"` (so
  `["object","null"]` would pass) → three unit diagnostics tests failed (root-union rejection,
  structural-validator rejection, start-intermediate requiredness); the real-Atlas bounded-profile
  rejection test correctly stayed green throughout, since it exercises Atlas's own validator, not
  this client's mirror — proof Atlas remains authoritative regardless of a client-side regression.

Results: `git diff --check` exit 0; `format:check`, `lint` (0 errors; pre-existing
`react-hooks/exhaustive-deps` and `react-refresh/only-export-components` warnings unrelated to this
milestone), `typecheck`, `build`, `scan:bundle` exit 0 (56 public files clean); unit `612 passed`;
real-Atlas contract `163 passed, 3 skipped`; stream `27 passed`; browser `141 passed`; remote-like
`1 passed` on Node `v24.14.0` supplied through `PHASE7_NODE_BINARY`.

Correction (2026-07-31, verification round): an earlier revision of this section recorded the
contract suite as `179 passed` — that number never reproduced; the correct count was `163`
(Milestone A's 147 plus the 16 new interface cases; the new suite had been double-counted). The
unit/browser counts above also reflect the post-review fix round (independent verification
findings F1–F5): the Clear-after-add-and-save regression fix with its browser regression test,
the unsavable ambiguous/orphaned-output escape hatches, the unknown-`schema_version` run-snapshot
render, unchanged-interface omission on save (no re-encode), the closed local-mirror parity gaps
(depth seed, non-root `$schema`, `examples`, `required` entries, empty property names,
`pathRepresentable` polarity, whole-document byte cap), and a declared-mode browser test that now
genuinely reaches Atlas's 400 through the advisory 1 MiB gap instead of stopping at the local
mirror.

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
conversation item routes, the global artifact window/filter/permission contract, delivery
filters and bounded retry to `failed`, audit/usage date bounds and CSV headers, user/token
lifecycle with the raw token returned once, and the four-role permission matrix — the harness
now seeds an `auditor`), and browser tests (`tests/e2e/phase5.spec.ts`: forbidden states,
reload-persistent creates, a real artifact ledger with lazy preview/filter/total/empty/download
coverage, Atlas-side filters, same-origin CSV downloads, the one-time token lifecycle swept
across DOM and storage, and a no-scaffold-data sweep). Full command results are in
`CHECKLIST.md`.

## Phase 3 audit evidence (2026-07-20)

The editor audit re-ran typecheck, lint, formatting, focused graph/layout units, the full unit
suite, real-Atlas contract suite, and the browser suite. The browser suite completed **63 passed**
tests, including unsaved-navigation blocking, start-node deletion protection, confirmed node
deletion, semantic save/reload, and the real Atlas validation/run paths. The full command results
are recorded in `CHECKLIST.md`.
