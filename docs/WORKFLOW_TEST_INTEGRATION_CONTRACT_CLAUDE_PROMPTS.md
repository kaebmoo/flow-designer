# Claude Code Prompt Pack — Workflow Test and Application Interface Contract

Status: **ready for staged execution after plan review**

Companion documents:

- [Implementation plan](WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md)
- [Independent test plan](WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md)

> วิธีใช้: อย่าส่งทั้งสาม prompt ให้ Claude Code ทำรวดเดียว ใช้ Prompt A ก่อน ตรวจ diff/UX/test
> แล้วอนุมัติให้สร้าง commit ใหม่ของ Milestone A จึงแทนค่า `<FLOW_MILESTONE_A_COMMIT>` และใช้
> Prompt B ใน Atlas repository เมื่อ Atlas ผ่าน gate และได้รับ commit ที่ชัดเจนแล้ว จึงแทนค่า
> `<ATLAS_INTERFACE_COMMIT>` และใช้ Prompt C กลับมาที่ Flow Designer การแบ่งเช่นนี้ป้องกัน
> public contract, migration และ UI เปลี่ยนพร้อมกันโดยไม่มีจุดตรวจรับ

The recorded planning baselines were flow-designer `863dfd9` and Atlas `4b837cc`, both clean on
`main` on 2026-07-31. Every prompt requires Claude Code to inspect the live state again. The
recorded hashes are evidence, not reset targets.

---

## Prompt A — Flow Designer Test Run and Observed Integration Contract

