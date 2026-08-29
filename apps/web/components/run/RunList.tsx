"use client";

import Image from "next/image";
import { runHistory, suite } from "@/lib/fixtures";

export function RunList({ activeId }: { activeId: string }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-kumo-hairline bg-kumo-base">
      <h2 className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
        Runs
      </h2>

      <ul className="flex flex-col gap-0.5 px-2">
        {runHistory.map((r) => {
          const active = r.id === activeId;
          return (
            <li key={r.id}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                className={`w-full rounded-md px-2.5 py-2 text-left transition hover:bg-kumo-recessed
                  focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus
                  ${active ? "border border-kumo-hairline bg-kumo-recessed" : "border border-transparent"}`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      r.status === "ok" ? "bg-kumo-success" : "bg-kumo-warning"
                    }`}
                  />
                  <span
                    className={`text-[13px] font-medium ${active ? "text-kumo-strong" : "text-kumo-subtle"}`}
                  >
                    {r.id.replace("-", " ")}
                  </span>
                </span>
                <span className="mt-0.5 block pl-3.5 text-xs text-kumo-placeholder">
                  <code className="font-mono">{r.ref}</code> · {r.when} · {r.clean}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex-1" />

      <div className="m-2.5 rounded-lg border border-kumo-hairline bg-kumo-recessed p-2.5">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-kumo-placeholder">
          Fixture
        </h3>
        <div className="h-[68px] overflow-hidden rounded-md border border-kumo-hairline">
          <Image
            src="/shots/root.png"
            alt="The screen every branch starts from"
            width={264}
            height={165}
            className="h-full w-full object-cover object-top"
          />
        </div>
        <code className="mt-2 block font-mono text-[11px] text-kumo-subtle">
          {suite.fixture.snapshotId}…
        </code>
        <p className="mt-2 border-t border-kumo-hairline pt-2 text-xs leading-normal text-kumo-subtle">
          Every branch forks from here instead of signing in again.
        </p>
      </div>
    </aside>
  );
}
