# Release and deployment runbook

## Topology

```text
reverse proxy / HTTPS
  -> flow-designer instances
  -> one Atlas primary instance
       -> persistent Atlas data and uploads
       -> thClaws workers
```

Frontend instances may scale horizontally if they are stateless and all use the same Atlas origin. Do not run multiple active Atlas writers unless Atlas has a documented distributed deployment mode.

## Pre-release

- Record the frontend commit and Atlas commit/version tested.
- Run `bun run lint` and `bun run build`.
- Run contract, browser, and stream tests.
- Confirm API origin, HTTPS, cookie attributes, and CORS policy.
- Confirm no service/worker token is in the browser bundle.
- Confirm the release checklist is complete.

## Deployment requirements

- HTTPS for the frontend and Atlas.
- Secure, httpOnly, same-site session cookies where the chosen topology permits.
- Persistent Atlas database/upload storage.
- Atlas secret key and worker credentials supplied through deployment secrets.
- Backups and restore test for Atlas state and artifacts.
- Reverse-proxy timeouts that permit SSE connections.
- Explicit request/body limits for artifacts and webhook inputs.

## Rollback

1. Stop routing traffic to the new frontend.
2. Restore the previous frontend build.
3. Keep Atlas state untouched unless an Atlas migration/recovery procedure explicitly requires it.
4. Review frontend/Atlas contract differences.
5. Re-run the local runbook before retrying deployment.

## Known boundary

This repository cannot make Atlas horizontally scalable. If Atlas needs replicas, distributed workflow ownership, a broker, or Postgres, track and implement that work in the Atlas repository first, then update `docs/BACKEND_INTEGRATION.md` here.
