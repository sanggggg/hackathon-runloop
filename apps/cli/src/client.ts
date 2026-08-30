import type { Run, Suite } from "@branchpoint/schema";
import { ApiError, RemoteError } from "./errors.js";

type Fetch = typeof globalThis.fetch;
type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface StartRunInput {
  suiteId: string;
  ref?: string;
}

export interface BranchpointApi {
  startRun(input: StartRunInput, signal?: AbortSignal): Promise<{ runId: string }>;
  getRun(runId: string, signal?: AbortSignal): Promise<Run>;
  listRuns(suiteId?: string, signal?: AbortSignal): Promise<Run[]>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<Run>;
  listSuites(signal?: AbortSignal): Promise<Suite[]>;
  getSuite(suiteId: string, signal?: AbortSignal): Promise<Suite>;
  createSuite(suite: unknown, signal?: AbortSignal): Promise<Suite>;
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: Fetch;
  sleep?: Sleep;
  maxGetAttempts?: number;
  requestTimeoutMs?: number;
}

interface ApiErrorBody {
  error?: unknown;
  code?: unknown;
  requestId?: unknown;
  details?: unknown;
}

const EXECUTION_STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
]);

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (sanitized, secret) => (secret ? sanitized.replaceAll(secret, "[REDACTED]") : sanitized),
    value,
  );
}

function normalizeSecrets(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => right.length - left.length);
}

function requireRun(value: unknown): Run {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !EXECUTION_STATUSES.has(String(value.executionStatus)) ||
    !Array.isArray(value.results)
  ) {
    throw new RemoteError("the server returned an invalid Run document", "invalid_api_response");
  }
  for (const result of value.results) {
    if (
      !isRecord(result) ||
      typeof result.nodeId !== "string" ||
      (result.status !== "pass" && result.status !== "fail") ||
      (result.status === "pass" && result.failReason !== undefined) ||
      (result.status === "fail" &&
        result.failReason !== "unresolved" &&
        result.failReason !== "error-screen" &&
        result.failReason !== "timeout")
    ) {
      throw new RemoteError("the server returned an invalid NodeResult document", "invalid_api_response");
    }
  }
  return value as unknown as Run;
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after")?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 5_000);
  }
  return 250 * 2 ** (attempt - 1);
}

function requireSuite(value: unknown): Suite {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.tree)) {
    throw new RemoteError("the server returned an invalid Suite document", "invalid_api_response");
  }
  return value as unknown as Suite;
}

export class ApiClient implements BranchpointApi {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #sleep: Sleep;
  readonly #maxGetAttempts: number;
  readonly #requestTimeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#maxGetAttempts = options.maxGetAttempts ?? 3;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.#maxGetAttempts) || this.#maxGetAttempts < 1) {
      throw new Error("maxGetAttempts must be a positive integer");
    }
    if (!Number.isInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
  }

  async startRun(input: StartRunInput, signal?: AbortSignal): Promise<{ runId: string }> {
    const value = await this.#request("POST", "/runs", input, signal);
    if (!isRecord(value) || typeof value.runId !== "string" || !value.runId) {
      throw new RemoteError("the server did not return a runId", "invalid_api_response");
    }
    return { runId: value.runId };
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<Run> {
    return requireRun(await this.#request("GET", `/runs/${encodeURIComponent(runId)}`, undefined, signal));
  }

  async listRuns(suiteId?: string, signal?: AbortSignal): Promise<Run[]> {
    const query = suiteId ? `?suiteId=${encodeURIComponent(suiteId)}` : "";
    const value = await this.#request("GET", `/runs${query}`, undefined, signal);
    if (!Array.isArray(value)) {
      throw new RemoteError("the server returned an invalid Run list", "invalid_api_response");
    }
    return value.map(requireRun);
  }

  async cancelRun(runId: string, signal?: AbortSignal): Promise<Run> {
    return requireRun(
      await this.#request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, undefined, signal),
    );
  }

  async listSuites(signal?: AbortSignal): Promise<Suite[]> {
    const value = await this.#request("GET", "/suites", undefined, signal);
    if (!Array.isArray(value)) {
      throw new RemoteError("the server returned an invalid Suite list", "invalid_api_response");
    }
    return value.map(requireSuite);
  }

  async getSuite(suiteId: string, signal?: AbortSignal): Promise<Suite> {
    return requireSuite(
      await this.#request("GET", `/suites/${encodeURIComponent(suiteId)}`, undefined, signal),
    );
  }

  async createSuite(suite: unknown, signal?: AbortSignal): Promise<Suite> {
    return requireSuite(await this.#request("POST", "/suites", suite, signal));
  }

  async #request(
    method: "GET" | "POST",
    pathname: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempts = method === "GET" ? this.#maxGetAttempts : 1;
    const secrets = normalizeSecrets([this.#token]);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason;
      const requestTimeout = AbortSignal.timeout(this.#requestTimeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout;
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${pathname}`, {
          method,
          signal: requestSignal,
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt < attempts) {
          await this.#sleep(250 * 2 ** (attempt - 1), signal);
          continue;
        }
        throw new RemoteError(
          requestTimeout.aborted
            ? "the Branchpoint API request timed out"
            : "could not reach the Branchpoint API",
          requestTimeout.aborted ? "request_timeout" : "network_error",
          {
            cause: error,
          },
        );
      }

      if (
        method === "GET" &&
        (response.status === 429 || response.status >= 500) &&
        attempt < attempts
      ) {
        try {
          await response.arrayBuffer();
        } catch {
          if (signal?.aborted) throw signal.reason;
        }
        await this.#sleep(retryDelay(response, attempt), signal);
        continue;
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (method === "GET" && attempt < attempts) {
          await this.#sleep(250 * 2 ** (attempt - 1), signal);
          continue;
        }
        throw new RemoteError(
          requestTimeout.aborted
            ? "the Branchpoint API response timed out"
            : "could not read the Branchpoint API response",
          requestTimeout.aborted ? "request_timeout" : "network_error",
          { cause: error },
        );
      }
      let value: unknown;
      try {
        value = text ? (JSON.parse(text) as unknown) : undefined;
      } catch (error) {
        throw new RemoteError(
          `the Branchpoint API returned non-JSON data (HTTP ${response.status})`,
          "invalid_api_response",
          { cause: error },
        );
      }
      if (!response.ok) {
        const errorBody = isRecord(value) ? (value as ApiErrorBody) : {};
        throw new ApiError(
          response.status,
          typeof errorBody.code === "string" ? redact(errorBody.code, secrets) : "api_error",
          typeof errorBody.error === "string"
            ? redact(errorBody.error, secrets)
            : `the Branchpoint API returned HTTP ${response.status}`,
          {
            ...(typeof errorBody.requestId === "string"
              ? { requestId: redact(errorBody.requestId, secrets) }
              : {}),
            ...(Array.isArray(errorBody.details) && errorBody.details.every((item) => typeof item === "string")
              ? { details: (errorBody.details as string[]).map((item) => redact(item, secrets)) }
              : {}),
          },
        );
      }
      return value;
    }
    throw new RemoteError("the Branchpoint API request did not complete", "network_error");
  }
}
