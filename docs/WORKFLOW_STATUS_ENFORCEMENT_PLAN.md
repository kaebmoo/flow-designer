# Workflow status and execution enforcement plan

Status: Implemented 2026-08-09 (both repositories; see the report in the implementing session).
Flow requalified against Atlas `bc49652` plus the local Atlas falsy-status validation fix on
2026-08-10. Atlas create/import now reject invalid falsy workflow statuses (`""`, `false`, `0`)
instead of coercing them to defaults; Flow's server function validator rejects the same values
before forwarding UI/BFF requests.
Atlas: shared guard `ensure_workflow_runnable`, `execution_mode` on `POST /api/workflow-runs`,
closed status vocabulary, `workflow_definition.status_change` audit, migration 016 backfill,
`scripts/check_workflow_status.py` in the gate. Flow Designer: status selector in the editor,
status through create/update, explicit `execution_mode` on every start, `workflow_not_runnable`
mapped to actionable copy, contract + E2E coverage.

Date: 2026-08-09; review addendum 2026-08-10

Product decision confirmed: `draft` workflows may use Test Run, but production/direct and trigger
runs require `active`; `disabled` blocks every run.

## Decision summary

This change must touch both repositories:

- **Atlas Control Plane** is the source of truth and must enforce whether a workflow may run.
- **Flow Designer** must expose the status, send it through its typed transport, and explain any refusal.

Changing only the UI would be cosmetic: a caller could still start a `draft` workflow directly through
Atlas. Changing only Atlas would be safe but hard to operate because users would have no way to change
the status or understand a refusal.

## Current behavior

- New workflows created from Flow Designer omit `status`; Atlas defaults them to `draft`.
- Pack import defaults a missing pack status to `active`.
- Flow Designer displays `workflow.status` but does not edit or send it on save.
- Atlas accepts `status` on workflow create/update, but `start_workflow()` currently does not check it.
- Therefore `draft`, `active`, and `disabled` are currently labels, not execution policy.

Relevant current code:

- Flow Designer list display: `src/routes/_app/workflows.index.tsx`
- Flow Designer create/save boundary: `src/lib/atlas-mutations.functions.ts`
- Flow Designer Atlas transport: `src/lib/atlas-api.server.ts`
- Atlas workflow start: `atlas/workflows.py`
- Atlas workflow persistence: `atlas/db.py`

## Proposed semantics

Use a closed status vocabulary:

| Status     | Editor changes | Test Run | Direct/production Run | Trigger Run |
| ---------- | -------------- | -------- | --------------------- | ----------- |
| `draft`    | allowed        | allowed  | blocked               | blocked     |
| `active`   | allowed        | allowed  | allowed               | allowed     |
| `disabled` | allowed        | blocked  | blocked               | blocked     |

The `draft` Test Run exception is intentional: authors need to validate a workflow before making it
production-active. It must be an explicit test execution mode, not an implicit UI-only bypass.

This policy is confirmed for implementation.

## Contract changes

### Atlas

1. Validate workflow status against `draft | active | disabled` on create and update.
2. Keep `status` in `POST /api/workflows` and `PUT /api/workflows/{id}`.
3. Add an explicit execution mode to `POST /api/workflow-runs`:

   ```json
   { "execution_mode": "test" | "production" }
   ```

   Omitted mode defaults to `production`, so old callers fail closed against draft workflows.

4. Add one shared guard used by every workflow-start path:
   - direct `POST /api/workflow-runs`;
   - trigger-created runs;
   - synchronous/internal definition-backed starts;
   - recovery/reconciliation paths, if they can create a new run.

5. Enforce:
   - `draft + test` → allowed;
   - `draft + production` → rejected;
   - `active + test/production` → allowed;
   - `disabled + any mode` → rejected.

6. Return a stable error code and message, for example:

   ```json
   {
     "error": "workflow_not_runnable",
     "reason": "draft_requires_test_mode",
     "status": "draft"
   }
   ```

7. Record a workflow status-change audit event with old status, new status, actor, and workflow id.
8. Update OpenAPI, workflow schemas, backend integration docs, and Atlas contract tests.

### Flow Designer

1. Add a shared `WorkflowStatus` type and constants.
2. Add `status` to the editable workflow view and workflow draft state.
3. Add a status selector in `/workflows/$id` with clear copy:
   - Draft — test only;
   - Active — production runs enabled;
   - Disabled — all runs blocked.

4. Send `status` in the typed create/update transport.
5. Send `execution_mode: "test"` from the editor Test Run action.
6. Send `execution_mode: "production"` from all production/direct run actions.
7. Map `workflow_not_runnable` to an actionable inline error that names the current status and the
   next action, rather than exposing a raw Atlas error.