```text
You are implementing Milestone A of a staged workflow-integration project.

Repository you may edit:
/Users/seal/Documents/GitHub/flow-designer

Repository you may inspect but MUST NOT edit in this phase:
/Users/seal/Documents/GitHub/atlas-control-plane

Do not modify thClaws.

Read completely before editing:
- /Users/seal/Documents/GitHub/flow-designer/AGENTS.md
- /Users/seal/Documents/GitHub/flow-designer/CLAUDE.md if present
- docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md
- docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md
- docs/ARCHITECTURE.md
- docs/BACKEND_INTEGRATION.md
- docs/FRONTEND_ENGINEERING.md
- docs/TESTING_AND_QA.md
- docs/guides/web-user-guide-en.md
- docs/guides/web-user-guide-th.md
- Atlas AGENTS.md and the Atlas files referenced by the companion plan, read-only

Preflight:
1. Report pwd, current branch, HEAD, `git status --short --branch`,
   `git diff --stat`, `git diff --check`, and `git worktree list` for both repos.
2. Re-read the actual start-run, workflow editor, run-detail, artifact-query,
   mapper, tests, Atlas prompt renderer, and Atlas API paths. Do not rely only
   on the plan's line numbers.
3. The following planning changes may be uncommitted when this prompt is
   delivered:
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_CLAUDE_PROMPTS.md
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md
   - the three links for them in docs/README.md
   Treat the three planning documents as user-owned/read-only, preserve the
   README links, and record this exact baseline. Their presence alone is not a
   blocker. If any other tracked or untracked work overlaps this scope, STOP
   and report it.
   Do not stash, reset, restore, clean, checkout over, delete, or overwrite it.
4. Do not pull, rebase, amend, squash, force-push, or rewrite history. This
   Flow Designer repo is connected to Lovable.
5. Do not commit, push, open a PR, merge, or deploy unless separately asked.
6. Do not edit `.env`, generated files, `src/routeTree.gen.ts` by hand,
   node_modules, build output, test artifacts, or lockfiles.
7. Add no dependency. Use the existing React/Radix/UI and test stack.

Objective:
Close the immediate workflow input/output test gap without building an
end-user application and without changing Atlas. Replace the current
input-less one-click Run with a safe Test Run dialog and an explicitly
advisory Observed integration contract. Start a real Atlas run through the
existing typed same-origin server path, then reuse the real run-detail UI.

Truthfulness rule:
Anything derived from prompt placeholders or node configuration is
OBSERVED/ADVISORY. It is not an Atlas-enforced schema. Never infer or claim
types, defaults, business descriptions, branch-independent requiredness,
or guaranteed outputs. Never call it OpenAPI, declared, authoritative, or
enforced. Never auto-save inferred data into Atlas.

Implement the following coherent slice.

1. Pure observed-contract module

Add a focused pure module such as:
`src/lib/workflow-run-contract.ts`

It must:
- use Atlas's actual dotted identifier placeholder grammar, then select only
  the `input.*` root;
- support nested dictionary paths but not array indexes;
- deduplicate each path while retaining every consuming node id;
- distinguish the start worker from downstream/conditional nodes;
- handle parent/child paths such as `{input.user}` and
  `{input.user.name}` with one nested skeleton that satisfies both, and add a
  truthful diagnostic note that the parent renders as JSON;
- create a deterministic illustrative JSON object without claiming its
  values are typed defaults;
- derive possible worker artifacts from `outputs[0]`, with kind `json` only
  when `output_format === "json"`, otherwise `text`;
- keep producer ids and mark every output possible/branch-dependent;
- never invent fixed file-ref outputs from `collect_files`;
- generate deterministic, bounded advisory JSON/Markdown and copy snippets.

Before deciding whether manager prompt references are included, inspect the
current target Atlas execution path. The generated contract must match
executable behavior. Atlas docs/UI currently claim manager substitution, but
the implementation may build manager prompts through a different path. Do
not hide that discrepancy or falsely claim an unused manager input. Record it
as an Atlas follow-up if confirmed.

2. Test Run dialog

Replace the current direct Run mutation with a button labelled `Test run`.
Opening the dialog must have no side effect.

Add a focused component such as:
`src/components/atlas/workflow-test-run-dialog.tsx`

The dialog/sheet must provide:
- an Input JSON tab with a raw textarea, always available;
- `{}` or an observed skeleton that safely represents every satisfiable path as the initial example;
- clear invalid-JSON and top-level-object validation;
- arrays, strings, numbers, booleans, and null rejected as the root;
- a definite missing reference in the start WORKER prompt as a blocking
  preflight error because Atlas would fail immediately;
- missing downstream/branch-only observed paths as warnings, not invented
  global requirements;
- explicit copy that Start creates a real, potentially cost-bearing Atlas run;
- an explicit final `Start test run` click;
- disabled duplicate submission and no automatic retry;
- accessible focus containment, Escape/close behavior, labels, descriptions,
  pending state, error association, and focus restoration.

Do not persist the entered run input in localStorage, sessionStorage, URL
search params, logs, analytics, generated examples, or downloadable files.

3. Real start-run path

Use the existing hook/server-function/fixed Atlas adapter. Pass:

`{ workflowDefinitionId: id, input: parsedInput }`

Do not add a generic proxy, new executor, fake run, browser-to-Atlas call, or
browser-visible Atlas bearer.

Preserve:
- save-before-run and dirty/invalid graph guards;
- Atlas RBAC and error authority;
- single-flight mutation;
- real `wfr_...` id navigation;
- no optimistic local run state.

4. Integration tab

The same surface must include an Integration tab labelled:
`Observed · not enforced by Atlas`

Separate two categories visibly:

Official Atlas API facts:
- `POST /api/workflow-runs`;
- 202 and real run id;
- poll run detail;
- list artifacts;
- waiting/terminal states;
- approvals;
- optional signed webhook reply;
- direct run has no dedupe, while trigger `/fire` supports a dedupe key.

Observed workflow facts:
- workflow id and currently observed version;
- input paths and every consuming node;
- possible artifacts, producer node, and observed text/json kind;
- explicit limitations for branches, dynamic files, and unknown types.

Generate copy-safe cURL, backend TypeScript, and Python examples using
`$ATLAS_BASE_URL`, `$ATLAS_TOKEN`, or obvious placeholders. Never include the
real private Atlas origin, bearer, session cookie, callback secret, or the
user's current test values. Do not recommend a bearer in browser JavaScript.

Provide a safe copy/download of advisory JSON/Markdown if it stays small and
uses only generated placeholders. State that `attachments` in JSON is
text/metadata, not binary file upload; the current post-start file endpoint is
not atomic pre-start file staging.

5. Run detail request/output inspection

The Atlas run response already carries input to the server mapper. Add a
bounded pretty-JSON preview to RunDetailView ONLY:
- do not add business input to shared RunView or Flow Designer's
  browser-facing run-list models/caches;
- cap with the existing 32,000-character preview discipline;
- return an explicit truncation flag;
- render collapsed by default with a PII/sensitive-data warning;
- keep `_meta` visible only within the same bounded detail preview; never
  promote its values into copy snippets.

Make run artifacts refresh without a manual reload:
- invalidate/refetch this run's artifact query on relevant live change;
- ensure one terminal-state refresh even when no streamable job remains;
- avoid an unbounded/refetch loop;
- preserve the complete artifact table and preview/download behavior.

6. Documentation

Update EN and TH parity:
- docs/guides/web-user-guide-en.md
- docs/guides/web-user-guide-th.md
- docs/BACKEND_INTEGRATION.md
- docs/TESTING_AND_QA.md
- docs/README.md

Add focused EN/TH application-integration guides only if that is clearer than
overloading the operator guide. Explain browser UI vs application backend vs
Atlas vs thClaws. Remove the stale statement that editor Run can only send
empty input.

7. Required tests

Pure/unit:
- exact Atlas placeholder grammar;
- ignored artifact/run/node/job roots;
- nested paths;
- duplicates and multiple consumers;
- parent/child path nesting and diagnostic note;
- malformed/unsupported placeholders;
- no-placeholder graph;
- start-worker error versus downstream warning;
- possible output inference and collect_files non-inference;
- deterministic safe snippet/contract generation;
- JSON/root validation;
- bounded detail input preview;
- RunView still structurally omits input.

Real-Atlas contract:
- nested business objects, arrays, and scalars reach the persisted run
  unchanged through the existing start path;
- assert and document the sole existing exception: Atlas may merge the
  workflow's `default_reply` into `_meta.reply` when the caller omitted it;
- a real id is returned;
- authorization/error behavior is preserved;
- no generic browser transport is introduced;
- execute a manager-start probe through the real recorded Atlas baseline and
  capture the actual `/agent/run` prompt in the existing thClaws test stub.
  Prove whether the authored `{input.*}` text is rendered, and make observed
  extraction match that executable result. Do not treat source review as
  runtime proof or change the pinned expectation silently.

Browser:
- open/close/focus restoration;
- opening causes no mutation;
- invalid JSON and non-object roots cannot start;
- observed skeleton can be edited;
- definite start-worker missing path blocks;
- conditional warning does not masquerade as schema;
- one explicit submit creates one real run and navigates to `/runs/wfr_...`;
- pending state prevents duplicate submit;
- error stays visible and useful;
- observed labels never say required/type-safe/enforced;
- copied/downloaded examples contain no test value/token/private origin;
- bounded input appears only on detail;
- terminal artifact appears without page reload;
- existing dirty, permission, approval, cancel, artifact, and delivery behavior
  remains green.

Implement and execute all automated Milestone A cases in
WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md. Hand the manual UAT-A checklist
to the reviewer; do not claim a human acceptance result you did not observe.

Work in small logical edits. Do not perform unrelated cleanup.

Verification gate:
- `git diff --check`
- `bun run format:check`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run test:contract`
- `bun run test:stream`
- `bun run test:e2e`
- `bun run test:remote`
- `bun run build`
- `bun run scan:bundle`

