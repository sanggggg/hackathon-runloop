import { fetchScreenshot } from "@/lib/server/api";

/**
 * Screenshots need the bearer token too, so an <img src> cannot point at the
 * engine directly. Ids may contain slashes, hence the catch-all segment.
 */
export async function GET(_: Request, ctx: { params: Promise<{ id: string[] }> }) {
  const { id } = await ctx.params;
  const upstream = await fetchScreenshot(id.map(encodeURIComponent).join("/"));

  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/png",
      "cache-control": "private, max-age=300",
    },
  });
}
