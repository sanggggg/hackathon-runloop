# Branchpoint Engine

The engine walks a QA intent tree inside Runloop devboxes. A straight path
keeps using the same devbox. At a node with two or more runnable children it
persists the browser checkpoint, snapshots the devbox disk once, and creates a
child devbox from that same snapshot for every branch.

```text
fixture snapshot
  -> materialize target ref and start app
  -> checkpoint + disk snapshot at a fork point
  -> create child devboxes in parallel
  -> restart app and restore browser checkpoint in every child
  -> give each child a different QA node
  -> recurse, aggregate results, clean up every devbox and temporary snapshot
```

## Boundaries

`BranchpointEngine` owns tree validation, traversal, concurrency, result order,
and cleanup. It does not know how Playwright or an LLM works. Those live behind
`ContainerRuntime`, whose `executeNode` method invokes a browser QA agent inside
the devbox.

HTTP and CLI entrypoints should share `createRunloopEngine` rather than assemble
the Runloop client, runtime, screenshot store, and Python bootstrap separately:

```ts
import { createRunloopEngine } from "@branchpoint/engine";

const { engine, artifactStore } = await createRunloopEngine({
  runloopBaseUrl: process.env.RUNLOOP_API_URL,
  artifactDir: process.env.BRANCHPOINT_ARTIFACT_DIR,
  openrouterModel: process.env.BRANCHPOINT_OPENROUTER_MODEL,
  openrouterSecret: process.env.BRANCHPOINT_OPENROUTER_SECRET,
});

const run = await engine.run({
  suite,
  ref,
  runId,
  signal: controller.signal,
  onProgress: async (partialRun) => {
    await runStore.save(partialRun);
  },
});
```

`onProgress` captures a new unfinished `Run` snapshot immediately after every
committed node result, then delivers snapshots serially across concurrent
branches. The callback cannot mutate engine-owned result state. If a callback
rejects, the run follows the same resource-cleanup path as another infrastructure
failure and rejects with `EngineRunError`; its `partialRun` includes the node
result that triggered the callback. The final returned `Run` is still the
authoritative finished value. A branch keeps its devbox permit while its callback
is pending, so persistence callbacks should be bounded and return promptly.

The factory locates `runner/browser-agent.py` correctly when invoked from either
the TypeScript source layout or compiled `dist/src` output. Deployments must
therefore retain the package-level `runner` directory alongside `dist`.

Runloop disk snapshots do **not** preserve browser or application processes.
The in-container agent must write its logical browser state to disk after every
node. At minimum that checkpoint contains:

- Playwright `storageState` including IndexedDB;
- the current URL;
- session storage when the application depends on it;
- the branch-local agent transcript or other reasoning state needed to resume.

After a fork, the runtime restarts the app. The agent then launches a new
browser context, restores that checkpoint, visits the saved URL, and only then
executes the branch-specific intent.

Every product verdict also requires a PNG. `RunloopRuntime` downloads that PNG
before shutting the devbox down and hands it to a `ScreenshotArtifactStore`.
The CLI uses `LocalArtifactStore`, so `NodeResult.screenshotId` remains valid
after all branch devboxes and temporary snapshots have been deleted.

## Agent protocol

The runtime writes an `AgentNodeRequest` JSON document inside the devbox. The
configured agent command reads it and writes an `AgentNodeResult` JSON document.
The agent must persist the next browser checkpoint before returning `pass`.

Product outcomes are represented as node results:

- no matching control: `fail / unresolved`;
- the action or goal exceeds its deadline: `fail / timeout`;
- the action succeeded but the expected screen did not: `fail / error-screen`;
- the goal was reached: `pass`.

Devbox boot, app start, snapshot, agent-process, and cleanup failures are
infrastructure errors. They reject the run as `EngineRunError` and are never
mislabelled as application failures.

The bundled Python runner has two deliberate model modes:

- no OpenRouter key and no model: deterministic lexical resolver/judge;
- key and model both configured: model-required mode. Authentication,
  transport, structured-output, and schema failures are infrastructure errors
  after bounded retries; they never silently fall back to lexical matching.

