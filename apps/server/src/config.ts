import path from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  artifactDirectory: string;
  apiToken?: string;
  corsOrigins: ReadonlySet<string>;
  maxBodyBytes: number;
  maxActiveRuns: number;
  shutdownTimeoutMs: number;
  runloopApiKey?: string;
  runloopApiUrl?: string;
  maxDevboxConcurrency: number;
  workDir: string;
  agentCommand: string;
  targetHealthPath: string;
  openrouterModel?: string;
  openrouterSecret?: string;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function optionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseOrigins(value: string | undefined, production: boolean): ReadonlySet<string> {
  const defaults = production
    ? []
    : ["http://localhost:3000", "http://127.0.0.1:3000"];
  const origins = (value ? value.split(",") : defaults)
    .map((entry) => entry.trim().replace(/\/$/, ""))
    .filter(Boolean);
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch (error) {
      throw new Error(`BRANCHPOINT_CORS_ORIGINS contains invalid origin '${origin}'`, {
        cause: error,
      });
    }
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`BRANCHPOINT_CORS_ORIGINS must contain bare http(s) origins: '${origin}'`);
    }
  }
  return new Set(origins);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): ServerConfig {
  const production = env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT);
  const dataDirectory = path.resolve(
    workingDirectory,
    optionalString(env, "BRANCHPOINT_DATA_DIR") ?? ".branchpoint-data",
  );
  const apiToken = optionalString(env, "BRANCHPOINT_API_TOKEN") ?? optionalString(env, "BRANCHPOINT_TOKEN");
  const allowInsecure = env.BRANCHPOINT_ALLOW_INSECURE === "true";
  if (production && !apiToken && !allowInsecure) {
    throw new Error(
      "BRANCHPOINT_API_TOKEN is required in production (set BRANCHPOINT_ALLOW_INSECURE=true only for an intentionally public server)",
    );
  }

  const openrouterModel = optionalString(env, "BRANCHPOINT_OPENROUTER_MODEL");
  const openrouterSecret = optionalString(env, "BRANCHPOINT_OPENROUTER_SECRET");
  if (Boolean(openrouterModel) !== Boolean(openrouterSecret)) {
    throw new Error(
      "BRANCHPOINT_OPENROUTER_MODEL and BRANCHPOINT_OPENROUTER_SECRET must be configured together",
    );
  }

  const targetHealthPath = optionalString(env, "BRANCHPOINT_HEALTH_PATH") ?? "/";
  if (!targetHealthPath.startsWith("/") || /[\0\r\n]/.test(targetHealthPath)) {
    throw new Error("BRANCHPOINT_HEALTH_PATH must begin with '/' and contain no control characters");
  }

  return {
    host: optionalString(env, "HOST") ?? "0.0.0.0",
    port: positiveInteger(env, "PORT", 4000, 65_535),
    dataDirectory,
    databasePath: path.join(dataDirectory, "server.json"),
    artifactDirectory: path.join(dataDirectory, "artifacts"),
    ...(apiToken ? { apiToken } : {}),
    corsOrigins: parseOrigins(env.BRANCHPOINT_CORS_ORIGINS, production),
    maxBodyBytes: positiveInteger(env, "BRANCHPOINT_MAX_BODY_BYTES", 1_048_576, 10_485_760),
    maxActiveRuns: positiveInteger(env, "BRANCHPOINT_MAX_ACTIVE_RUNS", 1, 32),
    shutdownTimeoutMs: positiveInteger(env, "BRANCHPOINT_SHUTDOWN_TIMEOUT_MS", 170_000, 300_000),
    ...(optionalString(env, "RUNLOOP_API_KEY")
      ? { runloopApiKey: optionalString(env, "RUNLOOP_API_KEY") }
      : {}),
    ...(optionalString(env, "RUNLOOP_API_URL")
      ? { runloopApiUrl: optionalString(env, "RUNLOOP_API_URL") }
      : {}),
    maxDevboxConcurrency: positiveInteger(env, "BRANCHPOINT_MAX_CONCURRENCY", 8, 128),
    workDir: optionalString(env, "BRANCHPOINT_WORK_DIR") ?? "/home/user/workspace",
    agentCommand:
      optionalString(env, "BRANCHPOINT_AGENT_COMMAND") ?? "python3 .branchpoint/browser-agent.py",
    targetHealthPath,
    ...(openrouterModel ? { openrouterModel } : {}),
    ...(openrouterSecret ? { openrouterSecret } : {}),
  };
}
