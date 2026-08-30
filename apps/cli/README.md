# Branchpoint remote CLI

`branchpoint` calls the deployed QA Engine server; it never creates Runloop
resources directly. The shared server token is accepted only through the
environment so it does not appear in shell history or process arguments.

```bash
export BRANCHPOINT_API_TOKEN=...
# Optional; defaults to the production Railway server.
export BRANCHPOINT_API_URL=https://branchpoint-server-production.up.railway.app

pnpm --filter @branchpoint/cli build
node apps/cli/dist/src/cli.js run --suite nimbus-action-baseline --ref "$GITHUB_SHA"
```

## Commands

```text
branchpoint run --suite <suite-id> [--ref <git-ref>] [--detach]
                [--poll-interval <seconds>] [--timeout <seconds>]
branchpoint runs [list] [--suite <suite-id>]
branchpoint runs get <run-id>
branchpoint runs cancel <run-id>
branchpoint suites [list]
branchpoint suites get <suite-id>
branchpoint suites push --file <suite.json>
```

Commands write one JSON document to stdout. Polling progress and error documents
go to stderr. `run` waits by default so it can gate CI; `--detach` exits after
the server accepts the run. POST requests are never retried, avoiding duplicate
runs after an ambiguous network failure. GET requests use three bounded attempts.

`BRANCHPOINT_API_TOKEN` authenticates the CLI to the QA Engine server. Suite
source repositories are public, so the run request contains only the Suite id
and optional target ref.

When `GITHUB_STEP_SUMMARY` is present, `run` appends a Markdown result table. It
also writes `run-id` and `outcome` to `GITHUB_OUTPUT`, allowing a workflow step
with an `id` to expose both values. The raw JSON can be retained with `tee`.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Run passed, or a detached/read/write command succeeded |
| `1` | Engine execution succeeded but a product node failed (`error-screen`/`timeout`); mixed stale/product failures also use `1` |
| `2` | Every failed node was unresolved, so the stored Suite tree is stale |
| `3` | Invalid usage/configuration, API/network/protocol error, infrastructure failure, or cancellation |
| `124` | Polling timeout; remote cancellation was attempted |
| `130` | `SIGINT`; remote cancellation was attempted when a run id was known |
| `143` | `SIGTERM`; remote cancellation was attempted when a run id was known |
