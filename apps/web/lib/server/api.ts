import "server-only";
import type { Run, Suite } from "@branchpoint/schema";

/**
 * The only place that holds the API token.
 *
 * The engine's README is explicit that the shared bearer token must stay
 * server-side, so nothing here may be imported from a client component — the
 * `server-only` import turns that mistake into a build error rather than a
 * leaked secret.
 */
const BASE = (process.env.BRANCHPOINT_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const TOKEN = process.env.BRANCHPOINT_API_TOKEN ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(503, `Cannot reach the engine at ${BASE}.`);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let message = raw.slice(0, 300);
    try {
      message = (JSON.parse(raw) as { error?: string }).error ?? message;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, message || res.statusText);
  }
  return (await res.json()) as T;
}

export const listSuites = () => call<Suite[]>("/suites");
export const getSuite = (id: string) => call<Suite>(`/suites/${encodeURIComponent(id)}`);
export const updateTree = (id: string, tree: Suite["tree"]) =>
  call<Suite>(`/suites/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ tree }),
  });

export const listRuns = (suiteId?: string) =>
  call<Run[]>(`/runs${suiteId ? `?suiteId=${encodeURIComponent(suiteId)}` : ""}`);
export const getRun = (id: string) => call<Run>(`/runs/${encodeURIComponent(id)}`);
/** Returns only the id — the run itself is polled afterwards. */
export const startRun = (suiteId: string, ref?: string) =>
  call<{ runId: string }>("/runs", {
    method: "POST",
    body: JSON.stringify({ suiteId, ref }),
  });
export const cancelRun = (id: string) =>
  call<Run>(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });

/** Screenshots are authenticated too, so they cannot be linked directly. */
export async function fetchScreenshot(screenshotId: string): Promise<Response> {
  return fetch(`${BASE}/screenshots/${screenshotId}`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}
