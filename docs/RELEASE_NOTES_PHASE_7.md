# Phase 7 release notes

Release state: **candidate verified; production blocked**

## Atlas `82207f7` adoption addendum (2026-07-21)

The frontend adoption pass is complete against clean Atlas `82207f7` (Atlas remained read-only).
It adds session expiry/429 UX, token lifecycle metadata, nullable workflow `default_reply`,
`expected_version` conflict handling with semantic draft recovery, cursor-paged run history, and
SSE `retry`/keepalive transport handling. The implementation is split across commits `6619542`,
`ef83d08`, `701027d`, and `8671e08`; the final test-fixture/redirect corrections are in the
follow-up handoff commit.

Final evidence: unit `414 passed`; real-Atlas contract `143 passed, 3 skipped`; stream `27
passed`; browser `98 passed`; remote-like Node `v24.14.0` `1 passed`; production build and
canary bundle scan passed (`57` public files clean); lint exited 0 with 8 warnings; formatting,
typecheck, and `git diff --check` passed.

Decision: **no production ship**. Exact `PUBLIC_ORIGIN`, private `ATLAS_API_ORIGIN`, production
secret-store value, proxy buffering/timeout configuration, backup/restore drill, and log sink are
still deployment/operator inputs. Local and controlled-demo use is ready; no push was performed.

### Post-adoption fix passes (2026-07-21, later)

Two review rounds followed. `23f4b16`/`388f79d`/`519ee46`/`5abaac8` fixed 8 of 9 issues the first
round found; `1a34544`/`cfd7c38`/`aaec1e0` close the last one after a live-debugged correction —
the "critical" layout-reset finding was actually a test bug (an ambiguous `localStorage` key
lookup made worse by the second round's own new test coverage repeating the save more times),
not a production race, and the second review's own initial fix for it was reverted once that was
confirmed. Current evidence: unit `436 passed`; contract `143 passed, 3 skipped`; stream `27
passed`; browser `99 passed`. Full account: `RELEASE_READINESS.md`.

> **Backend status update (2026-07-21):** These notes record the Phase 7 candidate tested against
> Atlas `595ef62`. Atlas `82207f7` subsequently implemented expiry/capping/rate limiting plus
> additive workflow/event/HTTP contracts. The old backend P0 is closed, but this candidate remains
> blocked pending the adoption and requalification in `ATLAS_82207F7_ADOPTION_PLAN.md`.

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

At the Phase 7 evidence commit, Atlas `595ef62` still had the token-lifecycle P0. Atlas
`82207f7` closes it with expiring/capped dashboard sessions and login rate limiting. The current
frontend candidate still must not ship because it has not adopted or fully tested the new
session/token/workflow/event/HTTP contracts.

Exact production public/private origins and the production secret store are also undecided, so
no specific production deployment is ready. Remaining Atlas limitations (single-primary
runtime, per-client SSE polling, mostly limit-only pagination, retention/observability gaps, and
the rest) remain in `ATLAS_LIMITATIONS.md` and were not reclassified as frontend features.

## Upgrade and rollback

No frontend-owned database migration exists. Deploy the immutable Node artifact with the
required environment, then canary login/read/export/SSE behavior. To roll back the frontend,
route traffic to the previous immutable artifact and leave Atlas state untouched. If Atlas is
upgraded separately, follow its backup/migration/restore runbook; do not call a frontend artifact
rollback an Atlas data rollback.
