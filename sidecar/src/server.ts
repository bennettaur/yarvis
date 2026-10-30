import { failInterruptedAgentRuns, pruneAgentRunEvents } from "./agentRuns/service.ts";
import { syncBuiltins } from "./agentTools/registry.ts";
import { importLegacyAlarmsOnStart } from "./alarms/legacyImport.ts";
import { startAlarmScheduler } from "./alarms/scheduler.ts";
import { createApp } from "./app.ts";
import { browserBridge } from "./browser/bridge.ts";
import { removeDiscoveryOnExit, writeDiscovery } from "./browser/discovery.ts";
import { loadConfig, loadInstanceConfig } from "./config.ts";
import { getDb } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { startHeadsDownLoop } from "./headsDown/loop.ts";
import { allJobsWithAgentJobs } from "./jobs/registry.ts";
import { startJobScheduler } from "./jobs/scheduler.ts";
import { installLogCapture } from "./lib/log.ts";
import { watchParentProcess } from "./lib/parentWatch.ts";
import { redactSecrets } from "./llm/errors.ts";
import { chooseEmbedder } from "./memory/embedder.ts";
import { sweepStaleGuides } from "./pr/guides.ts";
import { createReadiness } from "./readiness.ts";
import { sweepContextDirs } from "./reviewWorkspaces/agentContext.ts";
import { sweepMutantCopies } from "./reviewWorkspaces/mutantCopy.ts";
import {
  failInterruptedMutationRuns,
  mutantCopiesInUse,
} from "./reviewWorkspaces/mutationTesting.ts";
import {
  REREVIEW_CONTEXT_DIR_PREFIX,
  REREVIEW_RUN_TIMEOUT_MS,
} from "./reviewWorkspaces/rereview.ts";
import {
  VERIFICATION_CONTEXT_DIR_PREFIX,
  VERIFICATION_RUN_TIMEOUT_MS,
} from "./reviewWorkspaces/verification.ts";
import { migrateStructuralConfig } from "./settings/migrateStructuralConfig.ts";
import { startTelegramBot } from "./telegram/index.ts";
import { resumeAgentSessions } from "./workspaces/claudeSession.ts";
import { startWorkspacePoller } from "./workspaces/poller.ts";
import { registerSymlinkAlerts, resumeKickOffs } from "./workspaces/service.ts";

// Before anything else logs: the buffer this fills is what the app's
// Diagnostics view reads, and a line written during boot is exactly the one
// worth having when startup is what failed.
installLogCapture();

const config = loadConfig();
const instance = loadInstanceConfig();
// Agent runs this instance recorded before this moment belong to a previous
// process; see `failInterruptedAgentRuns`.
const bootedAt = new Date();

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
  // `ANSWER_WAIT_MS` in `questions/contract.ts` stays under this, since an
  // `ask_user` call sends nothing while it waits. A route that must wait longer
  // opts out for its own request with `lib/idleTimeout.ts`, as the permission
  // ingest route does.
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

// The extension's native host finds this sidecar through a file, since the port
// is new each launch. Every instance writes one, so several can share a browser.
writeDiscovery({
  name: instance.name,
  port: config.port,
  token: browserBridge.token,
  pid: process.pid,
})
  .then(removeDiscoveryOnExit)
  .catch((e) => console.error("[browser] could not write the discovery file:", e));

try {
  const removed =
    sweepContextDirs({
      prefix: VERIFICATION_CONTEXT_DIR_PREFIX,
      maxAgeMs: VERIFICATION_RUN_TIMEOUT_MS,
    }) +
    sweepContextDirs({ prefix: REREVIEW_CONTEXT_DIR_PREFIX, maxAgeMs: REREVIEW_RUN_TIMEOUT_MS });
  if (removed > 0) console.log(`[agent-context] removed ${removed} leftover context folders`);
} catch (e) {
  console.error("[agent-context] could not sweep leftover context folders:", e);
}

