# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added copyable Atlas ids to the Fleet and Workspaces pages and to their edit
  dialogs: the `wrk_`/`wsp_` id a workflow node actually routes on is now shown
  in full, in monospace, behind a keyboard-operable copy control that names what
  it copies and announces the result to assistive tech.
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

### Fixed

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

[Unreleased]: https://github.com/kaebmoo/flow-designer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kaebmoo/flow-designer/releases/tag/v0.1.0