8. Keep trigger `enabled` separate from workflow `status`; both must be visible because they control
   different things.
9. Add a status filter or grouping on `/workflows` only if the list becomes large enough to need it.

## Data migration and rollout

### Before enforcement

1. Inventory existing workflow statuses and unknown values.
2. Confirm whether existing workflows should keep running unchanged.
3. Recommended compatibility migration: backfill existing runnable workflows to `active` before the
   enforcement release. New workflows created from the UI remain `draft`.
4. Preserve explicit statuses in imported packs; keep pack import default `active` unless product
   policy changes.

### Rollout order

1. Land Atlas read/write contract and tests behind no enforcement.
2. Land Flow Designer status editing and explicit execution mode.
3. Run migration/backfill and verify the status inventory.
4. Enable Atlas enforcement.
5. Requalify Flow Designer against the deployed Atlas revision.
6. Update user and integration documentation.

Do not enable enforcement before the UI can move a workflow from `draft` to `active`, unless the
operator has an approved Atlas-only migration/runbook.

## Test plan

### Atlas unit/contract tests

- create defaults to `draft`;
- valid status updates persist;
- invalid statuses are rejected;
- draft production run is rejected;
- draft test run is accepted;
- active production and test runs are accepted;
- disabled runs are rejected in both modes;
- trigger starts use production mode;
- direct API callers cannot bypass the guard by omitting `execution_mode`;
- status changes write an audit event;
- existing status migration is idempotent.

### Flow Designer tests

- status selector loads the Atlas value;
- saving status increments the workflow version and survives reload;
- Test Run sends test mode;
- production/direct Run sends production mode;
- blocked status renders a useful recovery message;
- trigger `enabled` and workflow `status` remain independent;
- viewer/operator permissions follow Atlas authorization.

## Acceptance criteria

- A new workflow visibly starts as `Draft`.
- An operator can change it to `Active` from Flow Designer.
- A Draft production run cannot be created through the UI, Atlas API, or a trigger.
- A Draft Test Run works when the recommended exception is enabled.
- A Disabled workflow cannot run through any entry point.
- Existing workflows do not unexpectedly stop running after rollout.
- No client-side-only enforcement is relied upon.
- The API contract, migration, audit event, UI copy, and tests are documented.

## Implementation prompt

Use this prompt for the implementation task:

```text
Implement workflow status enforcement across both repositories:

  - Flow Designer: /Users/seal/Documents/GitHub/flow-designer
  - Atlas: /Users/seal/Documents/GitHub/atlas-control-plane

Read these first:

  - flow-designer/AGENTS.md
  - flow-designer/docs/WORKFLOW_STATUS_ENFORCEMENT_PLAN.md
  - flow-designer/docs/BACKEND_INTEGRATION.md
  - atlas/AGENTS.md, if present
  - Atlas workflow API/schema docs

Product decision:

  - statuses are draft, active, disabled;
  - draft allows explicit Test Run only;
  - draft production/direct/trigger runs are blocked;
  - active allows test and production runs;
  - disabled blocks every run;
  - omitted execution_mode means production.

Requirements:

1. Atlas is the enforcement authority. Add a shared guard to every workflow-start path and a
   stable workflow_not_runnable error contract. Do not rely on Flow Designer checks.
2. Atlas must validate and persist only the supported status values and accept status in workflow
   create/update. Add execution_mode to POST /api/workflow-runs, defaulting to production.
3. Flow Designer must add status to its typed workflow view/draft, expose a selector in the workflow
   editor, send status through create/update, send test mode from Test Run, and send production mode
   from production/direct Run actions.
4. Keep trigger.enabled separate from workflow status.
5. Inventory existing workflow rows and add an idempotent migration/backfill to active for existing
   runnable workflows, unless the user explicitly chooses a different migration policy.
6. Add Atlas contract tests and Flow Designer unit/E2E tests for every status/mode combination,
   authorization, audit logging, migration, reload, and blocked-run copy.
7. Update OpenAPI and project docs. Preserve the existing Atlas-source-of-truth architecture and
   optimistic versioning. Do not add frontend domain persistence or a second RBAC system.

Validation commands:

  - Flow Designer: bun run typecheck
  - Flow Designer: bun run lint
  - Flow Designer: bun run build
  - Flow Designer: bun run test
  - relevant Flow Designer E2E/contract tests
  - relevant Atlas unit/contract tests

Report changed files, migration behavior, API examples, test results, and any unresolved product
or compatibility decision. Do not commit or push until the user explicitly asks.
```
