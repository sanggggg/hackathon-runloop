import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@branchpoint/schema"],
  // Several lockfiles exist while worktrees are in play; pin the root so Next
  // does not guess a different one on each machine.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
};

export default config;
