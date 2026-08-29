import Link from "next/link";
import { suite } from "@/lib/fixtures";
import { RouteTabs } from "@/components/RouteTabs";

function Mark() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="4.5" r="2.3" />
      <circle cx="5" cy="19.5" r="2.3" />
      <circle cx="19" cy="19.5" r="2.3" />
      <path d="M12 6.8v4.4M12 11.2H5v6M12 11.2h7v6" />
    </svg>
  );
}

export default function SuiteLayout({ children }: { children: React.ReactNode }) {
  const repoName = new URL(suite.repo.url).pathname.slice(1);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-kumo-hairline bg-kumo-base px-4">
        <Link
          href="/"
          className="flex items-center gap-2 text-kumo-subtle hover:text-kumo-strong"
        >
          <Mark />
          <span className="text-sm font-semibold text-kumo-strong">Branchpoint</span>
        </Link>

        <span className="h-5 w-px bg-kumo-hairline" />

        <RouteTabs suiteId={suite.id} />

        <div className="flex items-center gap-2 text-[13px]">
          <span className="text-kumo-placeholder">{repoName}</span>
          <span className="text-kumo-inactive">/</span>
          <code className="font-mono text-xs text-kumo-default">{suite.repo.ref}</code>
        </div>

        <div className="flex-1" />
      </header>

      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
