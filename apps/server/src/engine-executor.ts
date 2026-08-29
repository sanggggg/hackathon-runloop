import {
  LocalArtifactStore,
  createRunloopEngine,
  type RunInput,
} from "@branchpoint/engine";
import type { Run } from "@branchpoint/schema";
import type { ServerConfig } from "./config.js";
import type { RunExecutor } from "./run-service.js";

class ConfiguredExecutor implements RunExecutor {
  readonly configured = true;
  readonly #run: (input: RunInput) => Promise<Run>;

  constructor(run: (input: RunInput) => Promise<Run>) {
    this.#run = run;
  }

  run(input: RunInput): Promise<Run> {
    return this.#run(input);
  }
}

class UnconfiguredExecutor implements RunExecutor {
  readonly configured = false;

  async run(_input: RunInput): Promise<Run> {
    throw new Error("RUNLOOP_API_KEY is not configured");
  }
}

export interface ExecutorBundle {
  executor: RunExecutor;
  artifactStore: LocalArtifactStore;
}

export async function createRunExecutor(config: ServerConfig): Promise<ExecutorBundle> {
  if (!config.runloopApiKey) {
    return {
      executor: new UnconfiguredExecutor(),
      artifactStore: new LocalArtifactStore(config.artifactDirectory),
    };
  }

  const bundle = await createRunloopEngine({
    runloopApiKey: config.runloopApiKey,
    ...(config.runloopApiUrl ? { runloopBaseUrl: config.runloopApiUrl } : {}),
    maxConcurrency: config.maxDevboxConcurrency,
    workDir: config.workDir,
    agentCommand: config.agentCommand,
    healthPath: config.targetHealthPath,
    artifactDir: config.artifactDirectory,
    ...(config.openrouterModel ? { openrouterModel: config.openrouterModel } : {}),
    ...(config.openrouterSecret ? { openrouterSecret: config.openrouterSecret } : {}),
  });
  return {
    executor: new ConfiguredExecutor((input) => bundle.engine.run(input)),
    artifactStore: bundle.artifactStore,
  };
}
