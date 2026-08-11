# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-11

### Added

- Added **Draft with AI** to the Workflows list: a plain-language description is
  sent to Atlas's `POST /api/workflows/draft` through a session-validated server
  function whose deadline is sized for the two builder jobs Atlas may spend, and
  the returned proposal — name, description, explanation, warnings, and a
  node/edge/policy summary — is reviewed in a dialog before anything exists.
  Creating omits `status`, so Atlas stores the workflow as `draft`, then the
  editor opens. Proposed triggers are display-only, the mutation never retries a
  billed model call, and Atlas's 400 text is shown verbatim, with a setup hint
  when no `workflow_builder` worker is configured.
- Added editor AI assists — **Explain**, **Repair with AI** (offered once Atlas
  rejects a save or validation), **Suggest workers**, and **Suggest triggers**.
  Every result stays a proposal: an accepted repair replaces only the unsaved
  canvas draft and never saves, a suggested worker id is written to one node per
  click, and a suggested trigger becomes a row only through the existing
  create-trigger action. Worker suggestions keep working on an instance with no
  `workflow_builder` worker, because Atlas falls back to local role matching.
- Added copyable Atlas ids to the Fleet and Workspaces pages and to their edit
  dialogs: the `wrk_`/`wsp_` id a workflow node actually routes on is now shown
  in full, in monospace, behind a keyboard-operable copy control that names what
  it copies and announces the result to assistive tech.
- Added run input-file uploads: an "Upload input file" control on the run
  detail's Artifacts section stores files as `upload_*` `file_ref` artifacts
  through a same-origin transport route (`POST /api/workflow-runs/{id}/files`),
  keeping the Atlas bearer server-side. Bytes are relayed as a stream and never
  buffered, the per-file cap is `ATLAS_MAX_UPLOAD_BYTES` (32 MiB by default, and
  Atlas re-checks it), and the request timeout is sized from the file rather
  than fixed. Re-attaching the same filename replaces what is there; a different
  filename whose sanitised key would collide takes a fresh key instead of
  shadowing it, because Atlas has no operation that removes an artifact.
- Added held test runs: a "Start held (paused)" option in the Test Run dialog
  creates the run born-paused via Atlas's `hold: true`, so files can be attached
  on the run page before pressing Resume — uploads can never race the first
  node's dispatch.

- Added workflow controls on the jobs page so operators can act on workflows from
  job context.
- Added the Atlas-backed global artifacts ledger with kind and run filters, run
  links, authenticated file downloads, and explicit loading, error, forbidden,
  and empty states.
- Added the workflow Test Run dialog with observed `{input.*}` contract
  discovery, JSON preflight, generated integration examples, and cross-tab save
  detection.
- Added Atlas `workflow.interface` support in the editor, including declared-mode
  schema and sample input handling, interface snapshots on run detail, drift
  warnings, and versioned integration guides and snippets.
- Added workflow pack export and import UI for Atlas workflow bundles, including
  client-side previews, a 5 MiB cap, accessible pending states, and
  create-new/import atomicity behavior.
- Added durable product and design-system documentation in `PRODUCT.md` and
  `DESIGN.md`, with the shared UI primitive and accessibility rules linked from
  engineering documentation.

### Changed

- Changed workflow execution controls to enforce Atlas's status model: draft,
  active, and disabled crossed with execution mode are guarded at the mutation
  boundary, and Atlas's `409 workflow_not_runnable` is surfaced verbatim rather
  than retried or hidden. The enforcement badge — declared/validated versus
  observed/unchecked — was hoisted out of a collapsed `<details>` to sit beside
  the cost note, where the decision is actually made.
- Changed the node inspector's advanced routing from free-text `worker_id` and
  `workspace_id` boxes to pickers over Atlas's real inventory. Each option names
  the worker, or the workspace key with its directory and owning worker, plus the
  id, so a node can no longer be pinned to the wrong directory by pasting an
  opaque string; choosing a worker narrows the workspace list to that worker's
  own. An id Atlas no longer lists stays selected and labelled rather than being
  silently dropped, and the saved value is still the bare id string.