Use Node 24 and the repository-pinned Bun. If a required command is blocked,
report the exact reason and run the closest safe subset, but do not call the
milestone complete.

Mandatory mutation checks:
- make the start-run call drop `input`; the targeted test must fail;
- make opening the dialog submit; the targeted browser test must fail;
- stop terminal artifact invalidation; the targeted test must fail;
- put input on RunView/list; the structural mapper test must fail;
- remove the observed/advisory label; the UI test must fail.

Restore every deliberate mutation before the final green gate. Never commit a
mutation.

STOP after the gate. Do not commit.

Report:
- branch, HEAD, and final status;
- changed files and diffstat;
- concise user-visible behavior;
- exact command, exit code, and test counts for every check;
- mutation-check evidence;
- confirmed manager-placeholder behavior and any Atlas follow-up;
- known limitations, especially no authoritative schema/version pin and no
  pre-start binary attachment;
- test-plan traceability and whether manual UAT-A is pending or observed;
- explicit confirmation that Atlas and thClaws were not modified.
```

---

## Prompt B — Atlas Authoritative Workflow Interface

Run this only after reviewing Milestone A, accepting the public contract decisions in the
companion plan, and recording the accepted Milestone A implementation in a new clean commit.
Replace `<FLOW_MILESTONE_A_COMMIT>` below before use.

```text
You are implementing Milestone B: an additive, authoritative, versioned
workflow application interface in Atlas Control Plane.

Repository you may edit:
/Users/seal/Documents/GitHub/atlas-control-plane

Repository you may inspect but MUST NOT edit in this phase:
/Users/seal/Documents/GitHub/flow-designer at
<FLOW_MILESTONE_A_COMMIT>

Do not proceed while that placeholder is unresolved. Do not modify thClaws.

Read completely before editing:
- /Users/seal/Documents/GitHub/atlas-control-plane/AGENTS.md
- /Users/seal/Documents/GitHub/atlas-control-plane/CLAUDE.md if present
- /Users/seal/Documents/GitHub/flow-designer/docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md
- /Users/seal/Documents/GitHub/flow-designer/docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md
- Atlas docs/plans/ga-completion-plan.md, especially documentation policy
- Atlas docs/specs/workflow-definition.schema.json
- Atlas docs/specs/openapi.yaml
- Atlas docs/specs/input-adapter-contract.md
- Atlas docs/specs/pack-format.md
- Atlas docs/specs/threat-model.md
- Atlas concepts and visual-builder specs in both EN and TH
- current migrations, workflow runner, trigger service, packs, API handlers,
  and every related hermetic check

