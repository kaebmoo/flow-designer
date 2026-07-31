# Workflow Test and Application Interface Contract — Test Plan

Status: **proposed acceptance baseline; execution evidence pending**

Planning date: 2026-07-31 (Asia/Bangkok)

Companion documents:

- [Implementation plan](WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md)
- [Claude Code prompt pack](WORKFLOW_TEST_INTEGRATION_CONTRACT_CLAUDE_PROMPTS.md)
- [Flow Designer testing strategy](TESTING_AND_QA.md)

> **สรุป:** แผนนี้ใช้ตรวจงานที่ Claude Code ทำใน Prompt A, B และ C แยกจากกัน
> โดยไม่เชื่อเพียงรายงานว่า test ผ่าน ต้องมี automated test, real-Atlas contract test,
> browser acceptance, mutation proof และ manual UAT ของ Permit Application ตาม milestone
> ก่อนอนุญาตให้ commit หรือเริ่ม milestone ถัดไป

## 1. Purpose and release rule

The test objective is to prove that the workflow input/output gap is closed without introducing
a second executor, leaking Atlas credentials or run input, overstating an inferred contract, or
breaking legacy workflows.

This plan tests three independently releasable milestones:

| Milestone | System under test                                        | Required outcome                                                                               |
| --------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A         | Flow Designer against pre-interface Atlas                | Real JSON Test Run, observed integration guide, bounded input/output inspection                |
| B         | Atlas Control Plane                                      | Persisted and enforced workflow interface, version guard, snapshots, trigger and pack behavior |
| C         | Flow Designer against the pinned interface-enabled Atlas | Interface authoring, declared Test Run, legacy fallback, historical snapshot display           |

Rules:

1. Passing tests from one milestone do not authorize work on the next milestone.
2. Mock-only proof is insufficient for any Atlas wire, persistence, trigger, version, or snapshot
   claim.
3. A contract suite skipped because Atlas is absent is **not a pass**.
4. A new test must be shown to fail when its protected behavior is deliberately broken and pass
   after restoration where the prompt requires mutation evidence.
5. All test data is synthetic. Real applicant information, national IDs, tokens, callback
   secrets, and private production origins are forbidden.
6. No test may use a developer's running Atlas database. Use the existing temporary database and
   ephemeral-port harness.
7. Do not commit screenshots, traces, videos, generated downloads, databases, or test-result
   directories.

## 2. Responsibilities and independence

### Claude Code implementer

- adds implementation and the automated tests named by the applicable prompt;
- records the initial worktree state and preserves the planning documents;
- runs focused tests while developing, then the complete milestone gate;
- performs and restores the mandatory mutations;
- reports exact commands, exit codes, pass/skip counts, and relevant Atlas/Flow commits;
- stops before commit, push, PR, merge, or deployment.

### Reviewer/operator

- inspects the diff before trusting test output;
- confirms each requirement maps to at least one test below;
- reruns the focused smoke set and complete milestone gate from the reviewed worktree;
- performs the manual UAT checklist;
- rejects unexplained skips, snapshots updated without review, weakened assertions, increased
  timeouts without evidence, or tests that reproduce production logic instead of calling it.

### Product acceptance

The product owner confirms the wording and workflow are understandable to a workflow author and
an application developer. Automated tests remain authoritative for protocol, persistence,
security, and compatibility behavior.

## 3. Environment and baseline

### 3.1 Required software

| Component     | Requirement                                                |
| ------------- | ---------------------------------------------------------- |
| Flow Designer | Node 24.x and repository-pinned Bun 1.3.14                 |
| Atlas         | Python 3.11+; Node for the embedded-dashboard syntax check |
| Atlas lint    | `uvx` with the versions pinned by `scripts/lint.sh`        |
| Browser       | Playwright Chromium, one worker, non-parallel suite        |
| Git           | Reviewed worktree; no stash/reset/clean/history rewrite    |

### 3.2 Isolation

Flow contract and browser tests must reuse:

- `tests/contract/atlas-instance.ts` for a temporary SQLite database, temporary upload directory,
  ephemeral port, independent secret, and auth bypasses disabled;
- `tests/e2e/global-setup.ts` for the isolated Atlas plus Flow Designer dev server;
- `tests/fixtures/thclaws-stub.ts` when a deterministic running worker and artifact are needed.

The thClaws stub substitutes for a worker only. The browser still calls Flow Designer, Flow
Designer still calls a real Atlas process, Atlas still persists the run and events, and Atlas
genuinely calls the stub worker.

### 3.3 Commit matrix

