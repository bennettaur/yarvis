/**
 * Starts everything a demo needs: a fresh demo database, the fake chat model,
 * GitHub, Google and JIRA servers, a sidecar pointed at all of them, and the
 * Vite dev server serving `demo/index.html`.
 *
 * The sidecar's home directory and settings file point into
 * `demo/output/.state/` and its workspaces root into `/tmp/yarvis-demo/`, so
 * nothing from the real Yarvis install (its memories, Claude Code sessions,
 * workspaces) can show up in a screenshot. One run at a time per machine:
 * runs share the demo database and the workspaces root.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { startFakeGithub } from "./fakeGithub/server";
import { startFakeGoogle } from "./fakeGoogle/server";
import { SITE_URL as JIRA_SITE_URL, VIEWER as JIRA_VIEWER } from "./fakeJira/data";
import { startFakeJira } from "./fakeJira/server";
import { FAKE_MODEL, startFakeLlm } from "./fakeLlm/server";
import { OUTPUT_DIR, REPO_ROOT } from "./paths";

const STATE_DIR = join(OUTPUT_DIR, ".state");
/**
 * The app shows a workspace's full path, so workspaces live somewhere that
 * doesn't reveal the developer's username or folder layout.
 */
export const DEMO_TMP = "/tmp/yarvis-demo";
export const WORKSPACES_ROOT = join(DEMO_TMP, "workspaces");

/**
 * Makes `/tmp/yarvis-demo` ours before anything under it is deleted. Any local
 * user can create paths in /tmp, so one that's a symlink, someone else's, or
 * writable by others could redirect the cleanup or the workspace writes.
 */
function claimDemoTmp(): void {
  mkdirSync(DEMO_TMP, { recursive: true, mode: 0o700 });
  const info = lstatSync(DEMO_TMP);
  const ours = info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.();
  if (!ours) {
    throw new Error(`refusing to use ${DEMO_TMP}: it must be a directory you own, not a symlink`);
  }
  // Ours already, so closing it to everyone else is safe; the workspaces
  // inside are wiped and recreated after this.
  chmodSync(DEMO_TMP, 0o700);
}

const DEFAULT_DATABASE_URL = "postgres://localhost:5432/yarvis_demo";

/** Provider keys the sidecar may use when they're set in the runner's env. */
export const PASSTHROUGH_SECRETS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY"];

/**
 * The custom provider that points at the fake model. Its id is fixed so the
 * fixture can select it before the page loads.
 */
export const FAKE_PROVIDER_ID = "00000000-0000-4000-8000-00000000de70";
/** The fake model's provider id as the sidecar and the chat pickers name it. */
export const FAKE_PROVIDER = `custom:${FAKE_PROVIDER_ID}`;
const FAKE_PROVIDER_NAME = "Demo model";

/** Shown in Settings, so it should look like a Google OAuth client id. */
export const DEMO_GOOGLE_CLIENT_ID = "123456789012-demo.apps.googleusercontent.com";

/**
 * Registers the fake model as a custom provider, written straight into the
 * sidecar's settings file the way its own custom-provider routes store one.
 * PR line questions and guided reviews pick their model on the sidecar, not
 * from the page, so they're pinned to it too: otherwise a provider key passed
 * through from the runner's env would send them to a real model.
 */
function writeFakeProvider(settingsPath: string, fakeLlmUrl: string): void {
  const now = new Date().toISOString();
  const provider = {
    id: FAKE_PROVIDER_ID,
    name: FAKE_PROVIDER_NAME,
    baseUrl: `${fakeLlmUrl}/v1`,
    apiKind: "openai-chat",
    models: [FAKE_MODEL],
    headerNames: [],
    createdAt: now,
    updatedAt: now,
  };
  const fakeModel = { provider: FAKE_PROVIDER, model: FAKE_MODEL };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        customProviders: { [provider.id]: provider },
        prModels: { guide: fakeModel, ask: fakeModel },
      },
      null,
      2,
    ),
  );
}

/** The specialist the scheduled-jobs flow runs, by the `name:` the Specialist picker lists. */
export const DEMO_SPECIALIST = "standup-writer";

/**
 * Writes a specialist that runs on the fake model. A job on the default agent
 * would run on the default chat model, which is a real provider whenever the
 * runner passes a provider key through.
 */
