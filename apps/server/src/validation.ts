import type { Node, Suite } from "@branchpoint/schema";
import {
  RunInputValidationError,
  TreeIndex,
  TreeValidationError,
  validateRunInput,
} from "@branchpoint/engine";
import { HttpError } from "./errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationDetails(error: RunInputValidationError | TreeValidationError): readonly string[] {
  return error.issues;
}

export function validateSuite(value: unknown): Suite {
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_suite", "request body must be a complete Suite JSON object");
  }
  const suite = value as unknown as Suite;
  if (typeof suite.id === "string" && suite.id !== suite.id.trim()) {
    throw new HttpError(422, "invalid_suite", "suite validation failed", [
      "suite.id must not have leading or trailing whitespace",
    ]);
  }
  try {
    validateRunInput({ suite });
    new TreeIndex(suite.tree);
  } catch (error) {
    if (error instanceof RunInputValidationError || error instanceof TreeValidationError) {
      throw new HttpError(422, "invalid_suite", "suite validation failed", validationDetails(error));
    }
    throw error;
  }
  return structuredClone(suite);
}

export function parseTreePatch(value: unknown, suite: Suite): Suite {
  if (!isRecord(value) || !Array.isArray(value.tree)) {
    throw new HttpError(400, "invalid_tree_patch", "request body must contain a tree array");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "tree")) {
    throw new HttpError(400, "invalid_tree_patch", "only the tree field can be updated");
  }
  return validateSuite({ ...suite, tree: value.tree as Node[] });
}

export interface StartRunBody {
  suiteId: string;
  ref?: string;
}

export function parseStartRun(value: unknown): StartRunBody {
  if (!isRecord(value) || typeof value.suiteId !== "string" || !value.suiteId.trim()) {
    throw new HttpError(400, "invalid_run_request", "suiteId is required");
  }
  if (value.ref !== undefined && (typeof value.ref !== "string" || !value.ref.trim())) {
    throw new HttpError(400, "invalid_run_request", "ref must be a non-empty string when provided");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "suiteId" && key !== "ref")) {
    throw new HttpError(400, "invalid_run_request", "only suiteId and ref are accepted");
  }
  return {
    suiteId: value.suiteId.trim(),
    ...(typeof value.ref === "string" ? { ref: value.ref.trim() } : {}),
  };
}
