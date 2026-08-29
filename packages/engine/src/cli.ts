#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Suite } from "@branchpoint/schema";
import { LocalArtifactStore } from "./artifact-store.js";
import { BranchpointEngine } from "./engine.js";
import { EngineRunError } from "./errors.js";
import { RunloopClient } from "./runloop-client.js";
import { RunloopRuntime } from "./runloop-runtime.js";

interface CliOptions {
  suitePath: string;
  ref?: string;
  maxConcurrency: number;
  workDir: string;
  agentCommand: string;
  healthPath: string;
  openrouterModel?: string;
  openrouterSecret?: string;
  artifactDir: string;
}

let terminationSignal: NodeJS.Signals | undefined;

function usage(): string {
  return `Usage:
  branchpoint-engine run --suite <suite.json> [options]

Options:
  --ref <git-ref>              Override suite.repo.ref
  --max-concurrency <number>   Maximum live devboxes (default: 8)
  --work-dir <path>            Repo path in the fixture (default: /home/user/workspace)
  --agent-command <command>    In-container browser agent command
  --health-path <path>         App health path (default: /)
  --openrouter-model <model>   Model id exposed to the in-container resolver
  --openrouter-secret <name>   Existing Runloop Secret mapped to OPENROUTER_API_KEY
  --artifact-dir <path>        Persistent screenshot directory (default: .branchpoint-artifacts)
  --help                       Show this help

Environment:
  RUNLOOP_API_KEY              Required
  RUNLOOP_API_URL              Optional API base URL
  BRANCHPOINT_WORK_DIR         Default for --work-dir
  BRANCHPOINT_AGENT_COMMAND    Default for --agent-command
  BRANCHPOINT_HEALTH_PATH      Default for --health-path
  BRANCHPOINT_OPENROUTER_MODEL Default for --openrouter-model
  BRANCHPOINT_OPENROUTER_SECRET Default for --openrouter-secret
  BRANCHPOINT_ARTIFACT_DIR     Default for --artifact-dir
`;
}

function parsePositiveInteger(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]): CliOptions | "help" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (argv[0] !== "run") throw new Error("the first argument must be 'run'");

  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near '${flag ?? "end of command"}'`);
    }
    values.set(flag, value);
  }

  const known = new Set([
    "--suite",
    "--ref",
    "--max-concurrency",
    "--work-dir",
    "--agent-command",
    "--health-path",
    "--openrouter-model",
    "--openrouter-secret",
    "--artifact-dir",
  ]);
  for (const flag of values.keys()) {
    if (!known.has(flag)) throw new Error(`unknown option '${flag}'`);
  }

  const suitePath = values.get("--suite");
  if (!suitePath) throw new Error("--suite is required");
  const openrouterModel =
    values.get("--openrouter-model") ?? process.env.BRANCHPOINT_OPENROUTER_MODEL;
  const openrouterSecret =
    values.get("--openrouter-secret") ?? process.env.BRANCHPOINT_OPENROUTER_SECRET;
  if (Boolean(openrouterModel) !== Boolean(openrouterSecret)) {
    throw new Error("--openrouter-model and --openrouter-secret must be configured together");
  }
  return {
    suitePath,
    ...(values.get("--ref") ? { ref: values.get("--ref") } : {}),
    maxConcurrency: parsePositiveInteger(
      "--max-concurrency",
      values.get("--max-concurrency") ?? "8",
    ),
    workDir: values.get("--work-dir") ?? process.env.BRANCHPOINT_WORK_DIR ?? "/home/user/workspace",
    agentCommand:
      values.get("--agent-command") ??
      process.env.BRANCHPOINT_AGENT_COMMAND ??
      "python3 .branchpoint/browser-agent.py",
    healthPath: values.get("--health-path") ?? process.env.BRANCHPOINT_HEALTH_PATH ?? "/",
    artifactDir:
      values.get("--artifact-dir") ??
      process.env.BRANCHPOINT_ARTIFACT_DIR ??
      ".branchpoint-artifacts",
    ...(openrouterModel ? { openrouterModel } : {}),
    ...(openrouterSecret ? { openrouterSecret } : {}),
  };
}

function parseSuite(value: unknown, source: string): Suite {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    !Array.isArray((value as { tree?: unknown }).tree)
  ) {
    throw new Error(`'${source}' is not a Suite JSON document`);
  }
  return value as Suite;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write(usage());
    return;
  }

  const suiteSource = await readFile(path.resolve(options.suitePath), "utf8");
  const suite = parseSuite(JSON.parse(suiteSource) as unknown, options.suitePath);
  const runnerPath = fileURLToPath(new URL("../../runner/browser-agent.py", import.meta.url));
  const runnerSource = await readFile(runnerPath, "utf8");

  const client = new RunloopClient({
    ...(process.env.RUNLOOP_API_URL ? { baseUrl: process.env.RUNLOOP_API_URL } : {}),
  });
  const runtime = new RunloopRuntime({
    client,
    artifactStore: new LocalArtifactStore(options.artifactDir),
    workDir: options.workDir,
    agentCommand: options.agentCommand,
    healthPath: options.healthPath,
    bootstrapFiles: {
      ".branchpoint/browser-agent.py": runnerSource,
    },
    ...(options.openrouterModel
      ? { environmentVariables: { BRANCHPOINT_OPENROUTER_MODEL: options.openrouterModel } }
      : {}),
    ...(options.openrouterSecret
      ? { secrets: { OPENROUTER_API_KEY: options.openrouterSecret } }
      : {}),
  });
  const engine = new BranchpointEngine({
    runtime,
    maxConcurrency: options.maxConcurrency,
  });
  const controller = new AbortController();
  let signalCount = 0;
  const terminate = (signal: NodeJS.Signals): void => {
    signalCount += 1;
    terminationSignal = signal;
    if (signalCount === 1) {
      process.stderr.write(`${signal} received; stopping new work and cleaning up Runloop resources...\n`);
      controller.abort(new Error(`received ${signal}`));
      return;
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = (): void => terminate("SIGINT");
  const onSigterm = (): void => terminate("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let run;
  try {
    run = await engine.run({
      suite,
      ...(options.ref ? { ref: options.ref } : {}),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof EngineRunError) {
    process.stderr.write(`${error.message}\n${JSON.stringify(error.partialRun, null, 2)}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  process.exitCode = terminationSignal === "SIGINT" ? 130 : terminationSignal === "SIGTERM" ? 143 : 1;
});
