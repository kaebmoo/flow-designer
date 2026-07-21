# Release and deployment runbook

Use this with `docs/RELEASE_READINESS.md`. A green test matrix does not override an open
production blocker.

## Supported topology

```text
browser
  -> HTTPS reverse proxy / load balancer
     -> one or more stateless flow-designer Node 24 instances
        -> one private Atlas primary
           -> Atlas SQLite database + upload directory
           -> thClaws workers
```

The browser calls only flow-designer. Atlas's bearer is attached server-side. Frontend replicas
may scale horizontally without sticky sessions when every replica has the same `SESSION_SECRET`
and `ATLAS_API_ORIGIN`. Atlas remains a single primary until Atlas itself gains distributed
storage/runtime ownership; never point multiple writers at the same or independent databases and
call that one control plane.

## Required release inputs

Do not start a production deployment until the owner records all of these:

| Input                           | Requirement                                                                |
| ------------------------------- | -------------------------------------------------------------------------- |
| Frontend commit/artifact digest | Immutable and built from the reviewed commit                               |
| Atlas commit/version            | Compatible commit tested by the contract suite                             |
| `PUBLIC_ORIGIN`                 | Exact external HTTPS origin, with no path/query/fragment                   |
| `ATLAS_API_ORIGIN`              | Exact private server-to-server origin; never a `VITE_` variable            |
| `SESSION_SECRET`                | Generated ≥32-character value from the production secret store             |
| `SESSION_MAX_AGE`               | Default 28,800 seconds unless the owner records another value              |
| Atlas session policy            | TTL ≥ frontend max age; active-session cap and login limiter recorded      |
| Proxy configuration             | TLS, no SSE buffering, idle timeout >45 seconds, request/body limits       |
| Atlas persistence               | `ATLAS_DB`, `ATLAS_UPLOAD_DIR`, one active primary                         |
| Backup                          | Destination, retention, encryption key location, last restore-drill result |
| Logs                            | stderr collector, retention/access policy, redaction review                |
| Rollback                        | Previous frontend artifact and routing procedure                           |
| Risk decisions                  | Every open P0 fixed or explicitly accepted in writing                      |

Exact production origins and secret-store selection are still open at the Phase 7 handoff.

## Build and preflight