Record these values before every run:

```text
Flow Designer branch:
Flow Designer HEAD:
Atlas branch:
Atlas HEAD:
Atlas interface schema version:
Node:
Bun:
Python:
Browser project:
```

Required pairings:

| Test phase | Flow revision                    | Atlas revision                                                                                       |
| ---------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A          | Prompt A candidate               | recorded pre-interface Atlas baseline                                                                |
| B          | read-only Flow planning baseline | Prompt B Atlas candidate                                                                             |
| C-new      | Prompt C candidate               | exact `<ATLAS_INTERFACE_COMMIT>`                                                                     |
| C-legacy   | Prompt C candidate               | pre-interface Atlas baseline or an equivalent absent-field wire fixture plus a real legacy smoke run |

Do not switch or reset the user's active checkout merely to create this matrix. Use a separate
clean worktree/archive or the repository's `ATLAS_REPO_PATH` mechanism.

## 4. Canonical Permit Application test fixture

Use one named fixture across unit, contract, browser, and manual tests:
`PERMIT_APPLICATION_CONTRACT_V1`.

### 4.1 Graph

Create exactly this definition, replacing only `<THCLAWS_STUB_WORKER_ID>` with the worker ID
registered by the isolated test harness:

```json
{
  "name": "PoC Permit Application",
  "description": "Synthetic workflow fixture for input/output contract testing",
  "graph": {
    "start": "intake",
    "nodes": [
      {
        "id": "intake",
        "type": "worker",
        "worker_id": "<THCLAWS_STUB_WORKER_ID>",
        "prompt": "STEP=intake\nตรวจความครบถ้วนของคำขออนุญาตต่อไปนี้ และระบุสิ่งที่ขาด:\nผู้ขอ: {input.applicant_name}\nประเภทคำขอ: {input.permit_type}\nรายละเอียด: {input.detail}\nเอกสารแนบ: {input.attachments}\nstub:count=20;interval=400",
        "outputs": ["intake_review"],
        "budget_units": 1,
        "execution": "stream"
      },
      {
        "id": "assessment",
        "type": "worker",
        "worker_id": "<THCLAWS_STUB_WORKER_ID>",
        "prompt": "STEP=assessment\nประเมินผล {artifact.intake_review}\nบริบทเพิ่มเติม: {input.review_context}\nstub:count=3;interval=200",
        "outputs": ["assessment_result"],
        "budget_units": 1,
        "execution": "stream"
      }
    ],
    "edges": [
      {
        "from": "intake",
        "to": "assessment",
        "condition": {
          "type": "always"
        }
      }
    ]
  },
  "policy": {
    "max_jobs": 2,
    "max_iterations": 2,
    "max_attempts_per_node": 1,
    "max_minutes": 5,
    "max_budget_units": 2,
    "allowed_worker_ids": ["<THCLAWS_STUB_WORKER_ID>"],
    "stop_on_first_failure": true
  },
  "default_reply": null
}
```

For the default-reply variant only, replace `default_reply: null` with the object defined after
Section 4.2; every other byte of the semantic fixture remains the same. Milestones B/C add the
interface from Section 4.3 without changing this graph or policy.

`review_context` is intentionally downstream-only and optional. It proves that Flow Designer
shows a warning rather than inventing a global requirement, while Atlas's declared schema keeps
the path representable.

### 4.2 Synthetic valid input

```json
{
  "applicant_name": "นายทดสอบ ระบบ",
  "permit_type": "ขออนุญาตก่อสร้าง",
  "detail": {
    "building_type": "อาคารพาณิชย์",
    "floors": 2
  },
  "attachments": [
    {
      "name": "synthetic-id-copy.pdf",
      "kind": "identity-copy"
    },
    {
      "name": "synthetic-land-title.pdf",
      "kind": "land-record"
    }
  ],
  "review_context": "ข้อมูลสมมติสำหรับทดสอบ PoC เท่านั้น",
  "_meta": {
    "source": {
      "channel": "web_form",
      "adapter": "flow-designer-test",
      "form": "permit-poc",
      "external_id": "TEST-PERMIT-001"
    }
  }
}
```

When testing the existing default-reply merge, define:

```json
{
  "mode": "none",
  "correlation_id": "TEST-PERMIT-001"
}
```

Expected persistence: every business value is unchanged; Atlas may add only the documented
`_meta.reply` value when the caller omitted it.

### 4.3 Authoritative interface for Milestones B/C

The interface fixture must follow the exact bounded profile in the implementation plan:

