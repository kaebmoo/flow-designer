# ADR-0001: Atlas is the source of truth

- Status: accepted
- Date: 2026-07-19
- Scope: `flow-designer`

## Context

The initial UI plan proposed adding Postgres/Drizzle, Supabase Auth, a second schema, and a second workflow executor. The existing Atlas Control Plane already provides authentication, RBAC, SQLite persistence, workers, jobs, workflow definitions, workflow execution, triggers, artifacts, deliveries, audit, usage, and SSE/job events.

The current `flow-designer` scaffold stores mock domain data in Zustand and simulates runs in the browser. Adding another persistence and execution stack would create two sources of truth and make failure/recovery semantics ambiguous.

## Decision

Atlas owns all domain and execution state. `flow-designer` is a client/UI with a thin typed transport layer.

The frontend may contain:

- Atlas API type definitions
- response/request mappers
- query cache and invalidation
- secure session transport
- SSR and thin stream proxying
- UI-local draft state

The frontend must not contain:

- domain persistence
- a second auth/RBAC system
- a worker credential store
- a workflow executor
- a scheduler or durable job queue

## Consequences

Positive:

- one source of truth
- Atlas remains responsible for worker secrets and execution safety
- fewer services to deploy and back up
- frontend reloads and multi-tab behavior become authoritative
- future Atlas storage migration does not require a frontend schema migration

Negative:

- frontend availability and capabilities are bounded by Atlas API behavior
- Atlas's current single-node scaling limits remain
- API contract/version changes must be handled at the transport boundary
- live workflow progress may need job SSE plus run refetch until Atlas provides a unified run stream

## Rejected alternatives

### PocketBase as a second backend

Rejected because it duplicates users/domain state and introduces identity synchronization with Atlas.

### Postgres/Drizzle in the frontend repository

Rejected because it would duplicate Atlas persistence and move execution ownership away from the existing backend.

### Browser-to-thClaws direct calls

Rejected because worker credentials, routing policy, audit, and artifact safety must stay in Atlas.

## Review trigger

Revisit this ADR only when Atlas publishes a new multi-instance/storage contract or the product explicitly requires a separate product backend with a documented data ownership boundary.
