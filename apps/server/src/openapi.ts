export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Branchpoint QA Engine API",
    version: "0.1.0",
    description:
      "Manage prepared QA suites and asynchronously execute them with the Branchpoint engine.",
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/healthz": {
      get: {
        security: [],
        summary: "Liveness probe",
        responses: { "200": { description: "Server process is alive" } },
      },
    },
    "/readyz": {
      get: {
        security: [],
        summary: "Readiness probe",
        responses: {
          "200": { description: "Store and QA engine are ready" },
          "503": { description: "QA engine is not configured or server is draining" },
        },
      },
    },
    "/suites": {
      get: {
        summary: "List suites",
        responses: { "200": { description: "Suite list" } },
      },
      post: {
        summary: "Register a prepared Suite JSON document",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Suite" } } },
        },
        responses: {
          "201": { description: "Suite registered" },
          "409": { description: "Suite id already exists" },
          "422": { description: "Suite or tree is invalid" },
        },
      },
    },
    "/suites/{suiteId}": {
      parameters: [
        { name: "suiteId", in: "path", required: true, schema: { type: "string" } },
      ],
      get: {
        summary: "Get a suite",
        responses: {
          "200": { description: "Suite" },
          "404": { description: "Suite not found" },
        },
      },
      patch: {
        summary: "Replace a suite tree",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tree"],
                properties: {
                  tree: { type: "array", items: { $ref: "#/components/schemas/Node" } },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated suite" },
          "422": { description: "Tree is invalid" },
        },
      },
    },
    "/runs": {
      get: {
        summary: "List runs, newest first",
        parameters: [{ name: "suiteId", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Run list" } },
      },
      post: {
        summary: "Queue a run",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["suiteId"],
                properties: {
                  suiteId: { type: "string" },
                  ref: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "202": { description: "Run queued" },
          "503": { description: "Engine not configured or server draining" },
        },
      },
    },
    "/runs/{runId}": {
      get: {
        summary: "Poll a run and its partial node results",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Run" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/runs/{runId}/cancel": {
      post: {
        summary: "Cancel a queued or running run",
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "202": { description: "Cancellation accepted" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/screenshots/{screenshotId}": {
      get: {
        summary: "Read a persisted PNG; screenshotId may contain slashes",
        parameters: [
          { name: "screenshotId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "PNG screenshot" },
          "404": { description: "Screenshot not found" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
    schemas: {
      Node: {
        type: "object",
        required: ["id", "parentId", "label", "intent", "kind", "state"],
        properties: {
          id: { type: "string" },
          parentId: { type: ["string", "null"] },
          label: { type: "string" },
          intent: { type: "string" },
          expectedOutcome: { type: "string" },
          kind: { enum: ["fixture", "step", "goal"] },
          state: { enum: ["unverified", "verified", "unresolved"] },
          lastSeenLabel: { type: "string" },
        },
      },
      Suite: {
        type: "object",
        required: ["id", "name", "repo", "blueprintId", "fixture", "tree"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          repo: { type: "object" },
          blueprintId: { type: "string" },
          fixture: { type: "object" },
          tree: { type: "array", items: { $ref: "#/components/schemas/Node" } },
        },
      },
    },
  },
} as const;