function writeDemoSpecialist(agentsDir: string): void {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${DEMO_SPECIALIST}.md`),
    [
      "---",
      `name: ${DEMO_SPECIALIST}`,
      "description: Drafts a standup update from the user's tasks.",
      "tools: [list_tasks]",
      `model: ${FAKE_PROVIDER}/${FAKE_MODEL}`,
      "maxSteps: 4",
      "---",
      "",
      "You draft the user's standup update from their task list. Keep it to three short sections: yesterday, today, blockers.",
      "",
    ].join("\n"),
  );
}

export interface Stack {
  /** The app's URL, `demo/index.html` on the Vite dev server. */
  appUrl: string;
  databaseUrl: string;
  sidecarUrl: string;
  sidecarPort: number;
  sidecarToken: string;
  stop(): Promise<void>;
}

const closeServers = (servers: Server[]) =>
  Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));

/** Starts the fake model, GitHub, Google and JIRA, closing any already running if one fails. */
async function startFakes(ports: { llm: number; github: number; google: number; jira: number }) {
  const started: Server[] = [];
  try {
    started.push(await startFakeLlm(ports.llm));
    started.push(await startFakeGithub(ports.github));
    started.push(await startFakeGoogle(ports.google));
    started.push(await startFakeJira(ports.jira));
  } catch (e) {
    await closeServers(started);
    throw e;
  }
  return started;
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
  claimDemoTmp();
  rmSync(WORKSPACES_ROOT, { recursive: true, force: true });
  const home = join(STATE_DIR, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(WORKSPACES_ROOT, { recursive: true });

  const [sidecarPort, vitePort, fakeLlmPort, fakeGithubPort, fakeGooglePort, fakeJiraPort] =
    await Promise.all(Array.from({ length: 6 }, findFreePort));
  const sidecarToken = randomBytes(24).toString("hex");
  const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
  const appOrigin = `http://localhost:${vitePort}`;
  const fakeLlmUrl = `http://127.0.0.1:${fakeLlmPort}`;
  const fakeGithubUrl = `http://127.0.0.1:${fakeGithubPort}`;
  const fakeGoogleUrl = `http://127.0.0.1:${fakeGooglePort}`;
  const fakeJiraUrl = `http://127.0.0.1:${fakeJiraPort}`;

  const settingsPath = join(home, ".yarvis", "settings.json");
  writeFakeProvider(settingsPath, fakeLlmUrl);
  const agentsDir = join(home, ".yarvis", "agents");
  writeDemoSpecialist(agentsDir);
  // Resolved before anything starts: past this point a failure has to stop
  // what's running, which only the try block below does.
  const bunPath = resolveBunPath();
  const fakes = await startFakes({
    llm: fakeLlmPort,
    github: fakeGithubPort,
    google: fakeGooglePort,
    jira: fakeJiraPort,
  });

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
    YARVIS_SETTINGS_PATH: settingsPath,
    // The AI SDK won't send a request without a key. The fake model ignores it.
    YARVIS_CUSTOM_PROVIDER_SECRETS: JSON.stringify({ [FAKE_PROVIDER_ID]: { apiKey: "demo" } }),
    // GitHub, Google and JIRA point at the fakes. The credentials only have to
    // be present for the sidecar to call them; the fakes ignore their values.
    GITHUB_TOKEN: "demo-github-token",
    YARVIS_GITHUB_API_URL: fakeGithubUrl,
    YARVIS_GITHUB_GRAPHQL_URL: `${fakeGithubUrl}/graphql`,
    GOOGLE_CLIENT_ID: DEMO_GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "demo-google-secret",
    YARVIS_GOOGLE_CALENDAR_API_URL: `${fakeGoogleUrl}/calendar/v3`,
    YARVIS_GOOGLE_TOKEN_URL: `${fakeGoogleUrl}/token`,
    // The site is what links into JIRA show; requests go to the fake.
    JIRA_BASE_URL: JIRA_SITE_URL,
    JIRA_EMAIL: JIRA_VIEWER.emailAddress,
    JIRA_API_TOKEN: "demo-jira-token",
    YARVIS_JIRA_API_URL: fakeJiraUrl,
    YARVIS_AGENTS_DIR: agentsDir,
    YARVIS_WORKSPACES_ROOT: WORKSPACES_ROOT,
    CLAUDE_HOME: join(home, ".claude"),
  };
  for (const key of PASSTHROUGH_SECRETS) {
    if (process.env[key]) sidecarEnv[key] = process.env[key];
  }

  const sidecar = startProcess("sidecar", bunPath, ["run", "sidecar/src/server.ts"], sidecarEnv);
  // Vite only hands `VITE_*` variables to the page, so it can keep the shell's
  // env. `TAURI_DEV_HOST` is dropped: it would bind the dev server to the LAN.
  const { TAURI_DEV_HOST: _, ...viteEnv } = process.env;
  const vite = startProcess("vite", join(REPO_ROOT, "node_modules", ".bin", "vite"), [], {
    ...viteEnv,
    YARVIS_DEV_PORT: String(vitePort),
  });
  const stop = async () => {
    await Promise.all([sidecar.child, vite.child].map(stopChild));
    await closeServers(fakes);
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
    databaseUrl,
    sidecarUrl,
    sidecarPort,
    sidecarToken,
    stop,
  };
}
