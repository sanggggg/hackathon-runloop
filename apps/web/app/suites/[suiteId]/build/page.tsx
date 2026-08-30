import { getSuite } from "@/lib/server/api";
import { BuildView } from "@/components/build/BuildView";

export const dynamic = "force-dynamic";

export default async function BuildPage({ params }: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await params;
  const suite = await getSuite(suiteId);
  return <BuildView suite={suite} />;
}
