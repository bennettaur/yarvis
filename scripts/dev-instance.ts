#!/usr/bin/env bun
/**
 * Launches `tauri dev` as a named Yarvis instance, so a build under development
 * can run beside the primary one.
 *
 * The name selects a bundle identifier, and Tauri derives the app data
 * directory and the single-instance socket from that — so `settings.json`,
 * `alarms.json` and the core control socket separate without further work. It
 * also selects a Vite dev-server port, since the default one is taken by
 * whatever is already running.
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
import { createServer } from "node:net";

/** Identifier of the primary instance, from `tauri.conf.json`. */
const BASE_IDENTIFIER = "com.mikebennett.yarvis";

/**
 * Dev-server ports available to named instances, starting above the primary's
 * 1420. Allocated in pairs: `vite.config.ts` puts the HMR socket on `port + 1`
 * when `TAURI_DEV_HOST` is set, so handing two instances adjacent ports would
 * put one's HMR socket on the other's dev server.
 */
const PORT_RANGE_START = 1430;
const PORT_RANGE_SIZE = 60;
const PORTS_PER_INSTANCE = 2;
const INSTANCE_SLOTS = PORT_RANGE_SIZE / PORTS_PER_INSTANCE;

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

/**
 * The port an instance prefers. Derived from its slug rather than assigned in
 * order, so relaunching lands on the port it used last and a bookmarked dev URL
 * keeps working. Taking the slug rather than the raw name keeps it agreeing with
 * the identifier: two spellings that share an app data directory must not run on
 * two different ports.
 */
export function devPortFor(slug: string): number {
  // FNV-1a, for a spread that doesn't cluster on names sharing a prefix.
  let hash = 0x811c9dc5;
  for (const char of slug) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PORT_RANGE_START + (hash % INSTANCE_SLOTS) * PORTS_PER_INSTANCE;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * The port this run actually uses: the preferred one when its pair is free,
 * otherwise the next free pair in the range. Vite runs with `strictPort`, so
 * without this an unrelated service sitting on the derived port would stop the
 * launch rather than move it. Both ports of the pair have to be free — the
 * second is the HMR socket.
 */
export async function resolveDevPort(
  preferred: number,
  isFree: (port: number) => Promise<boolean> = isPortFree,
): Promise<number> {
  const preferredSlot = Math.floor((preferred - PORT_RANGE_START) / PORTS_PER_INSTANCE);
  for (let offset = 0; offset < INSTANCE_SLOTS; offset++) {
    const slot = (preferredSlot + offset) % INSTANCE_SLOTS;
    const port = PORT_RANGE_START + slot * PORTS_PER_INSTANCE;
    if ((await isFree(port)) && (await isFree(port + 1))) return port;
  }
  throw new Error(
    `no free port pair between ${PORT_RANGE_START} and ${PORT_RANGE_START + PORT_RANGE_SIZE - 1}`,
  );
}

export function identifierFor(slug: string): string {
  return `${BASE_IDENTIFIER}.${slug}`;
}

/**
 * The config Tauri merges over `tauri.conf.json` for this instance. Kept to the
 * two keys that must differ: merging replaces an array wholesale, so writing
 * `app.windows` here to retitle the window would discard the size configured
 * alongside the title. The Rust core retitles it at runtime instead.
 */
export function overrideConfig(
  slug: string,
  port: number,
): { identifier: string; build: { devUrl: string } } {
  return {
    identifier: identifierFor(slug),
    build: { devUrl: `http://localhost:${port}` },
  };
}

/**
 * What the child process is told about itself. `YARVIS_DEV_PORT` and the
 * `devUrl` in [`overrideConfig`] are two expressions of one number — the webview
 * loads from the one and the sidecar allows the origin built from the other, so
 * if they ever disagree every API call is refused by the origin check.
 */
export function childEnv(name: string, port: number): Record<string, string> {
  return { YARVIS_INSTANCE: name, YARVIS_DEV_PORT: String(port) };
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

  // Slugify before anything binds a socket, so an unusable name fails outright
  // rather than after a port search.
  const slug = slugify(name);
  // An explicit port is taken as given — if it's occupied, saying so beats
  // quietly serving somewhere the user didn't ask for.
  const port = Number(process.env.YARVIS_DEV_PORT) || (await resolveDevPort(devPortFor(slug)));
  const config = overrideConfig(slug, port);

  console.log(`[dev-instance] "${name}" — identifier ${config.identifier}, dev server on ${port}`);
  console.log(
    process.env.YARVIS_DATABASE_URL
      ? "[dev-instance] using YARVIS_DATABASE_URL (isolated from the primary database)"
      : "[dev-instance] sharing the primary database — set YARVIS_DATABASE_URL to isolate it",
  );

  const child = spawn("bun", ["run", "tauri", "dev", "--config", JSON.stringify(config)], {
    stdio: "inherit",
    env: { ...process.env, ...childEnv(name, port) },
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
