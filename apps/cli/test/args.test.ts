import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  loadConfig,
  parseArgs,
} from "../src/args.js";
import { UsageError } from "../src/errors.js";

test("run arguments have CI-safe polling defaults and accept explicit overrides", () => {
  assert.deepEqual(parseArgs(["run", "--suite", "suite-1"]), {
    kind: "run",
    suiteId: "suite-1",
    detach: false,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_SECONDS * 1_000,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1_000,
  });
  assert.deepEqual(
    parseArgs([
      "run",
      "--suite",
      "suite-1",
      "--ref",
      "deadbeef",
      "--detach",
      "--poll-interval",
      "0.25",
      "--timeout",
      "90",
    ]),
    {
      kind: "run",
      suiteId: "suite-1",
      ref: "deadbeef",
      detach: true,
      pollIntervalMs: 250,
      timeoutMs: 90_000,
    },
  );
});

test("runs and suites subcommands parse without ambiguous positional options", () => {
  assert.deepEqual(parseArgs(["runs"]), { kind: "runs-list" });
  assert.deepEqual(parseArgs(["runs", "list", "--suite", "a/b"]), {
    kind: "runs-list",
    suiteId: "a/b",
  });
  assert.deepEqual(parseArgs(["runs", "get", "run-1"]), { kind: "runs-get", runId: "run-1" });
  assert.deepEqual(parseArgs(["runs", "cancel", "run-1"]), {
    kind: "runs-cancel",
    runId: "run-1",
  });
  assert.deepEqual(parseArgs(["suites"]), { kind: "suites-list" });
  assert.deepEqual(parseArgs(["suites", "get", "suite-1"]), {
    kind: "suites-get",
    suiteId: "suite-1",
  });
  assert.deepEqual(parseArgs(["suites", "push", "--file", "suite.json"]), {
    kind: "suites-push",
    filename: "suite.json",
  });
});

test("invalid, duplicate, and token command-line options are rejected", () => {
  for (const args of [
    ["run"],
    ["run", "--suite", "suite", "--suite", "other"],
    ["run", "--suite", "suite", "--timeout", "0"],
    ["run", "--suite", "suite", "--timeout", "1e308"],
    ["run", "--suite", "suite", "--token", "secret"],
    ["runs", "wat"],
    ["suites", "push", "suite.json"],
  ]) {
    assert.throws(() => parseArgs(args), UsageError);
  }
});

test("configuration requires an env token and normalizes an http(s) API URL", () => {
  assert.throws(() => loadConfig({}), /BRANCHPOINT_API_TOKEN/);
  assert.deepEqual(loadConfig({ BRANCHPOINT_API_TOKEN: " token " }), {
    apiUrl: DEFAULT_API_URL,
    apiToken: "token",
  });
  assert.deepEqual(
    loadConfig({ BRANCHPOINT_API_TOKEN: "token", BRANCHPOINT_API_URL: "http://localhost:4000/" }),
    { apiUrl: "http://localhost:4000", apiToken: "token" },
  );
  assert.throws(
    () => loadConfig({ BRANCHPOINT_API_TOKEN: "token", BRANCHPOINT_API_URL: "file:///tmp/api" }),
    /http\(s\)/,
  );
  for (const insecure of [
    "http://api.example",
    "https://user:password@api.example",
    "https://api.example?token=value",
    "https://api.example#fragment",
  ]) {
    assert.throws(
      () => loadConfig({ BRANCHPOINT_API_TOKEN: "token", BRANCHPOINT_API_URL: insecure }),
      UsageError,
    );
  }
  assert.equal(
    loadConfig({ BRANCHPOINT_API_TOKEN: "token", BRANCHPOINT_API_URL: "http://[::1]:4000/" }).apiUrl,
    "http://[::1]:4000",
  );
});
