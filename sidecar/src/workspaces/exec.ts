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

/** Builds an allowlisted env, overlaying any explicit extras. */
export function scrubbedEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
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
}

/** Runs a command to completion, capturing stdout/stderr. Never inherits secrets. */
export async function run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: scrubbedEnv(opts.env),
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
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new Error(`command timed out after ${timeoutMs}ms: ${args.join(" ")}`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamOptions extends RunOptions {
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
    env: scrubbedEnv(opts.env),
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