Preflight:
1. Report pwd, branch, HEAD, `git status --short --branch`,
   `git diff --stat`, `git diff --check`, and `git worktree list` in both repos.
2. Verify Flow Designer HEAD exactly equals <FLOW_MILESTONE_A_COMMIT> and that
   the accepted Milestone A implementation and automated tests are present.
   If any Milestone A implementation change is still uncommitted, STOP. Prompt
   B must not reinterpret an unreviewed Flow diff as its baseline.
3. Only these Flow Designer planning changes may remain uncommitted:
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_CLAUDE_PROMPTS.md
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md
   - their three links in docs/README.md
   They are read-only input to this Atlas phase and are not a blocker. If Atlas
   is dirty in this scope, or any other tracked/untracked work overlaps, STOP.
   Do not stash, reset, restore, clean, checkout over, delete, or overwrite it.
4. Do not pull, rebase, amend, squash, force-push, rewrite history, commit,
   push, open a PR, merge, or deploy unless separately asked.
5. Do not edit `.env`, generated/vendor/build artifacts, shipped migration
   functions, dashboard gate-marker ids/classes, or unrelated files.
6. Atlas core remains Python STANDARD LIBRARY ONLY. Add no dependency.
7. Every API change is additive. Existing paths/envelopes and interface-absent
   behavior must remain unchanged.
8. Do not add `tenant_id`.

Objective:
Add the optional nullable `workflow.interface` contract defined by the
companion plan. Atlas must persist and validate it, validate business input
before run side effects, support an optional direct-run workflow-version pin,
snapshot interface/version onto runs, and round-trip it through packs.

Do not implement a full JSON Schema engine, UI form layout, binary file intake,
required-on-success output proof, JSON output content schemas, webhook artifact
filtering, or thClaws integration.

1. Architecture and exact v1 contract

Add an ADR that records:
- `interface.schema_version === 1`;
- optional nullable legacy semantics;
- bounded JSON-Schema-compatible input profile;
- business projection excluding exactly `_meta` and `_trigger_chain`;
- synthetic sample policy;
- outputs as public POSSIBLE text/json artifact keys, not guaranteed branch
  results;
- optional `primary_output`;
- optional direct-run `expected_workflow_version`;
- run interface/version snapshots;
- pack behavior;
- every deferred item.

Implement the exact shape and semantics in:
/Users/seal/Documents/GitHub/flow-designer/docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md

If current code makes one of those decisions impossible or unsafe, STOP and
report source evidence. Do not silently redesign a public contract.

2. Bounded standard-library validator

Add one focused module, for example `atlas/workflow_interface.py`.

V1 input_schema:
- root must declare exactly `type: "object"`;
- support `type` (one primitive string or unique primitive string array),
  `properties`, `required`, boolean `additionalProperties`, `items`, `enum`,
  `const`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`,
  `maxItems`, and annotation-only `title`, `description`, `default`,
  `examples`;
- accept optional `$schema` only when it equals
  `https://atlas.local/schemas/workflow-interface-input-v1.schema.json`;
  never fetch it;
- reject every unknown/unsupported keyword, including `$ref`, combinators,
  conditional schemas, regex pattern, arbitrary format, dependent/dynamic,
  and unevaluated keywords;
- require schema_version and input_schema in an interface object; sample_input,
  outputs, and primary_output are optional; omitted outputs means [];
- enforce interface/sample 65,536-byte UTF-8 caps; an interface-enabled run's
  complete effective input has a 1,048,576-byte cap before reserved projection;
- measure byte caps using exactly
  `json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
  allow_nan=False).encode("utf-8")`;
- reject non-finite numbers;
- enforce depth 16, total properties 256, each required/enum list 256, outputs
  256, validation traversal 10,000 instance nodes, title 256 Unicode code
  points, and description 2,048 Unicode code points;
- produce stable path-aware ValueError messages;
- treat JSON boolean as distinct from number/integer;
- compare enum/const with JSON type fidelity;
- never recurse or allocate without the documented bounds.

At definition validation:
- interface absent/null is valid;
- reject unknown fields inside the new interface/schema/output objects without
  introducing a new broad rejection policy for legacy workflow-root extras;
- validate sample_input with the same business schema;
- output keys match exactly `^[A-Za-z_][A-Za-z0-9_]{0,127}$`;
- each declared output is produced by exactly one worker;
- kind is text/json and matches output_format;
- output entries are unique;
- primary_output references a declared output;
- annotations are bounded;
- after manager interpolation parity is resolved, every executable
  `{input.path}` is representable by the schema, and every path used by the
  graph start node is declared and required at every object segment; every
  intermediate start-path segment must declare exactly `type: "object"` and
  cannot be a nullable or mixed scalar/object union;
