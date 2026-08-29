import type { Run, Suite } from "@branchpoint/schema";
import { humanMs, tally, toLines, type Line, type Outcome } from "./lines.ts";

import { bold, blue, dim, green, red, yellow, pad, padStart } from "./color.ts";

const GLYPH: Record<Outcome, { mark: string; paint: (s: string) => string }> = {
  passed: { mark: "✔", paint: green },
  healed: { mark: "⚠", paint: yellow },
  discovered: { mark: "✚", paint: blue },
  failed: { mark: "✖", paint: red },
};

export function renderTerminal(run: Run, suite: Suite): string {
  const lines = toLines(run, suite);
  const t = tally(lines, run);
  const out: string[] = [];
  const repo = suite.repo.url.replace(/^https?:\/\/github\.com\//, "");

  const width = Math.min(46, Math.max(...lines.map((l) => l.path.length)) + 2);

  out.push("");
  out.push(`  ${bold("Branchpoint")}  ${dim(repo)}  ${bold(run.ref)}`);
  out.push("");

  for (const l of lines) {
    const g = GLYPH[l.outcome];
    out.push(
      `  ${g.paint(g.mark)}  ${pad(l.path, width)}${dim(pad(l.summary, 34))}${dim(padStart(humanMs(l.elapsedMs), 7))}`,
    );
  }

  out.push("");
  const counts = [
    green(`${t.passed} passed`),
    t.failed ? red(`${t.failed} failed`) : dim("0 failed"),
  ];
  if (t.healed) counts.push(yellow(`${t.healed} healed`));
  if (t.discovered) counts.push(blue(`${t.discovered} new`));
  out.push(`  ${counts.join(dim("   "))}`);

  const failures = lines.filter((l) => l.outcome === "failed");
  if (failures.length) {
    out.push("");
    out.push(`  ${bold("Failed paths")}`);
    for (const f of failures) {
      out.push(`    ${red(f.path)}`);
      if (f.detail) out.push(`      ${dim(f.detail)}`);
    }
  }

  out.push("");
  out.push(
    `  ${dim(
      `${humanMs(run.wallClockMs)} wall clock · ${run.results.length} branches from one snapshot · ${humanMs(
        run.sequentialEstimateMs,
      )} if run one at a time`,
    )}`,
  );
  out.push(`  ${dim(`tree v${run.treeVersion} · $${run.costUsd.toFixed(2)}`)}`);
  out.push("");

  return out.join("\n");
}

export type { Line };
