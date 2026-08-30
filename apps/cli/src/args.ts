import { UsageError } from "./errors.js";

export const DEFAULT_API_URL = "https://branchpoint-server-production.up.railway.app";
export const DEFAULT_POLL_INTERVAL_SECONDS = 2;
export const DEFAULT_TIMEOUT_SECONDS = 1_800;

export type Command =
  | {
      kind: "run";
      suiteId: string;
      ref?: string;
      detach: boolean;
      pollIntervalMs: number;
      timeoutMs: number;
    }
  | { kind: "runs-list"; suiteId?: string }
  | { kind: "runs-get"; runId: string }
  | { kind: "runs-cancel"; runId: string }
  | { kind: "suites-list" }
  | { kind: "suites-get"; suiteId: string }
  | { kind: "suites-push"; filename: string }
  | { kind: "help" };

export interface CliConfig {
  apiUrl: string;
  apiToken: string;
}

export function usage(): string {
  return `Usage:
  branchpoint run --suite <suite-id> [--ref <git-ref>] [--detach] [options]
  branchpoint runs [list] [--suite <suite-id>]
  branchpoint runs get <run-id>
  branchpoint runs cancel <run-id>
  branchpoint suites [list]
  branchpoint suites get <suite-id>
  branchpoint suites push --file <suite.json>

Run options:
  --poll-interval <seconds>  Poll interval (default: ${DEFAULT_POLL_INTERVAL_SECONDS})
  --timeout <seconds>        Maximum wait including queue time (default: ${DEFAULT_TIMEOUT_SECONDS})
  --detach                   Return after the server accepts the run
  --help                     Show this help

All command output is JSON. Authentication is accepted only from the environment:
  BRANCHPOINT_API_TOKEN      Required shared server Bearer token
  BRANCHPOINT_API_URL        Optional server URL (default: ${DEFAULT_API_URL})
`;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${flag} requires a value`);
  return value;
}

function positiveSeconds(flag: string, value: string): number {
  const parsed = Number(value);
  const milliseconds = Math.ceil(parsed * 1_000);
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > 2_147_483_647
  ) {
    throw new UsageError(`${flag} requires a positive number of seconds`);
  }
  return milliseconds;
}

function parseRun(args: string[]): Command {
  let suiteId: string | undefined;
  let ref: string | undefined;
  let detach = false;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_SECONDS * 1_000;
  let timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1_000;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--detach") {
      if (seen.has(flag)) throw new UsageError(`${flag} may be provided only once`);
      seen.add(flag);
      detach = true;
      continue;
    }
    if (!["--suite", "--ref", "--poll-interval", "--timeout"].includes(flag)) {
      throw new UsageError(`unknown run option '${flag}'`);
    }
    if (seen.has(flag)) throw new UsageError(`${flag} may be provided only once`);
    seen.add(flag);
    const value = requireValue(args, index, flag);
    index += 1;
    if (flag === "--suite") suiteId = value.trim();
    if (flag === "--ref") ref = value.trim();
    if (flag === "--poll-interval") pollIntervalMs = positiveSeconds(flag, value);
    if (flag === "--timeout") timeoutMs = positiveSeconds(flag, value);
  }

  if (!suiteId) throw new UsageError("--suite is required");
  if (ref !== undefined && !ref) throw new UsageError("--ref must not be empty");
  return {
    kind: "run",
    suiteId,
    ...(ref ? { ref } : {}),
    detach,
    pollIntervalMs,
    timeoutMs,
  };
}

function expectSingleId(args: string[], label: string): string {
  if (args.length !== 1 || !args[0]?.trim()) {
    throw new UsageError(`${label} requires exactly one id`);
  }
  return args[0].trim();
}

function parseRuns(args: string[]): Command {
  const operation = args[0];
  if (operation === "get") return { kind: "runs-get", runId: expectSingleId(args.slice(1), "runs get") };
  if (operation === "cancel") {
    return { kind: "runs-cancel", runId: expectSingleId(args.slice(1), "runs cancel") };
  }
  const listArgs = operation === "list" ? args.slice(1) : args;
  if (listArgs.length === 0) return { kind: "runs-list" };
  if (listArgs.length === 2 && listArgs[0] === "--suite" && listArgs[1]?.trim()) {
    return { kind: "runs-list", suiteId: listArgs[1].trim() };
  }
  throw new UsageError("runs accepts list [--suite <suite-id>], get <run-id>, or cancel <run-id>");
}

function parseSuites(args: string[]): Command {
  const operation = args[0];
  if (operation === undefined || (operation === "list" && args.length === 1)) {
    return { kind: "suites-list" };
  }
  if (operation === "get") {
    return { kind: "suites-get", suiteId: expectSingleId(args.slice(1), "suites get") };
  }
  if (operation === "push" && args.length === 3 && args[1] === "--file" && args[2]?.trim()) {
    return { kind: "suites-push", filename: args[2] };
  }
  throw new UsageError("suites accepts list, get <suite-id>, or push --file <suite.json>");
}

export function parseArgs(args: string[]): Command {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { kind: "help" };
  const [command, ...rest] = args;
  if (command === "run") return parseRun(rest);
  if (command === "runs") return parseRuns(rest);
  if (command === "suites") return parseSuites(rest);
  throw new UsageError(`unknown command '${command}'`);
}

export function loadConfig(env: NodeJS.ProcessEnv): CliConfig {
  const apiToken = env.BRANCHPOINT_API_TOKEN?.trim();
  if (!apiToken) {
    throw new UsageError("BRANCHPOINT_API_TOKEN is required", "missing_api_token");
  }
  const rawUrl = env.BRANCHPOINT_API_URL?.trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new UsageError("BRANCHPOINT_API_URL must be an absolute http(s) URL", "invalid_api_url", {
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("BRANCHPOINT_API_URL must be an absolute http(s) URL", "invalid_api_url");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UsageError(
      "BRANCHPOINT_API_URL must not contain credentials, query parameters, or a fragment",
      "invalid_api_url",
    );
  }
  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !localHost) {
    throw new UsageError(
      "BRANCHPOINT_API_URL must use HTTPS except for localhost and loopback addresses",
      "insecure_api_url",
    );
  }
  return {
    apiUrl: url.toString().replace(/\/$/, ""),
    apiToken,
  };
}