Successful structured model responses are exposed as `modelCalls` per node
(when nonzero), and the run reports their aggregate. Use that receipt—not
`costUsd > 0`—to prove that structured model responses were used. `costUsd` is
only the provider-reported billing total and can legitimately remain zero for
a successful BYOK or otherwise zero-charge response. HTTP retries are not
counted as additional successful model calls. On `EngineRunError`, both
aggregates cover only node results already committed to `partialRun`; they are
not a complete bill for the failed in-flight agent.

OpenRouter receives bounded candidate labels/text for intent resolution and
bounded visible page text for goal judgement. Page content is treated as
untrusted data in the system prompt.

## Commands

```bash
pnpm --filter @branchpoint/engine typecheck
pnpm --filter @branchpoint/engine test
pnpm --filter @branchpoint/engine build
```

To run a prepared Suite through the CLI, create an account-level Runloop Secret
first and pass only its **name**. Never put the raw OpenRouter value in a Suite,
command argument, or checked-in environment file.

```bash
RUNLOOP_API_KEY=... pnpm --filter @branchpoint/engine build
RUNLOOP_API_KEY=... node packages/engine/dist/src/cli.js run \
  --suite packages/engine/examples/nimbus-suite.json \
  --openrouter-model google/gemini-3.1-flash-lite \
  --openrouter-secret MY_OPENROUTER_SECRET \
  --health-path /__qa/health \
  --artifact-dir .branchpoint-artifacts
```

The Suite fixture must already contain the exact target commit, installed
browser/runtime dependencies, and a browser checkpoint. Target and fixture refs
are validated independently; branch names are accepted, but pinned 40-character
SHAs are strongly recommended for reproducible runs.

## Live Nimbus E2E

The first full real-API run and its exact tree, node verdicts, timing, model
receipt, screenshot audit, and cleanup evidence are recorded in
[`docs/runs/2026-08-29-nimbus-live-e2e.md`](../../docs/runs/2026-08-29-nimbus-live-e2e.md).

The live harness creates a sanitized depth-one repository at the exact pinned
commit from a local clone of `sanggggg/hackathon-runloop-demo`; the original
repository history plus local dirty and untracked files are never uploaded. It
prepares a signed-in `demo-head` fixture, creates a Runloop disk snapshot, and
verifies nested forks against the pinned commit in
[`examples/nimbus-suite.json`](examples/nimbus-suite.json). It expects the
renamed starter path and import path to pass, and the blank/later regressions to
fail as `error-screen`.

```bash
BRANCHPOINT_DEMO_REPO_PATH=/absolute/path/to/hackathon-runloop-demo \
BRANCHPOINT_DEMO_REF=b36666c0351c94e5074e532f88cf8e70695549ea \
RUNLOOP_API_KEY=... \
OPENROUTER_API_KEY=... \
pnpm --filter @branchpoint/engine e2e:live-demo
```

The harness creates a randomly named temporary Runloop Secret, injects it into
the QA devboxes, and deletes it after devboxes and snapshots are cleaned. It
also handles SIGINT/SIGTERM and retries cleanup. Screenshots remain under the
reported `.branchpoint-artifacts/live-*` directory.

This live run sends candidate control text and goal-screen text from the demo
application to OpenRouter. Run it only for a repository whose content is
approved for that external processing. Runloop devbox-level secret injection
also makes the raw value available to processes in that trusted devbox; use a
Runloop gateway instead before testing untrusted repositories.

[`examples/nimbus-suite.json`](examples/nimbus-suite.json) shows the intended
input for the external Nimbus demo repository. Replace the Blueprint and
fixture snapshot placeholders after preparing the repo in Runloop.

Current scope: discovered nodes are aggregated when an agent reports them, but
the bundled click runner does not yet synthesize new tree nodes automatically.
The live demo therefore includes `Import from CSV` explicitly as an unverified
goal.
