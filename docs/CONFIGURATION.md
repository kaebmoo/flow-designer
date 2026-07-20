# Configuration decisions for Phase 1

Phase 0 does not select values or install anything. This document lists the configuration Phase 1 requires, records what is already fixed by Atlas source, and turns the rest into explicit user decisions with a recommendation and trade-off for each.

## Fixed by Atlas source (not decisions)

Verified against Atlas `595ef62` (`atlas/config.py`, `atlas/app.py`):

- Atlas is **bearer-token only** and issues **no cookies**. The browser session cookie is therefore owned by flow-designer.
- Atlas CORS (`_cors_headers`): with `ATLAS_CORS_ORIGINS` empty it sends `Access-Control-Allow-Origin: *`; with it set, it reflects only allowlisted origins. It **never** sends `Access-Control-Allow-Credentials`, and it allows the `authorization` header. So: cross-origin **cookie** credentials to Atlas are **not supported**. A cross-origin request carrying an `Authorization: Bearer` header _is_ technically possible (allowlisted origin + header), but this architecture **rejects** it because it would require the Atlas bearer to live in browser code. The browser talks only to flow-designer; flow-designer talks to Atlas server-to-server.
- Atlas env vars are all `ATLAS_*`: `ATLAS_HOST` (default `127.0.0.1`), `ATLAS_PORT` (default `8787`), `ATLAS_DB`, `ATLAS_UPLOAD_DIR`, `ATLAS_API_TOKEN` (legacy admin token), `ATLAS_LOOPBACK_NO_AUTH`, `ATLAS_SECRET_KEY`, `ATLAS_CORS_ORIGINS`, `ATLAS_SERVE_UI`, `ATLAS_PUBLIC_BASE_URL` (worker callbacks), `ATLAS_OUTBOUND_ALLOWLIST`, `ATLAS_REQUEST_LOG`, and related timeouts. These are set on **Atlas**, not on flow-designer.
- Default dev Atlas origin: `http://127.0.0.1:8787`.

## Decisions requiring the user

Each is a real deployment choice. Recommendation first; do not pick silently.

### Reviewed defaults pending the Phase 1 gate (2026-07-19)

These defaults have passed technical review, but they are **not** a substitute for the user's explicit Phase 1 approval. This correction pass does not open Phase 1; the details below carry the rationale/trade-offs:

- Package manager **Bun 1.3.14** (pinned in `package.json`); production runtime **Node 24 LTS** (Cloudflare Workers = separate runtime if chosen).
- Topology **same-origin BFF**, Atlas reached over a **private** origin.
- Session via **TanStack Start `useSession`** (verify the installed-version API) before any custom crypto.
- Key rotation v1: **single key, rotate → force re-login** (no custom two-key crypto).
- Cookie **`HttpOnly; SameSite=Lax`, host-only**; `Secure=true` prod, `Secure=false` local HTTP.
- Authorization: **Atlas is the only enforcement authority**; frontend role data is UX-only.
- Workflow UI: **Atlas-native graph model**, no pseudo-node lowering; layout stored **locally** with auto-layout fallback.
- SSE contract: **verified as documented**, pending the Phase 1 gate with the other defaults.

Still needing explicit user approval: the complete Phase 1 gate, plus exact public/private production origins and domains (decisions 2–3) and the production secret store (decision 4).

### Confirmed at the Phase 1 gate (2026-07-20)

The user opened Phase 1 with these decisions. Three deployment values were **deliberately deferred**, so Phase 1 shipped against local values and committed placeholders rather than inventing production names.

