#!/usr/bin/env node

import { once } from "node:events";
import { createBranchpointHttpServer } from "./app.js";
import { loadConfig } from "./config.js";
import { createRunExecutor } from "./engine-executor.js";
import { RunService, type ServiceLogger } from "./run-service.js";
import { JsonFileStore } from "./store.js";

const logger: ServiceLogger = {
  info(event, fields = {}) {
    process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`);
  },
  error(event, error, fields = {}) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        event,
        ...fields,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      })}\n`,
    );
  },
};

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new JsonFileStore(config.databasePath);
  const { executor, artifactStore } = await createRunExecutor(config);
  const service = new RunService({
    store,
    executor,
    maxActiveRuns: config.maxActiveRuns,
    logger,
  });
  await service.initialize();

  const server = createBranchpointHttpServer({
    service,
    artifactStore,
    ...(config.apiToken ? { apiToken: config.apiToken } : {}),
    corsOrigins: config.corsOrigins,
    maxBodyBytes: config.maxBodyBytes,
    logger,
  });

  server.listen(config.port, config.host);
  await once(server, "listening");
  logger.info("server_started", {
    host: config.host,
    port: config.port,
    dataDirectory: config.dataDirectory,
    authentication: config.apiToken ? "bearer" : "disabled",
    engine: executor.configured ? "configured" : "missing_RUNLOOP_API_KEY",
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.error("forced_shutdown", new Error(`received ${signal} twice`));
      process.exit(signal === "SIGINT" ? 130 : 1);
    }
    shuttingDown = true;
    logger.info("server_draining", { signal, activeRuns: service.activeRunCount });
    server.close();
    server.closeIdleConnections();

    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), config.shutdownTimeoutMs);
      timeout.unref();
    });
    const stopped = service.shutdown().then(() => "stopped" as const);
    const outcome = await Promise.race([stopped, timedOut]);
    if (timeout) clearTimeout(timeout);

    if (outcome === "timeout") {
      logger.error(
        "shutdown_timeout",
        new Error(`engine cleanup exceeded ${config.shutdownTimeoutMs}ms`),
        { activeRuns: service.activeRunCount },
      );
      server.closeAllConnections();
      process.exitCode = 1;
      return;
    }
    logger.info("server_stopped", { signal });
    if (signal === "SIGINT") process.exitCode = 130;
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch((error: unknown) => {
      logger.error("shutdown_failed", error, { signal });
      server.closeAllConnections();
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.error("server_start_failed", error);
  process.exitCode = 1;
});