- root `type: "object"`;
- required: `applicant_name`, `permit_type`, `detail`, `attachments`;
- optional: `review_context`;
- `additionalProperties: false`;
- `detail` is a closed object requiring string `building_type` and integer `floors`;
- `attachments` is an array of closed objects requiring string `name` and `kind`;
- synthetic `sample_input` is the business projection of Section 4.2;
- public possible outputs:
  - `intake_review`, kind `text`;
  - `assessment_result`, kind `text`;
- `primary_output: "assessment_result"`.

This fixture must not declare either output as guaranteed on every branch.

### 4.4 Negative inputs

| Fixture                                     | Purpose                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| malformed JSON                              | Parser feedback and no mutation                                                                |
| `null`, array, string, number, boolean root | Object-root guard                                                                              |
| missing `attachments`                       | Start-worker preflight in A; Atlas 400 in B/C                                                  |
| missing optional `review_context`           | Downstream warning; start remains permitted                                                    |
| unknown `secret_override`                   | `additionalProperties: false` rejection                                                        |
| `floors: true`                              | JSON bool must not pass integer/number validation                                              |
| nullable intermediate `detail: null`        | Nested prompt/schema safety                                                                    |
| oversized effective input                   | Exact Atlas 1 MiB boundary                                                                     |
| synthetic `DO_NOT_COPY_TEST_SENTINEL`       | Prove generators do not copy entered values; use this safe fixture instead of real PII/secrets |

## 5. Requirement traceability

| Requirement                     | Primary automated proof | Manual proof |
| ------------------------------- | ----------------------- | ------------ |
| A: explicit JSON Test Run       | A-U04, A-C01, A-E03     | UAT-A        |
| A: observed, not enforced       | A-U01–A-U03, A-E02      | UAT-A        |
| A: no secret/input leakage      | A-U05, A-E05, A-S01     | UAT-A        |
| A: bounded run input detail     | A-U06, A-E04            | UAT-A        |
| A: artifacts appear live        | A-E04 with stub worker  | UAT-A        |
| B: persisted interface          | B-DB01, B-API01         | API smoke    |
| B: bounded input validation     | B-V01–B-V05             | API smoke    |
| B: direct vs trigger semantics  | B-R01–B-R04, B-R08      | API smoke    |
| B: version and snapshots        | B-R05, B-SN01           | API smoke    |
| B: packs                        | B-P01                   | None         |
| B: manager interpolation parity | B-PR01                  | None         |
| C: authoring and save/reload    | C-U01, C-E01            | UAT-C        |
| C: declared run/version guard   | C-C01–C-C03, C-E02      | UAT-C        |
| C: legacy observed fallback     | C-U02, C-C04, C-E03     | UAT-C        |
| C: historical snapshot          | C-U03, C-E04            | UAT-C        |

## 6. Milestone A test cases

Expected test placement:

- new `tests/unit/workflow-run-contract.test.ts`;
- extend `tests/unit/atlas-read-mappers.test.ts` and `tests/unit/atlas-api.test.ts`;
- extend `tests/contract/mutations.contract.test.ts`;
- extend `tests/e2e/editor.spec.ts` for the saved/dirty editor guards;
- add late-running `tests/e2e/zz-workflow-test-run.spec.ts` for the real stub-worker lifecycle;
- reuse `tests/e2e/phase6-a11y.spec.ts` patterns rather than duplicating accessibility helpers.

### 6.1 Pure/unit

| ID    | Test                                                               | Expected result                                                                                                         |
| ----- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| A-U01 | Extract exact Atlas `{input.*}` grammar                            | Dotted dictionary paths found; other roots, array indexes, malformed braces ignored/diagnosed                           |
| A-U02 | Duplicate consumers and parent/child path nesting                  | All node IDs retained; parent and child paths share one nested skeleton, with an informational parent-renders-JSON note |
| A-U03 | Infer worker outputs                                               | Only `outputs[0]`; text/json kind correct; branch-dependent; no invented `collect_files` output                         |
| A-U04 | Parse input JSON                                                   | Only a plain object root accepted; error includes useful parse location                                                 |
| A-U05 | Generate cURL/TypeScript/Python and downloadable advisory contract | Deterministic, bounded, placeholder-only; no actual origin, bearer, callback secret, or entered input                   |
| A-U06 | Map run detail input                                               | 32,000-character Unicode-safe preview plus truncation flag only on `RunDetailView`; `RunView` structurally has no input |

Mutation expectations:

- broaden the placeholder regex;
- omit one consuming node;
- put entered input into generated snippets;
- add input to `RunView`;
- remove the 32,000-character cap.

