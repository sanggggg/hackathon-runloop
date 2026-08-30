import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("branchpoint-data", {
    region: "sfo",
    sizeMB: 500,
  });

  const server = service("branchpoint-server", {
    build: "pnpm --filter @branchpoint/server... build",
    start: "node apps/server/dist/src/index.js",
    healthcheck: "/readyz",
    healthcheckTimeout: 300,
    env: {
      NODE_ENV: "production",
      BRANCHPOINT_DATA_DIR: "/app/data",
      BRANCHPOINT_API_TOKEN: preserve(),
      RUNLOOP_API_KEY: preserve(),
      RUNLOOP_API_URL: preserve(),
      BRANCHPOINT_OPENROUTER_MODEL: preserve(),
      BRANCHPOINT_OPENROUTER_SECRET: preserve(),
      BRANCHPOINT_CORS_ORIGINS: preserve(),
      // The Nimbus fixture installs Playwright into a venv and serves health at
      // its own path, so the engine defaults ("python3 ..." and "/") do not fit
      // it. A run fails in about eight seconds without these.
      BRANCHPOINT_AGENT_COMMAND: ".branchpoint/venv/bin/python .branchpoint/browser-agent.py",
      BRANCHPOINT_HEALTH_PATH: "/__qa/health",
      BRANCHPOINT_MAX_CONCURRENCY: "4",
      BRANCHPOINT_SHUTDOWN_TIMEOUT_MS: "170000",
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "180",
    },
    replicas: 1,
    volumeMounts: {
      "/app/data": data,
    },
  });

  // The dashboard holds the API token server-side and proxies every call, so
  // it needs the server's URL and token but never exposes either to a browser.
  const web = service("branchpoint-web", {
    build: "pnpm --filter @branchpoint/web build",
    start: "pnpm --filter @branchpoint/web start",
    healthcheck: "/",
    healthcheckTimeout: 300,
    env: {
      NODE_ENV: "production",
      // Railway resolves this reference at deploy time, so the URL follows the
      // server service rather than being pinned to today's domain.
      BRANCHPOINT_API_URL: "https://${{branchpoint-server.RAILWAY_PUBLIC_DOMAIN}}",
      BRANCHPOINT_API_TOKEN: preserve(),
    },
    replicas: 1,
  });

  return project("hackathon-runloop", {
    resources: [server, data, web],
  });
});