| Item                            | Decision                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Session max age                 | **28800 s (8 hours)**, implemented as the default in `src/lib/env.server.ts` and overridable with `SESSION_MAX_AGE`                         |
| Cookie                          | `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only; `Secure` whenever `PUBLIC_ORIGIN` is https, **independent of `NODE_ENV`** (see note below) |
| Session mechanism               | TanStack Start `useSession`, single `SESSION_SECRET` (≥32 chars); rotation forces re-login                                                  |
| Env var names                   | `ATLAS_API_ORIGIN`, `SESSION_SECRET`, `PUBLIC_ORIGIN`, `NODE_ENV`, optional `SESSION_MAX_AGE`                                               |
| Local Atlas origin              | `http://127.0.0.1:8787`                                                                                                                     |
| `PUBLIC_ORIGIN` (production)    | **Deferred.** `.env.example` documents it as a TODO. Required before any deploy.                                                            |
| `ATLAS_API_ORIGIN` (production) | **Deferred.** `.env.example` documents it as a TODO. Required before any deploy.                                                            |
| Production secret store         | **Deferred.** No code depends on the choice — every variable is read from the process environment regardless of what supplies it.           |

Two implementation details worth recording, both discovered by reading the installed source rather than assuming:

- **`sessionHeader: false` is mandatory.** `useSession` otherwise accepts a sealed session from an `x-fd_session-session` **request header in preference to the cookie**, which would let a caller supply a session out-of-band. The httpOnly cookie is now the only accepted carrier.
- **CSRF `origin` is singular and only consulted when `Sec-Fetch-Site` is absent.** The framework checks `Sec-Fetch-Site` first, then `Origin`, then `Referer`, and denies a request carrying none of the three. The `origin` matcher therefore exists for the reverse-proxy case, where the browser's origin differs from the internal request URL. Both sides are normalised through `URL` before comparison, since `PUBLIC_ORIGIN` may be written with a trailing slash, mixed case, or an explicit default port.
- **Cookie `Secure` is driven by the `PUBLIC_ORIGIN` scheme, not by `NODE_ENV`.** This corrects the earlier decision recorded above. `NODE_ENV` silently defaults to `development` when unset, and some runtimes never populate it, so gating on it would drop `Secure` from the cookie carrying the Atlas bearer on a genuine HTTPS deployment — failing open on precisely the flag that keeps it off cleartext. The origin is validated at startup, so its scheme is the reliable signal.

### 1. Package manager and deployment runtime (separate concerns)

Treat the package manager and the production runtime as two independent choices.

**Package manager — Pinned: Bun 1.3.14.** `bun.lock` already exists and `package.json` records `"packageManager": "bun@1.3.14"`, so contributors and CI use the same package-manager version. Bun is **not installed on this machine** — installation still requires approval before Phase 1. This is orthogonal to where the app runs in production.

