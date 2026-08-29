import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("local config has safe server and persistence defaults", () => {
  const config = loadConfig({}, "/tmp/branchpoint-config-test");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4000);
  assert.equal(config.maxActiveRuns, 1);
  assert.equal(config.shutdownTimeoutMs, 170_000);
  assert.equal(config.databasePath, "/tmp/branchpoint-config-test/.branchpoint-data/server.json");
  assert(config.corsOrigins.has("http://localhost:3000"));
});

test("production requires API authentication unless explicitly overridden", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /BRANCHPOINT_API_TOKEN is required in production/,
  );
  const config = loadConfig({ NODE_ENV: "production", BRANCHPOINT_API_TOKEN: "secret" });
  assert.equal(config.apiToken, "secret");
  assert.equal(config.corsOrigins.size, 0);
});

test("OpenRouter model and Runloop secret name are an atomic configuration pair", () => {
  assert.throws(
    () => loadConfig({ BRANCHPOINT_OPENROUTER_MODEL: "model" }),
    /must be configured together/,
  );
  assert.throws(
    () => loadConfig({ BRANCHPOINT_OPENROUTER_SECRET: "secret-name" }),
    /must be configured together/,
  );
  const config = loadConfig({
    BRANCHPOINT_OPENROUTER_MODEL: "model",
    BRANCHPOINT_OPENROUTER_SECRET: "secret-name",
  });
  assert.equal(config.openrouterModel, "model");
  assert.equal(config.openrouterSecret, "secret-name");
});

test("numeric and CORS settings reject malformed values", () => {
  assert.throws(() => loadConfig({ PORT: "0" }), /PORT must be an integer/);
  assert.throws(
    () => loadConfig({ BRANCHPOINT_CORS_ORIGINS: "https://dashboard.example/path" }),
    /bare http\(s\) origins/,
  );
});
