import { syncBuiltins } from "./agentTools/registry.ts";
import { createApp } from "./app.ts";
import { loadConfig, loadInstanceConfig } from "./config.ts";
import { getDb } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { allJobs } from "./jobs/registry.ts";
import { startJobScheduler } from "./jobs/scheduler.ts";
import { installLogCapture } from "./lib/log.ts";
import { watchParentProcess } from "./lib/parentWatch.ts";
import { redactSecrets } from "./llm/errors.ts";
import { chooseEmbedder } from "./memory/embedder.ts";
import { sweepStaleGuides } from "./pr/guides.ts";
import { createReadiness } from "./readiness.ts";
import { migrateStructuralConfig } from "./settings/migrateStructuralConfig.ts";
import { startTelegramBot } from "./telegram/index.ts";
import { startWorkspacePoller } from "./workspaces/poller.ts";
import { resumeKickOffs } from "./workspaces/service.ts";

// Before anything else logs: the buffer this fills is what the app's
// Diagnostics view reads, and a line written during boot is exactly the one
// worth having when startup is what failed.
installLogCapture();

const config = loadConfig();
const instance = loadInstanceConfig();

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
    .then(async () => {
      // A secondary instance serves its window and nothing else: the work below
      // reaches out to providers and writes rows on a schedule, and running it
      // from two processes against one database duplicates both.
      if (!instance.backgroundWorkers) {
        readiness.set("ready");
        console.log(`[sidecar] instance '${instance.name}' is not running background workers`);
        return;
      }
      // One-time copy of the small structural config tables (custom providers,
      // MCP servers, voice/embeddings/wip/github-pr/job config) into the shared
      // ~/.yarvis/settings.json. Gated behind `structuralSettingsMigrated` in
      // that file, so this is a no-op on every startup after the first —
      // restricted to this instance the same way the work below is, since two
      // instances racing to write the same settings file is worse than one.
      //
      // Runs before `readiness.set("ready")`: nothing gates routes on readiness
      // besides /health's own loading screen, so a request served mid-migration
      // could read a section the copy hasn't reached yet, or have its own write
      // clobbered by the migration's snapshot-based overwrite of that section.
      try {
        await migrateStructuralConfig(getDb(config.databaseUrl as string).db);
      } catch (e) {
        console.error("[sidecar] structural config migration failed:", redactSecrets(String(e)));
      }
      readiness.set("ready");
      // Seed the built-in tools into the unified registry so the Tool Manager
      // and tool search see them. Best-effort: a failure here (e.g. embedder
      // misconfig) must not take the service down. Gated with the rest because
      // it embeds and upserts against the shared database; the tool routes seed
      // the registry lazily, so a secondary instance still reads a correct one.
      try {
        const db = getDb(config.databaseUrl as string).db;
        await syncBuiltins(db, await chooseEmbedder(config, db));
      } catch (e) {
        console.error("[sidecar] built-in tool sync failed:", redactSecrets(String(e)));
      }
      // The Telegram bot drives the chat agent, which needs the database, so it
      // only starts once migrations have applied. It is a no-op without a token.
      startTelegramBot(config);
      // Consolidation, the nightly rollup, and the Claude Code session digest.
      // Behind the same instance gate as the poller: these write rows and call
      // providers on a schedule, and two processes doing that against one
      // database would duplicate both.
      startJobScheduler(config, allJobs());
      // Background PR/checks poller. No-op without a GitHub token; reconciles
      // interrupted runs on its first tick.
      startWorkspacePoller(config);
      // A workspace still holding a "Start work" prompt is one whose session was
      // never launched, which only a restart mid-kick-off can leave behind — the
      // sequence otherwise runs to completion here regardless of the UI. Pick
      // those back up, provisioning included.
      resumeKickOffs(getDb(config.databaseUrl as string).db).catch((e) =>
        console.error("[sidecar] could not resume interrupted kick-offs:", e),
      );
      // Backstop for review guides whose pull requests were closed on the
      // provider's own site, which the app never observes. Once at startup is
      // enough for a month-long TTL; a timer would only make it prompter about
      // deleting rows nobody is looking at.
      sweepStaleGuides(getDb(config.databaseUrl as string).db)
        .then((removed) => {
          if (removed > 0) console.log(`[sidecar] swept ${removed} stale PR review guides`);
        })
        .catch((e) => console.error("[sidecar] guide sweep failed:", e));
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
