import { spawnSync } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  input?: string;
  /** Return a non-zero exit instead of throwing, for commands where failing is an answer. */
  allowFailure?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Runs a command with no shell, so arguments are never re-parsed. */
export function run(command: string, args: string[], options: RunOptions = {}): RunResult {
  const child = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  const result = { stdout: child.stdout, stderr: child.stderr, status: child.status ?? 1 };
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

/** Calls the GitHub API through `gh`, which brings its own auth (GH_TOKEN in CI). */
export function ghApi<T>(path: string, args: string[] = [], input?: unknown): T {
  const { stdout } = run(
    "gh",
    ["api", path, ...args, ...(input === undefined ? [] : ["--input", "-"])],
    { input: input === undefined ? undefined : JSON.stringify(input) },
  );
  return (stdout.trim() ? JSON.parse(stdout) : null) as T;
}

/** Like `ghApi`, for a list endpoint: follows every page and flattens them. */
export function ghApiPages<T>(path: string): T[] {
  const { stdout } = run("gh", ["api", path, "--paginate", "--slurp"]);
  return (JSON.parse(stdout) as T[][]).flat();
}