- Improved list and table surfaces across runs, jobs, deliveries, artifacts,
  audit, usage, workflows, users, fleet, and workspaces with accessible filter
  chips, status icons and tones, keyboardable rows, selected-row state,
  horizontal scrolling, return-focus behavior, and clearer operator copy.
- Improved workflow editor keyboard operation with node selection, inspector
  connect flow, and undo/redo guidance.
- Improved the workflow canvas over six design passes: focus rings that stay
  visible on cyan fills, destructive actions styled destructive, the
  unsaved-changes blocker made a real modal, arrival fit floored at a readable
  zoom, a themed minimap, and pointer-coarse control sizing.

### Fixed

- Fixed the triggers page offering two buttons with the same accessible name
  ("New trigger") whenever the list was empty; the empty-state call to action is
  now distinct.
- Fixed delivery status tones so delivered and blocked states are visually
  distinct from neutral statuses.
- Fixed mobile and table accessibility regressions, including clipped wide
  tables, duplicate screen-reader descriptions, iOS auth input zoom, create-user
  focus return, and screen-reader access to run-state explanations.

### Security

- Hardened observed workflow contract derivation so `__proto__` path segments are
  treated as data rather than prototype properties.

## [0.1.0] - 2026-07-22

### Added

- Initial Atlas-backed Flow Designer web app with protected authentication,
  Atlas identity validation, sealed HttpOnly session cookies, CSRF protection,
  and same-origin BFF routes so browser clients never call Atlas directly.
- Operator surfaces for dashboard, fleet, workspaces, workflows, jobs, run
  detail/history, triggers, conversations, artifacts, deliveries, audit, usage,
  users, tokens, and settings.
- Atlas workflow editor with graph editing, starter examples, save conflict
  handling, workflow default reply support, and atomic `expected_version` saves.
- Live run detail with snapshot canvas, per-job SSE streams, bounded logs,
  cursor-paged event history, retry/keepalive handling, and stale-data warnings
  during Atlas outages.
- Operational exports and downloads for artifact content, audit CSV, and usage
  CSV through authenticated same-origin routes.
- Admin and operator controls for job cancellation, destructive-action
  confirmation, token lifecycle metadata, session expiry and 429 UX, and an
  honest read-only settings state.
- Release and deployment documentation for Bun 1.3.14 builds, Node 24
  self-hosted Nitro output, runtime environment validation, bundle-secret
  scanning, rollback, proxy, backup/restore, and release readiness.

### Changed

- Pinned self-hosted production output to Nitro `node-server` on Node 24.x while
  preserving Lovable-hosted Cloudflare build behavior.
- Made production startup fail fast for non-HTTPS `PUBLIC_ORIGIN` and the
  committed example `SESSION_SECRET`.
- Adopted Atlas `82207f7` additive session, token, workflow default, atomic save,
  cursor history, SSE keepalive, and transport contracts.
- Documented the Phase 7 candidate as ready for local development and controlled
  demos, with production deployment still blocked pending exact origins, secret
  store, proxy, backup/restore drill, and log sink.

### Fixed

- Fixed login form hydration races that could lose input or submit natively
  before React hydrated.
- Fixed stale run-event placeholder behavior when switching runs or event window
  sizes.
- Fixed workflow draft recovery validation for `defaultReply` and token-expiry
  picker minimums.
- Fixed accessibility and destructive-action gaps around keyboard, focus, ARIA
  behavior, non-dismissible pending destructive dialogs, and destructive button
  tone.
- Fixed operator-facing stream, transport, and redaction issues found during
  phase gate reviews.

### Security

- Kept Atlas bearers in server-sealed HttpOnly cookies and server-only request
  paths, with empty browser storage and no credentials in URLs verified by
  acceptance tests.
- Added server-only environment validation, CSRF origin checks, response shape
  guards, server/log redaction, client-bundle secret scanning, and `.env` ignore
  rules.

[Unreleased]: https://github.com/kaebmoo/flow-designer/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kaebmoo/flow-designer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kaebmoo/flow-designer/releases/tag/v0.1.0