- downstream/conditional prompt paths may be optional but may not be
  impossible under a closed schema;
- no real secret/PII detector is invented; docs and API make sample ownership
  explicit.

Use the same validator from API, runtime, packs, and checks. Do not create
drifting validation copies.

3. Prompt-contract parity prerequisite

Verify worker AND manager prompt interpolation against published docs.
Current code may render worker prompts through render_prompt while appending a
manager prompt through another path. If confirmed, make manager's authored
prompt use the same documented `{input.*}`, `{artifact.*}`, `{run.*}`,
`{node.*}`, and `{job.*}` rendering before manager context/instructions are
appended. Preserve the manager_decision_v1 response contract. Add a hermetic
regression check. If compatibility evidence says this cannot be changed
additively, STOP and report instead of hiding the mismatch.

4. Append-only migration and persistence

Append the next migration number available at execution time. Never edit an
existing step.

Add nullable columns:
- workflow_definitions.interface TEXT
- workflow_runs.interface_snapshot TEXT
- workflow_runs.workflow_version_snapshot INTEGER

Do not edit `SCHEMA`, `MIGRATIONS[0]`, or any shipped migration. A fresh DB
already applies every migration in order. Add only the next append-only
migration, then update row decoding, definition create/get/list/update,
explicit null clear, optimistic expected_version save, run create/get/list,
and migration checks.

Preserve SQL NULL as application null for interface/snapshot. Do not decode it
to `{}` because null means no authoritative contract.

Changing only interface must increment workflow version exactly once under the
existing optimistic save rule.

5. Workflow CRUD and validate endpoint

POST /api/workflows:
- optional interface object/null;
- validate graph/policy/default reply/interface before persistence.

PUT /api/workflows/{id}:
- absent interface preserves stored interface;
- explicit null clears it;
- object replaces it;
- if graph changes while interface is omitted, validate the stored interface
  against the merged new graph before writing;
- preserve expected_version conflict behavior.

GET/list:
- return the additive interface field.

POST /api/workflows/{id}/validate:
- additively accept/merge interface when supplied;
- otherwise validate the stored interface against the candidate graph;
- do not mislabel default_reply validation if that endpoint still excludes it.

Do not add a generic contract endpoint in v1.

6. Shared run-start validation and version guard

Direct start request may add:
`expected_workflow_version?: positive integer`
Boolean is not an integer.

Load the definition once and use that same object for version comparison,
graph, policy, interface, and snapshots.

For direct start, perform this order before workflow-run creation or runtime
side effects:
1. normalize/apply the existing default reply;
2. validate the existing `_meta` envelope;
3. compare expected workflow version when supplied;
4. enforce the 1,048,576-byte cap on the complete effective input when an
   interface exists;
5. remove exactly `_meta` and `_trigger_chain` for business projection;
6. validate business input when interface exists;
7. create/audit/start the run and snapshots.

Direct invalid input returns the existing `{error}` envelope with HTTP 400 and
creates no run, runtime node, workflow event, job, approval, artifact,
delivery, or workflow-run create/provenance audit. Direct version mismatch
returns HTTP 409 and creates no run.
Requests omitting the new field and definitions without interface retain exact
legacy behavior.

Trigger semantics MUST remain backward compatible:
- `/api/workflow-triggers/{id}/fire` continues to return its current HTTP 202
  result object when an OBJECT payload fails interface/envelope validation;
- the trigger event records state `failed`, a path-aware error, and `run: null`;
- a non-object `payload` retains its current separate HTTP 400 behavior before
  trigger bookkeeping and creates no trigger event;
- schedule/internal triggers use the same validation and create no run on
  incompatibility;
- preserve the current dedupe claim and received/failed trigger-event ordering;
  validation must precede workflow-run creation, not trigger bookkeeping;
- do not invent payload mapping or defaults beyond the existing workflow
  `default_reply` merge;
- v1 does not add a trigger version pin; document the limitation;
- preserve existing dedupe-claim semantics on failed fire.

7. Run snapshots

Snapshot onto each definition-backed run:
- graph;
- policy;
- interface object or null;
- workflow version.

Legacy/standalone rows remain nullable. Definition edit/delete cannot change a
historical run's interface/version interpretation. Resume/recovery must not
read a later live interface to reinterpret old input.

8. Packs

Keep the current pack schema version because this field is optional/additive.

Inside each workflows[] item:
- accept optional interface;
- validate with the shared validator and graph cross-check;
- persist on import;
- preserve on export;
- naturally include it in existing HMAC signing.

