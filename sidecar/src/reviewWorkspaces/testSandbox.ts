/**
 * Runs a PR's tests from the sidecar, inside a macOS Seatbelt sandbox.
 *
 * Claude Code's sandbox only wraps the commands Claude Code runs, and mutation
 * testing runs the tests itself, so it brings its own: `sandbox-exec` with a
 * profile that
 *  - denies the network, except loopback (test servers bound to 127.0.0.1) and
 *    Unix sockets — with DNS resolution (mDNSResponder) denied too, since a
 *    lookup is a way out on its own;
 *  - denies writes anywhere but the scratch copy, a per-run temp folder and a
 *    few devices;
 *  - denies reads of the home-directory credentials in `SECRET_HOME_PATHS`.
 * Everything else is allowed, because test runners read toolchains from all
 * over the disk. There is no fallback: where the sandbox can't be applied the
 * tests don't run (`SandboxUnavailableError`).
 *
 * Commands are argv, never a shell line, with the review setup's environment
 * (no provider secrets, no SSH agent) and their own process group, so a
 * timeout or a cancel kills everything they started.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SECRET_HOME_PATHS } from "../agentRuns/service.ts";
import { scrubbedEnv } from "../workspaces/exec.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** How much output is kept: the tail, where runners print their summary. */
const MAX_OUTPUT_CHARS = 64_000;

const KILL_GRACE_MS = 5_000;

/** Withheld like the setup script's environment (see `SETUP_WITHHELD_ENV`). */
const WITHHELD_ENV = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH", "GIT_SSH_COMMAND"];

export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(`the test sandbox is unavailable, so no tests were run: ${detail}`);
    this.name = "SandboxUnavailableError";
  }
}

/** A Seatbelt string literal. Paths come from our own temp and review folders. */
function sbString(value: string): string {
  if (/["\\\0\n]/.test(value)) throw new Error(`unsafe path for the sandbox profile: ${value}`);
  return `"${value}"`;
}

/**
 * The profile for one run. Every path is a realpath, since Seatbelt matches
 * the resolved path (`/private/var/…`, not `/var/…`).
 */
export function sandboxProfile(options: { writable: string[]; home?: string }): string {
  const home = realpathOr(options.home ?? homedir());
  const writable = options.writable.map((dir) => `(subpath ${sbString(realpathSync(dir))})`);
  const secrets = SECRET_HOME_PATHS.map((path) => `(subpath ${sbString(join(home, path))})`);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(allow network-outbound (remote unix-socket))",
    '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(deny mach-lookup (global-name "com.apple.dnssd.service"))',
    "(deny file-write*)",
    `(allow file-write* ${writable.join(" ")} ${[
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/tty")',
      '(literal "/dev/dtracehelper")',
      '(regex #"^/dev/fd/")',
      '(regex #"^/dev/ttys[0-9]+$")',
    ].join(" ")})`,
    `(deny file-read* ${secrets.join(" ")})`,
  ].join("\n");
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface SandboxedRun {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** The tail of stdout and stderr together. */
  output: string;
}

export interface SandboxedCommand {
  argv: string[];
  cwd: string;
  /** Where the command may write besides `cwd`; its TMPDIR is the first. */
  tempDir: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Tests point this at a fake home. */
  home?: string;
}

export type SandboxRunner = (command: SandboxedCommand) => Promise<SandboxedRun>;

/** Groups still running, killed if the sidecar exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

export function assertSandboxAvailable(): void {
  if (process.platform !== "darwin") {
    throw new SandboxUnavailableError("sandboxed test runs are only supported on macOS");
  }
  if (!existsSync(SANDBOX_EXEC)) throw new SandboxUnavailableError(`${SANDBOX_EXEC} not found`);
}

/**
 * Tool caches that default to somewhere under the home directory, pointed at
 * the run's temp folder instead: the sandbox refuses writes under `~`, and a
 * runner that can't write its cache fails before any test runs. Go's module
 * cache (`GOMODCACHE`) is left where it is, since only reads of it are needed
 * offline. Cargo builds into the copy's own `target/` already.
 */
function cacheEnv(tempDir: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: join(tempDir, "cache"),
    GOCACHE: join(tempDir, "go-build"),
    npm_config_cache: join(tempDir, "npm"),
    YARN_CACHE_FOLDER: join(tempDir, "yarn"),
    BUN_INSTALL_CACHE_DIR: join(tempDir, "bun"),
    PIP_CACHE_DIR: join(tempDir, "pip"),
    PYTHONPYCACHEPREFIX: join(tempDir, "pycache"),
  };
}

/** The scrubbed environment a sandboxed command gets. Exported for tests. */
export function sandboxEnv(command: Pick<SandboxedCommand, "tempDir" | "home">) {
  return scrubbedEnv(
    {
      TMPDIR: command.tempDir,
      ...cacheEnv(command.tempDir),
      // Runners that watch by default (vitest, jest) run once under CI.
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...(command.home ? { HOME: command.home } : {}),
    },
    WITHHELD_ENV,
  );
}

export const runSandboxed: SandboxRunner = (command) => {
  assertSandboxAvailable();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
    });
  }
  const profile = sandboxProfile({
    writable: [command.cwd, command.tempDir],
    ...(command.home ? { home: command.home } : {}),
  });
  const started = Date.now();
  return new Promise<SandboxedRun>((resolve, reject) => {
    const child = spawn(SANDBOX_EXEC, ["-p", profile, ...command.argv], {
      cwd: command.cwd,
      env: sandboxEnv(command),
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = child.pid;
    if (pgid !== undefined) liveGroups.add(pgid);

    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    let aborted = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (pgid === undefined) return;
      killGroup(pgid, "SIGTERM");
      forceKill ??= setTimeout(() => killGroup(pgid, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, command.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (command.signal.aborted) onAbort();
    else command.signal.addEventListener("abort", onAbort, { once: true });

    const cleanUp = () => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      command.signal.removeEventListener("abort", onAbort);
      if (pgid !== undefined) {
        // Whatever the tests left running in the background goes with them.
        killGroup(pgid, "SIGKILL");
        liveGroups.delete(pgid);
      }
    };
    child.on("error", (e) => {
      cleanUp();
      reject(e);
    });
    child.on("close", (code) => {
      cleanUp();
      resolve({ exitCode: code, timedOut, aborted, durationMs: Date.now() - started, output });
    });
  });
};

/**
 * Checks, before any test runs, that the sandbox applies and holds: a command
 * inside it can run, and can't write next to the copy. A sandbox that can't be
 * applied (a nested one, say) fails here rather than letting a test run
 * outside it.
 */
export async function checkSandbox(
  runner: SandboxRunner,
  dirs: { cwd: string; tempDir: string; outside: string },
): Promise<void> {
  const probe = join(dirs.outside, `.yarvis-sandbox-probe-${process.pid}`);
  const signal = new AbortController().signal;
  const ran = await runner({
    argv: ["/bin/sh", "-c", 'echo ok; echo escaped > "$1"', "sh", probe],
    cwd: dirs.cwd,
    tempDir: dirs.tempDir,
    timeoutMs: 15_000,
    signal,
  });
  if (!ran.output.includes("ok")) {
    throw new SandboxUnavailableError(ran.output.trim().slice(0, 500) || "it did not start");
  }
  if (existsSync(probe)) {
    rmSync(probe, { force: true });
    throw new SandboxUnavailableError("a write outside the copy was not refused");
  }
}
