# Branchpoint

Agent-driven QA scenario trees on [Runloop](https://runloop.ai). Write the flows
you care about in plain words, fork one snapshot into every branch, and re-run
the whole tree against each commit.

The pitch, in one line:

> Conventional regression tests store a **selector**, so they die when the UI
> moves. We store an **intent**, so the agent follows it.
> `#solo` breaks on the next deploy. *"Choose the solo option"* still holds in
> five years.

---

## What is here

| Path | |
|---|---|
| `docs/build-spec.html` | **Start here.** Measured numbers, the five traps, pinned contracts, and the six-way work split. Open it in a browser. |
| `packages/schema/src/index.ts` | The pinned contracts as real types. Changing these stalls other people — raise it first. |
| `design/` | Design canvas source: four `.dc.html` artboards, `canvas.json`, and real screenshots captured from a devbox. |
| `experiments/` | Standalone scripts that produced every number in the spec. Each one runs on its own. |
| [`hackathon-runloop-demo`](https://github.com/sanggggg/hackathon-runloop-demo) | The companion Nimbus browser-QA fixture. Its profiles, actions, and expected outcomes live in [`qa/manifest.json`](https://github.com/sanggggg/hackathon-runloop-demo/blob/cb30fb3ed4aa2f1b30ca1180df82f3eef05313f3/qa/manifest.json). |

## The two routes

**Build** — chat only. No browser, no screenshots, nothing executed. Each card
stores an intent. Nodes are `unverified` until a run checks them, and go
`unresolved` when the wording matched nothing on the page.

**Run** — one page, three states: pick a trigger, watch the branches fork, read
the results. Green means the path still works, red means it failed. That is the
whole legend; nuance lives in words on the node (`passed · UI changed`) and in
the detail panel.

A red card in Build is a bug in the **tree**. A red node in Run is a bug in the
**app**. Keeping those apart is why the routes are separate.

## Why fork

Wall clock tracks tree **depth**, not path count.

```
8 paths, one at a time, each re-signing in     ~3m 30s
8 paths forked from one snapshot                ~16s
```

Measured on a real devbox: fork boots in **2.7s**, and three forks in parallel
cost the same as one. Agent-driven QA has always been too slow to run on every
deploy; this is what makes it affordable.

## Verified, so nobody re-derives it

| | |
|---|---|
| Devbox create → running | 2.0s |
| Snapshot (light / with Chromium) | 3.4s / 18.6s |
| Fork boot from snapshot | 2.6–2.7s |
| Chromium + Playwright install | 41s — bake into the Blueprint |
| Branch & Race, end to end | 65s, ~$0.15 |

Proven working: fork inherits disk state, a browser login session survives a
fork, screenshots capture in the box and download to the host.

## Demo fixture and Runloop validation

The real browser target is
[`sanggggg/hackathon-runloop-demo`](https://github.com/sanggggg/hackathon-runloop-demo),
a deterministic onboarding app called **Nimbus**. It has real authentication,
persisted server state, semantic controls, branching journeys, and named
failure profiles. It makes no third-party network calls at runtime, so the same
ref and action sequence always produce the same oracle.

The two-ref demo is deliberately small and immutable:

| Ref | What Branchpoint should report |
|---|---|
| [`fixture-v1-baseline`](https://github.com/sanggggg/hackathon-runloop-demo/tree/fixture-v1-baseline) · `cb30fb3` | Five original journeys pass; CSV import does not exist. |
| [`fixture-demo-head`](https://github.com/sanggggg/hackathon-runloop-demo/tree/fixture-demo-head) · `db1f49e` | A renamed starter control still passes as `UI changed`; blank and decide-later fail on deterministic error screens; a working CSV-import path is discovered. |

Pin the peeled commit SHAs, not `main`. Do not set `QA_PROFILE` or `QA_VARIANT`
for this comparison: each ref's committed `fixture.config.json` selects its
behavior.
The pinned commits are `cb30fb3ed4aa2f1b30ca1180df82f3eef05313f3`
and `db1f49ee2431ae89761c9621a56ac8795f7d4b3a`, respectively.
Additional published refs isolate DOM refactors, copy changes, regressions,
removed controls, discovery, and timeouts; the
[fixture README](https://github.com/sanggggg/hackathon-runloop-demo#profiles)
lists the full matrix.

The repo contract is intentionally conventional:

```bash
npm ci && npm run build
npm start                    # terminal 1, port 3000
```

Then, in another terminal:

```bash
curl http://127.0.0.1:3000/__qa/health
```

Agents should read
[`qa/manifest.json`](https://github.com/sanggggg/hackathon-runloop-demo/blob/cb30fb3ed4aa2f1b30ca1180df82f3eef05313f3/qa/manifest.json)
rather than duplicate credentials, accessible labels, action IDs, or outcomes.
`POST /__qa/reset` isolates flows, `GET /__qa/state` is the server oracle, and
`GET /__qa/events` explains how the browser got there. Assert terminal `stage`
and `outcome`, not presentation copy.

On 2026-08-29 the fixture was exercised against the real Runloop API, not a
mock. These artifacts are account-scoped and can be rebuilt from the pinned SHA
if they are removed:

| Artifact | Verified value |
|---|---|
| Runtime Blueprint | `branchpoint-node22-playwright-1.62.0` · `bpt_34FmWfEvKypQOyjrC7LVA` · Node 22.15.0, npm 10.9.2, Chromium |
| Signed-in fixture snapshot | `branchpoint-nimbus-baseline-v1` · `snp_34FmaUWcfqTTEIq3t9k9K` · baseline `cb30fb3` parked at `/onboarding/use-case` |
| Fork smoke | Session restored, `Solo plan → Starter template` reached `done / solo-starter`; server and browser state agreed |
| Blueprint lookup → fork assertion | 48.75s with the built Blueprint reused; every Devbox created by the smoke test was shut down afterward |

The snapshot contains the persisted server state and Playwright
`storage_state`. It does **not** contain a running process, so every fork must
restart `npm start` and restore the browser state before continuing. The
validation uploaded an archive of the pinned private ref.

This validates the Runloop primitive and the Nimbus target. The product UI in
`apps/web` still renders the hand-written data in `apps/web/lib/fixtures.ts`;
wiring the orchestrator to this fixture is the next engine step.

## Running the experiments

```bash
export RUNLOOP_API_KEY=...
export OPENROUTER_API_KEY=...        # branch_race.py only

python3 experiments/fork_test.py     # fork inherits disk state
python3 experiments/branch_race.py   # agent loop + mid-run snapshot + 3 forks
python3 experiments/flowmap_test.py  # a login session survives a fork
python3 experiments/shot_test.py     # capture screenshots, download them
python3 experiments/capture_shots.py # build the demo app, shoot v1 and v2
```

No dependencies — Python stdlib only. Every script shuts its devboxes down in a
`finally` block; if one dies badly, check for strays:

```bash
curl -s -H "Authorization: Bearer $RUNLOOP_API_KEY" \
  https://api.runloop.ai/v1/devboxes?limit=20
```

## Rebuilding the design canvas

The seeded output is gitignored because it is regenerable. From `design/`:

```bash
node "$DESIGN_SKILL/seed-canvas.mjs" \
  --template "$DESIGN_SKILL/payload.template.html" \
  --out branchpoint-qa-tree.html --title "Branchpoint" \
  --artboard Main.dc.html --artboard Setup.dc.html \
  --artboard Builder.dc.html --artboard RunnerIdle.dc.html \
  --canvas canvas.json \
  $(for f in design/shots/*.png; do echo --image "$f"; done)
```

Colours come from [Kumo](https://kumo-ui.com) light-mode tokens, lifted from the
live site — no invented values. Status colours are Kumo's `success` and
`danger`.

## Running it end to end

The engine does not exist yet, so a mock stands in for it on the same HTTP
routes. Nothing else is stubbed — the CLI and the web app talk to it exactly
as they will talk to the real thing.

```bash
pnpm install
pnpm --dir apps/mock-server dev      # http://localhost:4000
```

Then, in another shell:

```bash
cd apps/cli
bp() { node --experimental-strip-types src/index.ts "$@"; }

bp suite list
bp suite show nimbus-onboarding      # the tree, with unresolved steps flagged
bp run --suite nimbus-onboarding --wait
bp runs --watch                      # in-flight runs, refreshed
```

Mock runs take about as long as real ones, so `--wait` and `--watch` exercise
the paths they will use for real.

## Running the web app

```bash
pnpm install
pnpm --dir apps/web dev     # http://localhost:3000
```

Both routes render from `apps/web/lib/fixtures.ts` — a hand-written `Suite` and
`Run` typed against `packages/schema`. No engine required. When `POST /runs`
starts returning something real, swap the fixture import for a fetch and the
components do not change.

UI is [Kumo](https://kumo-ui.com) (`@cloudflare/kumo`), light mode, with its
semantic tokens rather than raw colours.

## Order of work

Only the first item blocks anyone.

1. **Schemas committed** — done, in `packages/schema`.
2. **Blueprint built and validated** — Node 22, Chromium, and Playwright are
   baked once and reused by fixture Devboxes.
3. **Orchestrator and intent resolver, in parallel** — the orchestrator runs
   against a stub resolver that returns the first candidate; the resolver is
   scored against saved HTML with no devbox at all.
4. **Both UIs against fixture JSON** — hand-write one `Suite` and one `Run`.
5. **Join them, run against the
   [demo repo](https://github.com/sanggggg/hackathon-runloop-demo).** Expect the
   first changed-ref run to include both red paths and resilient passes. That is
   the system working.
6. **Two commits, two runs.** That is the demo.
