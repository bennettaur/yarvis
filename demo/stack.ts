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

export const REPO_ROOT = join(import.meta.dirname, "..");
export const OUTPUT_DIR = join(REPO_ROOT, "demo", "output");
const STATE_DIR = join(OUTPUT_DIR, ".state");

const DEFAULT_DATABASE_URL = "postgres://localhost:5432/yarvis_demo";

/** Provider keys the sidecar may use when they're set in the runner's env. */
const PASSTHROUGH_SECRETS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY"];

export interface Stack {
  /** The app's URL, `demo/index.html` on the Vite dev server. */
  appUrl: string;
  sidecarUrl: string;
  sidecarPort: number;
  sidecarToken: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
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

/**
 * Drops and recreates the demo database so every run starts from the same
 * seed. Refuses any database whose name doesn't contain "demo", since a
 * mistyped URL here would wipe real data.
 */
function recreateDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, "");
  if (!/demo/i.test(name)) {
    throw new Error(
      `refusing to recreate database "${name}": demo databases must have "demo" in their name`,
    );
  }
  url.pathname = "/postgres";
  for (const sql of [
    `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
    `CREATE DATABASE "${name}"`,
  ]) {
    const result = spawnSync("psql", [url.toString(), "-v", "ON_ERROR_STOP=1", "-qc", sql], {
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
function bunBinary(): string {
  const result = spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not run bun: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

function start(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const verbose = process.env.DEMO_VERBOSE === "1";
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => `[${name}] ${line}\n`)
      .join("");
  child.stdout?.on("data", (chunk: Buffer) => verbose && process.stdout.write(prefix(chunk)));
  // Errors always show: a sidecar that fails to boot otherwise looks like a
  // timeout with no explanation.
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(prefix(chunk)));
  return child;
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
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

export async function startStack(): Promise<Stack> {
  const databaseUrl = process.env.YARVIS_DEMO_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  recreateDatabase(databaseUrl);

  rmSync(STATE_DIR, { recursive: true, force: true });
  const home = join(STATE_DIR, "home");
  const workspacesRoot = join(STATE_DIR, "workspaces");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspacesRoot, { recursive: true });

  const [sidecarPort, vitePort] = await Promise.all([freePort(), freePort()]);
  const sidecarToken = randomBytes(24).toString("hex");
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

  const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
  const sidecar = start("sidecar", bunBinary(), ["run", "sidecar/src/server.ts"], sidecarEnv);
  const vite = start(
    "vite",
    join(REPO_ROOT, "node_modules", ".bin", "vite"),
    ["--port", String(vitePort), "--strictPort"],
    { ...process.env, YARVIS_DEV_PORT: String(vitePort) },
  );
  const children = [sidecar, vite];
  const stop = async () => {
    await Promise.all(children.map(stopChild));
  };

  try {
    await waitFor("the sidecar to finish migrating", async () => {
      const res = await fetch(`${sidecarUrl}/health`);
      const body = (await res.json()) as { ready?: boolean; phase?: string; error?: string };
      if (body.phase === "error") throw new Error(`sidecar migration failed: ${body.error}`);
      return body.ready === true;
    });
    await waitFor("the Vite dev server", async () => (await fetch(appOrigin)).ok);
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
