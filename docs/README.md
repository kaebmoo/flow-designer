# Flow Designer documentation

This project is the web UI for the existing Atlas Control Plane. It is not a second control plane.

## User guide

- [Web User Guide — English](guides/web-user-guide-en.md)
- [คู่มือใช้งานผ่านเว็บ — ภาษาไทย](guides/web-user-guide-th.md)

The guides above are for operators: navigation, fleet, jobs, the workflow
editor, runs and approvals, triggers, deliveries, the artifact ledger, usage,
and audit — including what is deliberately out of scope today (ad-hoc job
composition, run file uploads, and solution-pack import/export remain
API-only; see
[Atlas's own Web User Guide](https://github.com/kaebmoo/atlas-control-plane/blob/main/docs/guides/web-user-guide-en.md)
for the minimal embedded ops console that ships with Atlas itself). Everything
below this section is engineering documentation.

## Read first

1. [Architecture](ARCHITECTURE.md)
2. [Backend integration contract](BACKEND_INTEGRATION.md)
3. [Implementation plan](IMPLEMENTATION_PLAN.md)
4. [Master checklist](CHECKLIST.md)

## Design and operating documents

- [Frontend engineering rules](FRONTEND_ENGINEERING.md)
- [Configuration decisions for Phase 1](CONFIGURATION.md)
- [Testing and QA strategy](TESTING_AND_QA.md)
- [Phase 7 release readiness](RELEASE_READINESS.md)
- [Phase 7 release notes](RELEASE_NOTES_PHASE_7.md)
- [Atlas 82207f7 adoption plan](ATLAS_82207F7_ADOPTION_PLAN.md)
- [Atlas 82207f7 coding prompt](ATLAS_82207F7_CODING_PROMPT.md)
- [Atlas limitations and backend backlog](ATLAS_LIMITATIONS.md)
- [ADR-0001: Atlas is the source of truth](adr/0001-atlas-is-source-of-truth.md)

## Runbooks

- [Local development](runbooks/local-development.md)
- [Release and deployment](runbooks/release.md)

## Scope boundary

The frontend owns presentation, navigation, query caching, form state, optimistic UI where safe, and transport adapters. Atlas owns persistence, authentication, authorization, worker credentials, routing, workflow execution, event history, artifacts, triggers, deliveries, audit, and usage.

The phase plan is intentionally sequential. Do not start a later phase until the preceding gate is reviewed and confirmed.