Continue accepting the legacy bundle-level sample_input as its existing
authoring-only field. Do not silently convert it to one workflow's interface
or create two sources of truth. Legacy packs round-trip as before.

Update one bundled synthetic example to demonstrate the per-workflow
interface while retaining compatibility.

9. Docs, OpenAPI, and security

Update every required source with EN/TH parity:
- docs/specs/workflow-definition.schema.json
- docs/specs/openapi.yaml
- docs/specs/api-reference-en.md
- docs/specs/api-reference-th.md
- docs/specs/workflow-visual-builder-spec-en.md
- docs/specs/workflow-visual-builder-spec-th.md
- docs/concepts-en.md
- docs/concepts-th.md
- docs/guides/api-integration-guide-en.md
- docs/guides/api-integration-guide-th.md
- docs/specs/input-adapter-contract.md
- docs/specs/pack-format.md
- docs/specs/threat-model.md
- docs/README.md, PROGRESS/release evidence, and the new ADR

State explicitly:
- this is a bounded profile, not complete JSON Schema;
- samples are persisted/exported and must be synthetic;
- interface is readable by roles that can read the workflow;
- reserved-field projection rules;
- outputs are possible/public, not required on all branches;
- callbacks/polling retain all existing artifacts;
- JSON attachments are not binary staging;
- the current file upload endpoint is post-run and not atomic for the start
  node;
- the 1 MiB effective-input bound is checked after JSON decoding and is not a
  general transport-level `_read_json` body cap;
- direct version guard exists; trigger version pin is deferred.

10. Hermetic checks

Add one focused standard-library check such as:
scripts/check_workflow_interface.py

Fold it into scripts/gate.sh and relevant py_compile/doc-check lists.

Cover:
- fresh DB and upgrade from the previous schema version;
- migration idempotency and legacy data survival;
- create/get/list/update/clear interface;
- interface-only optimistic version increment and stale conflict;
- unknown field/keyword rejection;
- exact profile URI and size serialization;
- every supported primitive/container keyword;
- depth/interface/sample/effective-input/count/traversal/annotation bounds;
- bool-vs-number and typed enum/const;
- sample mismatch;
- output producer/key/kind/primary checks;
- impossible prompt path rejection, start-path requiredness, and optional
  downstream path acceptance;
- nullable/mixed intermediate start-path rejection;
- graph edit revalidates stored interface;
- direct valid start;
- direct invalid input 400 and no run/event/job;
- direct input exactly at and above the 1 MiB boundary, including a
  `default_reply` merge that tips effective input over the limit;
- direct expected-version success and 409/no run;
- valid and invalid manual/webhook trigger payload;
- invalid/oversized `/fire` retains 202 + failed event + run null and existing
  dedupe bookkeeping;
- fixed trigger incompatibility starts no run;
- incompatible schedule failure advances according to existing scheduling
  semantics rather than wedging the slot;
- interface/version snapshot survives later definition edit/delete;
- pack import/export/signature round trip and tamper;
- possible/primary output omission does not fail an otherwise successful run;
- undeclared artifacts remain present in polling and signed webhooks;
- workflow read/update RBAC remains unchanged and audit details never copy the
  full interface/sample;
- invalid `_meta` precedes version comparison; after a valid envelope, a stale
  version precedes business-schema validation;
- non-object `/fire` payload retains 400 and creates no trigger event;
- legacy workflow/run/pack behavior unchanged;
- worker/manager placeholder parity.

Extend existing migration, workflow DB/API, pack, fuzz, and docs checks where
their ownership requires it. The validator must never leak an unexpected
exception type for hostile bounded input.

Mandatory mutation evidence:
- bypass business input validation -> focused check RED;
- bypass the effective-input size cap -> RED;
- skip start-prompt/schema cross-check -> RED;
- drop interface persistence -> RED;
- drop snapshot/version -> RED;
- accept an unsupported keyword -> RED;
- ignore expected version -> RED;
- change interface-invalid `/fire` from 202 failed-event to 400 -> RED;
- change non-object `/fire` from 400/no-event to 202 -> RED;
- drop pack interface -> RED;
- bypass manager placeholder rendering after the parity fix -> RED.

Restore every mutation and run green. Never commit a mutation.

Implement and execute all automated Milestone B cases in the independent test
plan. Hand its API/UAT review steps to the reviewer; do not substitute prose
for the hermetic checks.

Verification:
- `git diff --check`
- `./scripts/gate.sh`
- `./scripts/lint.sh`

STOP after the gate. Do not commit.

