#!/usr/bin/env node

import { loadConfig, parseArgs, usage } from "./args.js";
import { ApiClient } from "./client.js";
import { executeCommand, serializeError } from "./commands.js";
import { EXIT_CODE, SignalInterruption } from "./errors.js";
import { writeGitHubMetadata } from "./github.js";

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(usage());
    return;
  }

  const config = loadConfig(process.env);
  const api = new ApiClient({ baseUrl: config.apiUrl, token: config.apiToken });
  const controller = new AbortController();
  let signalCount = 0;
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
    signalCount += 1;
    if (signalCount > 1) process.exit(signal === "SIGINT" ? EXIT_CODE.sigint : EXIT_CODE.sigterm);
    controller.abort(new SignalInterruption(signal));
  };
  const onSigint = (): void => interrupt("SIGINT");
  const onSigterm = (): void => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    const result = await executeCommand(command, api, {
      signal: controller.signal,
      onProgress(run) {
        process.stderr.write(
          `${JSON.stringify({ runId: run.id, executionStatus: run.executionStatus, results: run.results.length })}\n`,
        );
      },
    });
    process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
    try {
      await writeGitHubMetadata(result, process.env);
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ warning: "github_metadata_write_failed", message: error instanceof Error ? error.message : String(error) })}\n`,
      );
    }
    process.exitCode = result.exitCode;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

main().catch((error: unknown) => {
  const result = serializeError(error);
  process.stderr.write(`${JSON.stringify(result.output, null, 2)}\n`);
  process.exitCode = result.exitCode;
});
