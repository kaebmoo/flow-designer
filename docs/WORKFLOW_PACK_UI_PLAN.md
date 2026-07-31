# Milestone D plan — Pack export/import UI

Status: planned 2026-07-31. Implementer: Codex. Independent verifier: Claude.
Baseline: Flow Designer `b00406e` (Milestone C accepted). Atlas target:
`15c4876aa4f86e109a3cc52d6a299f46791053a2` — **read-only, must stay clean and at exactly this
commit before, during, and after implementation.** thClaws must not be touched.

## 1. Goal

Give Flow Designer a UI for Atlas's existing pack mechanism: export one workflow (graph, policy,
interface, triggers) as a single JSON bundle, and import such a bundle to create new workflows.
Atlas already implements the entire backend (`atlas/packs.py`); this milestone is UI + typed RPC
plumbing + the test evidence that the UI faithfully reflects what Atlas actually does.

**Non-goals:** no changes to the pack format, no signing UI (signing needs `ATLAS_SECRET_KEY`,
which never reaches the browser), no editing of a bundle in the UI, no import-merge/overwrite
semantics (Atlas has none), no workaround for the `default_reply` export gap (see §2 quirks).

## 2. Verified Atlas contract (all at `15c4876`, cite these — do not re-derive loosely)

| Operation           | Endpoint                                                         | Status | Envelope                                                     | Permission         |
| ------------------- | ---------------------------------------------------------------- | ------ | ------------------------------------------------------------ | ------------------ |
| List built-in packs | `GET /api/packs`                                                 | 200    | `{packs: [...]}`                                             | `read`             |
| Export a workflow   | `GET /api/packs/{definitionId}/export`                           | 200    | `{pack: <bundle>}`                                           | `read`             |
| Import a bundle     | `POST /api/packs/import` (body = the bundle itself, not wrapped) | 201    | `{pack: {name, version}, workflows: [...], triggers: [...]}` | `workflows.manage` |

Bundle shape (`atlas/packs.py:190-224`, spec in Atlas `docs/specs/pack-format.md`):
`{schema_version: 1, name, version: string, description, roles: [], sample_input: {}, docs: "",
workflows: [{name, description, version: int, status, graph, policy, interface}], triggers:
[{workflow: <index>, name, type, config, enabled}], signature?}`.

Behavior facts the UI and tests must reflect:

- **Import always creates new rows** (`create_workflow_definition` mints a fresh `wfd_` id,
  `atlas/db.py:1265-1266`). It never overwrites or merges; importing twice yields two copies.
  Duplicate names are legal. The UI must say "creates new workflows", never "restore/replace".
- **Import is atomic** (`atlas/packs.py:158-170`): any failure rolls back every definition and
  trigger already written. The UI never needs a partial-import state.
- **Validation is the real engine's** (`validate_pack` at `atlas/packs.py:55`,
  `_validate_pack_references` at `:111`): graph, policy caps, interface
  (`validate_interface` — the same Milestone C profile, including the graph cross-check), trigger
  payloads, and worker/workspace references (`allow_unresolved_roles=True` keeps role-only nodes
  portable). A pack that fails validation answers 400 with a path-ish message and creates nothing.
- **Signature policy** (`atlas/packs.py:139-144`): a bundle _carrying_ a `signature` must verify
  against the server's `ATLAS_SECRET_KEY` or the import is rejected; an unsigned bundle is
  accepted unless the server sets `require_signed_packs`. The UI surfaces whether a bundle is
  signed and passes it through untouched — it never strips, adds, or re-computes a signature.
- **`PACK_SCHEMA_VERSION = 1` is strict equality** (`atlas/packs.py:60-61`). A future
  `schema_version: 2` bundle is rejected by Atlas at import — the UI shows Atlas's 400 verbatim
  and must not "helpfully" rewrite the version. (Same doctrine as the Milestone C interface rule.)
- **Errors are `ValueError` → 400**, including export of an unknown definition id
  (`atlas/packs.py:193-194` — it is a 400, **not** a 404; pin this in a contract test rather than
  assuming REST convention).
- **Quirk — `default_reply` is not in the bundle** (`export_pack` omits it; import creates with
  the default `{}`). An exported-then-imported workflow silently loses its `default_reply`. Do
  NOT compensate frontend-side (architecture rule: no hiding Atlas gaps). Surface it as one
  sentence in the export UI ("default reply is not included in a pack") and record it in
  `docs/ATLAS_LIMITATIONS.md` as a backend follow-up.
