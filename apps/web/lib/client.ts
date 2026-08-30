import type { Run, Suite } from "@branchpoint/schema";

/**
 * Browser-side calls go to this app's own route handlers, never to the engine,
 * so the shared API token stays on the server.
 */
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? res.statusText);
  return body as T;
}

export const fetchRuns = (suiteId: string) =>
  json<Run[]>(`/api/runs?suiteId=${encodeURIComponent(suiteId)}`);

export const fetchRun = (runId: string) => json<Run>(`/api/runs/${encodeURIComponent(runId)}`);

export const startRun = (suiteId: string, ref?: string) =>
  json<{ runId: string }>("/api/runs", {
    method: "POST",
    body: JSON.stringify({ suiteId, ref }),
  });

export const cancelRun = (runId: string) =>
  json<Run>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });

export const saveTree = (suiteId: string, tree: Suite["tree"]) =>
  json<Suite>(`/api/suites/${encodeURIComponent(suiteId)}`, {
    method: "PATCH",
    body: JSON.stringify({ tree }),
  });

/** Screenshots are proxied too, since the engine requires the token for them. */
export const shotUrl = (screenshotId: string) => `/shot/${screenshotId}`;
