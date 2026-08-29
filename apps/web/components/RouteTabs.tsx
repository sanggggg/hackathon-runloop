"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ROUTES = [
  { slug: "build", label: "Build" },
  { slug: "run", label: "Run" },
] as const;

/**
 * The two routes are the product's spine: Build is written, Run is executed.
 * Screenshots only ever exist on the Run side.
 */
export function RouteTabs({ suiteId }: { suiteId: string }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Suite routes"
      className="flex items-center gap-1 rounded-lg border border-kumo-hairline bg-kumo-recessed p-[3px]"
    >
      {ROUTES.map((r) => {
        const href = `/suites/${suiteId}/${r.slug}`;
        const active = pathname === href;
        return (
          <Link
            key={r.slug}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1 text-[13px] transition focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-kumo-focus ${
                active
                  ? "bg-kumo-base font-medium text-kumo-strong shadow-sm"
                  : "text-kumo-placeholder hover:text-kumo-default"
              }`}
          >
            {r.label}
          </Link>
        );
      })}
    </nav>
  );
}
