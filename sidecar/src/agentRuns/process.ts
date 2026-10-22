import { spawn } from "node:child_process";
import { claudeChildEnv } from "../lib/claudeCli.ts";

/**
 * Starts a headless Claude Code process and hands its stdout over line by
 * line, for a caller that wants to react to a run while it works rather than
 * read its answer at the end (`jobs/runners.ts` does that).
 */

/**
 * Longest stdout line read. A line is one stream-json message, and a tool
 * result echoes whatever the tool returned — a whole file, say — so this is
 * generous; a longer line is skipped rather than buffered without bound.
 */
const MAX_LINE_CHARS = 4_000_000;

/** How much stderr is kept for the error message of a failed run. */
const MAX_STDERR_CHARS = 20_000;

/** How long a process is given to exit on SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 5_000;

export interface StreamingLaunch {
  program: string;
  args: string[];
  cwd: string;
  /** Aborting it stops the run: the whole process group is terminated. */
  signal: AbortSignal;
  timeoutMs: number;
  onLine: (line: string) => void;
}

export interface StreamingExit {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  /** The caller's signal aborted the run. */
  aborted: boolean;
}

/**
 * Sends `signal` to the child's whole process group. Claude Code starts tools —
 * a test suite, a build — as children of its own, which would outlive a kill
 * aimed only at it and go on writing into the checkout.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

export function launchStreaming(launch: StreamingLaunch): Promise<StreamingExit> {
  return new Promise<StreamingExit>((resolve, reject) => {
    const child = spawn(launch.program, launch.args, {
      cwd: launch.cwd,
      env: claudeChildEnv(),
      // No shell: the prompt and the directory reach the child as argv, so
      // nothing in them is ever interpreted as a command.
      shell: false,
      // Its own process group, so cancelling reaches everything it started.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let aborted = false;
    let exited = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (exited || child.pid === undefined) return;
      killGroup(child.pid, "SIGTERM");
      forceKill ??= setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      }, KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, launch.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (launch.signal.aborted) onAbort();
    else launch.signal.addEventListener("abort", onAbort, { once: true });

    let buffer = "";
    let skipping = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      let rest = chunk;
      for (let newline = rest.indexOf("\n"); newline !== -1; newline = rest.indexOf("\n")) {
        const piece = rest.slice(0, newline);
        rest = rest.slice(newline + 1);
        if (!skipping) launch.onLine(buffer + piece);
        buffer = "";
        skipping = false;
      }
      if (skipping) return;
      buffer += rest;
      if (buffer.length > MAX_LINE_CHARS) {
        buffer = "";
        skipping = true;
      }
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
    });

    const cleanUp = () => {
      exited = true;
      clearTimeout(timer);
      launch.signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      cleanUp();
      if (forceKill) clearTimeout(forceKill);
      reject(e);
    });
    // Anything still in the group once Claude Code exits was started by the run
    // and left behind — a dev server it backgrounded, say. Nothing is left to
    // read its output, and while it holds the pipes open `close` never comes, so
    // it goes too. A SIGKILL already pending from a stop still fires for
    // whatever ignores this.
    child.on("exit", () => {
      if (child.pid !== undefined) killGroup(child.pid, "SIGTERM");
    });
    child.on("close", (code) => {
      cleanUp();
      if (!skipping && buffer) launch.onLine(buffer);
      resolve({ code, stderr, timedOut, aborted });
    });
  });
}
