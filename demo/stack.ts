/**
 * Starts everything a demo needs: a fresh demo database, a sidecar against
 * it, and the Vite dev server serving `demo/index.html`.
 *
 * The sidecar runs with its home directory, settings file and workspaces root
 * pointed at a scratch directory, so nothing from the real Yarvis install (its
 * memories, Claude Code sessions, workspaces) can show up in a screenshot.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { OUTPUT_DIR, REPO_ROOT } from "./paths";

const STATE_DIR = join(OUTPUT_DIR, ".state");

const DEFAULT_DATABASE_URL = "postgres://localhost:5432/yarvis_demo";

/** Provider keys the sidecar may use when they're set in the runner's env. */
export const PASSTHROUGH_SECRETS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY"];

export interface Stack {
  /** The app's URL, `demo/index.html` on the Vite dev server. */
  appUrl: string;
  sidecarUrl: string;
  sidecarPort: number;
  sidecarToken: string;
  stop(): Promise<void>;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not pick a free port"));
      });
    });
  });
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** URL query keys that make Postgres clients connect to a different database than the path names. */
const DATABASE_OVERRIDE_PARAMS = ["database", "dbname", "db"];

export interface DemoDatabase {
  name: string;
  /** Connection to the server's `postgres` database, for dropping and creating `name`. */
  adminUrl: string;
}

/**
 * Checks that `databaseUrl` names a local database that is safe to drop. The
 * run deletes it, so a mistyped URL would wipe real data. The same URL is
 * what the sidecar connects to, so anything that could send it to another
 * database is refused too.
 */
export function demoDatabase(databaseUrl: string): DemoDatabase {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9_]*demo[A-Za-z0-9_]*$/i.test(name)) {
    throw new Error(
      `refusing to use database "${name}": a demo database name has "demo" in it and only letters, digits and underscores`,
    );
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `refusing to use database host "${url.hostname}": demo databases must be local`,
    );
  }
  for (const param of DATABASE_OVERRIDE_PARAMS) {
    if (url.searchParams.has(param)) {
      throw new Error(
        `refusing "?${param}=" in the demo database URL: it overrides the database name`,
      );
    }
  }
  url.pathname = "/postgres";
  return { name, adminUrl: url.toString() };
}

/** Drops and recreates the demo database so every run starts from the same seed. */
function recreateDatabase({ name, adminUrl }: DemoDatabase): void {
  for (const sql of [
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    `CREATE DATABASE "${name}"`,
  ]) {
    const result = spawnSync("psql", [adminUrl, "-v", "ON_ERROR_STOP=1", "-qc", sql], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`psql failed running ${sql}: ${result.stderr || result.error}`);
    }
  }
}

/**
 * The real bun binary. `bun` on PATH may be a version-manager shim (mise,
 * asdf), and a shim stops working once the sidecar's HOME is redirected.
 */
function resolveBunPath(): string {
  const result = spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not run bun: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

interface StartedProcess {
  child: ChildProcess;
  /** Rejects if the process fails to start or exits, so a startup wait can stop early. */
  exited: Promise<never>;
}

function startProcess(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): StartedProcess {
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<never>((_, reject) => {
    child.once("error", (e) => reject(new Error(`${name} failed to start: ${e.message}`)));
    child.once("exit", (code, signal) =>
      reject(new Error(`${name} exited during startup (${signal ?? `code ${code}`})`)),
    );
  });
  // Only startup waits on this; once they're done, an exit is expected.
  exited.catch(() => {});
  const isVerbose = process.env.DEMO_VERBOSE === "1";
  const prefixLines = (chunk: Buffer) =>
    chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => `[${name}] ${line}\n`)
      .join("");
  child.stdout?.on("data", (chunk: Buffer) => {
    if (isVerbose) process.stdout.write(prefixLines(chunk));
  });
  // Errors always show: a sidecar that fails to boot otherwise looks like a
  // timeout with no explanation.
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(prefixLines(chunk)));
  return { child, exited };
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (e) {
      // `fetch` throws a TypeError while nothing is listening yet; anything
      // else is a real failure.
      if (!(e instanceof TypeError)) throw e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function stopChild(child: ChildProcess): Promise<void> {
  // A child killed by a signal has no exit code, only a signal code.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function startStack(): Promise<Stack> {
  const databaseUrl = process.env.YARVIS_DEMO_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  recreateDatabase(demoDatabase(databaseUrl));

  rmSync(STATE_DIR, { recursive: true, force: true });
  const home = join(STATE_DIR, "home");
  const workspacesRoot = join(STATE_DIR, "workspaces");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspacesRoot, { recursive: true });

  const [sidecarPort, vitePort] = await Promise.all([findFreePort(), findFreePort()]);
  const sidecarToken = randomBytes(24).toString("hex");
  const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
  const appOrigin = `http://localhost:${vitePort}`;

  // Built from scratch rather than inheriting process.env, so a token or key
  // in the developer's shell can't leak into the demo by accident.
  const sidecarEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    // Postgres falls back to the OS user when the URL names no role.
    USER: process.env.USER,
    HOME: home,
    DATABASE_URL: databaseUrl,
    YARVIS_SIDECAR_PORT: String(sidecarPort),
    YARVIS_SIDECAR_TOKEN: sidecarToken,
    YARVIS_ALLOWED_ORIGINS: appOrigin,
    // No pollers or scheduled jobs, so nothing changes the seeded data or
    // calls out to GitHub mid-recording.
    YARVIS_INSTANCE: "demo",
    YARVIS_BACKGROUND_WORKERS: "0",
    YARVIS_SETTINGS_PATH: join(home, ".yarvis", "settings.json"),
    YARVIS_AGENTS_DIR: join(home, ".yarvis", "agents"),
    YARVIS_WORKSPACES_ROOT: workspacesRoot,
    CLAUDE_HOME: join(home, ".claude"),
  };
  for (const key of PASSTHROUGH_SECRETS) {
    if (process.env[key]) sidecarEnv[key] = process.env[key];
  }

  const sidecar = startProcess(
    "sidecar",
    resolveBunPath(),
    ["run", "sidecar/src/server.ts"],
    sidecarEnv,
  );
  // Vite only hands `VITE_*` variables to the page, so it can keep the shell's
  // env. `TAURI_DEV_HOST` is dropped: it would bind the dev server to the LAN.
  const { TAURI_DEV_HOST: _, ...viteEnv } = process.env;
  const vite = startProcess("vite", join(REPO_ROOT, "node_modules", ".bin", "vite"), [], {
    ...viteEnv,
    YARVIS_DEV_PORT: String(vitePort),
  });
  const stop = async () => {
    await Promise.all([sidecar.child, vite.child].map(stopChild));
  };

  try {
    await Promise.race([
      sidecar.exited,
      waitFor("the sidecar to finish migrating", async () => {
        const res = await fetch(`${sidecarUrl}/health`);
        const body = (await res.json()) as { ready?: boolean; phase?: string; error?: string };
        if (body.phase === "error") throw new Error(`sidecar migration failed: ${body.error}`);
        return body.ready === true;
      }),
    ]);
    await Promise.race([
      vite.exited,
      waitFor("the Vite dev server", async () => (await fetch(appOrigin)).ok),
    ]);
  } catch (e) {
    await stop();
    throw e;
  }

  return {
    appUrl: `${appOrigin}/demo/index.html`,
    sidecarUrl,
    sidecarPort,
    sidecarToken,
    stop,
  };
}
