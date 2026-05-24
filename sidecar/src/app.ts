import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import type { Config } from "./config.ts";
import { pingDb } from "./db/client.ts";

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
export function createApp(config: Config): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: config.allowedOrigins ?? "*",
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: SERVICE_NAME,
      uptimeMs: Date.now() - startedAt,
    }),
  );

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

  return app;
}
