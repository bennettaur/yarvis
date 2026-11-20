#!/usr/bin/env bun
/**
 * Launches `tauri dev` as a named Yarvis instance, so a build under development
 * can run beside the primary one.
 *
 * The name selects a bundle identifier, and Tauri derives the app data
 * directory and the single-instance socket from that — so the instance gets
 * its own `connection.json`, local yarvis-server (on a port of its own) and
 * Keychain device token without further work.
 *
 * The instance's own behaviour (which database it uses, whether it runs the
 * background workers or claims the global hotkeys) is decided by the env vars
 * documented in `src-tauri/src/instance.rs`; this script only passes them
 * through.
 *
 *   bun run dev:instance migration-test
 *   YARVIS_DATABASE_URL=postgres://localhost:5432/yarvis_dev \
 *     bun run dev:instance migration-test
 */

import { spawn } from "node:child_process";

/** Identifier of the primary instance, from `tauri.conf.json`. */
const BASE_IDENTIFIER = "com.mikebennett.yarvis";

/**
 * Longest slug that still fits the single-instance guard. The plugin builds
 * `/tmp/<identifier with dots as underscores>_si.sock`, and a Unix socket path
 * caps at ~104 bytes — past that the guard silently fails to bind and a second
 * launch stops being caught. A long branch name reaches this easily.
 */
const MAX_SLUG_LENGTH = 48;

/**
 * Reduces a name to what a bundle identifier accepts. macOS treats an
 * identifier as an ASCII reverse-DNS string, so anything else becomes a dash.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  if (!slug) {
    throw new Error(`instance name "${name}" has no usable characters`);
  }
  return slug;
}

export function identifierFor(slug: string): string {
  return `${BASE_IDENTIFIER}.${slug}`;
}

/**
 * The config Tauri merges over `tauri.conf.json` for this instance. Only the
 * identifier: merging replaces an array wholesale, so writing `app.windows`
 * here to retitle the window would discard the size configured alongside the
 * title. The Rust core retitles it at runtime instead.
 */
export function overrideConfig(slug: string): { identifier: string } {
  return { identifier: identifierFor(slug) };
}

/** What the child process is told about itself. */
export function childEnv(name: string): Record<string, string> {
  return { YARVIS_INSTANCE: name };
}

async function main() {
  const name = process.argv[2] ?? process.env.YARVIS_INSTANCE;
  if (!name) {
    console.error(
      "usage: bun run dev:instance <name>\n\n" +
        "Runs `tauri dev` as a named instance alongside the primary app.\n" +
        "Set YARVIS_DATABASE_URL to give it its own database.",
    );
    process.exit(1);
  }

  const config = overrideConfig(slugify(name));

  console.log(`[dev-instance] "${name}" — identifier ${config.identifier}`);
  console.log(
    process.env.YARVIS_DATABASE_URL
      ? "[dev-instance] using YARVIS_DATABASE_URL (isolated from the primary database)"
      : "[dev-instance] sharing the primary database — set YARVIS_DATABASE_URL to isolate it",
  );

  const child = spawn("bun", ["run", "tauri", "dev", "--config", JSON.stringify(config)], {
    stdio: "inherit",
    env: { ...process.env, ...childEnv(name) },
  });

  child.on("exit", (code, signal) => {
    // Mirror how the child ended so a Ctrl-C or a crash isn't reported as success.
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

// Guarded so the tests can import the helpers above without launching an app.
if (import.meta.main) {
  main().catch((e) => {
    console.error(`[dev-instance] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
