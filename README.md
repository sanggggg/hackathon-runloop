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

## Order of work

Only the first item blocks anyone.

1. **Schemas committed** — done, in `packages/schema`.
2. **Build the Blueprint** — removes 41s from every experiment. Do this early.
3. **Orchestrator and intent resolver, in parallel** — the orchestrator runs
   against a stub resolver that returns the first candidate; the resolver is
   scored against saved HTML with no devbox at all.
4. **Both UIs against fixture JSON** — hand-write one `Suite` and one `Run`.
5. **Join them, run against the demo repo.** Expect the first run to be mostly
   red. That is the system working.
6. **Two commits, two runs.** That is the demo.
