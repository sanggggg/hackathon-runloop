# @branchpoint/cli

A thin client. It does not run any tests — it asks the service to evaluate a
commit and reports the verdict. That is why CI needs a token and nothing else:
no browser install, no runner dependencies, no flake from the CI machine.

```bash
export BRANCHPOINT_TOKEN=...
branchpoint run --suite nimbus-onboarding --wait
```

## Try it without a service

```bash
BRANCHPOINT_API=fixture pnpm --dir apps/cli branchpoint run --suite demo --wait
```

Runs against the same sample data the web app uses, so the output and exit
codes are real even before the engine exists.

## Exit codes

| | |
|---|---|
| `0` | every path passed |
| `1` | a path failed — the app broke |
| `2` | a step matched nothing — the tree is stale, not the app |
| `3` | the run could not be started |

`1` and `2` are deliberately different. A check that cannot tell "your app
broke" from "your test is stale" gets muted like every other flaky suite.

A path the agent kept alive through a UI change counts as **passing** — not
failing on a renamed button is the point of the product. Teams that want to
hear about it anyway can pass `--strict-ui`.

## Output

`--format human` (default) prints the tree with per-path timings.
`--format markdown` prints the pull request comment.
`--format json` prints the raw `Run`.

## In CI

See `.github/actions/branchpoint/action.yml`, and `docs/ci-example.yml` for a
workflow you can copy into the repository you want tested. Three lines:

```yaml
- uses: sanggggg/hackathon-runloop/.github/actions/branchpoint@main
  with:
    suite: nimbus-onboarding
    token: ${{ secrets.BRANCHPOINT_TOKEN }}
```