Each relevant focused test must become red.

### 6.2 Real-Atlas contract

| ID    | Action                                                            | Expected result                                                                                                              |
| ----- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A-C01 | Start Permit run through `atlasStartWorkflowRun` with Section 4.2 | HTTP 202, real `wfr_…`, nested business values persist unchanged                                                             |
| A-C02 | Repeat with workflow `default_reply`                              | Persisted input contains the documented `_meta.reply` merge and no other mutation                                            |
| A-C03 | Submit non-object roots through the production boundary           | Rejected before a run is created                                                                                             |
| A-C04 | Start as unauthorized/viewer roles                                | Existing 401/403 behavior preserved                                                                                          |
| A-C05 | Inspect list and detail mappers                                   | Browser-facing list model omits input; detail mapper returns only bounded preview                                            |
| A-C06 | Execute a manager-start probe against the recorded Atlas baseline | Captured worker prompt proves whether authored `{input.*}` is rendered; observed extraction matches that executable behavior |

The test must set `ATLAS_REPO_PATH` explicitly. A suite-wide skip caused by a missing checkout
fails this milestone. For A-C06, capture the real `/agent/run` request in the test stub; do not
infer manager behavior from source text alone. At the recorded pre-interface baseline, the
authored manager placeholder remains literal. If a different target commit renders it, stop and
update the recorded compatibility expectation before changing the observed extractor.

### 6.3 Browser acceptance

Prefer a new late-running spec such as `tests/e2e/zz-workflow-test-run.spec.ts`, because it creates
an extra stub worker/workflow and must not disturb strict shared-seed assertions.

| ID    | Browser scenario                               | Expected result                                                                                                     |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A-E01 | Open, Escape, close, and reopen Test Run       | No start mutation; focus contained and restored; entered input not browser-persisted                                |
| A-E02 | Inspect observed Permit contract               | Start fields shown as observed references; downstream `review_context` shown as warning; no type/required guarantee |
| A-E03 | Submit valid Section 4.2 input once            | One request, pending guard prevents duplicate, URL becomes `/runs/wfr_…`                                            |
| A-E04 | Watch stub-worker run complete                 | Input preview collapsed/bounded; `intake_review` and `assessment_result` appear without reload                      |
| A-E05 | Copy/download every integration example        | No entered Thai values, private Atlas origin, bearer, cookie, or callback secret                                    |
| A-E06 | Enter malformed JSON and every non-object root | Clear error; Start disabled; no request                                                                             |
| A-E07 | Omit `attachments`                             | Blocking start-worker diagnostic; no request                                                                        |
| A-E08 | Omit only `review_context`                     | Warning is visible; Start remains available                                                                         |
| A-E09 | Make editor dirty                              | Test Run and Atlas validation remain disabled with Save-first explanation                                           |
| A-E10 | Use viewer role                                | Mutation unavailable according to existing RBAC UX                                                                  |
| A-E11 | Terminal artifact invalidation                 | Exactly bounded refetch behavior; artifact appears once; no polling/refetch loop                                    |

### 6.4 Security and accessibility

| ID    | Check                                                                          | Expected result                                                                               |
| ----- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| A-S01 | Search DOM, URL, local/session storage, generated downloads, and client bundle | No bearer, callback secret, or entered applicant data outside the bounded run-detail view     |
| A-S02 | Inspect browser network                                                        | Browser calls only same-origin Flow routes; no browser-to-Atlas or browser-to-thClaws request |
| A-S03 | Keyboard-only dialog use                                                       | Tab containment, labelled controls, error association, Escape, focus restoration              |
| A-S04 | Slow real start mutation                                                       | Submit disabled while pending; one Atlas run only                                             |
| A-S05 | Large input preview                                                            | Collapsed by default, Unicode-safe truncation, no unbounded DOM                               |

### 6.5 Milestone A manual UAT

Run against the isolated browser harness or a dedicated non-production environment.

1. Sign in as an administrator/operator.
2. Open the saved Permit workflow and verify the editor is clean.
3. Click **Test run** and confirm no run is created yet.
4. Verify the initial JSON is clearly illustrative and the Integration tab says
   **Observed · not enforced by Atlas**.
5. Remove `attachments`; confirm Start is blocked.
6. Restore `attachments`, remove only `review_context`; confirm warning, not schema language.
7. Paste Section 4.2 and click **Start test run** once.
8. Confirm navigation to a real `wfr_…` page.
9. Expand the input preview and compare it with the synthetic request, including the documented
   default reply merge when enabled.
