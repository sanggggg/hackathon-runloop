/**
 * Liveness only. The root path redirects to a suite, and a 307 fails Railway's
 * healthcheck, so the probe needs somewhere that always answers 200. It
 * deliberately does not touch the engine: this says the dashboard is up, not
 * that the API behind it is.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
