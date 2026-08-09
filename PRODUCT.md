# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences share the same web UI:

- **Internal operators** (primary, day-to-day): the team running an Atlas
  Control Plane deployment. Atlas roles are exactly `admin`, `operator`,
  `viewer`, `auditor`. They manage the worker fleet, run and supervise jobs and
  workflow runs, approve/pause/resume/cancel/replay execution, edit workflow
  definitions on a canvas, and monitor artifacts, deliveries, triggers, usage,
  and audit.
- **External customers / tenants**: log into the _same_ UI to observe and
  operate their own slice — their runs, workflows, artifacts, deliveries. This
  means the UI is not a purely internal admin console; screens must be safe and
  legible for a customer, not just an operator who already knows the system.

Distinct from both is the **application developer** building _on top of_ a
workflow via Atlas's API + integration guides — they are served by
documentation, not this UI.

## Product Purpose

Flow Designer is the web UI/client for the existing **Atlas Control Plane**. It
is not a second control plane and holds no domain state of its own. It gives
operators and customers a browsable, editable, observable window onto Atlas:
authentication, fleet, jobs, conversations, the workflow canvas editor and test
runs, workflow runs and approvals, triggers, deliveries, the artifact ledger,
usage, and audit. Success is that a person can operate Atlas confidently
through the browser without touching the raw API, while Atlas remains the single
enforced source of truth.

## Positioning

The single defining constraint: **Atlas is the only source of truth and the
only authorization authority.** Flow Designer deliberately owns _no_ domain
database, _no_ second auth system, _no_ workflow executor, and _no_ frontend
RBAC. Its differentiator is a disciplined, transparent client that preserves
Atlas IDs/states/error semantics faithfully and never hides, works around, or
duplicates Atlas persistence — including surfacing Atlas's real limitations
rather than papering over them. A neighboring "workflow tool" that embeds its
own executor and database is a different product; Flow Designer's value is that
it does not.

## Operating Context

- Talks only to Atlas over HTTP; workflow execution runs on **thClaws workers**
  that the browser never contacts directly (credentials and routing stay behind
  Atlas).
- The Atlas bearer token is opaque and per-user; it lives server-side in an
  httpOnly cookie minted by Flow Designer and never reaches browser code or a
  URL. Server functions forward `Authorization: Bearer` to Atlas.
- Live job output arrives via same-origin SSE proxied to Atlas
  (`GET /api/jobs/{id}/events?after=<seq>`); workflow-run progress is assembled
  from per-job SSE + run refetch + sequence-cursor history (there is no single
  unified run stream).
- Documentation ships bilingual (English + Thai user and integration guides);
  the **application UI itself is currently English-only** (`html lang="en"`, no
  i18n framework installed).
- The repository is connected to **Lovable**, so published git history is not
  rewritten.

## Capabilities and Constraints

- Surfaces present: auth/login, dashboard, fleet, workspaces, jobs,
  conversations, workflows (index + canvas editor `_app/workflows.$id`), runs
  (index + detail), triggers, deliveries, artifacts, usage, audit, settings,
  users; plus CSV export routes (usage, audit) and streaming/content proxy
  routes.
- Deliberately **out of scope in the UI today** (API-only in Atlas): ad-hoc job
  composition, and solution-pack import/export beyond the shipped pack
  export/import UI. Do not invent UI for what Atlas exposes only via API without
  confirming scope. (Run file uploads left this list when the run detail gained
  its **Upload input file** control alongside held test runs.)
- Frontend responsibilities are bounded to presentation, navigation, query
  caching (TanStack Query), form state, safe optimistic UI, and typed transport
  adapters. Domain state must never be persisted or duplicated client-side;
  Zustand is for transient UI-only state, never workers/jobs/workflows/runs.
- Atlas runs on single-node SQLite with real scaling constraints; the frontend
  must not hide or work around them (tracked in `docs/ATLAS_LIMITATIONS.md`).
- A workflow may carry an Atlas-validated `interface` (Declared · enforced) or
  fall back to an advisory Observed contract inferred from prompt text.
- Every server-backed page must keep loading, empty, error, forbidden, and
  not-found states explicit; live logs must be bounded/virtualized, never an
  unbounded DOM list.

## Brand Commitments

**Open — nothing is binding yet.** The current working name in the UI is "Flow
Designer" and appears in user-facing copy, but the user has confirmed name and
visual identity are _both still provisional_ (the package is generically named
`tanstack_start_ts`). No committed logo, palette, or typography constraint
exists. Any future visual identity is free to be established; treat the current
look as incumbent evidence, not a binding commitment.

## Evidence on Hand

- Extensive engineering docs under `docs/` (ARCHITECTURE, BACKEND_INTEGRATION,
  IMPLEMENTATION_PLAN, CHECKLIST, TESTING_AND_QA, ADR-0001, ATLAS_LIMITATIONS)
  and bilingual user + application-integration guides under `docs/guides/`.
- Real, working implementation through Phase 7 plus milestones A/C/D (workflow
  Test Run dialog, authoritative `workflow.interface`, pack export/import UI).
- No fabricated testimonials, customers, pricing, benchmarks, or deployment
  claims exist and none should be invented.

## Product Principles

1. **Atlas is truth; the UI is a faithful window.** Preserve Atlas IDs, states,
   and error semantics; never duplicate its persistence, auth, RBAC, or
   executor.
2. **The RPC boundary is the security boundary, not the route guard.** Every
   private server function validates the session and calls a fixed, typed Atlas
   operation — never a generic proxy.
3. **Two audiences, one UI.** Screens must read safely for an external customer,
   not just an operator who already knows the system.
4. **Show the real system, including its limits.** Explicit loading/empty/error/
   forbidden/not-found states; surface Atlas constraints instead of papering
   over them.
5. **Bounded by construction.** Live/streaming and large lists are always
   bounded and incrementally rendered; nothing unbounded reaches the DOM.

## Accessibility & Inclusion

Target **WCAG 2.1 AA** for future design work: sufficient contrast, full
keyboard operation, screen-reader-correct semantics, and state that never relies
on colour alone (the codebase already carries colour-blind-operator affordances
and `aria-live` status regions — hold new work to at least this bar).
