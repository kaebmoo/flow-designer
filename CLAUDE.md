## Architecture rules

- `flow-designer` is the UI/client for the existing Atlas Control Plane. Atlas is the single source of truth for authentication, users, roles, workers, workspaces, jobs, conversations, workflows, runs, artifacts, triggers, deliveries, audit, usage, and execution.
- Do not add Postgres, Drizzle, PocketBase, a second domain database, a second auth system, or a workflow executor to this repository unless the user explicitly changes the architecture decision in `docs/adr/0001-atlas-is-source-of-truth.md`.
- Do not call thClaws workers directly from browser code. Worker credentials and worker routing stay behind Atlas.
- `*.functions.ts` holds `createServerFn` RPC wrappers. Routes, components, loaders, and hooks **may** statically import them; the bundler replaces the body with a network call, so server code never ships to the browser. Do not dynamically import server functions.
- `*.server.ts` holds server-only Atlas HTTP clients, session/cookie helpers, credentials, and secrets. Client code must **never** import `*.server.ts`. Secrets and `process.env` reads happen only in request-time server execution.
- Each private server function must **validate the flow-designer session** (authentication) and call a **typed, fixed Atlas operation** — never a generic arbitrary Atlas proxy. A route `beforeLoad` is a UI navigation boundary only; the RPC endpoint is reachable directly, so never assume a UI guard ran.
- **Atlas is the only authorization authority.** Do not build a second RBAC system in the frontend. Frontend role/permission data is for UX only (hide/disable) and must never be the security boundary; never treat a cookie-cached role as a security decision — a role can change in Atlas at any time, and Atlas enforces permissions on every call.
- A route handler may exist only as thin transport glue (for example, a same-origin SSE proxy); it must not contain domain logic, persistence, or secrets.
- Because this repo defines `src/start.ts`, install `createCsrfMiddleware()` in the start `requestMiddleware` before adding any auth or mutation server function (CSRF is not auto-installed once `start.ts` exists). The Atlas bearer token stays server-side in an httpOnly cookie and must never reach browser code or a URL query string.
- Use Atlas API contracts and adapters instead of leaking raw Atlas response shapes throughout components. Keep mapping code in `src/lib/`.

## Routing and generated files

- Never edit `src/routeTree.gen.ts`; it is auto-generated.
- Every route with a loader must define both `errorComponent` and `notFoundComponent`.
- Protected pages belong under an authenticated route layout and must verify the current Atlas identity before rendering protected data.

## UI and styling

- Use design tokens from `src/styles.css`; do not introduce hardcoded colors such as `bg-black`, `text-white`, or arbitrary color literals like `bg-[#...]`.
- Keep loading, empty, error, forbidden, and not-found states explicit for every server-backed page.
- Live logs must be bounded and virtualized or incrementally rendered; never render an unbounded event list in one DOM tree.

## Delivery and process

- Work phase-by-phase using `docs/IMPLEMENTATION_PLAN.md` and stop at the phase gate for user confirmation.
- Run the checklist in `docs/CHECKLIST.md` before declaring a phase complete.
- Commit small phases with clear messages. Do not rewrite published history because this repository is connected to Lovable.
- If an ambiguity changes the Atlas contract, auth boundary, data ownership, or security model, stop and ask before coding. For UI-only details, choose the smallest consistent implementation and document the assumption.

## Source of truth and limitations

- The current Atlas checkout is `/Users/seal/Documents/GitHub/atlas-control-plane`; its OpenAPI and behavior are summarized in `docs/BACKEND_INTEGRATION.md`.
- Atlas currently has single-node SQLite/runtime scaling constraints. Do not hide, work around, or duplicate Atlas persistence in the frontend. Track backend improvements in `docs/ATLAS_LIMITATIONS.md`.
