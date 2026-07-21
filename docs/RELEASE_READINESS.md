# Phase 7 release readiness

Status: **Atlas 82207f7 adoption verified; production release blocked**

Evidence date: 2026-07-21 (Asia/Bangkok)

Adoption commits: `6619542`, `ef83d08`, `701027d`, and `8671e08`; the release-evidence update is
the follow-up commit containing this document. Baseline before the adoption pass: `85649e8`.
No commit was amended, rebased, squashed, force-pushed, or pushed.

Phase 7 tested Atlas commit: `595ef62bcfa38c1135867807bfe2fae320e37b0c`. The contract suite passed
both against the existing checkout and against a clean temporary `git archive` of that exact
commit. The existing checkout contained user-owned uncommitted changes and was never modified,
reset, or used as proof of a pristine commit.

Atlas `82207f7` was clean and its completion gate was GREEN before this pass. The adoption
implementation and requalification below cover its additive contracts; the original `595ef62`
matrix remains historical compatibility evidence only.

## Release decision

| Target                              | Decision            | Reason                                                                                                                                           |
| ----------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local development / controlled demo | Ready               | Full functional, contract, stream, browser, restart, and remote-like matrices pass.                                                              |
| Production                          | **Do not ship yet** | Code and tests are requalified, but exact production origins, secret store, proxy, backup/restore drill, and log sink are still operator inputs. |
| A specific production deployment    | **Not configured**  | Exact `PUBLIC_ORIGIN`, private `ATLAS_API_ORIGIN`, production secret store, proxy, backup destination, and log sink remain operator inputs.      |

The historical Phase 7 matrix below remains valid evidence for its original frontend/Atlas pair.
The adoption matrix below is the current code/test evidence for Atlas `82207f7`; it is not a
production deployment certificate.

## Verification matrix

Every result below came from one uninterrupted release-matrix command at implementation commit
`7740797`, except the clean-archive contract rerun and the explicit Node 24 remote-like rerun,
which are called out separately. The latter reran after the harness began rejecting non-24
runtimes.

| Check                            | Result | Evidence                                                                                                                         |
| -------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                       | Pass   | `bun run typecheck`, exit 0                                                                                                      |
| ESLint                           | Pass   | `bun run lint`, exit 0; 6 existing Fast Refresh warnings, 0 errors                                                               |
| Formatting                       | Pass   | `bun run format:check`, exit 0                                                                                                   |
| Unit                             | Pass   | `bun run test`: 391 passed                                                                                                       |
| Real-Atlas contract              | Pass   | `bun run test:contract`: 136 passed, 3 skipped                                                                                   |
| Clean pinned-Atlas contract      | Pass   | `ATLAS_REPO_PATH=<clean 595ef62 archive> bun run test:contract`: 136 passed, 3 skipped; archive removed after the run            |
| Stream                           | Pass   | `bun run test:stream`: 24 passed                                                                                                 |
| Browser acceptance               | Pass   | `bun run test:e2e`: 94 passed                                                                                                    |
| Remote-like production transport | Pass   | `PHASE7_NODE_BINARY=<Node 24> bun run test:remote`: 1 passed on Node v24.14.0 through HTTPS proxy → built server → private Atlas |
| Production build                 | Pass   | canary env + `bun run build`; Nitro reports `preset: node-server`                                                                |
| Client bundle                    | Pass   | canary private origin + session secret, `bun run scan:bundle`: 57 files, no forbidden symbol/value, positive control present     |
| Diff integrity                   | Pass   | `git diff --check`, exit 0                                                                                                       |
| Generated route tree             | Pass   | `git diff 64eeae9..7740797 -- src/routeTree.gen.ts` produced no diff                                                             |

The 3 contract skips are the suite's intentional fixture gaps already recorded by the earlier
phases; the command did not skip the Atlas suite. Five contract files executed against the real
server.

## Required scenario matrix

| Scenario                             | Result | Source of evidence                                                                              |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| Login, reload, logout                | Pass   | `tests/e2e/auth.spec.ts`                                                                        |
| Two tabs / shared persisted mutation | Pass   | `tests/e2e/editor.spec.ts`: stale editor save is refused after another tab changes the workflow |
| Expired/revoked auth                 | Pass   | mid-visit revoked session redirects to `/auth`; stream 401 stops without reconnect              |
| Slow worker                          | Pass   | 25-second silent-worker browser test: stale, not terminal, then recovered                       |
| Worker offline                       | Pass   | real unreachable seeded worker and offline/degraded UI paths                                    |
| Stream disconnect/reconnect          | Pass   | stream adapter retry/gap tests plus browser silent-stream recovery                              |
| Duplicate/out-of-order event         | Pass   | stream tests dedupe and state-regression guards                                                 |
| Atlas restart                        | Pass   | process killed and respawned on the same port/database; persisted rows recover                  |
| Warm cached data during outage       | Pass   | real Atlas outage after two cached workflow windows; shell warns that cached data may be stale  |
| Same-origin artifact bytes           | Pass   | successful file upload to Atlas, then HTTPS public-origin download through the BFF              |
| Same-origin CSV exports              | Pass   | audit and usage CSV through the public origin; correct filename/content type                    |
| Same-origin SSE                      | Pass   | terminal job event stream through the public origin with `after=0` and `event: close`           |

## Deployment and security matrix

