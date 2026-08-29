import type { Run } from "@branchpoint/schema";

export class RunInputValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid QA run input:\n- ${issues.join("\n- ")}`);
    this.name = "RunInputValidationError";
    this.issues = issues;
  }
}

export class EngineRunError extends Error {
  readonly runId: string;
  readonly partialRun: Run;
  override readonly cause: unknown;

  constructor(runId: string, partialRun: Run, cause: unknown) {
    super(`QA run '${runId}' failed because of an infrastructure error`, { cause });
    this.name = "EngineRunError";
    this.runId = runId;
    this.partialRun = partialRun;
    this.cause = cause;
  }
}
