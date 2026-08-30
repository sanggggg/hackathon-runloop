import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiError, listSuites } from "@/lib/server/api";
import { EngineDown } from "@/components/EngineDown";

export const dynamic = "force-dynamic";

export default async function Home() {
  let suites;
  try {
    suites = await listSuites();
  } catch (err) {
    return <EngineDown message={err instanceof ApiError ? err.message : "Unexpected error"} />;
  }

  if (suites.length === 1) redirect(`/suites/${suites[0].id}/build`);

  if (suites.length === 0) {
    return (
      <main className="flex h-screen items-center justify-center p-6">
        <div className="max-w-lg text-center">
          <h1 className="text-xl font-semibold text-kumo-strong">No suites registered</h1>
          <p className="mt-2 text-[13px] leading-normal text-kumo-subtle">
            A suite is a repository plus the tree of flows to check. Register one against the
            engine, then it shows up here.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-recessed p-3 text-left font-mono text-[11px] text-kumo-subtle">
{`curl "$BRANCHPOINT_API_URL/suites" \\
  -H "Authorization: Bearer $BRANCHPOINT_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary @packages/engine/examples/nimbus-suite.json`}
          </pre>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-10">
      <h1 className="text-xl font-semibold text-kumo-strong">Suites</h1>
      <ul className="mt-4 flex flex-col gap-2">
        {suites.map((s) => (
          <li key={s.id}>
            <Link
              href={`/suites/${s.id}/build`}
              className="flex items-center justify-between rounded-lg border border-kumo-hairline bg-kumo-base px-4 py-3 transition hover:border-kumo-placeholder"
            >
              <span className="text-[15px] font-medium text-kumo-strong">{s.name}</span>
              <span className="font-mono text-xs text-kumo-placeholder">
                {s.repo.url.replace(/^https?:\/\/github\.com\//, "")} · {s.tree.length} steps
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
