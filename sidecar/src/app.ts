import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { createActivityIngestRoutes, createActivityRoutes } from "./activity/routes.ts";
import { createAgentRunRoutes } from "./agentRuns/routes.ts";
import { createDecisionPlaygroundRoutes } from "./agents/decisionPlaygroundRoutes.ts";
import { createSpecialistRoutes } from "./agents/routes.ts";
import { createAlarmRoutes } from "./alarms/routes.ts";
import { createArtifactRoutes } from "./artifacts/routes.ts";
import { createAttentionIngestRoutes, createAttentionRoutes } from "./attention/routes.ts";
import { createAzureRoutes } from "./azure/routes.ts";
import { createAzureBoardsRoutes } from "./azureBoards/routes.ts";
import { browserBridge } from "./browser/bridge.ts";
import { createBrowserChatRoutes } from "./browser/chat.ts";
import { createBrowserRoutes } from "./browser/routes.ts";
import { createCcRoutes } from "./cc/routes.ts";
import { createChatRoutes } from "./chat/routes.ts";
import { createClipboardRoutes } from "./clipboard/routes.ts";
import type { Config } from "./config.ts";
import { createCustomProviderRoutes } from "./customProviders/routes.ts";
import { pingDb } from "./db/client.ts";
import { createEventRoutes } from "./events/routes.ts";
import { createGithubAuthRoutes } from "./github/authRoutes.ts";
import { createGithubRoutes } from "./github/routes.ts";
import { createCalendarRoutes, createGoogleCallbackRoutes } from "./google/routes.ts";
import { createHeadsDownRoutes } from "./headsDown/routes.ts";
import { createIssueRoutes } from "./issues/routes.ts";
import { createJiraRoutes } from "./jira/routes.ts";
import { createJobRoutes } from "./jobs/routes.ts";
import { createComplexityModelRoutes } from "./llm/complexityRoutes.ts";
import { createDecisionModelRoutes } from "./llm/decisionRoutes.ts";
import { redactSecrets } from "./llm/errors.ts";
import { createModelCatalogRoutes } from "./llm/routes.ts";
import { createLogRoutes } from "./logs/routes.ts";
import { createMcpOAuthCallbackRoutes } from "./mcp/callbackRoutes.ts";
import { createMcpRoutes } from "./mcp/routes.ts";
import { createMcpEndpointInfoRoutes, createMcpEndpointRoutes } from "./mcpServer/routes.ts";
import { createMemoryRoutes } from "./memory/routes.ts";
import { createOmniRoutes } from "./omni/routes.ts";
import { createPrModelRoutes } from "./pr/modelRoutes.ts";
import { createPrRoutes } from "./pr/routes.ts";
import { createProjectRoutes } from "./projects/routes.ts";
import { createQuestionRoutes } from "./questions/routes.ts";
import { createReadiness, type Readiness } from "./readiness.ts";
import { createMutationTestingConfigRoutes } from "./reviewWorkspaces/mutationConfig.ts";
import { createReviewWorkspaceRoutes } from "./reviewWorkspaces/routes.ts";
import { createTaskRoutes } from "./tasks/routes.ts";
import { createTelegramRoutes } from "./telegram/routes.ts";
import { createTodoRoutes } from "./todos/routes.ts";
import { createVoiceRoutes } from "./voice/routes.ts";
import { createWipRoutes } from "./wip/routes.ts";
import { createWorkStreamRoutes } from "./workStreams/routes.ts";
import { createAgentSessionIngestRoutes } from "./workspaces/agentSessionIngest.ts";
import { createRepoRoutes, createWorkspaceRoutes } from "./workspaces/routes.ts";

const SERVICE_NAME = "yarvis-sidecar";
const startedAt = Date.now();

/**
 * Builds the Hono application.
 *
 * Security model for this loopback service:
 *  - Every route except `/health` requires the bearer token (primary control).
 *  - CORS is restricted to the configured origins so the webview can call us
 *    while other browser origins cannot read responses.
 *  - `/health` is intentionally unauthenticated so the Rust supervisor can probe
 *    readiness; it exposes nothing sensitive.
 */