| Concern             | Code/test state                                                                                                                | Deployment state                                                                     | Gate                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| Runtime             | Self-hosted Nitro target pinned to `node-server`; `package.json` requires Node 24.x                                            | Node v24.14.0 executed the remote-like artifact; build on the target OS/architecture | Pass for self-hosted Node 24                 |
| `PUBLIC_ORIGIN`     | Required, origin-only; production HTTP is rejected                                                                             | Exact HTTPS origin is still TODO                                                     | **Deployment input required**                |
| `ATLAS_API_ORIGIN`  | Required, origin-only, server-only; real private canary stayed out of client bundle                                            | Exact private origin is still TODO                                                   | **Deployment input required**                |
| `SESSION_SECRET`    | Required, ≥32 chars; committed placeholder rejected in production; canary stayed out of bundle                                 | Secret store and generated value are still TODO                                      | **Deployment input required**                |
| Cookie              | `HttpOnly; Secure; SameSite=Lax; Path=/`; host-only; 8-hour default                                                            | Verified through remote-like HTTPS proxy                                             | Pass                                         |
| CSRF                | `PUBLIC_ORIGIN` URL-normalized; wrong origin rejected                                                                          | Matching public origin accepted behind an internal HTTP hop                          | Pass                                         |
| CORS                | Browser never calls Atlas; no Atlas browser-CORS dependency                                                                    | Keep Atlas private; do not expose its bearer to browser code                         | Pass for required topology                   |
| Same-origin routes  | Artifact, SSE, audit CSV, usage CSV attach bearer server-side                                                                  | HTTPS proxy streamed every route without exposing Atlas origin/token                 | Pass                                         |
| Error/log redaction | Atlas 5xx text, cause chain, cookies, headers, and bodies excluded                                                             | Choose a log sink; preserve stderr and never enable body/header logging at proxy     | Code pass; operator input required           |
| Bundle secrets      | Static symbols plus real canary values scanned with positive control                                                           | Repeat with release canaries for every artifact                                      | Pass                                         |
| Frontend replicas   | Sealed stateless cookie; shared secret/private origin; no sticky session required                                              | All replicas must share `SESSION_SECRET` and `ATLAS_API_ORIGIN`                      | Supported                                    |
| Atlas topology      | Frontend assumes one primary Atlas origin                                                                                      | Do not run multiple Atlas writers against one/independent SQLite databases           | Single primary only                          |
| SSE proxy           | Client counts Atlas 15-second keepalives as transport activity, honors bounded retry, and preserves event cursor semantics     | Disable buffering; timeout >45 seconds                                               | Code/test pass; deployment topology required |
| Backup/restore      | Atlas provides WAL-safe online DB backup plus paired upload archive                                                            | Select destination/retention/key and complete a restore drill before production      | Operator action required                     |
| Rollback            | Previous frontend artifact can be restored without changing Atlas state                                                        | Retain immutable artifacts and deployment metadata                                   | Documented                                   |
| Token lifecycle     | Client surfaces session expiry, real 429 Retry-After countdown, token purpose/expiry/lifecycle, and authoritative 401 sign-out | Configure production secret/origins and monitor expiry/rate-limit signals            | Code/test pass; deployment inputs required   |

## Atlas `82207f7` adoption evidence (2026-07-21)

The flow-designer implementation now targets the clean Atlas checkout at `82207f7` read-only.
Logical commits are `6619542` (transport contracts), `ef83d08` (session/token UX), `701027d`
(default reply and atomic workflow saves), and `8671e08` (cursor history and SSE keepalives).
The final fixture and 401-history corrections are included with this handoff.

| Check               | Result | Actual evidence                                                                                                                                   |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript          | Pass   | `bun run typecheck`, exit 0                                                                                                                       |
| ESLint              | Pass   | `bun run lint`, exit 0; 8 warnings, 0 errors                                                                                                      |
| Formatting          | Pass   | `bun run format:check`, exit 0                                                                                                                    |
| Unit                | Pass   | `bun run test`, 414 passed                                                                                                                        |
| Real-Atlas contract | Pass   | `bun run test:contract`, 143 passed, 3 skipped                                                                                                    |
| Stream              | Pass   | `bun run test:stream`, 27 passed                                                                                                                  |
| Browser acceptance  | Pass   | `bun run test:e2e`, 98 passed                                                                                                                     |
| Remote-like Node 24 | Pass   | `PHASE7_NODE_BINARY=/Users/seal/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bun run test:remote`, 1 passed on v24.14.0 |
| Production build    | Pass   | canary `bun run build`; Nitro `preset: node-server`                                                                                               |
| Client bundle       | Pass   | canary `bun run scan:bundle`; 57 files clean, positive control present                                                                            |
| Diff integrity      | Pass   | `git diff --check`, exit 0                                                                                                                        |

The first full browser run exposed test-fixture coupling to Atlas's real login limiter (86 passed,
12 failed); the CSRF fixture was isolated with throwaway usernames and the final rerun was 98/98.
The targeted 401 history regression also passed after changing the redirect to `replace`.

Adoption coverage specifically proves session metadata/expiry and 429 countdown, token lifecycle,
default-reply CRUD/inheritance/override/allowlist/delivery, atomic 409 saves and layout migration,
cursor pages/dedupe/cap, SSE `retry: 3000` and comment keepalives, and same-origin Node 24
transport/security. No Atlas source was changed and no push was performed.

## Atlas `82207f7` re-verification

The clean current Atlas source and commits `60d4190`, `ffe96c5`, `d4bec5b`, `6c49aab`, and
`01ac1ad` were traced:

- migration 014 adds `purpose`/`expires_at`, revokes identified legacy login sessions, and
  authentication expires tokens;
- login creates bounded dashboard sessions and applies a pre-password rate limiter with
  `Retry-After`;
- rejected unread request bodies close safely;
- workflow saves accept atomic `expected_version`;
- workflow-run events expose cursor pages;
- job SSE emits reconnect and keepalive controls.

Atlas's gate is GREEN and the old flow contract remains compatible, but production may proceed
only after the new behaviors are adopted and covered by the full release matrix plus exact
deployment inputs.
