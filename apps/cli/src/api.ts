import type { Node, Run, Suite } from "@branchpoint/schema";

/**
 * The whole client. Nothing is evaluated here — every command is one or two
 * HTTP calls, which is why CI needs a token and nothing else.
 */
export interface Client {
  baseUrl: string;
  token: string;
}

async function call<T>(c: Client, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${c.token}`,
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new Error(
      `cannot reach ${c.baseUrl} — is the service up? ` +
        `(start the mock with: pnpm --dir apps/mock-server dev)`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = body.slice(0, 300);
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? message;
    } catch {
      /* not json, keep the raw text */
    }
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${message}`);
  }
  return (await res.json()) as T;
}

export const listSuites = (c: Client) => call<Suite[]>(c, "/suites");

export const getSuite = (c: Client, id: string) => call<Suite>(c, `/suites/${id}`);

export const createSuite = (
  c: Client,
  body: { repo: { url: string }; describe?: string; name?: string },
) => call<Suite>(c, "/suites", { method: "POST", body: JSON.stringify(body) });

export const updateTree = (c: Client, id: string, tree: Node[]) =>
  call<Suite>(c, `/suites/${id}`, { method: "PATCH", body: JSON.stringify({ tree }) });

export const listRuns = (c: Client, suiteId?: string) =>
  call<Run[]>(c, `/runs${suiteId ? `?suiteId=${encodeURIComponent(suiteId)}` : ""}`);

export const getRun = (c: Client, id: string) => call<Run>(c, `/runs/${id}`);

export const startRun = (c: Client, body: { suiteId: string; ref?: string }) =>
  call<{ runId: string }>(c, "/runs", { method: "POST", body: JSON.stringify(body) });

export async function waitForRun(c: Client, runId: string, timeoutMs: number): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(c, runId);
    if (run.finishedAt) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish within the timeout`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
