export function EngineDown({ message }: { message: string }) {
  return (
    <main className="flex h-screen items-center justify-center p-6">
      <div className="max-w-lg">
        <h1 className="text-xl font-semibold text-kumo-danger">The engine is not answering</h1>
        <p className="mt-2 text-[13px] leading-normal text-kumo-subtle">{message}</p>
        <p className="mt-4 text-[13px] leading-normal text-kumo-subtle">
          Start it locally, or point <code className="font-mono text-xs">BRANCHPOINT_API_URL</code>{" "}
          at the deployed one and set{" "}
          <code className="font-mono text-xs">BRANCHPOINT_API_TOKEN</code>.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-kumo-hairline bg-kumo-recessed p-3 font-mono text-[11px] text-kumo-subtle">
{`pnpm --filter @branchpoint/engine build
pnpm --filter @branchpoint/server build
node --env-file-if-exists=apps/server/.env apps/server/dist/src/index.js`}
        </pre>
      </div>
    </main>
  );
}
