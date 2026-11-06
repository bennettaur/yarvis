import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { settingsPath } from "../settings/store.ts";
import { speechChildEnv } from "./server.ts";
import script from "./turn_server.py" with { type: "text" };

/**
 * Runs the turn detector that continuous voice mode streams the microphone to:
 * Silero VAD to hear speech and pauses, and smart-turn to judge whether a pause
 * ends the user's turn. See `turn_server.py` for the protocol.
 *
 * Unlike the mlx-audio server, each sidecar runs its own on a port the OS
 * picks, so instances never share or fight over one. It starts when a chat
 * first asks for it and stops when the sidecar exits, staying up between
 * conversations so a second one doesn't wait for the models to load again. A sidecar killed without
 * warning closes the server's stdin, which the server exits on.
 *
 * The script ships embedded in the sidecar, because a packaged app has no repo
 * checkout. It is written out before each start and run with
 * `uv run --script`, which installs its pinned dependencies once and caches them.
 */

/** Lines of the server's output kept for the status view. */
const LOG_TAIL_LINES = 200;

/** Lines of that log written to sidecar.log beside a failure. */
const FAILURE_LOG_LINES = 5;

const READY_LINE = /^YARVIS_TURN_READY (\d+)$/;

/**
 * How long a start may take before it counts as hung. Generous, because the
 * first start installs the Python packages and downloads the models.
 */
const START_TIMEOUT_MS = 10 * 60_000;

export type TurnDetectorState = "stopped" | "starting" | "running" | "failed";

export interface TurnDetectorStatus {
  state: TurnDetectorState;
  /** Where to connect, token included. Null until the server is listening. */
  url: string | null;
  log: string[];
  error: string | null;
}

export interface TurnDetectorDeps {
  spawn: (program: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** Writes the server script and returns its path. */
  writeScript: () => string;
  /** The token every websocket connection must present. */
  newToken: () => string;
  /** Kills the server's process group. */
  kill: (pid: number) => void;
  startTimeoutMs: number;
}

/**
 * Writes the server script beside settings.json and returns its path.
 *
 * Instances share ~/.yarvis, so the file is named for its contents: two builds
 * never run each other's script. Older builds' files are left in place, since
 * one may still be running. Written to a temp file and renamed, so another
 * instance's uv never reads half of it.
 */
export function writeTurnServerScript(source: string): string {
  const dir = join(dirname(settingsPath()), "voice");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const file = join(dir, `turn_server.${hash}.py`);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, source, { mode: 0o600, flag: "w" });
  renameSync(temp, file);
  return file;
}

const defaultTurnDetectorDeps: TurnDetectorDeps = {
  spawn: (program, args, env) =>
    spawn(program, args, {
      env,
      shell: false,
      // Its own process group, so stopping it reaches the Python process uv starts.
      detached: true,
      // stdin stays open for the server's lifetime; its closing is the exit signal.
      stdio: ["pipe", "pipe", "pipe"],
    }),
  writeScript: () => writeTurnServerScript(script),
  newToken: () => randomBytes(32).toString("hex"),
  kill: (pid) => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  },
  startTimeoutMs: START_TIMEOUT_MS,
};

/** Splits a stream into lines, holding back a line that hasn't ended yet. */
function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let partialLine = "";
  return (chunk) => {
    const lines = (partialLine + chunk.toString()).split("\n");
    partialLine = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
}

export class TurnDetector {
  private child: ChildProcess | null = null;
  /**
   * The last process started. Kept after it exits so its final output is still
   * logged; output from earlier processes is ignored.
   */
  private latestChild: ChildProcess | null = null;
  private port: number | null = null;
  private token = "";
  private log: string[] = [];
  private error: string | null = null;
  private exitHookInstalled = false;

  constructor(private readonly deps: TurnDetectorDeps = defaultTurnDetectorDeps) {}

  status(): TurnDetectorStatus {
    let state: TurnDetectorState;
    if (this.child) state = this.port === null ? "starting" : "running";
    else state = this.error ? "failed" : "stopped";
    return {
      state,
      url:
        state === "running"
          ? `ws://127.0.0.1:${this.port}/?token=${encodeURIComponent(this.token)}`
          : null,
      log: this.log,
      error: this.error,
    };
  }

  /** Starts the server unless it is already starting or running. Answers at once. */
  start(): TurnDetectorStatus {
    if (this.child) return this.status();
    this.installExitHook();
    this.port = null;
    this.log = [];
    this.error = null;
    this.token = this.deps.newToken();

    let path: string;
    try {
      path = this.deps.writeScript();
    } catch (e) {
      this.report(
        `could not write the turn detector script: ${e instanceof Error ? e.message : e}`,
      );
      return this.status();
    }

    // The built environment keeps provider keys and the sidecar's bearer out of
    // the child; the token is the one secret it gets.
    const env = {
      ...speechChildEnv(),
      YARVIS_TURN_TOKEN: this.token,
      HF_HUB_DISABLE_TELEMETRY: "1",
    };
    const child = this.deps.spawn("uv", ["run", "--quiet", "--script", path], env);
    this.child = child;
    this.latestChild = child;

    const startTimer = setTimeout(() => {
      if (this.child !== child || this.port !== null) return;
      this.fail(child, "the turn detector didn't start in time; see its log");
    }, this.deps.startTimeoutMs);
    startTimer.unref?.();

    child.stdout?.on(
      "data",
      lineReader((line) => {
        const ready = READY_LINE.exec(line.trim());
        if (ready && this.child === child) {
          this.port = Number(ready[1]);
          clearTimeout(startTimer);
        } else if (this.latestChild === child) this.append(line);
      }),
    );
    child.stderr?.on(
      "data",
      lineReader((line) => {
        if (this.latestChild === child) this.append(line);
      }),
    );
    child.on("error", (e) => {
      clearTimeout(startTimer);
      if (this.child !== child) return;
      this.child = null;
      this.report(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "uv is not installed. Install it with `brew install uv`."
          : e.message,
      );
    });
    child.on("exit", (code, signal) => {
      clearTimeout(startTimer);
      if (this.child !== child) return;
      this.child = null;
      this.port = null;
      this.report(`the turn detector exited (${signal ?? `code ${code}`}); see its log`);
    });
    return this.status();
  }

  /** Kills a server and reports why, so the next start begins fresh. */
  private fail(child: ChildProcess, error: string): void {
    this.child = null;
    this.port = null;
    this.report(error);
    if (child.pid !== undefined) this.deps.kill(child.pid);
  }

  /** Records why the server stopped or couldn't start, in the status and in sidecar.log. */
  private report(error: string): void {
    this.error = error;
    console.warn(`[voice] ${error}`, this.log.slice(-FAILURE_LOG_LINES));
  }

  private append(line: string): void {
    if (!line.trim()) return;
    this.log = [...this.log, line].slice(-LOG_TAIL_LINES);
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.on("exit", () => {
      const pid = this.child?.pid;
      if (pid !== undefined) this.deps.kill(pid);
    });
  }
}
