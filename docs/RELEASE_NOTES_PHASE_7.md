# Phase 7 release notes

Release state: **candidate verified; production blocked**

## What changed

- Added a reproducible remote-like acceptance suite. It builds the Node artifact, runs it on an
  internal HTTP origin, exposes it through a temporary HTTPS reverse proxy, and keeps Atlas on a
  third private origin.
- Verified URL-normalized `PUBLIC_ORIGIN` matching, CSRF rejection, secure host-only session
  cookies, private `ATLAS_API_ORIGIN`, and all four same-origin byte/stream routes.
- Pinned self-hosted Nitro output to `node-server` and declared Node 24.x as the production
  runtime. Lovable-hosted builds continue to use Lovable's forced Cloudflare output.
- Production startup now refuses a non-HTTPS `PUBLIC_ORIGIN` and the committed example
  `SESSION_SECRET`.
- Strengthened client-bundle scanning so release canary values for the session secret and private
  Atlas origin are checked without printing either value on failure.
- Added a shell-level warning when an active Atlas read fails while active cached data exists:
  the UI says the data may be stale instead of presenting the cache as current without context.
- Reconciled the delivery checklist, added the release-readiness matrix, and expanded the
  operator deployment/backup/rollback handoff.

## Compatibility and operations

- Frontend package manager: Bun 1.3.14.
- Self-hosted runtime: Node 24.x, Nitro `node-server` output.
- Atlas contract tested: `595ef62bcfa38c1135867807bfe2fae320e37b0c`.
- Browser topology remains same-origin BFF. Atlas stays private and bearer-token only.
- Frontend replicas are stateless and may scale horizontally when they share the same
  `SESSION_SECRET` and `ATLAS_API_ORIGIN`.
- Atlas remains a single primary. This release does not make SQLite/runtime execution
  active-active.

Behavior change: a process started with `NODE_ENV=production` now fails before serving if
`PUBLIC_ORIGIN` uses HTTP or if `SESSION_SECRET` is still the committed placeholder. This is
intentional fail-fast behavior.

## Verification summary

- Typecheck, lint, format, build: pass.
- Unit: 391 passed.
- Real Atlas contract: 136 passed, 3 skipped; repeated against a clean archive of the pinned
  Atlas commit with the same result.
- Stream: 24 passed.
- Browser: 94 passed.
- Remote-like built-Node/HTTPS/private-Atlas: 1 passed on Node v24.14.0; the harness rejects
  non-24 runtimes.
- Client bundle: 57 files clean with positive control and real canary-value checks.

See `RELEASE_READINESS.md` for commands, scenario mapping, and deployment inputs.

## Known blockers and limitations

**P0 — production release blocker:** Atlas login tokens do not expire, every login mints a new
live `"dashboard login"` token, old login tokens are not capped/cleaned up, and the login route
has no rate limiting. The frontend's 8-hour cookie and logout revocation are mitigations, not a
fix. No risk acceptance was recorded during Phase 7; therefore this candidate must not ship to
production.

Exact production public/private origins and the production secret store are also undecided, so
no specific production deployment is ready. Remaining Atlas limitations (single-primary
runtime, asymmetric SSE/no heartbeat, limit-only pagination, retention/observability gaps, and
the rest) remain in `ATLAS_LIMITATIONS.md` and were not reclassified as frontend features.

## Upgrade and rollback

No frontend-owned database migration exists. Deploy the immutable Node artifact with the
required environment, then canary login/read/export/SSE behavior. To roll back the frontend,
route traffic to the previous immutable artifact and leave Atlas state untouched. If Atlas is
upgraded separately, follow its backup/migration/restore runbook; do not call a frontend artifact
rollback an Atlas data rollback.
