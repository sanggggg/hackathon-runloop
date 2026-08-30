import { appendFile } from "node:fs/promises";
import type { CommandResult } from "./commands.js";

function safeOutput(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

function markdown(value: unknown): string {
  return String(value ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

function summary(result: CommandResult): string | undefined {
  if (!result.runId || !result.outcome) return undefined;
  const run = result.run;
  const passed = run?.results.filter((item) => item.status === "pass").length ?? 0;
  const failed = run?.results.filter((item) => item.status === "fail") ?? [];
  const lines = [
    "## Branchpoint QA",
    "",
    "| Run | Suite | Ref | Outcome | Passed | Failed |",
    "|---|---|---|---|---:|---:|",
    `| \`${markdown(result.runId)}\` | ${markdown(run?.suiteId)} | \`${markdown(run?.ref)}\` | **${markdown(result.outcome)}** | ${passed} | ${failed.length} |`,
  ];
  if (failed.length > 0) {
    lines.push("", "### Failed nodes", "");
    for (const item of failed) {
      lines.push(`- \`${markdown(item.nodeId)}\` — ${markdown(item.failReason ?? "failed")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function writeGitHubMetadata(
  result: CommandResult,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  const summaryFile = env.GITHUB_STEP_SUMMARY;
  const contents = summary(result);
  if (summaryFile && contents) tasks.push(appendFile(summaryFile, contents, "utf8"));

  const outputFile = env.GITHUB_OUTPUT;
  if (outputFile && result.runId && result.outcome) {
    tasks.push(
      appendFile(
        outputFile,
        `run-id=${safeOutput(result.runId)}\noutcome=${safeOutput(result.outcome)}\n`,
        "utf8",
      ),
    );
  }
  await Promise.all(tasks);
}
