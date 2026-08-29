import type { RunInput } from "./types.js";
import { RunInputValidationError } from "./errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateRunInput(input: RunInput): void {
  const value = input as unknown;
  const issues: string[] = [];
  if (!isRecord(value)) throw new RunInputValidationError(["input must be an object"]);

  if (value.runId !== undefined && !isNonEmptyString(value.runId)) {
    issues.push("runId must be a non-empty string when provided");
  }
  if (value.ref !== undefined && !isNonEmptyString(value.ref)) {
    issues.push("ref must be a non-empty string when provided");
  }

  const suite = value.suite;
  if (!isRecord(suite)) throw new RunInputValidationError([...issues, "suite must be an object"]);
  if (!isNonEmptyString(suite.id)) issues.push("suite.id must be a non-empty string");
  if (!isNonEmptyString(suite.name)) issues.push("suite.name must be a non-empty string");
  if (!isNonEmptyString(suite.blueprintId)) {
    issues.push("suite.blueprintId must be a non-empty string");
  }

  const repo = suite.repo;
  if (!isRecord(repo)) {
    issues.push("suite.repo must be an object");
  } else {
    if (!isNonEmptyString(repo.url)) issues.push("suite.repo.url must be a non-empty string");
    if (!isNonEmptyString(repo.ref)) issues.push("suite.repo.ref must be a non-empty string");
    if (typeof repo.buildCmd !== "string") issues.push("suite.repo.buildCmd must be a string");
    if (!isNonEmptyString(repo.startCmd)) {
      issues.push("suite.repo.startCmd must be a non-empty string");
    }
    if (!Number.isInteger(repo.port) || Number(repo.port) < 1 || Number(repo.port) > 65_535) {
      issues.push("suite.repo.port must be an integer from 1 to 65535");
    }
  }

  const fixture = suite.fixture;
  if (!isRecord(fixture)) {
    issues.push("suite.fixture must be an object");
  } else {
    if (!isNonEmptyString(fixture.snapshotId)) {
      issues.push("suite.fixture.snapshotId must be a non-empty string");
    }
    if (!isNonEmptyString(fixture.ref)) issues.push("suite.fixture.ref must be a non-empty string");
    if (!isNonEmptyString(fixture.description)) {
      issues.push("suite.fixture.description must be a non-empty string");
    }
  }

  if (!Array.isArray(suite.tree)) {
    issues.push("suite.tree must be an array");
  } else {
    suite.tree.forEach((node, index) => {
      const prefix = `suite.tree[${index}]`;
      if (!isRecord(node)) {
        issues.push(`${prefix} must be an object`);
        return;
      }
      if (!isNonEmptyString(node.id)) issues.push(`${prefix}.id must be a non-empty string`);
      if (node.parentId !== null && !isNonEmptyString(node.parentId)) {
        issues.push(`${prefix}.parentId must be null or a non-empty string`);
      }
      if (!isNonEmptyString(node.label)) issues.push(`${prefix}.label must be a non-empty string`);
      if (!isNonEmptyString(node.intent)) issues.push(`${prefix}.intent must be a non-empty string`);
      if (!["fixture", "step", "goal"].includes(String(node.kind))) {
        issues.push(`${prefix}.kind must be fixture, step, or goal`);
      }
      if (!["unverified", "verified", "unresolved"].includes(String(node.state))) {
        issues.push(`${prefix}.state must be unverified, verified, or unresolved`);
      }
      if (node.expectedOutcome !== undefined && !isNonEmptyString(node.expectedOutcome)) {
        issues.push(`${prefix}.expectedOutcome must be a non-empty string when provided`);
      }
      if (node.lastSeenLabel !== undefined && !isNonEmptyString(node.lastSeenLabel)) {
        issues.push(`${prefix}.lastSeenLabel must be a non-empty string when provided`);
      }
    });
  }

  if (issues.length > 0) throw new RunInputValidationError(issues);
}