export function createApp(config: Config, readiness: Readiness = createReadiness()): Hono {
  const app = new Hono();

  // CORS fails closed: without an explicit allowlist the only origins that may
  // reach the API are the Tauri webview's own. Open `*` is never used — the
  // bearer token is the primary control, but a stale/missing config must not
  // also dismantle the cross-origin defense.
  const corsOrigins = config.allowedOrigins ?? ["tauri://localhost", "http://tauri.localhost"];

  app.use(
    "*",
    cors({
      origin: corsOrigins,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // `/health` is intentionally unauthenticated. `ready` is false while startup
  // migrations run (or if they failed), so the frontend can gate behind a
  // loading screen until the service is usable.
  app.get("/health", (c) => {
    const { phase, error } = readiness.get();
    return c.json({
      status: "ok",
      service: SERVICE_NAME,
      uptimeMs: Date.now() - startedAt,
      ready: phase === "ready",
      phase,
      // `/health` is unauthenticated; redact any credentials that may have made
      // it into the error string (e.g. a `postgres://user:pass@host` connection
      // string thrown by the migration step).
      ...(error ? { error: redactSecrets(error) } : {}),
    });
  });

  // The Google OAuth loopback callback is unauthenticated like /health: the
  // redirect from Google can't carry our bearer token. It is CSRF-protected by
  // a state nonce and exposes nothing sensitive.
  app.route("/", createGoogleCallbackRoutes(config));

  // The MCP authorization callback is the same shape: a browser redirect that
  // can't carry the bearer, gated on a single-use state nonce instead.
  app.route("/", createMcpOAuthCallbackRoutes(config));

  // Attention-ingest sits OUTSIDE the main bearer wall and authenticates with its
  // own scoped token (checked inside the router), so a Claude session shell can
  // raise an attention flag without holding the full-access bearer.
  app.route("/ingest", createAttentionIngestRoutes(config));
  // Same token and shape: the session hooks register the Claude process with
  // its workspace. The attention router's `/ingest/*` middleware also runs for
  // it; this router checks the token itself rather than relying on that.
  app.route("/ingest/agent-session", createAgentSessionIngestRoutes(config));
  // The hooks that feed the Agent Field page, on the same token and session check.
  app.route("/ingest/activity", createActivityIngestRoutes(config));

  // The browser bridge is the same shape: the extension's native host holds only
  // this scoped token, checked inside the router, never the full-access bearer.
  // It also carries the side panel's chat, so that token can run agent turns.
  app.route(
    "/browser",
    createBrowserRoutes(config, browserBridge, createBrowserChatRoutes(config)),
  );

  // The MCP endpoint sits outside the bearer wall for the same reason and with
  // the same shape: its own scoped token, checked inside the router, so an MCP
  // client reaches the memory tools and nothing else.
  app.route("/mcp", createMcpEndpointRoutes(config));

  // Everything past this point requires the bearer token.
  app.use("/api/*", bearerAuth({ token: config.token }));

  app.get("/api/status", (c) =>
    c.json({
      service: SERVICE_NAME,
      databaseConfigured: config.databaseUrl !== undefined,
      providers: {
        anthropic: config.secrets.anthropicApiKey !== undefined,
        gemini: config.secrets.geminiApiKey !== undefined,
        cerebras: config.secrets.cerebrasApiKey !== undefined,
        huggingface: config.secrets.huggingFaceApiKey !== undefined,
      },
    }),
  );

  // Reachability of the configured Postgres, surfaced to the health UI.
  app.get("/api/db/health", async (c) => {
    if (!config.databaseUrl) {
      return c.json({ configured: false, reachable: false });
    }
    const reachable = await pingDb(config.databaseUrl);
    return c.json({ configured: true, reachable });
  });

  app.route("/api/tasks", createTaskRoutes(config));
  app.route("/api/chat", createChatRoutes(config));
  app.route("/api/clipboard", createClipboardRoutes(config));
  app.route("/api/custom-providers", createCustomProviderRoutes(config));
  app.route("/api/model-catalog", createModelCatalogRoutes(config));
  app.route("/api/complexity-models", createComplexityModelRoutes(config));
  app.route("/api/decision-model", createDecisionModelRoutes());
  app.route("/api/decision-playground", createDecisionPlaygroundRoutes(config));
  app.route("/api/mcp", createMcpRoutes(config));
  app.route("/api/mcp-endpoint", createMcpEndpointInfoRoutes(config));
  app.route("/api/cc", createCcRoutes());
  app.route("/api/github", createGithubRoutes(config));
  app.route("/api/github-auth", createGithubAuthRoutes(config));
  app.route("/api/issues", createIssueRoutes(config));
  app.route("/api/jira", createJiraRoutes(config));
  app.route("/api/azure", createAzureRoutes(config));
  app.route("/api/azure-boards", createAzureBoardsRoutes(config));
  app.route("/api/memory", createMemoryRoutes(config));
  app.route("/api/events", createEventRoutes(config));
  app.route("/api/projects", createProjectRoutes(config));
  app.route("/api/todos", createTodoRoutes(config));
  app.route("/api/artifacts", createArtifactRoutes(config));
  app.route("/api/work-streams", createWorkStreamRoutes(config));
  app.route("/api/heads-down", createHeadsDownRoutes(config));
  app.route("/api/specialists", createSpecialistRoutes(config));
  app.route("/api/jobs", createJobRoutes(config));
  app.route("/api/agent-runs", createAgentRunRoutes(config));
  app.route("/api/logs", createLogRoutes());
  app.route("/api/attention", createAttentionRoutes(config));
  app.route("/api/activity", createActivityRoutes());
  app.route("/api/questions", createQuestionRoutes(config));
  app.route("/api/wip", createWipRoutes(config));
  app.route("/api/calendar", createCalendarRoutes(config));
  app.route("/api/alarms", createAlarmRoutes(config));
  app.route("/api/omni", createOmniRoutes(config));
  app.route("/api/pr", createPrRoutes(config));
  app.route("/api/pr-models", createPrModelRoutes(config));
  app.route("/api/telegram", createTelegramRoutes());
  app.route("/api/voice", createVoiceRoutes(config));
  app.route("/api/repos", createRepoRoutes(config));
  app.route("/api/workspaces", createWorkspaceRoutes(config));
  app.route("/api/review-workspaces", createReviewWorkspaceRoutes(config));
  app.route("/api/mutation-testing-config", createMutationTestingConfigRoutes());

  return app;
}
