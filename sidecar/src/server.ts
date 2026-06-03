import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runMigrations } from "./db/migrate.ts";
import { createReadiness } from "./readiness.ts";

const config = loadConfig();

// If a database is configured, apply migrations before the service is usable
// and report that phase via /health so the UI can show a loading screen. With
// no database there is nothing to migrate, so we are ready immediately.
const readiness = createReadiness(config.databaseUrl ? "migrating" : "ready");
const app = createApp(config, readiness);

// Bind the port first so /health responds (with `ready: false`) right away,
// rather than making the frontend wait on a closed socket during migration.
const _server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
  // Streaming LLM endpoints (chat, omni) can wait well beyond Bun's 10s default
  // for the provider's first token, after which each streamed chunk resets the
  // idle timer. Without this the socket is closed mid-generation and the client
  // sees a timeout with no output. 255s is Bun's maximum.
  idleTimeout: 255,
});
if (config.tokenGenerated) {
}

if (config.databaseUrl) {
  runMigrations(config.databaseUrl)
    .then(() => {
      readiness.set("ready");
    })
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      readiness.set("error", message);
      console.error("[sidecar] migration failed:", e);
    });
}
