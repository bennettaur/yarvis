import { execFile, spawn } from "node:child_process";
import { claudeChildEnv } from "../lib/claudeCli.ts";

/**
 * Starts a headless Claude Code process and hands its stdout over line by
 * line, for a caller that wants to react to a run while it works rather than
 * read its answer at the end (`jobs/runners.ts` does that).
 *
 * Each run is its own process group. Claude Code starts tools — a test suite, a
 * build — as children of its own, which would outlive a kill aimed only at it
 * and go on writing into the checkout, so every kill here is aimed at the group.
 */

/**
 * Longest stdout line read. A line is one stream-json message, and a tool
 * result echoes whatever the tool returned — a whole file, say — so this is
 * generous; a longer line is skipped rather than buffered without bound.
 */
const MAX_LINE_CHARS = 4_000_000;

/**
 * Splits stdout chunks into lines, skipping any longer than `maxChars`. A line
 * can end in the same chunk that takes it over the limit, so the length is
 * checked when a line ends as well as while it is still being buffered.
 * `end` hands over a last line with no newline and returns how many were skipped.
 */
export function lineSplitter(
  onLine: (line: string) => void,
  maxChars = MAX_LINE_CHARS,
): { push: (chunk: string) => void; end: () => number } {
  let buffer = "";
  let skipping = false;
  let skipped = 0;
  return {
    push: (chunk) => {
      const pieces = chunk.split("\n");
      // Every piece but the last ends a line; the last is the start of the next.
      const rest = pieces.pop() ?? "";
      for (const piece of pieces) {
        if (skipping || buffer.length + piece.length > maxChars) skipped++;
        else onLine(buffer + piece);
        buffer = "";
        skipping = false;
      }
      if (skipping) return;
      buffer += rest;
      if (buffer.length > maxChars) {
        buffer = "";
        skipping = true;
      }
    },
    end: () => {
      if (skipping || buffer.length > maxChars) skipped++;
      else if (buffer) onLine(buffer);
      buffer = "";
      skipping = false;
      return skipped;
    },
  };
}

/** How much stderr is kept for the error message of a failed run. */
const MAX_STDERR_CHARS = 20_000;

/** How long a process is given to exit on SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 5_000;

export interface StreamingLaunch {
  program: string;
  args: string[];
  /** Written to the child's stdin, then closed. */
  stdin: string;
  cwd: string;
  /** Aborting it stops the run: the whole process group is terminated. */
  signal: AbortSignal;
  timeoutMs: number;
  onLine: (line: string) => void;
  /** Called with the group id (the child's pid) once it is running. */
  onSpawn?: (pid: number) => void;
}

export interface StreamingExit {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  /** The caller's signal aborted the run. */
  aborted: boolean;
  /** How many stdout lines were over the size limit and dropped. */
  skippedLines: number;
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

/** Whether any process in the group is still alive. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Groups of runs in flight, killed if the sidecar itself exits. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

/**
 * Kills every live run's group when the sidecar exits — including through the
 * parent watcher's `process.exit` when the app is gone. The listener must be
 * synchronous, which `process.kill` is. A SIGKILLed sidecar runs nothing; the
 * startup sweep catches what that leaves behind.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
  });
}

/**
 * When a process started, as `ps` reports it. Stored with a run's pid so a
 * later sweep can tell the process it started from an unrelated one that has
 * since been given the same pid. Null when there is no such process; rejects
 * when `ps` couldn't be asked, which must not read as "no such process".
 */
export function processStartTime(pid: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    try {
      execFile("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
        const started = stdout.trim();
        if (started) resolve(started);
        // `ps` exits 1 with no output for a pid it can't find.
        else if (!error || typeof error.code === "number") resolve(null);
        else reject(error);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Kills what is left of a run's process group from an earlier sidecar, if it is
 * still the same group. A pgid can't be reused while any member of the group is
 * alive, so a live group whose leader is gone is still ours; a live leader must
 * have the start time recorded for it.
 */
export async function killLeftoverGroup(
  pgid: number,
  recordedStart: string | null,
): Promise<boolean> {
  let leaderStart: string | null;
  try {
    leaderStart = await processStartTime(pgid);
  } catch (e) {
    console.error(`[agent-runs] could not check process ${pgid}; leaving it alone:`, e);
    return false;
  }
  const ours =
    leaderStart === null
      ? groupAlive(pgid)
      : recordedStart !== null && leaderStart === recordedStart;
  if (ours) killGroup(pgid, "SIGKILL");
  return ours;
}

export function launchStreaming(launch: StreamingLaunch): Promise<StreamingExit> {
  installExitHook();
  return new Promise<StreamingExit>((resolve, reject) => {
    const child = spawn(launch.program, launch.args, {
      cwd: launch.cwd,
      env: claudeChildEnv(),
      // No shell: the directory and arguments reach the child as argv, so
      // nothing in them is ever interpreted as a command.
      shell: false,
      // Its own process group, so cancelling reaches everything it started.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pgid = child.pid;
    if (pgid !== undefined) {
      liveGroups.add(pgid);
      launch.onSpawn?.(pgid);
    }

    let timedOut = false;
    let aborted = false;
    let closed = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (closed || pgid === undefined) return;
      killGroup(pgid, "SIGTERM");
      forceKill ??= setTimeout(() => killGroup(pgid, "SIGKILL"), KILL_GRACE_MS);
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

    // A child that exits before reading its stdin makes the write fail with
    // EPIPE; how it exited is what the caller needs, not that.
    child.stdin?.on("error", () => {});
    child.stdin?.end(launch.stdin);

    const lines = lineSplitter(launch.onLine);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", lines.push);

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
    });

    const cleanUp = () => {
      closed = true;
      clearTimeout(timer);
      launch.signal.removeEventListener("abort", onAbort);
      if (pgid !== undefined) liveGroups.delete(pgid);
    };
    // Anything still in the group once Claude Code exits was started by the run
    // and left behind — a dev server it backgrounded, say. Nothing is left to
    // read its output, and while it holds the pipes open `close` never comes, so
    // it goes too.
    child.on("exit", () => {
      if (pgid !== undefined) killGroup(pgid, "SIGTERM");
    });
    child.on("error", (e) => {
      cleanUp();
      if (forceKill) clearTimeout(forceKill);
      reject(e);
    });
    child.on("close", (code) => {
      cleanUp();
      const skippedLines = lines.end();
      // Keep the pending SIGKILL only for a straggler that ignored SIGTERM.
      if (forceKill && (pgid === undefined || !groupAlive(pgid))) clearTimeout(forceKill);
      resolve({ code, stderr, timedOut, aborted, skippedLines });
    });
  });
}
