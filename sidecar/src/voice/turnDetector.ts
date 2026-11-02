import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
 * first asks for it and stops when the sidecar exits. A sidecar killed without
 * warning closes the server's stdin, which the server exits on.
 *
 * The script ships embedded in the sidecar, because a packaged app has no repo
 * checkout. It is written out before each start and run with
 * `uv run --script`, which installs its pinned dependencies once and caches them.
 */

/** Lines of the server's output kept for the status view. */
const LOG_TAIL_LINES = 200;

const READY_LINE = /^YARVIS_TURN_READY (\d+)$/;

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
}

export const defaultTurnDetectorDeps: TurnDetectorDeps = {
  spawn: (program, args, env) =>
    spawn(program, args, {
      env,
      shell: false,
      // Its own process group, so stopping it reaches the Python process uv starts.
      detached: true,
      // stdin stays open for the server's lifetime; its closing is the exit signal.
      stdio: ["pipe", "pipe", "pipe"],
    }),
  writeScript: () => {
    const dir = join(dirname(settingsPath()), "voice");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "turn_server.py");
    writeFileSync(file, script, { mode: 0o600 });
    return file;
  },
  newToken: () => randomBytes(32).toString("hex"),
};

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

export class TurnDetector {
  private child: ChildProcess | null = null;
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
      this.error = `could not write the turn detector script: ${e instanceof Error ? e.message : e}`;
      return this.status();
    }

    // The built environment keeps provider keys and the sidecar's bearer out of
    // the child; the token is the one secret it gets.
    const env = { ...speechChildEnv(), YARVIS_TURN_TOKEN: this.token };
    const child = this.deps.spawn("uv", ["run", "--quiet", "--script", path], env);
    this.child = child;

    let pending = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const ready = READY_LINE.exec(line.trim());
        if (ready && this.child === child) this.port = Number(ready[1]);
        else this.append(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      for (const line of chunk.toString().split("\n")) this.append(line);
    });
    child.on("error", (e) => {
      if (this.child !== child) return;
      this.child = null;
      this.error =
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? "uv is not installed. Install it with `brew install uv`."
          : e.message;
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.port = null;
      this.error = `the turn detector exited (${signal ?? `code ${code}`}); see its log`;
    });
    return this.status();
  }

  stop(): TurnDetectorStatus {
    const pid = this.child?.pid;
    this.child = null;
    this.port = null;
    this.error = null;
    if (pid !== undefined) killGroup(pid);
    return this.status();
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
      if (pid !== undefined) killGroup(pid);
    });
  }
}