Use Bun 1.3.14 for dependency/install scripts and build the self-hosted artifact for the target
OS/architecture. The resulting server runs on Node 24.x.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run test:contract
bun run test:stream
bun run test:e2e
bun run test:remote
bun run build
bun run scan:bundle
```

`test:remote` refuses to start the built server on anything except Node 24.x. If the developer
shell resolves another Node line, point it at the release runtime explicitly:

```bash
PHASE7_NODE_BINARY=/absolute/path/to/node24 bun run test:remote
```

For the release build and scan, supply throwaway canary values for `SESSION_SECRET` and
`ATLAS_API_ORIGIN` to both commands. The scanner checks actual values as well as forbidden symbol
names and never prints a matched secret. Do not use real production secrets at build time; the
server reads them at runtime.

Confirm the build log says `Nitro (preset: node-server)` for a self-hosted release. Inside a
Lovable build, the Lovable wrapper intentionally forces its Cloudflare target instead.

## Atlas `82207f7` adoption handoff (2026-07-21)

The frontend adoption and requalification pass targets clean Atlas `82207f7` and leaves the Atlas
checkout read-only. Final evidence is recorded in `RELEASE_READINESS.md`: unit `414 passed`, real
Atlas contract `143 passed` with 3 intentional skips, stream `27 passed`, browser `98 passed`,
remote-like Node `v24.14.0` `1 passed`, and a clean 57-file canary bundle scan.

This is a code/test handoff, not a production approval. Before shipping, record the exact
`PUBLIC_ORIGIN`, private `ATLAS_API_ORIGIN`, generated `SESSION_SECRET` in the production secret
store, proxy SSE buffering/idle settings (>45 seconds), backup destination/retention, a restore
drill, and the log sink. Keep Atlas as one primary and do not push or deploy from this adoption
task.

Before tagging or deploying, also confirm:

- `git diff --check` exits 0;
- `git diff <baseline>..HEAD -- src/routeTree.gen.ts` is empty unless a generated route change
  was expected and reviewed;
- the branch contains no amend/rebase/squash/force-push of published Lovable history;
- `docs/RELEASE_READINESS.md` names every blocker truthfully.

## Runtime environment and secrets

Flow-designer requires:

```text
NODE_ENV=production
PUBLIC_ORIGIN=https://the-exact-frontend-host.example
ATLAS_API_ORIGIN=http://atlas-private-name-or-address:8787
SESSION_SECRET=<generated secret from the runtime secret store>
SESSION_MAX_AGE=28800  # optional
```

`PUBLIC_ORIGIN` and `ATLAS_API_ORIGIN` must be origins only. Production HTTP is rejected.
`SESSION_SECRET` must not be the committed example, must never use a `VITE_` prefix, and must be
identical across frontend replicas. Rotation is single-key: replace it and intentionally force
every frontend session to sign in again.

Atlas secrets remain Atlas-owned. At minimum, keep `ATLAS_SECRET_KEY` stable and private, keep
`ATLAS_LOOPBACK_NO_AUTH=false`, and keep worker credentials out of flow-designer. A wrong
`ATLAS_SECRET_KEY` after restore makes stored worker tokens unreadable.

For Atlas `82207f7`, record `ATLAS_SESSION_TOKEN_TTL_SECONDS`,
`ATLAS_MAX_ACTIVE_SESSIONS`, and the three `ATLAS_LOGIN_RATE_LIMIT_*` values. Keep frontend
`SESSION_MAX_AGE` less than or equal to the Atlas session TTL. Atlas keys login attempts by
normalized username plus its direct TCP peer; retain an edge login rate limit as defense in
depth, not as a replacement.

## Proxy and cookie verification

Terminate public TLS before flow-designer and preserve the public scheme/host with the proxy's
standard forwarded headers. Disable response buffering on `/api/jobs/*/events`; permit streaming
responses and set an idle timeout above 45 seconds. Atlas `82207f7` emits a 15-second keepalive,
while the client watchdog remains a recovery backstop. Apply upload/body limits compatible with
Atlas.

After login on the deployed host, inspect the session cookie:

```text
fd_session; HttpOnly; Secure; SameSite=Lax; Path=/
```

It must be host-only (no `Domain`). A cross-origin replay of a captured server-function POST must
receive 403; the configured public `Origin` must execute. Browser network records must contain no
request to `ATLAS_API_ORIGIN`, no `Authorization: Bearer` exposed to browser code, and no
`?token=` URL.

Canary the same-origin and cursor routes while authenticated:

- artifact content download;
- audit CSV;
- usage CSV;
- a job SSE stream, including `after=<seq>` and terminal `event: close` when available;
- a quiet job stream long enough to observe `retry: 3000` and at least two keepalive comments;
- workflow-run event history across more than one `next_after` cursor page.

## Logging and redaction

Flow-designer logs safe classifications to stderr. It does not log request/response bodies,
headers, cookies, Atlas 5xx text, the error cause chain, or the private Atlas origin. Configure the
platform collector around stderr and do not add proxy body/header logging to compensate.

Atlas request logging is opt-in with `ATLAS_REQUEST_LOG=true` (its production runner may enable
it). Atlas logs method/path/status/duration, not query strings or bodies. Confirm the collector's
access and retention policy before production. Search a canary incident log for session/token
values before approving the sink.

## Deploy and canary

1. Verify the P0 section in `RELEASE_READINESS.md`. Stop if any unaccepted blocker remains.
2. Run Atlas's online backup and record the DB/upload pair, even for a frontend-only release if
   an Atlas change is being deployed at the same time.
3. Deploy the immutable frontend artifact to a canary Node 24 instance with runtime secrets.
4. Probe the frontend process and open `/auth`. Atlas `/healthz` is liveness-only and is not a
   dependency-gated readiness signal.
5. Sign in with a canary identity; verify cookie flags and dashboard data.
6. Exercise a read, a permitted mutation, a forbidden role, one CSV, artifact download, and SSE.
7. Check logs and browser network records for redaction/secret boundaries.
8. Route traffic gradually and watch Atlas connection failures, 401/403 rates, stream reconnects,
   and Node process errors.

## Backup and restore handoff

Atlas commit `82207f7` contains the authoritative procedures in
`docs/ops/backup-restore.md` and `scripts/backup.sh` in the Atlas repository:

- `scripts/backup.sh <destination>` uses SQLite online `.backup`, including committed WAL pages,
  while Atlas remains online;
- it archives `ATLAS_UPLOAD_DIR` after the DB snapshot with the same timestamp; restore the pair;
- optional `ATLAS_BACKUP_KEY` encrypts both outputs; keep the key outside the destination;
- the backup script never prunes; set and review retention separately.

A restore requires stopping Atlas, keeping the current DB aside, removing stale WAL/SHM
sidecars, restoring the SQLite snapshot and matching upload archive, starting Atlas with the same
`ATLAS_SECRET_KEY`, and verifying workers, usage, and an artifact download. Complete and record a
restore drill on production-like storage before production release; documentation alone is not a
drill.

## Rollback

Frontend-only rollback:

1. Stop routing new traffic to the candidate.
2. Route traffic to the previous immutable frontend artifact using the same runtime secrets.
3. Leave Atlas state untouched; flow-designer owns no schema or domain persistence.
4. Verify login, one Atlas read, one same-origin download/export, and SSE reconnect.
5. Compare the rolled-back frontend's tested Atlas contract before restoring full traffic.

If Atlas changed in the same release, a previous frontend artifact is not an Atlas rollback.
Follow Atlas's migration/backup/restore procedure and its compatibility decision. Never replace a
database merely because the UI artifact was rolled back.

## Current hard stop

Atlas `82207f7` implements expiring/capped dashboard sessions and login rate limiting, so the old
backend token-lifecycle P0 is closed. The current flow-designer candidate has not yet adopted or
fully requalified the new session metadata, Retry-After UX, token fields, atomic save, event
cursor, heartbeat, or rejected-body transport contract. Do not deploy until
`ATLAS_82207F7_ADOPTION_PLAN.md` is complete, the full matrix is rerun, and deployment-specific
origins/secrets/proxy/backup/log inputs are recorded.