- **Quirk — export permission is `read`** (`app.py:_required_permission`): any signed-in viewer
  can export a bundle, including `interface.sample_input` and trigger `config`. The exported
  trigger entries carry `{name, type, config, enabled}` only — a contract test must assert no
  token/secret field appears anywhere in an exported bundle for a workflow with a webhook-style
  trigger (Phase 5's raw-token-once rule means Atlas should not have one to leak; prove it).

## 3. UX specification

### Export

- One button, **Export pack**, in the workflow editor page header area
  (`src/routes/_app/workflows.$id.tsx`), visible whenever the workflow loaded. Click → typed
  server fn → browser download of the JSON bundle, pretty-printed, filename
  `<workflow-name-slug>.pack.json` (slug: lowercase, `[a-z0-9-]`, collapse others to `-`;
  filename built client-side from the workflow name already on screen — no user input reaches
  the filename).
- While fetching: button disabled with an in-progress label. On failure: the mapped Atlas error
  shown inline near the button (same `toClientAtlasError`/`describeAtlasError` path as every
  other action; a `forbidden` renders as the accent-toned role fact, not a destructive error).
- One sentence of fine print near the action (tooltip or caption): the bundle contains the
  graph, policy, interface (including `sample_input` — synthetic data only), and triggers;
  `default_reply` is not included.

### Import

- Entry point on the workflows list page (`src/routes/_app/workflows.index.tsx`): an
  **Import pack** button opening a dialog. Hidden or disabled (with reason) for roles whose
  frontend role data lacks `workflows.manage` — UX only; Atlas remains the authority and a 403
  from a forced call renders truthfully.
- Dialog flow:
  1. File picker (`accept="application/json,.json"`). The file is read **client-side**
     (`FileReader`), parsed as JSON; a parse failure or a non-object shows an inline error and
     never leaves the browser.
  2. **Preview before any network call**, rendered from the parsed bundle: pack name, pack
     version, workflow count with names, trigger count, signed / unsigned badge, and — when
     `schema_version !== 1` — a warning that Atlas will reject it (still allow submitting;
     Atlas's 400 is the boundary, mirror is advisory. Same doctrine as Milestone C).
  3. Explicit **Import** button sends the parsed bundle through the typed server fn. On 201:
     show the created workflows as links (`/workflows/{id}`) and close-on-navigate. On 400:
     Atlas's message verbatim, dialog stays open, bundle retained, no automatic retry. On 403:
     the forbidden rendering.
- Size cap: reject files over 5 MiB client-side with a clear message, and enforce the same cap
  in the server fn validator (defense in depth; a pack is normally a few KB).
- No import state may persist across dialog close/reopen (same rule the Test Run dialog obeys —
  close blanks the selection and preview).

### Explicitly out of scope for UI

`GET /api/packs` (built-in pack gallery) — nothing user-facing this milestone; do not build a
gallery page. If trivially cheap, the import dialog MAY ignore it entirely.

## 4. Architecture constraints (repo rules, all mandatory)

- Two typed operations in `src/lib/atlas-api.server.ts`: `atlasExportPack(token, definitionId)`
  and `atlasImportPack(token, bundle)`, each guarding the exact envelope above (`expectShape`
  style, like every neighbour). No generic proxy.
- Server fns in `src/lib/atlas-mutations.functions.ts` (import) and the read-side equivalent for
  export, each validating the flow-designer session first (`mutate()` / the read wrapper),
  validating inputs field-by-field (id: non-empty string; bundle: plain object under the byte
  cap — do **not** forward arbitrary extra transport fields; the bundle itself passes through
  byte-exact, since Atlas owns its validation).
- The bundle must round-trip **byte-faithfully at the JSON-value level**: no key stripping, no
  re-ordering that changes content, no injected fields, signature untouched. (Serialization may
  re-order keys — signatures are computed over sorted keys server-side, so order is not
  load-bearing — but no value may change.)
- Client code never touches `*.server.ts`; the download is produced from the server fn's return
  value in the browser (`Blob` + object URL), no new route handler.
- Query invalidation: a successful import invalidates the workflows list query so the new rows
  appear without a reload.
- Design tokens only; explicit loading/empty/error/forbidden states for both flows.

## 5. Required tests

### Contract (`tests/contract/pack-ui.contract.test.ts`, real isolated Atlas, same harness as

`workflow-interface.contract.test.ts`)

1. Export round-trip: create workflow (graph + Milestone C Permit interface + one trigger) →
   export → assert bundle shape, `schema_version: 1`, interface present and byte-equal, trigger
   `{workflow: 0, name, type, config, enabled}`; assert **no** `token`/`secret` key anywhere in
   the serialized bundle.
2. Export unknown id → pin the actual status (expected 400 per source; if it answers otherwise,
   record what it does — do not force-fit).
3. Import the exported bundle → 201; created workflow has fresh id ≠ original, identical
   graph/policy/interface; trigger exists and points at the new id; importing the same bundle
   again creates a second copy (duplicate-tolerant, never overwrite).
4. Import atomicity: bundle with two workflows where the second has an invalid graph → 400, and
   **neither** workflow exists afterwards (list count unchanged).
5. Interface enforcement inside packs: bundle whose workflow carries an interface that fails the
   bounded profile (e.g. root `type: ["object","null"]`) → 400, nothing created.
6. Signature: import an exported bundle after signing it with the test instance's secret (compute
   HMAC-SHA256 over the canonical form in the test, mirroring `_pack_signature`) → accepted;
   tamper one byte of a signed bundle → 400 "signature"; unsigned → accepted (default config).
