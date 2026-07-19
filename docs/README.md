# Flow Designer documentation

This project is the web UI for the existing Atlas Control Plane. It is not a second control plane.

## Read first

1. [Architecture](ARCHITECTURE.md)
2. [Backend integration contract](BACKEND_INTEGRATION.md)
3. [Implementation plan](IMPLEMENTATION_PLAN.md)
4. [Master checklist](CHECKLIST.md)

## Design and operating documents

- [Frontend engineering rules](FRONTEND_ENGINEERING.md)
- [Configuration decisions for Phase 1](CONFIGURATION.md)
- [Testing and QA strategy](TESTING_AND_QA.md)
- [Atlas limitations and backend backlog](ATLAS_LIMITATIONS.md)
- [ADR-0001: Atlas is the source of truth](adr/0001-atlas-is-source-of-truth.md)

## Runbooks

- [Local development](runbooks/local-development.md)
- [Release and deployment](runbooks/release.md)

## Scope boundary

The frontend owns presentation, navigation, query caching, form state, optimistic UI where safe, and transport adapters. Atlas owns persistence, authentication, authorization, worker credentials, routing, workflow execution, event history, artifacts, triggers, deliveries, audit, and usage.

The phase plan is intentionally sequential. Do not start a later phase until the preceding gate is reviewed and confirmed.