Report:
- branch, HEAD, final status, files and diffstat;
- migration number and compatibility behavior;
- exact supported/rejected schema profile;
- exact direct-run versus trigger failure semantics;
- exact command/exit/test evidence and mutation evidence;
- test-plan traceability and pending/observed manual acceptance;
- docs/OpenAPI EN-TH parity;
- remaining deferred work;
- explicit confirmation that Flow Designer and thClaws were not modified.
```

---

## Prompt C — Flow Designer Adopts the Atlas Interface

Run this only after Milestone A exists at the clean commit accepted before Prompt B and the Atlas
change exists at a separate clean, recorded commit. Replace `<FLOW_MILESTONE_A_COMMIT>` and
`<ATLAS_INTERFACE_COMMIT>` below before use.

```text
You are implementing Milestone C: adopt Atlas's authoritative workflow
application interface in Flow Designer.

Repository you may edit:
/Users/seal/Documents/GitHub/flow-designer based on
<FLOW_MILESTONE_A_COMMIT>

Target Atlas you may inspect and run for contract tests but MUST NOT edit:
/Users/seal/Documents/GitHub/atlas-control-plane at
<ATLAS_INTERFACE_COMMIT>

Do not proceed while either placeholder is unresolved. Do not modify thClaws.

Read completely before editing:
- both repositories' AGENTS.md
- flow-designer/CLAUDE.md if present
- docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md
- docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md
- the complete Milestone A implementation/tests/docs
- Atlas's new ADR, workflow definition schema, OpenAPI, API references,
  migration, validator, hermetic check, and exact commit diff
- flow-designer architecture, backend integration, frontend engineering, and
  testing strategy

Preflight:
1. Verify Flow Designer HEAD exactly equals <FLOW_MILESTONE_A_COMMIT>. Verify
   Atlas HEAD exactly equals <ATLAS_INTERFACE_COMMIT>, its worktree is clean,
   and `./scripts/gate.sh` evidence is available.
2. Report branch, HEAD, status, diffstat, diff-check, and worktrees for both
   repos.
3. These user-owned planning changes may remain as the recorded baseline:
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_CLAUDE_PROMPTS.md
   - docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_TEST_PLAN.md
   - their existing docs/README.md links
   Preserve them. If any other user work overlaps, STOP. Do not
   stash/reset/restore/clean/overwrite it.
4. Do not pull, rebase, amend, squash, force-push, commit, push, PR, merge,
   deploy, edit generated files, or add dependencies.
5. Preserve Lovable history and keep the Atlas bearer server-only.

Objective:
Make the stored, Atlas-enforced interface authoritative in Flow Designer while
retaining the Milestone A observed contract as an explicitly advisory fallback
for legacy workflows whose interface is absent.

1. Contract types and boundary guards

- Add guarded optional/null `interface` to Atlas workflow types.
- Add guarded run `interface_snapshot` and workflow-version snapshot.
- Reject/disable editing for unknown interface schema versions with a clear
  compatibility message; never silently drop or reinterpret them.
- Keep additive unknown Atlas response fields permissible where the existing
  boundary intentionally allows them.
- Preserve null versus absent semantics.
- Include interface in create/update editable view, dirty baseline,
  optimistic expected_version save, conflict preservation, draft recovery,
  and returned-version rebaseline.

2. Application interface authoring

Add a workflow-level `Application interface` inspector/panel:
- input_schema JSON editor for Atlas's exact bounded profile;
- sample_input JSON editor with a synthetic-data/PII warning;
- graph-derived output table limited to valid unique worker outputs;
- title/description editing and primary-output selection;
- clear interface action using explicit null;
- local deterministic diagnostics that mirror Atlas's exact URI, structural
  rules, non-byte count bounds, prompt/schema consistency, and output rules
  for fast feedback; byte-size estimates are advisory because JavaScript and
  Python number serialization are not byte-identical;
- Atlas save/validate errors remain authoritative and map to the panel.

Do not add a separate UI-schema language or dependency. Keep raw JSON
available. A generated form may cover only lossless top-level scalar, enum,
and boolean fields; nested objects/arrays always retain raw JSON test mode.

3. Test Run authoritative mode

When interface exists and schema_version is supported:
- label `Declared · enforced by Atlas`;
- prefill from stored sample_input when present;
- validate locally, then submit with both input and
  expected_workflow_version;
- show an advisory client-side size warning near 1 MiB, but do not block solely
  on the JavaScript byte estimate; Atlas measures after `default_reply` and is
  authoritative;
- handle Atlas 400 field/path messages and 409 version drift without retry;
- retain entered in-memory data while the dialog remains open;
- never store it in browser persistence;
- use authoritative types/requiredness only from stored interface.