10. Without reloading, confirm both stub artifacts become visible.
11. Copy each integration example and verify it contains placeholders rather than the current
    input or real credentials.
12. Open the run list and confirm applicant data is not rendered in any row.
13. Repeat as viewer and confirm no unauthorized start is possible.
14. Review English and Thai wording, especially “observed,” “possible output,” and the binary
    attachment limitation.

Capture only the run ID, workflow ID, commits, and pass/fail notes. Do not capture applicant input
in screenshots or logs.

## 7. Milestone B test cases

All B tests are Atlas-owned, Python-standard-library-only, hermetic, and folded into
`scripts/gate.sh`. The focused check is expected to be
`scripts/check_workflow_interface.py` or its reviewed equivalent.

### 7.1 Migration and persistence

Atlas fresh databases already apply every migration in order. Prompt B must append only the next
migration available at execution time and must not edit `SCHEMA`, `MIGRATIONS[0]`, or any shipped
migration to make a fresh-DB test pass.

| ID     | Test                                       | Expected result                                                                     |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| B-DB01 | Fresh DB and upgrade from previous schema  | New nullable definition/run columns exist; legacy rows remain readable              |
| B-DB02 | Initialize upgraded DB repeatedly          | Migration is idempotent                                                             |
| B-DB03 | Create/get/list/update/clear interface     | absent/object/null semantics preserved; interface-only save increments version once |
| B-DB04 | Stale `expected_version` on interface edit | Conflict; stored interface unchanged                                                |
| B-DB05 | Later definition edit/delete               | Existing run keeps interface and workflow-version snapshots                         |

### 7.2 Bounded validator

| ID    | Test                                                              | Expected result                                                                                                                                             |
| ----- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-V01 | Every supported keyword and primitive/container                   | Correct validation with stable path-aware `ValueError`                                                                                                      |
| B-V02 | Unknown keyword, `$ref`, combinator, conditional, pattern, format | Rejected; nothing silently ignored                                                                                                                          |
| B-V03 | Exact profile URI and every size/count/depth/traversal bound      | At-limit accepted; over-limit rejected; non-finite numbers rejected                                                                                         |
| B-V04 | `true` versus `1`, integer/number, typed enum/const               | JSON type fidelity preserved                                                                                                                                |
| B-V05 | Reserved projection                                               | Exactly `_meta` and `_trigger_chain` excluded; another underscore key cannot bypass schema                                                                  |
| B-V06 | Sample input                                                      | Valid synthetic sample accepted; mismatch rejected; never merged into a production run                                                                      |
| B-V07 | Output declarations                                               | Key regex, unique producer, kind, duplicate, annotation, count, and primary-output rules enforced                                                           |
| B-V08 | Prompt/schema cross-check                                         | Start paths required at every segment; intermediate nullable/mixed type rejected; optional downstream path accepted; impossible closed-schema path rejected |
| B-V09 | Hostile bounded objects                                           | Validator raises only documented `ValueError`, never recursion/type/internal exceptions                                                                     |

Byte-boundary tests use Atlas's exact Python serialization from the plan. Include a case where
the caller is below 1 MiB but applying `default_reply` makes the effective input exceed the cap.

### 7.3 API and runtime

| ID      | Test                                                                         | Expected result                                                                                                            |
| ------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| B-API01 | Workflow POST/GET/list/PUT/validate                                          | Interface round-trips; validate endpoint merges stored interface with candidate graph                                      |
| B-API02 | Graph edit omits interface but invalidates stored outputs/input paths        | Save and validate endpoint reject before write                                                                             |
| B-API03 | Explicit `interface: null` plus graph edit                                   | Interface clears intentionally; no stale-interface cross-check                                                             |
| B-R01   | Direct valid Permit start                                                    | HTTP 202 and run created with exact interface/version snapshots                                                            |
| B-R02   | Direct missing `attachments`, unknown key, wrong type, oversized input       | HTTP 400; no run, runtime node, workflow event, job, approval, artifact, delivery, or workflow-run create/provenance audit |
| B-R03   | Trigger `/fire` with the same invalid inputs                                 | HTTP 202; trigger event `failed`, path-aware error, `run: null`; no workflow runtime work                                  |
| B-R04   | Trigger dedupe retry after validation failure                                | Existing dedupe-claim semantics unchanged                                                                                  |
| B-R05   | Direct matching/mismatching `expected_workflow_version`                      | Match starts; mismatch HTTP 409 and no run                                                                                 |
| B-R06   | Fixed schedule/internal trigger incompatible with interface                  | Failed trigger record; no run                                                                                              |
| B-R07   | Workflow without interface                                                   | Exact legacy start/trigger behavior preserved                                                                              |
| B-R08   | `/fire` body contains a non-object `payload`                                 | Existing HTTP 400 before trigger bookkeeping; no trigger event                                                             |
| B-R09   | Invalid `_meta` plus stale version; stale version plus invalid business data | Existing `_meta` 400 first; with a valid envelope, version 409 precedes business-schema errors                             |

