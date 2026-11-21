import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A real `yarvis-server` for the end-to-end tests: its own temp data dir and
 * HOME, the vault backend so nothing touches the Keychain, the ssh-agent on,
 * no sidecar, and the built web UI from `dist/`.
 */

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const BINARY = process.env.YARVIS_SERVER_BIN ?? join(ROOT, "server/target/debug/yarvis-server");

export interface TestServer {
  origin: string;
  dataDir: string;
  /** The HOME the server and its shells see. */
  home: string;
  recoveryKey: string;
  /** The vault's git signing key, `ssh-ed25519 AAAA… yarvis-server`. */
  signingKey: string;
  /** Runs the server's CLI against this server's config. */
  cli: (args: string[]) => string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export async function startServer(): Promise<TestServer> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("build the web UI first: bun run build");
  }
  if (!existsSync(BINARY)) {
    throw new Error(
      `build the server first: cargo build --manifest-path server/Cargo.toml (${BINARY})`,
    );
  }
  const root = mkdtempSync(join(tmpdir(), "yarvis-e2e-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  // `localhost`, not 127.0.0.1: WebAuthn needs the RP ID to be a domain.
  const origin = `http://localhost:${port}`;
  const configPath = join(root, "server.toml");
  writeFileSync(
    configPath,
    [
      "[server]",
      `bind = "127.0.0.1:${port}"`,
      `data_dir = ${JSON.stringify(dataDir)}`,
      `web_dir = ${JSON.stringify(DIST)}`,
      "[auth]",
      `rp_id = "localhost"`,
      `origins = [${JSON.stringify(origin)}]`,
      "[secrets]",
      `backend = "vault"`,
      "[ssh_agent]",
      "enabled = true",
      "[sidecar]",
      "enabled = false",
      "",
    ].join("\n"),
  );
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    // A plain shell, so the user's rc files don't run in the test's terminals.
    SHELL: "/bin/sh",
    ENV: "",
    YARVIS_SETTINGS_PATH: join(home, ".yarvis", "settings.json"),
    RUST_LOG: "warn",
  };
  const cli = (args: string[]) =>
    execFileSync(BINARY, ["--config", configPath, ...args], { env, encoding: "utf8" });

  // `vault init` prints the recovery key on stdout and the signing key on stderr.
  const init = spawnSyncText(BINARY, ["--config", configPath, "vault", "init"], env);
  const recoveryKey = init.stdout.trim();
  const signingKey = init.stderr.match(/ssh-ed25519 \S+ \S+/)?.[0];
  if (!recoveryKey || !signingKey) throw new Error(`vault init said: ${init.stderr}`);

  const child: ChildProcess = spawn(BINARY, ["--config", configPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    log += chunk;
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`yarvis-server didn't start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    origin,
    dataDir,
    home,
    recoveryKey,
    signingKey,
    cli,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function spawnSyncText(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const out = spawnSync(command, args, { env, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${out.stderr}`);
  return out;
}

/** The one-time code the server wrote when it found no passkey. */
export const setupCode = (server: TestServer) =>
  readFileSync(join(server.dataDir, "setup-code"), "utf8").trim();
