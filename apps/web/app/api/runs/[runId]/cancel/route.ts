import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/server/api";
import { toResponse } from "@/lib/server/respond";

export async function POST(_: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  try {
    return NextResponse.json(await cancelRun(runId));
  } catch (err) {
    return toResponse(err);
  }
}
