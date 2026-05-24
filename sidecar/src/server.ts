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
const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
});

console.log(`[sidecar] listening on http://127.0.0.1:${server.port}`);
if (config.tokenGenerated) {
  // Only happens when run standalone (no host-supplied token); surfaced so a
  // local client can authenticate during development/testing.
  console.log(`[sidecar] generated dev token: ${config.token}`);
}

if (config.databaseUrl) {
  console.log("[sidecar] applying database migrations…");
  runMigrations(config.databaseUrl)
    .then(() => {
      readiness.set("ready");
      console.log("[sidecar] migrations applied; ready");
    })
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      readiness.set("error", message);
      console.error("[sidecar] migration failed:", e);
    });
}
