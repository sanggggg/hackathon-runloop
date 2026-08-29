# Branchpoint QA Engine Server

The server is the durable HTTP wrapper around `@branchpoint/engine`. It stores
prepared Suites, queues long-running engine work, persists partial node results,
serves screenshots, and gives the dashboard and remote CLI one polling contract.

## Local development

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
# Fill RUNLOOP_API_KEY and BRANCHPOINT_API_TOKEN in apps/server/.env
pnpm dev:server
```

The API listens on `http://localhost:4000`. Liveness is always available at
`GET /healthz`; readiness is `200` only when the engine is configured and the
server is accepting runs.

## Production integration

The deployed API base URL is:

```text
https://branchpoint-server-production.up.railway.app
```

Its live, machine-readable contract is available at
[`/openapi.json`](https://branchpoint-server-production.up.railway.app/openapi.json).
`/`, `/healthz`, `/readyz`, and `/openapi.json` are public. Every Suite, Run,
cancel, and screenshot endpoint requires the shared Bearer token:

```bash
export BRANCHPOINT_API_URL=https://branchpoint-server-production.up.railway.app
export BRANCHPOINT_API_TOKEN=replace-me

curl -fsS "$BRANCHPOINT_API_URL/suites" \
  -H "Authorization: Bearer $BRANCHPOINT_API_TOKEN"
```

Missing or invalid credentials return `401` with a `WWW-Authenticate: Bearer`
header. Requests carrying an `Origin` outside `BRANCHPOINT_CORS_ORIGINS` return
`403`. The remote CLI should read both values from environment variables. The
dashboard must keep the token server-side (for example, in a Next.js route
handler or server action); never ship it in a `NEXT_PUBLIC_*` variable or
browser bundle.

Register a complete, already-prepared Suite and start a run:

```bash
export BRANCHPOINT_API_TOKEN=replace-me

curl -fsS http://localhost:4000/suites \
  -H "Authorization: Bearer $BRANCHPOINT_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @packages/engine/examples/nimbus-suite.json

curl -fsS http://localhost:4000/runs \
  -H "Authorization: Bearer $BRANCHPOINT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"suiteId":"nimbus-onboarding"}'
```

Replace the Blueprint and snapshot placeholders in the example before running
it. Repository setup / Blueprint creation is not yet part of the engine, so
`POST /suites` deliberately rejects repo-only requests instead of inventing
fixture IDs.

## HTTP contract

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | Public | Process liveness |
| `GET` | `/readyz` | Public | Deployment readiness |
| `GET` | `/openapi.json` | Public | OpenAPI 3.1 description |
| `GET` | `/suites` | Bearer | List Suites |
| `POST` | `/suites` | Bearer | Register a complete Suite |
| `GET` | `/suites/:id` | Bearer | Read one Suite |
| `PATCH` | `/suites/:id` | Bearer | Validate and replace its tree |
| `POST` | `/runs` | Bearer | Queue a run; returns `202 { runId }` |
| `GET` | `/runs?suiteId=` | Bearer | List newest-first |
| `GET` | `/runs/:id` | Bearer | Poll lifecycle and partial results |
| `POST` | `/runs/:id/cancel` | Bearer | Cancel queued/running work |
| `GET` | `/screenshots/*` | Bearer | Read a persisted PNG |

Every protected endpoint expects `Authorization: Bearer <token>` when
`BRANCHPOINT_API_TOKEN` is configured. Production startup refuses to run
without a token unless `BRANCHPOINT_ALLOW_INSECURE=true` is deliberately set.

`Run.executionStatus` is one of `queued`, `running`, `cancelling`, `succeeded`,
`failed`, or `cancelled`. Product regressions still produce a `succeeded`
engine execution containing failed `NodeResult`s. `failed` is reserved for an
infrastructure failure and includes a safe machine-readable `Run.error`.

## Persistence and shutdown

`JsonFileStore` writes one versioned JSON document through serialized, atomic
renames. Screenshots live beside it under the configured data directory. On
startup, any persisted non-terminal run is marked `failed/server_restarted`;
the engine cannot safely resume a half-finished Runloop tree.

This adapter is intentionally for one process / one Railway replica. Its
interface is the seam for a later Postgres implementation; the screenshot
store can similarly move to object storage.

SIGTERM stops new work, aborts active engines, waits for their Runloop cleanup,
and terminalizes queued/in-flight records. The Railway configuration grants a
180-second deployment drain (170 seconds for application cleanup) and mounts
`/app/data` as a persistent Volume. A hard machine crash can still strand a
Runloop resource; startup recovery terminalizes the JSON record but does not
yet reconcile remote resources by metadata.

## Verification

```bash
pnpm --filter @branchpoint/server test
pnpm build:server
```

Server tests use fake executors and a real HTTP socket; they never call Runloop.
Use the engine's credentialed smoke/E2E scripts for live infrastructure checks.
