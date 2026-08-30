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
  } catch {
    throw new Error(`cannot reach ${c.baseUrl} — is BRANCHPOINT_API_URL right?`);
  }

  if (res.status === 401) {
    throw new Error("the server rejected the token. Check BRANCHPOINT_API_TOKEN.");
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let message = raw.slice(0, 300);
    try {
      message = (JSON.parse(raw) as { error?: string }).error ?? message;
    } catch {
      /* not json */
    }
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${message}`);
  }
  return (await res.json()) as T;
}

export const listSuites = (c: Client) => call<Suite[]>(c, "/suites");

export const getSuite = (c: Client, id: string) =>
  call<Suite>(c, `/suites/${encodeURIComponent(id)}`);

/** The server takes a whole prepared Suite document, fixture snapshot and all. */
export const registerSuite = (c: Client, suite: unknown) =>
  call<Suite>(c, "/suites", { method: "POST", body: JSON.stringify(suite) });

export const updateTree = (c: Client, id: string, tree: Node[]) =>
  call<Suite>(c, `/suites/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ tree }),
  });

export const listRuns = (c: Client, suiteId?: string) =>
  call<Run[]>(c, `/runs${suiteId ? `?suiteId=${encodeURIComponent(suiteId)}` : ""}`);

export const getRun = (c: Client, id: string) => call<Run>(c, `/runs/${encodeURIComponent(id)}`);

/** Answers 202 with the id only; the run itself is polled afterwards. */
export const startRun = (c: Client, body: { suiteId: string; ref?: string }) =>
  call<{ runId: string }>(c, "/runs", { method: "POST", body: JSON.stringify(body) });

export const cancelRun = (c: Client, id: string) =>
  call<Run>(c, `/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });

const IN_FLIGHT = new Set(["queued", "running", "cancelling"]);
export const isLive = (run: Run) => IN_FLIGHT.has(run.executionStatus ?? "succeeded");

export async function waitForRun(
  c: Client,
  runId: string,
  timeoutMs: number,
  onTick?: (run: Run) => void,
): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(c, runId);
    onTick?.(run);
    if (!isLive(run)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish within the timeout`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
