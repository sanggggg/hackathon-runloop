import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("branchpoint-data", {
    region: "us-west2",
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
      BRANCHPOINT_SHUTDOWN_TIMEOUT_MS: "170000",
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "180",
    },
    replicas: 1,
    volumeMounts: {
      "/app/data": data,
    },
  });

  return project("hackathon-runloop", {
    resources: [server, data],
  });
});
