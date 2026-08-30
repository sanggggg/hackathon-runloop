import { NextResponse } from "next/server";
import { getRun } from "@/lib/server/api";
import { toResponse } from "@/lib/server/respond";

export async function GET(_: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  try {
    return NextResponse.json(await getRun(runId));
  } catch (err) {
    return toResponse(err);
  }
}
