import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runMigrations } from "./db/migrate.ts";
import { watchParentProcess } from "./lib/parentWatch.ts";
import { redactSecrets } from "./llm/errors.ts";
import { createReadiness } from "./readiness.ts";
import { startTelegramBot } from "./telegram/index.ts";
import { startWorkspacePoller } from "./workspaces/poller.ts";

const config = loadConfig();

// When launched by the Rust core (host-supplied token), exit if that parent
// dies, so a crash/force-quit can't leave an orphaned sidecar polling Telegram
// and colliding with the next session's sidecar. Skipped for standalone/dev
// runs (generated token), where the parent is just a shell.
if (!config.tokenGenerated) watchParentProcess();

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
  // Standalone (no host-supplied token): print the full token only when the
  // developer opts in via env. Otherwise show a fingerprint that's enough to
  // recognise the same session in a debugger but useless on its own.
  if (process.env.YARVIS_LOG_DEV_TOKEN === "1") {
    console.log(`[sidecar] generated dev token: ${config.token}`);
  } else {
    const fingerprint = `${config.token.slice(0, 4)}...${config.token.slice(-4)} (${config.token.length} chars)`;
    console.log(
      `[sidecar] generated dev token fingerprint: ${fingerprint} — set YARVIS_LOG_DEV_TOKEN=1 to print the full token`,
    );
  }
}

if (config.databaseUrl) {
  runMigrations(config.databaseUrl)
    .then(() => {
      readiness.set("ready");
      // The Telegram bot drives the chat agent, which needs the database, so it
      // only starts once migrations have applied. It is a no-op without a token.
      startTelegramBot(config);
      // Background PR/checks poller. No-op without a GitHub token; reconciles
      // interrupted runs on its first tick.
      startWorkspacePoller(config);
    })
    .catch((e) => {
      // Redact before storing the message because `/health` (unauthenticated)
      // surfaces it, and postgres error messages routinely echo the
      // connection string (including the password) verbatim.
      const message = redactSecrets(e instanceof Error ? e.message : String(e));
      readiness.set("error", message);
      console.error("[sidecar] migration failed:", redactSecrets(String(e)));
    });
}
