import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { createAzureRoutes } from "./azure/routes.ts";
import { createCcRoutes } from "./cc/routes.ts";
import { createChatRoutes } from "./chat/routes.ts";
import type { Config } from "./config.ts";
import { createCustomProviderRoutes } from "./customProviders/routes.ts";
import { pingDb } from "./db/client.ts";
import { createGithubRoutes } from "./github/routes.ts";
import { createCalendarRoutes, createGoogleCallbackRoutes } from "./google/routes.ts";
import { redactSecrets } from "./llm/errors.ts";
import { createMemoryRoutes } from "./memory/routes.ts";
import { createOmniRoutes } from "./omni/routes.ts";
import { createReadiness, type Readiness } from "./readiness.ts";
import { createTaskRoutes } from "./tasks/routes.ts";
import { createTelegramRoutes } from "./telegram/routes.ts";

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
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

  // Everything past this point requires the bearer token.
  app.use("/api/*", bearerAuth({ token: config.token }));

  app.get("/api/status", (c) =>
    c.json({
      service: SERVICE_NAME,
      databaseConfigured: config.databaseUrl !== undefined,
      providers: {
        anthropic: config.secrets.anthropicApiKey !== undefined,
        gemini: config.secrets.geminiApiKey !== undefined,
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
  app.route("/api/custom-providers", createCustomProviderRoutes(config));
  app.route("/api/cc", createCcRoutes());
  app.route("/api/github", createGithubRoutes(config));
  app.route("/api/azure", createAzureRoutes(config));
  app.route("/api/memory", createMemoryRoutes(config));
  app.route("/api/calendar", createCalendarRoutes(config));
  app.route("/api/omni", createOmniRoutes(config));
  app.route("/api/telegram", createTelegramRoutes());

  return app;
}