When interface is absent:
- retain `Observed · not enforced` Milestone A behavior;
- update observed extraction to include executable manager `{input.*}` paths
  now that the pinned Atlas commit renders them; a missing start-manager path
  blocks preflight and a downstream-manager path remains a warning;
- do not auto-promote, merge, or save inferred fields;
- inference remains advisory.

If declared interface and observed prompt usage disagree:
- show a drift warning naming the path/node/output;
- do not mutate either source automatically;
- Atlas declared validation remains the application boundary.

4. Integration guide

Authoritative mode must include:
- workflow id and exact version;
- input_schema and synthetic sample;
- public possible outputs and primary output;
- request with expected_workflow_version;
- direct 400/409 behavior;
- polling, approval, artifacts, and signed-webhook facts;
- trigger no-version-pin limitation;
- minimum compatible Atlas commit/version;
- safe cURL, backend TypeScript, and Python examples without secrets.

Observed legacy mode retains all advisory caveats.

5. Run detail

- Display workflow-version and interface-snapshot identity on historical run
  detail.
- Interpret/highlight public outputs from the run snapshot, never the later
  live definition.
- Preserve bounded collapsed input and full artifact behavior.
- Legacy runs with null snapshots remain readable and say the contract is
  unavailable rather than guessing from the current workflow.

6. Packs/docs compatibility

Flow Designer does not need to become a pack importer/exporter unless it
already owns those operations. Document that Atlas packs now preserve
per-workflow interface and that legacy bundle-level sample_input remains
authoring-only.

Update EN/TH guides, backend integration, limitations, test strategy,
checklist/release evidence, and docs index from actual behavior.

7. Required tests

Unit:
- parse/serialize/null/unknown-version;
- dirty baseline and interface-only save;
- sample/schema/output diagnostics;
- manager observed extraction after Atlas interpolation parity;
- declared versus observed drift;
- authoritative versus legacy labels;
- versioned snippet generation;
- historical snapshot use rather than live definition.

Real-Atlas contract against <ATLAS_INTERFACE_COMMIT>:
- interface CRUD/clear;
- optimistic version conflict;
- valid run input;
- invalid input 400/no run;
- exact-limit and oversized input behavior;
- a payload whose workflow `default_reply` pushes effective input over the
  limit is rejected by Atlas and presented without retry;
- expected version 409/no run;
- trigger invalid payload semantics;
- interface/version snapshot;
- graph edit output cross-check;
- pack round trip if the client touches it.

Browser:
- author interface and save/reload;
- sample-prefilled Test Run;
- legacy observed start-manager preflight and downstream-manager warning;
- raw nested JSON;
- local then server validation;
- 400 and 409 presentation without retry;
- declared badge and copy-safe versioned guide;
- drift warning;
- clear to observed fallback;
- unknown-version read-only behavior;
- historical run snapshot;
- no input/secret persistence or list leakage;
- existing editor/run/approval/artifact/delivery behavior stays green.

Implement and execute all automated Milestone C cases in the independent test
plan, including a real absent-field smoke against the recorded pre-interface
Atlas baseline. Hand manual UAT-C to the reviewer.

Verification:
- `git diff --check`
- `bun run format:check`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run test:contract`
- `bun run test:stream`
- `bun run test:e2e`
- `bun run test:remote`
- `bun run build`
- `bun run scan:bundle`

Mutation evidence:
- drop interface from a save -> test RED;
- auto-promote observed fields -> test RED;
- omit expected_workflow_version -> contract test RED;
- use live rather than snapshotted interface on run detail -> test RED;
- remove authoritative/observed distinction -> browser test RED;
- place input on RunView/list -> structural test RED.

Restore mutations and finish green. Do not commit.

STOP and report:
- both repo commits/statuses and Flow diffstat;
- user-visible authoritative/legacy behavior;
- exact tests/commands/counts and mutation evidence;
- compatibility matrix by Atlas version/interface presence;
- test-plan traceability and whether manual UAT-C is pending or observed;
- remaining file-input/output-schema/thClaws limitations;
- explicit confirmation Atlas and thClaws were untouched.
```

---

## Final review checklist for the operator

Before authorizing a commit or push after any prompt:

- Confirm the reported diff contains only the authorized repository and milestone.
- Inspect user-visible wording for **Observed** versus **Declared/Atlas-enforced**.
- Confirm no real permit applicant data, national ID, token, private origin, or callback secret
  appears in source, fixture, snapshot, docs example, or generated download.
- Confirm Atlas direct-run and trigger failure semantics are reported separately.
- Confirm every deliberate mutation was restored.
- Confirm Flow Designer remains green before any Lovable-connected branch is pushed.
- Use new commits only; never amend/rebase/squash/force-push published Flow Designer history.
