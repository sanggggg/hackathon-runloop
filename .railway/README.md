# Branchpoint on Railway

This project uses Railway's TypeScript Infrastructure as Code. The deprecated
`railway.toml` / `railway.json` config format is intentionally not used.

The service builds from the repository root because `apps/server` depends on
the workspace packages in `packages/`. It runs as one replica with a 1 GiB
Volume mounted at `/app/data`; the JSON state file and screenshots both live
under that mount.

Before the first deploy, add these secret variables to `branchpoint-server`:

- `RUNLOOP_API_KEY`
- `BRANCHPOINT_API_TOKEN` — a long random bearer token used by the dashboard and CLI

Optional variables:

- `RUNLOOP_API_URL`
- `BRANCHPOINT_OPENROUTER_MODEL` and `BRANCHPOINT_OPENROUTER_SECRET` (set both)
- `BRANCHPOINT_CORS_ORIGINS` (comma-separated dashboard origins)
- `BRANCHPOINT_MAX_ACTIVE_RUNS` (default `1`)
- `BRANCHPOINT_MAX_CONCURRENCY` (Devboxes per run, default `8`)

The service intentionally starts with an empty source so it can be deployed
from a dirty/local worktree without requiring Railway GitHub App access. Upload
the repository root so all workspace packages are present:

```bash
pnpm install
railway login
railway link
railway config plan
railway config apply
railway up --service branchpoint-server
railway domain --service branchpoint-server
```

The checked-in `railway` npm package is the IaC TypeScript SDK. The commands
above use Railway CLI 5.42.1 or newer, installed separately.

The first `domain` command generates the public URL used by the dashboard and
CLI. It is safe to omit when the service should remain private-network only.
After granting Railway's GitHub App access, an optional
`railway service source connect --repo sanggggg/hackathon-runloop --branch main`
switches later deploys to GitHub autodeploys.

Railway gives an old deployment 180 seconds to drain; the server reserves 170
seconds for aborting the engine and deleting Runloop Devboxes and snapshots.

The `/readyz` deployment healthcheck stays at `503` until `RUNLOOP_API_KEY` is
configured. `NODE_ENV=production` also makes the API token mandatory.

Do not enable multiple replicas with this Volume-backed JSON store. Migrate run
state to a database and screenshots to object storage before horizontal scaling.
