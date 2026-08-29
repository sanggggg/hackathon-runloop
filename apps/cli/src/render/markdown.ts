import type { Run, Suite } from "@branchpoint/schema";
import { humanMs, tally, toLines, type Outcome } from "./lines.ts";

const ICON: Record<Outcome, string> = {
  passed: "✅",
  healed: "⚠️",
  discovered: "🆕",
  failed: "❌",
};

/**
 * The PR comment. This is the surface most people will ever see of the product,
 * so it leads with the verdict and keeps the reasoning one fold down.
 */
export function renderMarkdown(run: Run, suite: Suite, appUrl: string): string {
  const lines = toLines(run, suite);
  const t = tally(lines, run);
  const failures = lines.filter((l) => l.outcome === "failed");
  const runUrl = `${appUrl}/suites/${suite.id}/run?run=${run.id}`;

  const verdict = t.failed
    ? `**${t.failed} path${t.failed > 1 ? "s" : ""} failed** out of ${lines.length}`
    : `**All ${lines.length} paths passed**`;

  const md: string[] = [];

  md.push(`### Branchpoint · \`${run.ref}\``);
  md.push("");
  md.push(verdict + ".");
  md.push("");

  md.push("| | Path | Result | |");
  md.push("|:--:|---|---|--:|");
  for (const l of lines) {
    md.push(`| ${ICON[l.outcome]} | ${l.path} | ${l.summary} | ${humanMs(l.elapsedMs)} |`);
  }
  md.push("");

  if (failures.length) {
    md.push("<details open>");
    md.push(`<summary><b>What broke</b></summary>`);
    md.push("");
    for (const f of failures) {
      md.push(`**${f.path}** — ${f.summary}`);
      md.push("");
      if (f.detail) {
        md.push(`> ${f.detail}`);
        md.push("");
      }
    }
    md.push("</details>");
    md.push("");
  }

  if (t.healed) {
    md.push(
      `> ${t.healed} path${t.healed > 1 ? "s" : ""} kept working through a UI change. ` +
        `A stored selector would have failed here — the intent was re-resolved against the page instead.`,
    );
    md.push("");
  }

  if (t.discovered) {
    md.push(
      `> ${t.discovered} path${t.discovered > 1 ? "s" : ""} showed up that the tree did not have. ` +
        `Adopt or ignore [in Build](${appUrl}/suites/${suite.id}/build).`,
    );
    md.push("");
  }

  if (t.unresolved) {
    md.push(
      `> ${t.unresolved} step${t.unresolved > 1 ? "s" : ""} matched nothing on the page. ` +
        `That is a stale tree rather than a broken app — reword or drop them in Build.`,
    );
    md.push("");
  }

  md.push(
    `<sub>${humanMs(run.wallClockMs)} · ${run.results.length} branches forked from one snapshot ` +
      `· ${humanMs(run.sequentialEstimateMs)} if run one at a time · tree v${run.treeVersion} ` +
      `· <a href="${runUrl}">full run</a></sub>`,
  );

  return md.join("\n");
}
