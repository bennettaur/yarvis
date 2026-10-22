/**
 * Thin process-spawning wrapper around `Bun.spawn`. This is the only place in
 * the sidecar that shells out, so it centralizes two concerns:
 *
 *  - **Env scrubbing.** The sidecar process inherits provider secrets
 *    (ANTHROPIC_API_KEY, GITHUB_TOKEN, …) injected by the Rust core. Git and
 *    user-authored setup/run scripts must NOT see those, so commands run with a
 *    minimal allowlisted env plus any explicit extras the caller passes.
 *  - **Timeouts.** A hung git fetch or runaway script can't block forever.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Env vars passed through to spawned commands. Deliberately excludes every
 * provider secret. Keeps what git/ssh and typical build tooling need to work.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "SSH_AUTH_SOCK", // git over SSH needs the user's agent
  "SSH_AGENT_PID",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "XDG_CONFIG_HOME",
];

/** Builds an allowlisted env, minus `without`, overlaying any explicit extras. */
export function scrubbedEnv(
  extra: Record<string, string | undefined> = {},
  without: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined && !without.includes(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Extra env entries overlaid on the scrubbed allowlist. */
  env?: Record<string, string | undefined>;
  /** Written to the command's stdin; without it stdin is closed. */
  stdin?: string;
  /** Allowlisted variables to withhold from this command. */
  withoutEnv?: readonly string[];
}

export interface RunBytesResult {
  stdout: Uint8Array;
  stderr: string;
  exitCode: number;
}

/** Spawns a command with the scrubbed env and a timeout, and collects its output. */
async function spawnAndCollect(args: string[], opts: RunOptions): Promise<RunBytesResult> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: scrubbedEnv(opts.env, opts.withoutEnv),
    stdin: opts.stdin === undefined ? undefined : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new Error(`command timed out after ${timeoutMs}ms: ${args.join(" ")}`);
    }
    return { stdout: new Uint8Array(stdout), stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a command to completion, capturing stdout/stderr. Never inherits secrets. */
export async function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const result = await spawnAndCollect(args, opts);
  return { ...result, stdout: new TextDecoder().decode(result.stdout) };
}

/**
 * Like {@link run}, but hands stdout back as bytes. For reading file contents
 * out of git, where decoding as text would mangle a binary file before anything
 * could tell it was one.
 */
export function runBytes(args: string[], opts: RunOptions = {}): Promise<RunBytesResult> {
  return spawnAndCollect(args, opts);
}

export interface CappedRunResult extends RunResult {
  /** Stopped early: stdout reached `maxBytes`, or the time ran out. */
  stopped: "bytes" | "timeout" | null;
}

/**
 * Like {@link run}, but for a command whose output can be far bigger than
 * anyone wants (a search): stdout is read as it arrives and the process is
 * killed once `maxBytes` have come in, or when the time runs out. Either way
 * it answers with what it had rather than throwing, cut back to the last
 * complete line.
 */
export async function runCapped(
  args: string[],
  opts: RunOptions & { maxBytes: number },
): Promise<CappedRunResult> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: scrubbedEnv(opts.env, opts.withoutEnv),
    stdin: opts.stdin === undefined ? undefined : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  let stopped: CappedRunResult["stopped"] = null;
  const timer = setTimeout(() => {
    stopped ??= "timeout";
    proc.kill();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const readStdout = async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= opts.maxBytes) {
        stopped ??= "bytes";
        proc.kill();
        await reader.cancel().catch(() => {});
        break;
      }
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };

  try {
    const [bytes, stderr, exitCode] = await Promise.all([
      readStdout(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let stdout = new TextDecoder().decode(bytes);
    if (stopped) stdout = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
    return { stdout, stderr, exitCode, stopped };
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamOptions extends Omit<RunOptions, "stdin"> {
  /** Called with each decoded chunk of stdout/stderr as it arrives. */
  onChunk: (text: string) => void | Promise<void>;
}

/**
 * Runs a command, streaming combined stdout+stderr to `onChunk` as it arrives.
 * Resolves with the exit code. Used to surface setup-script output live over SSE.
 */
export async function runStreaming(args: string[], opts: StreamOptions): Promise<number> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: scrubbedEnv(opts.env, opts.withoutEnv),
    stdout: "pipe",
    stderr: "pipe",
  });

  // A hung script (waits on stdin, accidentally starts a long-lived server)
  // must not block provisioning forever while holding the per-repo lock.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const decoder = new TextDecoder();
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        await opts.onChunk(decoder.decode(chunk));
      }
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const exitCode = await proc.exited;
    if (timedOut) {
      throw new Error(`command timed out after ${timeoutMs}ms: ${args.join(" ")}`);
    }
    return exitCode;
  } finally {
    clearTimeout(timer);
  }
}

/** How long a repo's setup script may run before it is killed. */
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How much of a setup script's output is kept on the row once it finishes. The
 * live stream carries all of it; what is stored is the tail, which is where a
 * failure says why.
 */
export const SETUP_LOG_CAP = 16 * 1024;

/**
 * Runs a repo's setup script in `cwd`, streaming its output to `onChunk`, and
 * resolves with the exit code and the last {@link SETUP_LOG_CAP} characters of
 * output. `bash -c`, not `-lc`: a login shell would source the user's profile
 * and re-import the provider secrets the scrubbed environment strips.
 * `withoutEnv` withholds allowlisted variables on top of that.
 */
export async function runSetupScript(
  cwd: string,
  script: string,
  onChunk: (text: string) => void | Promise<void>,
  { withoutEnv = [] }: { withoutEnv?: readonly string[] } = {},
): Promise<{ exitCode: number; logTail: string }> {
  let logTail = "";
  const exitCode = await runStreaming(["bash", "-c", script], {
    cwd,
    withoutEnv,
    timeoutMs: SETUP_TIMEOUT_MS,
    onChunk: async (text) => {
      logTail = (logTail + text).slice(-SETUP_LOG_CAP);
      await onChunk(text);
    },
  });
  return { exitCode, logTail };
}