For “no run” assertions, compare database/API counts before and after; checking only the response
body is insufficient.

### 7.4 Prompt parity, snapshots, recovery, and packs

| ID     | Test                                                     | Expected result                                                                                                                |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| B-PR01 | Worker and manager prompt rendering                      | Documented `input/artifact/run/node/job` placeholders render consistently; manager decision suffix remains valid               |
| B-SN01 | Edit/delete definition after starting Permit run         | Historical interface/version unchanged                                                                                         |
| B-SN02 | Resume/recover old run                                   | Uses snapshots, never a later live interface                                                                                   |
| B-P01  | Signed pack export/import/export                         | Per-workflow interface round-trips and is covered by existing signature                                                        |
| B-P02  | Tamper with packed interface                             | Signature verification fails                                                                                                   |
| B-P03  | Legacy pack and bundle-level `sample_input`              | Existing authoring-only behavior unchanged; no automatic conversion                                                            |
| B-O01  | Successful branch omits declared primary/possible output | Run may still succeed; declaration does not become required-on-success                                                         |
| B-O02  | Run produces an undeclared artifact                      | Polling and signed webhook keep returning all existing artifacts                                                               |
| B-A01  | Read/update role matrix and audit detail                 | Existing permissions preserved; readable interface follows workflow read access; audit does not copy the full interface/sample |

### 7.5 Atlas mutation proof

Temporarily apply one mutation at a time:

| Mutation                                             | Required red signal |
| ---------------------------------------------------- | ------------------- |
| bypass business validation                           | B-R02 fails         |
| bypass effective-input cap                           | B-V03/B-R02 fails   |
| accept unsupported keyword                           | B-V02 fails         |
| skip start-path cross-check                          | B-V08 fails         |
| drop interface persistence                           | B-DB03 fails        |
| drop interface/version snapshot                      | B-DB05/B-SN01 fails |
| ignore expected version                              | B-R05 fails         |
| drop trigger validation                              | B-R03 fails         |
| turn interface-invalid trigger payload into HTTP 400 | B-R03 fails         |
| turn a non-object trigger payload into HTTP 202      | B-R08 fails         |
| drop pack interface                                  | B-P01 fails         |
| bypass manager rendering fix                         | B-PR01 fails        |

Restore each mutation immediately. End with a clean reviewed diff and a green complete Atlas gate.
No mutation may be committed.

### 7.6 Milestone B API smoke

After the hermetic gate, use a throwaway Atlas instance to:

1. create the Permit workflow and interface;
2. retrieve it and record workflow version;
3. start Section 4.2 with the matching version;
4. submit missing `attachments` directly and observe 400/no run;
5. fire the same invalid payload and observe 202/failed event/`run: null`;
6. fire a non-object payload and confirm the separate legacy 400/no-event behavior;
7. submit a stale expected version and observe 409/no run;
8. edit the definition and verify the first run still reports its old snapshots;
9. prove an omitted possible output does not fail a run and undeclared artifacts remain visible;
10. export/import the signed pack and compare the interface.

Do not point this smoke test at production or a developer database.

### 7.7 Milestone B manual review

- Upgrade and restart a sanitized copy of a staging-like SQLite database; hermetic coverage from
  the previous `SCHEMA_VERSION` to the newly appended version does not replace an operator
  rehearsal. Record both resolved version numbers in the evidence.
- Compare OpenAPI, English, and Thai descriptions side by side for direct 400, trigger object
  payload 202, trigger non-object payload 400, version 409, possible outputs, and pack behavior.
- Inspect every committed `sample_input` manually for synthetic data. Do not invent a PII detector.
- Confirm readers can see the interface, update permissions are unchanged, and audit rows do not
  duplicate the full interface or sample.

## 8. Milestone C test cases

### 8.1 Unit and boundary

