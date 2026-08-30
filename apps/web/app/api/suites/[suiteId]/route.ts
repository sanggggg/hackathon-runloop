import { NextResponse } from "next/server";
import type { Suite } from "@branchpoint/schema";
import { getSuite, updateTree } from "@/lib/server/api";
import { toResponse } from "@/lib/server/respond";

export async function GET(_: Request, ctx: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await ctx.params;
  try {
    return NextResponse.json(await getSuite(suiteId));
  } catch (err) {
    return toResponse(err);
  }
}

export async function PATCH(request: Request, ctx: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await ctx.params;
  try {
    const body = (await request.json()) as { tree?: Suite["tree"] };
    if (!body.tree) return NextResponse.json({ error: "tree is required" }, { status: 400 });
    return NextResponse.json(await updateTree(suiteId, body.tree));
  } catch (err) {
    return toResponse(err);
  }
}
