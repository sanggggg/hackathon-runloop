import { NextResponse } from "next/server";
import { listRuns, startRun } from "@/lib/server/api";
import { toResponse } from "@/lib/server/respond";

/** Proxies so the browser can poll without ever seeing the API token. */
export async function GET(request: Request) {
  const suiteId = new URL(request.url).searchParams.get("suiteId") ?? undefined;
  try {
    return NextResponse.json(await listRuns(suiteId));
  } catch (err) {
    return toResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { suiteId?: string; ref?: string };
    if (!body.suiteId) {
      return NextResponse.json({ error: "suiteId is required" }, { status: 400 });
    }
    return NextResponse.json(await startRun(body.suiteId, body.ref), { status: 202 });
  } catch (err) {
    return toResponse(err);
  }
}