| ID    | Test                                   | Expected result                                                                                                  |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| C-U01 | Parse absent/null/v1/unknown interface | Absent and null preserved; v1 editable; unknown version read-only and never dropped                              |
| C-U02 | Observed fallback after manager parity | Worker and executable manager paths inferred at pinned Atlas behavior; start-manager error vs downstream warning |
| C-U03 | Historical run mapper                  | Uses run snapshot, never current definition interface                                                            |
| C-U04 | Editor dirty/save/conflict state       | Interface-only edit dirty; save rebaselines returned version; conflict preserves local draft                     |
| C-U05 | Structural local diagnostics           | Matches Atlas rules; byte-size estimate explicitly advisory, not a blocking cross-language claim                 |
| C-U06 | Declared versus observed drift         | Names exact input path/node/output without auto-mutating either source                                           |

### 8.2 Real-Atlas contract

Run against exact `<ATLAS_INTERFACE_COMMIT>`.

| ID    | Test                                       | Expected result                                                           |
| ----- | ------------------------------------------ | ------------------------------------------------------------------------- |
| C-C01 | Interface CRUD/clear through Flow adapters | Exact absent/object/null behavior and optimistic conflict                 |
| C-C02 | Valid/invalid Permit start                 | Valid 202; invalid 400/no run; field path shown                           |
| C-C03 | Matching/stale workflow version            | Matching start; stale 409/no retry/no run                                 |
| C-C04 | Interface-absent workflow                  | Observed fallback remains usable                                          |
| C-C05 | Trigger invalid payload                    | Flow reports documented 202/failed-event semantics where shown            |
| C-C06 | Run snapshots and later definition edit    | Historical detail maps old interface/version                              |
| C-C07 | Effective input size boundary              | Atlas is final; default-reply boundary crossing is surfaced without retry |

Also run an absent-field boundary test and a real smoke run against the recorded pre-interface
Atlas baseline. This prevents a mapper that only understands `interface: null` from breaking when
an older Atlas omits the field entirely.

### 8.3 Browser acceptance

| ID    | Browser scenario                      | Expected result                                                                         |
| ----- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| C-E01 | Author Permit interface, save, reload | Exact schema/sample/outputs survive; synthetic-data warning visible                     |
| C-E02 | Open Test Run with declared interface | Badge says **Declared · enforced by Atlas**; sample prefilled; raw nested JSON retained |
| C-E03 | Clear interface                       | Explicit null save; UI returns to **Observed · not enforced**                           |
| C-E04 | Complete run, then edit definition    | Historical run shows snapshot version/output interpretation                             |
| C-E05 | Create stale version in a second tab  | 409 shown; no retry; entered in-memory input retained                                   |
| C-E06 | Atlas rejects field/type/size         | Path-aware 400 shown; client estimate never overrides server                            |
| C-E07 | Declared/observed drift               | Warning identifies exact path/node/output; no automatic rewrite                         |
| C-E08 | Legacy start-manager workflow         | Manager path participates in observed preflight after parity                            |
| C-E09 | Unknown future interface version      | Contract visible/read-only; Save cannot erase it                                        |
| C-E10 | Keyboard/RBAC/security regression     | Existing dialog, permissions, token isolation, and no-persistence rules remain green    |

### 8.4 Milestone C manual UAT

1. Open the Permit workflow's **Application interface** panel.
2. Paste the canonical schema/sample and select the two possible outputs.
3. Save and reload; confirm the exact values survive.
4. Open Test Run; confirm **Declared · enforced by Atlas** and sample prefill.
5. Remove `attachments`; confirm local feedback, then verify Atlas remains the authority.
6. Run the valid sample and confirm the request includes `expected_workflow_version`.
7. In a second tab, change/save the workflow, then start from the stale first tab; confirm 409,
   no automatic retry, and no duplicate run.
8. Complete a run, edit the live interface, then revisit the old run; confirm the old
   interface/version is displayed.
9. Clear the interface explicitly and confirm the legacy Observed mode returns.
10. Open a workflow with manager placeholders and confirm the observed behavior matches the pinned
    Atlas commit.
11. Confirm Thai/English guides clearly distinguish declared versus observed, possible outputs,
    trigger version limitation, and JSON attachments versus binary files.

## 9. Regression and non-functional checks

### 9.1 Required Flow Designer gate

Focused development commands may be:

```bash
bun run test -- \
  tests/unit/workflow-run-contract.test.ts \
  tests/unit/atlas-read-mappers.test.ts \
  tests/unit/atlas-api.test.ts
```

```bash
ATLAS_REPO_PATH=/Users/seal/Documents/GitHub/atlas-control-plane \
  bun run test:contract -- tests/contract/mutations.contract.test.ts
```

```bash
bun run test:e2e -- \
  tests/e2e/editor.spec.ts \
  tests/e2e/runs.spec.ts \
  tests/e2e/zz-workflow-test-run.spec.ts
```

