# Local development runbook

## Prerequisites

- **Bun 1.3.14** as the package manager — `bun.lock` is committed and `package.json` pins the version. Bun is **not installed on this machine** (only Node `v25.2.1` is present); installation requires approval. Production deploys target **Node 24 LTS** (see `docs/CONFIGURATION.md` §1); the `bun …` commands below are for local dev/CI.
- Atlas checkout at `/Users/seal/Documents/GitHub/atlas-control-plane`.
- At least one reachable thClaws worker if testing real jobs.

## Start Atlas

```bash
cd /Users/seal/Documents/GitHub/atlas-control-plane
python3 -m atlas --host 127.0.0.1 --port 8787
```

Atlas stores local state under its own `data/` directory. Do not point the frontend at the SQLite file.

## Start the frontend

```bash
cd /Users/seal/Documents/GitHub/flow-designer
bun install
bun run dev
```

The Atlas API origin must be provided through the approved runtime configuration. Do not hardcode a token or worker URL in source.

## Local verification order

1. `GET /healthz` on Atlas.
2. Login through the frontend and verify `/api/me`.
3. Verify workers and workspaces load.
4. Create or open a workflow.
5. Validate and save the workflow.
6. Start a run and verify the real run ID.
7. Open the job/run stream and test refresh/reconnect.
8. Verify logout removes access.

## Troubleshooting

- `401`: inspect session cookie handling and Atlas bearer forwarding; never print the token.
- `403`: verify Atlas role and endpoint permission.
- CORS/stream failure: use the approved server transport rather than adding a query-string token.
- Empty data: distinguish an empty Atlas response from a transport failure; do not fall back to mock data.
- Worker offline: verify Atlas worker health/polling before debugging the frontend.