if (config.databaseUrl) {
  runMigrations(config.databaseUrl)
    .then(async () => {
      await importLegacyAlarmsOnStart(config);
      // Yarvis's git refuses a clone with a symlink in its git data either way;
      // this raises the workspace alert when it does, on every instance.
      registerSymlinkAlerts(getDb(config.databaseUrl as string).db);
      // Every instance sweeps its own agent runs, secondaries included: only the
      // instance that started a run can know its process is gone.
      failInterruptedAgentRuns(getDb(config.databaseUrl as string).db, instance.name, bootedAt)
        .then((failed) => {
          if (failed > 0) console.log(`[agent-runs] marked ${failed} interrupted runs as failed`);
        })
        .catch((e) => console.error("[agent-runs] could not sweep interrupted runs:", e))
        // After the runs are marked, so this instance's crashed passes read as
        // finished and their scratch copies go.
        .then(() =>
          failInterruptedMutationRuns(
            getDb(config.databaseUrl as string).db,
            instance.name,
            bootedAt,
          ).then(
            (failed) => {
              if (failed > 0) {
                console.log(`[mutation-testing] marked ${failed} interrupted runs as failed`);
              }
            },
            (e) => console.error("[mutation-testing] could not sweep interrupted runs:", e),
          ),
        )
        .then(() =>
          sweepMutantCopies(getDb(config.databaseUrl as string).db, config, mutantCopiesInUse),
        )
        .then((removed) => {
          if (removed > 0) console.log(`[mutation-testing] removed ${removed} leftover copies`);
        })
        .catch((e) => console.error("[mutation-testing] could not sweep leftover copies:", e));
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
      // it embeds and upserts against the shared database; the tool routes sync
      // the built-ins on first use and chat seeds any it finds missing, so a
      // secondary instance still reads a correct one.
      try {
        const db = getDb(config.databaseUrl as string).db;
        await syncBuiltins(db, await chooseEmbedder(config, db));
      } catch (e) {
        console.error("[sidecar] built-in tool sync failed:", redactSecrets(String(e)));
      }
      // The Telegram bot drives the chat agent, which needs the database, so it
      // only starts once migrations have applied. It is a no-op without a token.
      startTelegramBot(config);
      // Consolidation, the nightly rollup, the Claude Code session digest, and
      // whatever scheduled agent jobs the user has saved.
      // Behind the same instance gate as the poller: these write rows and call
      // providers on a schedule, and two processes doing that against one
      // database would duplicate both.
      startJobScheduler(config, allJobsWithAgentJobs);
      // Background PR/checks poller. No-op without a GitHub token; reconciles
      // interrupted runs on its first tick.
      startWorkspacePoller(config);
      // The heads-down loop runs passes only while the user has it turned on;
      // otherwise it just checks once a minute whether they have.
      startHeadsDownLoop(config);
      // Rings alarms as they come due, through this instance's window. A
      // secondary instance sharing the database would only race it for each alarm.
      startAlarmScheduler(config);
      // A workspace still holding a "Start work" prompt is one whose session was
      // never launched, which only a restart mid-kick-off can leave behind — the
      // sequence otherwise runs to completion here regardless of the UI. Pick
      // those back up, provisioning included.
      resumeKickOffs(getDb(config.databaseUrl as string).db).catch((e) =>
        console.error("[sidecar] could not resume interrupted kick-offs:", e),
      );
      // The agent tabs live in the core's PTYs, so restarting the app ends every
      // session in them. Relaunch the ones it cut off where they left off.
      resumeAgentSessions(getDb(config.databaseUrl as string).db).catch((e) =>
        console.error("[sidecar] could not resume workspace agent sessions:", e),
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
      // Same cadence for trimming old agent runs' transcripts: the rows only
      // grow when a run finishes, and nothing reads a month-old run's text.
      pruneAgentRunEvents(getDb(config.databaseUrl as string).db)
        .then((pruned) => {
          if (pruned > 0) console.log(`[agent-runs] trimmed the text of ${pruned} old runs`);
        })
        .catch((e) => console.error("[agent-runs] could not trim old runs:", e));
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