Focused success is development feedback, not the release gate.

```bash
git diff --check
bun run format:check
bun run lint
bun run typecheck
bun run test
ATLAS_REPO_PATH=/Users/seal/Documents/GitHub/atlas-control-plane bun run test:contract
bun run test:stream
bun run test:e2e
PHASE7_NODE_BINARY=<NODE_24_BINARY> bun run test:remote
bun run build
bun run scan:bundle
```

Use the reviewed Atlas path/commit rather than assuming the example path still points to the
intended revision. Resolve `<NODE_24_BINARY>` during preflight and verify it reports Node 24.x;
the shell's default `node` must not be assumed to satisfy the remote-like gate.

Required assertions beyond exit code:

- new unit, contract, and browser tests actually ran;
- no suite-wide real-Atlas skip;
- any pre-existing intentional skips are named and unchanged;
- Playwright remains one-worker/non-parallel;
- no trace/video/screenshot containing credentials or applicant data is generated;
- no fixed sleep replaces condition polling;
- no timeout is increased merely to hide a race;
- client bundle scan contains no Atlas bearer, callback secret, or server-only origin.

### 9.2 Required Atlas gate

```bash
git diff --check
python3 scripts/check_workflow_interface.py
./scripts/gate.sh
./scripts/lint.sh
```

The focused command becomes valid after Prompt B creates the check. It must also be included in
`scripts/gate.sh` and its modules in the gate's `py_compile` list.

### 9.3 Performance and stability

- Test Run dialog opens without starting or polling a run.
- Generated contract size and computation are deterministically bounded.
- Input preview never exceeds its render bound.
- Artifact invalidation performs a bounded change/terminal refresh with no loop.
- Large workflow graphs do not recompute unrelated editor panels on every keystroke.
- Atlas validator respects size, depth, property, enum, output, and traversal limits.
- Concurrent stale version attempts create at most the correctly versioned run.

## 10. Evidence package

Claude Code's final report for each milestone must contain:

```text
Milestone:
Flow branch/HEAD/status:
Atlas branch/HEAD/status:
Changed files:
Diffstat:
Focused test commands and results:
Full gate commands and results:
Pass/fail/skip counts:
Mutation -> red test -> restoration -> green result:
Manual UAT result:
Known limitations:
Confirmation that the non-authorized repositories were untouched:
```

Keep evidence as text in the task/report or reviewed release documentation. Do not commit
temporary databases, tokens, raw request payloads, screenshots of applicant data, Playwright
artifacts, or downloaded contracts.

## 11. Defect severity and stop conditions

| Severity | Examples                                                                                             | Decision                           |
| -------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------- |
| P0       | bearer/input leak, auth bypass, production data touched, destructive history operation               | Stop immediately; do not commit    |
| P1       | invalid input creates a run, direct/trigger semantics wrong, snapshot/version ignored, duplicate run | Milestone fails                    |
| P2       | misleading observed/declared wording, artifact needs reload, inaccessible dialog, lost local draft   | Fix before acceptance              |
| P3       | cosmetic copy/layout issue with no contract or accessibility impact                                  | Record and obtain product decision |

Stop and request review when:

- an existing user change overlaps the implementation;
- the real Atlas suite cannot run;
- a required mutation does not turn the targeted test red;
- Atlas/Flow behavior differs from the approved public contract;
- EN/TH or OpenAPI/runtime behavior drifts;
- a test requires weakening an existing assertion, security control, or compatibility guarantee;
- the target Atlas commit cannot be pinned unambiguously.

## 12. Milestone exit checklist

### A may be accepted when

- every A test and the complete Flow gate are green;
- manual UAT-A passes;
- copied artifacts contain no secret or entered data;
- Atlas and thClaws repositories have no implementation diff;
- the UI says Observed and never implies schema enforcement.

### B may be accepted when

- every B test, focused check, mutation proof, Atlas gate, and lint pass;
- direct 400/no-run and trigger 202/failed-event/no-run are separately proven;
- migrations, snapshots, pack signing, manager parity, and legacy behavior pass;
- OpenAPI and EN/TH documents agree with runtime;
- Flow Designer and thClaws have no implementation diff.

### C may be accepted when

- every C test and full Flow gate pass against the pinned Atlas commit;
- absent/null/object/unknown-version and legacy Atlas cases pass;
- manual UAT-C passes;
- historical runs use snapshots and stale versions never auto-retry;
- declared and observed modes remain visibly distinct;
- no repository was committed, pushed, merged, or deployed without separate authorization.