7. `schema_version: 2` bundle → 400, message pinned.
8. `default_reply` gap: export a workflow that has a `default_reply` → assert the bundle lacks
   it and the re-imported copy has none — this test _documents_ the Atlas limitation.

### Unit

- Bundle preview mapper (parse → `{name, version, workflowNames, triggerCount, signed,
schemaVersionSupported}`) for: valid bundle, unsigned, signed, `schema_version: 2`, missing
  fields, non-object, oversized (cap logic).
- Filename slug: names with spaces, Thai characters, path separators, dots — must always yield
  a safe `[a-z0-9-]` slug, never empty (fallback `workflow`).
- Error mapping reuse: 400/403 from import map through the existing `toClientAtlasError` kinds.

### E2E (`tests/e2e/pack-ui.spec.ts`, real Atlas + real browser download)

1. Export: open a seeded workflow → click Export pack → assert the downloaded file
   (Playwright `download` event) parses as JSON with `schema_version: 1` and the workflow name.
2. Import happy path: pick a bundle file (write a temp fixture via the test) → preview shows
   name/counts → Import → success links appear → workflow list contains the new row without a
   reload → Atlas confirms via direct API read.
3. Import invalid: bundle with a broken graph → Atlas's 400 message shown verbatim, dialog stays
   open, direct API read confirms nothing was created.
4. Parse failure: a non-JSON file → inline error, **no network call to Atlas** (assert via no
   new workflow rows; a request-count assertion is a bonus, not required).
5. State reset: select a file, close the dialog, reopen → no residual preview or selection.
6. RBAC UX: as a viewer role, the Import affordance is hidden/disabled; export still works.
   (Do not assert Atlas's 403 by forcing the call from the UI unless a clean path exists.)

File-ordering note: the e2e file creates workflows, so it must sort after `reads.spec.ts` and
before `zz-*.spec.ts` — alphabetical `pack-ui` already does; keep the name.

### Mutation evidence (each must go red before revert; record in `docs/TESTING_AND_QA.md`)

1. Strip a field (e.g. `interface`) from the bundle in the import server fn → contract test 3
   or e2e 2 fails.
2. Swallow the 400 and close the dialog anyway → e2e 3 fails.
3. Skip session validation on the import server fn → the existing auth-contract pattern test
   for new mutations fails (add one if the harness lacks it for this fn).
4. Send the import even when the file failed to parse → e2e 4 fails.
5. Persist the selected bundle across dialog close → e2e 5 fails.
6. Build filename from unsanitized name → unit slug test fails.
7. Rewrite `schema_version` to 1 on an unsupported bundle before sending → contract test 7 /
   unit preview test fails.

## 6. Gate (unchanged, run all)

`git diff --check`; `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test`;
`bun run test:contract`; `bun run test:stream`; `bun run test:e2e`;
`PHASE7_NODE_BINARY=/Users/seal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
bun run test:remote`; `bun run build`; `bun run scan:bundle`. All exit 0; lint may keep the 10
pre-existing warnings only.

## 7. Process constraints for the implementer

- Do not modify Atlas or thClaws in any way. Atlas stays clean at `15c4876`.
- Do not edit `docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_PLAN.md` or
  `docs/WORKFLOW_TEST_INTEGRATION_CONTRACT_CLAUDE_PROMPTS.md` (user-owned).
- Do not edit `src/routeTree.gen.ts`.
- Docs to update: `docs/BACKEND_INTEGRATION.md` (two pack endpoints in the operation table),
  `docs/ATLAS_LIMITATIONS.md` (`default_reply` export gap as a backend follow-up),
  `docs/TESTING_AND_QA.md` (Milestone D evidence section with **reproducible** counts — record
  the numbers your final gate actually prints; Milestone C's evidence once recorded a
  double-counted suite and needed a correction), user guides (short pack section, EN + TH).
- Leave the work uncommitted on `main` for verification, exactly like Milestone C.

## 8. Acceptance criteria (what the verifier will check)

1. All §5 tests exist, are meaningful (assert Atlas state via direct API reads, not only UI
   re-renders), and pass against real Atlas.
2. The bundle passes through byte-faithfully: no strip/rewrite/re-encode anywhere in the chain,
   proven by contract test 1/3 and code trace.
3. Every §2 behavior fact is honored in UI copy (creates-new-not-overwrite, atomicity, signed
   badge, `default_reply` caveat).
4. Architecture rules of §4 hold (typed ops, session checks, no `*.server.ts` in client, no new
   route handler, no secrets client-side — `scan:bundle` clean).
5. Full gate green; mutation evidence recorded; Atlas/thClaws untouched; preserved docs intact.
6. The verifier will re-run the gate independently and spot-trace the import path for silent
   error swallowing and the export path for bundle mutation, and will reject partial-import or
   stale-dialog-state regressions.
