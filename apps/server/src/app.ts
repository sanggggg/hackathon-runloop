import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LocalArtifactStore } from "@branchpoint/engine";
import { HttpError } from "./errors.js";
import { openApiDocument } from "./openapi.js";
import type { RunService, ServiceLogger } from "./run-service.js";
import { parseStartRun } from "./validation.js";

export interface AppOptions {
  service: RunService;
  artifactStore: LocalArtifactStore;
  apiToken?: string;
  corsOrigins?: ReadonlySet<string>;
  maxBodyBytes?: number;
  logger?: ServiceLogger;
}

const quietLogger: ServiceLogger = {
  info() {},
  error() {},
};

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const contents = Buffer.from(`${JSON.stringify(body)}\n`);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", contents.byteLength);
  response.end(contents);
}

function decodeSegment(value: string, name: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) throw new Error("empty");
    return decoded;
  } catch (error) {
    throw new HttpError(400, "invalid_path", `${name} is not valid URL-encoded text`);
  }
}

function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const lengthHeader = request.headers["content-length"];
  if (lengthHeader !== undefined) {
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0) {
      throw new HttpError(400, "invalid_content_length", "content-length must be a non-negative integer");
    }
    if (length > maxBodyBytes) {
      throw new HttpError(413, "body_too_large", `request body exceeds ${maxBodyBytes} bytes`);
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) {
    throw new HttpError(413, "body_too_large", `request body exceeds ${maxBodyBytes} bytes`);
  }
  if (chunks.length === 0) return undefined;

  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new HttpError(415, "unsupported_media_type", "content-type must be application/json");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin?.replace(/\/$/, "");
  if (!origin) return true;
  response.setHeader("vary", "Origin");
  if (!allowedOrigins.has(origin)) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-max-age", "600");
  return true;
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function createRequestHandler(options: AppOptions) {
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  const corsOrigins = options.corsOrigins ?? new Set<string>();
  const logger = options.logger ?? quietLogger;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    let status = 500;
    response.setHeader("x-request-id", requestId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");

    try {
      const url = new URL(request.url ?? "/", "http://branchpoint.local");
      const pathname = normalizePath(url.pathname);
      const method = request.method ?? "GET";
      const corsAllowed = applyCors(request, response, corsOrigins);
      if (method === "OPTIONS") {
        if (!corsAllowed) {
          throw new HttpError(403, "origin_not_allowed", "request origin is not allowed");
        }
        status = 204;
        response.statusCode = status;
        response.end();
        return;
      }
      if (!corsAllowed) {
        throw new HttpError(403, "origin_not_allowed", "request origin is not allowed");
      }

      if (method === "GET" && pathname === "/") {
        status = 200;
        writeJson(response, status, {
          name: "branchpoint-server",
          status: "ok",
          health: "/healthz",
          readiness: "/readyz",
          openapi: "/openapi.json",
        });
        return;
      }
      if (method === "GET" && pathname === "/healthz") {
        status = 200;
        writeJson(response, status, { status: "ok" });
        return;
      }
      if (method === "GET" && pathname === "/readyz") {
        status = options.service.ready ? 200 : 503;
        writeJson(response, status, {
          status: options.service.ready ? "ready" : "not_ready",
          engine: options.service.ready ? "configured" : "unavailable_or_draining",
        });
        return;
      }
      if (method === "GET" && pathname === "/openapi.json") {
        status = 200;
        writeJson(response, status, openApiDocument);
        return;
      }

      if (!authorized(request.headers.authorization, options.apiToken)) {
        response.setHeader("www-authenticate", 'Bearer realm="branchpoint"');
        throw new HttpError(401, "unauthorized", "a valid bearer token is required");
      }

      if (method === "GET" && pathname === "/suites") {
        status = 200;
        writeJson(response, status, await options.service.listSuites());
        return;
      }
      if (method === "POST" && pathname === "/suites") {
        status = 201;
        writeJson(response, status, await options.service.createSuite(await readJson(request, maxBodyBytes)));
        return;
      }

      const suiteMatch = /^\/suites\/([^/]+)$/.exec(pathname);
      if (suiteMatch && method === "GET") {
        status = 200;
        writeJson(response, status, await options.service.getSuite(decodeSegment(suiteMatch[1], "suiteId")));
        return;
      }
      if (suiteMatch && method === "PATCH") {
        status = 200;
        writeJson(
          response,
          status,
          await options.service.updateTree(
            decodeSegment(suiteMatch[1], "suiteId"),
            await readJson(request, maxBodyBytes),
          ),
        );
        return;
      }

      if (method === "GET" && pathname === "/runs") {
        const suiteId = url.searchParams.get("suiteId")?.trim() || undefined;
        status = 200;
        writeJson(response, status, await options.service.listRuns(suiteId));
        return;
      }
      if (method === "POST" && pathname === "/runs") {
        const body = parseStartRun(await readJson(request, maxBodyBytes));
        status = 202;
        writeJson(response, status, await options.service.startRun(body.suiteId, body.ref));
        return;
      }

      const cancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(pathname);
      if (cancelMatch && method === "POST") {
        status = 202;
        writeJson(response, status, await options.service.cancelRun(decodeSegment(cancelMatch[1], "runId")));
        return;
      }
      const runMatch = /^\/runs\/([^/]+)$/.exec(pathname);
      if (runMatch && method === "GET") {
        status = 200;
        writeJson(response, status, await options.service.getRun(decodeSegment(runMatch[1], "runId")));
        return;
      }

      if (method === "GET" && pathname.startsWith("/screenshots/")) {
        const encodedId = pathname.slice("/screenshots/".length);
        const id = decodeSegment(encodedId, "screenshotId");
        let filename: string;
        try {
          filename = options.artifactStore.resolveScreenshot(id);
        } catch (error) {
          throw new HttpError(400, "invalid_screenshot_id", "screenshot id is invalid");
        }
        try {
          const [contents, file] = await Promise.all([readFile(filename), stat(filename)]);
          status = 200;
          response.statusCode = status;
          response.setHeader("content-type", "image/png");
          response.setHeader("content-length", file.size);
          response.setHeader("cache-control", "private, max-age=31536000, immutable");
          response.end(contents);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new HttpError(404, "screenshot_not_found", `screenshot '${id}' does not exist`);
          }
          throw error;
        }
      }

      throw new HttpError(404, "route_not_found", `no route for ${method} ${pathname}`);
    } catch (error) {
      const httpError =
        error instanceof HttpError
          ? error
          : new HttpError(500, "internal_error", "the server could not complete the request");
      status = httpError.status;
      if (!response.headersSent) {
        writeJson(response, status, {
          error: httpError.message,
          code: httpError.code,
          ...(httpError.details ? { details: httpError.details } : {}),
          requestId,
        });
      } else {
        response.destroy();
      }
      if (!(error instanceof HttpError) || status >= 500) {
        logger.error("http_request_failed", error, {
          requestId,
          method: request.method,
          path: request.url,
          status,
        });
      }
    } finally {
      logger.info("http_request", {
        requestId,
        method: request.method,
        path: request.url,
        status,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  };
}

export function createBranchpointHttpServer(options: AppOptions): Server {
  const handler = createRequestHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
