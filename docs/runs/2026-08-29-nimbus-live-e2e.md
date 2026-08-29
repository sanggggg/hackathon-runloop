# Nimbus live engine E2E — 2026-08-29

Status: **passed**

This record captures the first full Branchpoint engine run against the real
Runloop and OpenRouter APIs. The target was the companion Nimbus repository,
not a mock server. The harness completed with `ok: true` after verifying every
expected product verdict, screenshot, model-call receipt, and cleanup step.

## Run inputs

| Input | Value |
|---|---|
| Target repository | [`sanggggg/hackathon-runloop-demo`](https://github.com/sanggggg/hackathon-runloop-demo) |
| Pinned target ref | [`b36666c0351c94e5074e532f88cf8e70695549ea`](https://github.com/sanggggg/hackathon-runloop-demo/commit/b36666c0351c94e5074e532f88cf8e70695549ea) |
| Fixture | Signed in as the demo user at `/onboarding/use-case`, `QA_PROFILE=demo-head` |
| Browser | Playwright 1.62.0, headless Chromium, 1440×1000 viewport |
| Model | `google/gemini-3.1-flash-lite` through OpenRouter structured output |
| Engine concurrency | 4 |
| Harness | [`packages/engine/scripts/live-demo-e2e.mjs`](../../packages/engine/scripts/live-demo-e2e.mjs) |

Credentials were supplied only through process environment variables. The
harness copied the OpenRouter value into a randomly named temporary Runloop
Secret, injected that secret into trusted QA devboxes, and deleted it during
cleanup. No credential value is present in this record or the repository.
The uploaded source archive is produced from a new depth-one repository fetched
at the exact pinned commit. It contains only that commit's tracked tree and the
minimal Git metadata needed for the runtime's commit verification; the local
clone's history, dirty files, and untracked files such as `.env` or `.npmrc`
are never sent to Runloop.

## QA tree

The fixture node is state only; the agent executed the nine nodes below it.
This is the inline `demoSuite()` used by the live harness; its short runtime
node IDs intentionally differ from some IDs in the reusable example Suite.

```text
Signed-in fixture: /onboarding/use-case
├─ Team plan [step]
│  ├─ Invite teammates [step]
│  │  └─ Send invitations [goal] → Invitations sent
│  └─ Skip invites [goal] → Team workspace ready
├─ Solo plan [step]
│  ├─ Starter template [goal] → Starter project created
│  ├─ Blank workspace [goal] → Empty workspace ready
│  └─ Import from CSV [unverified goal] → Records imported
└─ Decide later [goal] → Progress saved for later
```

At the root, the signed-in fixture fanned out into the Team, Solo, and Decide
later branches. After Team passed, the engine checkpointed and forked Invite
and Skip from the same state. After Solo passed, it checkpointed and forked
Starter, Blank, and Import from the same state. Invite and Send form a straight
chain and reused one devbox instead of taking another snapshot.

## Results

`ok: true` means the engine produced the expected verdict for every node. It
does not mean the target application had no regressions: the fixture
deliberately contains two error paths, and detecting both as product failures
is part of the passing harness contract.

| Node | Verdict | Evidence | Model calls | Elapsed |
|---|---|---|---:|---:|
| Team plan | pass | Resolved `Team plan`; healthy next screen and checkpoint | 1 | 18,550 ms |
| Invite teammates | pass | Resolved `Invite teammates`; confirmation state checkpointed | 1 | 7,285 ms |
| Send invitations | pass | Reached `Invitations sent` | 2 | 13,880 ms |
| Skip invites | pass | Reached `Team workspace ready` | 2 | 9,405 ms |
| Solo plan | pass | Resolved `Solo plan`; all three child controls present | 1 | 17,940 ms |
| Starter template | pass · `ui-changed` | Baseline hint `Starter template` resolved to `Use a starter`; reached `Starter project created` | 2 | 7,896 ms |
| Blank workspace | fail · `error-screen` | `Something went off route`; blank workspace could not be created | 1 | 7,794 ms |
| Import from CSV | pass | Unverified path reached `Records imported` | 2 | 8,895 ms |
| Decide later | fail · `error-screen` | `Something went off route`; setup could not be saved for later | 1 | 17,745 ms |

Summary:

- 9 executed nodes: 7 pass, 2 expected product failures;
- 13 successful structured model responses;
- `costUsd: 0`, as reported by the provider for this BYOK run;
- no lexical fallback occurred in model-required mode.

`modelCalls`, rather than a positive provider billing amount, is the execution
receipt. A BYOK or otherwise zero-charge response can legitimately report
`costUsd: 0` after a real model call.

## Recorded timing

| Metric | Result |
|---|---:|
| Parallel tree wall clock | 44,724 ms |
| Terminal-path node-time estimate | 156,535 ms |
| Raw ratio between the two fields | 3.50× |

These two fields do not cover exactly the same work and therefore are not an
end-to-end speed-up benchmark. `wallClockMs` covers the engine tree run after
fixture snapshot preparation, including devbox creation, root preparation,
snapshot/fork work, branch execution, and cleanup. Each `NodeResult.elapsedMs`
is cumulative from just after its current devbox was created, so it includes
that devbox's prepare/app-start work and earlier nodes on the same straight
segment. `sequentialEstimateMs` takes the maximum cumulative value per devbox
segment and repeats those segments for every terminal path; it excludes devbox
creation and the common root-preparation segment, which has no `NodeResult`.
The raw 3.50× ratio is retained as an engine output, not claimed as a measured
wall-clock acceleration. A future benchmark should run the same tree serially
and in parallel with identical setup boundaries.

The devbox identities in the result still confirm the fork behavior itself:
sibling branches used distinct forked containers, while the Invite → Send
straight chain reused the same container.

## Screenshot and state evidence

The host downloaded one content-addressed PNG per executed node before any
devbox was shut down:

- all nine PNG files decoded successfully and had distinct SHA-256 hashes;
- eight were 1440×1000 and the full-page Skip result was 1440×1052;
- every filename hash prefix matched the bytes on disk;
- Team, Invite, and Solo showed the correct branch-local checkpoint state;
- Send, Skip, Starter, and Import showed their expected terminal success state;
- Blank and Decide later showed distinct, route-specific error messages;
- every page retained the signed-in shell, with no 404, login regression,
  loading-state capture, or cross-branch state leak.

The full-resolution files remain in the local, gitignored
`.branchpoint-artifacts/live-*` directory. They are intentionally not committed
because the deterministic harness can reproduce them from the pinned ref.

## Validation and cleanup

The final source state passed:

- 40 TypeScript/Node tests;
- 11 Python browser-runner tests;
- engine and web TypeScript checks;
- JavaScript syntax and Git whitespace checks;
- a repository scan for Runloop/OpenRouter key-shaped values.

The harness shuts down every tracked devbox, deletes every temporary disk
snapshot, deletes the temporary Runloop Secret, and removes the host staging
archive in `finally`. Cleanup failures turn the process into a nonzero exit;
this run exited zero after that cleanup completed.

## Harness corrections made during the smoke

Two checks were corrected before the first passing run:

1. Python Playwright was pinned to the published `1.62.0` release instead of
   the unavailable `1.62.1` version.
2. The model-execution assertion was changed from `costUsd > 0` to an explicit
   `modelCalls > 0` receipt. This keeps the E2E valid for BYOK and cached or
   otherwise zero-charge provider responses without weakening model-required
   behavior.

The third attempt produced the first complete passing run. During pre-PR review,
source staging was then hardened so the harness uploads a new depth-one repo at
the pinned commit rather than the caller's local checkout. A fourth confirmation
run exercised that hardened path, reproduced all verdicts, and exited zero. The
tables in this record are from that final confirmation run. The first attempt
had stopped during fixture preparation; the second reached all branch and
screenshot assertions before the billing-only assertion rejected the otherwise
successful BYOK run.

## Reproduce

Use a trusted local clone of the pinned demo ref. Supply both API values through
the environment or a shell secret manager; do not place them in a Suite file,
command argument, or checked-in environment file.

```bash
BRANCHPOINT_DEMO_REPO_PATH=/absolute/path/to/hackathon-runloop-demo \
BRANCHPOINT_DEMO_REF=b36666c0351c94e5074e532f88cf8e70695549ea \
RUNLOOP_API_KEY="$RUNLOOP_API_KEY" \
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
pnpm --filter @branchpoint/engine e2e:live-demo
```

The target repository can read devbox-level secrets while the agent is
running. Use this direct injection path only for trusted QA targets; place a
gateway between the target and model credentials before accepting untrusted
repositories.