**Production runtime — Decided: Node 24 LTS for Node-based deployments (VPS/Fly/containers).** As of July 2026, per the [Node.js release schedule](https://github.com/nodejs/release): **Node 24 is Active LTS**, **Node 20 is EOL**, and **Node 25** (the odd/current line installed here) is a short-lived non-LTS line, also past support. Do not target Node 20 or Node 25.

- **Trade-off:** Node 24 LTS is broadly supported by TanStack Start/Nitro and gets security updates through its LTS window; running on the machine's installed Node 25 would be convenient but unsupported.
- **If Cloudflare Workers is chosen instead,** treat it as a _distinct_ deployment runtime (Workers/`workerd`, not Node): validate the session primitive, streaming/SSE proxy, and any Node-API usage against the Workers runtime separately before committing.

### 2. Frontend public origin

- **Recommend:** a single HTTPS origin, e.g. `https://atlas.<domain>`, serving both the UI and its server functions/BFF.
- **Trade-off:** a dedicated origin keeps cookie scope tight; sharing an apex/other app origin risks cookie/path collisions.

### 3. Atlas private/server origin

- **Recommend:** reach Atlas over a **private** origin from the flow-designer server only (e.g. `http://atlas-internal:8787` on a private network), never exposed to the browser.
- **Trade-off:** private origin removes browser↔Atlas CORS entirely and keeps the bearer server-side; a publicly reachable Atlas widens attack surface and forces CORS/credential handling Atlas does not support.

### 4. Server-only environment variable names (flow-designer)

Proposed names (server-only; never `VITE_`-prefixed, never in the client bundle):

- `ATLAS_API_ORIGIN` — private Atlas base URL the server forwards to.
- `SESSION_SECRET` — the 32+ char `password` that seals the TanStack Start session cookie (single key; rotation = change it and force re-login, decision 6).
- `PUBLIC_ORIGIN` — the frontend's own public origin (for CSRF `origin` and absolute redirects).
- `COOKIE_DOMAIN` (optional), `NODE_ENV`.

**Decision:** confirm the names and which secret store supplies them.

### 5. Secure httpOnly cookie / session strategy

- **Decided: use TanStack Start's built-in session primitive** (`useSession` from `@tanstack/react-start/server`), which seals (encrypts) the cookie with a `password` (32+ chars) and sets `httpOnly`/`secure`/`sameSite`/`maxAge`. Store the Atlas bearer (and minimal identity for UI hints) in that sealed session. Do **not** hand-roll AEAD/cookie crypto.
- **Verify the API for the installed version first.** This repo pins `@tanstack/react-start` `^1.168.26`; confirm `useSession`'s signature/behavior against that version (and the [authentication guide](https://tanstack.com/start/latest/docs/framework/react/guide/authentication)) before writing session code, since the API has shifted across releases.
- **Trade-off:** the framework primitive is stateless (sealed cookie), so frontend replicas stay horizontal (decision 7) but cannot be revoked server-side before expiry — mitigate with a short `maxAge` and calling Atlas `POST /api/auth/logout` (which revokes the Atlas token) on logout. A server-side session store would add instant revocation but also shared infrastructure; only adopt it if revocation latency proves unacceptable.

### 6. Key rotation

- **Decided (v1): a single sealing `password`/`SESSION_SECRET`; rotate by changing the key and forcing re-login.** This avoids custom multi-key cryptography entirely and keeps the security surface small.
- **Do not implement custom two-key rotation** unless the framework primitive is insufficient _and_ the user approves the added complexity. Rotate on a schedule and on suspected compromise (accepting that active sessions must re-authenticate).
- **`Secure` flag:** `Secure=true` in production (HTTPS); `Secure=false` only for local HTTP dev (see decision 9).

### 7. Behavior across multiple stateless frontend replicas

- **Recommend:** stateless replicas behind the reverse proxy, all sharing the same `SESSION_SECRET` and the same `ATLAS_API_ORIGIN`. No sticky sessions required.
- **Trade-off:** requires disciplined key distribution; in return any replica can serve any request. This scales the **frontend** only — Atlas remains a single primary (see `ATLAS_LIMITATIONS.md`); the frontend does not and cannot make Atlas horizontally scalable.

### 8. CORS and reverse-proxy topology

- **Decided: same-origin BFF.** The browser calls only flow-designer; flow-designer calls Atlas server-to-server. This avoids browser↔Atlas CORS altogether.
- **Trade-off:** split-origin (browser calls Atlas directly) can't use cookie credentials (Atlas sends no `Access-Control-Allow-Credentials`); it _could_ send an `Authorization` header cross-origin with an allowlisted origin, but that puts the Atlas bearer in browser code — which this architecture rejects. Not worth the exposure.
- The reverse proxy must allow long-lived SSE (disable response buffering / raise idle timeouts) because Atlas emits no heartbeat.

### 9. Cookie `Secure` / `SameSite` / domain policy

- **Decided:** `HttpOnly; SameSite=Lax`, host-only (no `Domain`), `Path=/`; `Secure=true` in production HTTPS and `Secure=false` only for local HTTP dev. `SameSite=Lax` suits a same-origin app with top-level navigation; combine with the CSRF middleware (decision 8 / `FRONTEND_ENGINEERING.md`).
- **Trade-off:** `SameSite=Strict` is marginally safer but breaks some inbound links; `None` requires `Secure` and is only for deliberate cross-site use. Setting a `Domain` widens cookie exposure across subdomains, so keep it host-only unless subdomains genuinely need it.
