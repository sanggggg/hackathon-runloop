import { getSuite, listRuns } from "@/lib/server/api";
import { RunView } from "@/components/run/RunView";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await params;
  const [suite, runs] = await Promise.all([getSuite(suiteId), listRuns(suiteId)]);
  return <RunView suite={suite} initialRuns={runs} />;
}
