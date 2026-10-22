import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  groupAlive,
  killLeftoverGroup,
  launchStreaming,
  processStartTime,
  type StreamingLaunch,
} from "./process.ts";

const dir = mkdtempSync(join(tmpdir(), "yarvis-agent-process-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes an executable shell script standing in for `claude`. */
function fakeClaude(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function launch(program: string, overrides: Partial<StreamingLaunch> = {}) {
  const lines: string[] = [];
  const exit = launchStreaming({
    program,
    args: [],
    stdin: "",
    cwd: dir,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    onLine: (line) => lines.push(line),
    ...overrides,
  });
  return { lines, exit };
}

/** Reads a pid a fake wrote, once it has. */
async function readPid(file: string): Promise<number> {
  await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "");
  return Number(readFileSync(file, "utf8").trim());
}

describe("a streaming launch", () => {
  it("hands over stdout a line at a time, including a last line with no newline", async () => {
    const run = launch(fakeClaude("lines", `printf 'one\\ntwo\\nthr'; sleep 0.05; printf 'ee'`));
    expect(await run.exit).toMatchObject({ code: 0, timedOut: false, aborted: false });
    expect(run.lines).toEqual(["one", "two", "three"]);
  });

  it("passes the prompt on stdin, where a leading dash is just text", async () => {
    const run = launch(fakeClaude("stdin", "cat"), { stdin: "--help me; touch pwned" });
    await run.exit;
    expect(run.lines).toEqual(["--help me; touch pwned"]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("passes arguments as argv, never through a shell", async () => {
    const run = launch(fakeClaude("args", `printf '%s\\n' "$@"`), {
      args: ["--settings", "{}; touch pwned"],
    });
    await run.exit;
    expect(run.lines).toEqual(["--settings", "{}; touch pwned"]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("keeps the sidecar's secrets out of the child's environment", async () => {
    process.env.YARVIS_SIDECAR_TOKEN = "should-not-leak";
    try {
      const run = launch(fakeClaude("env", `echo "token=$YARVIS_SIDECAR_TOKEN"`));
      await run.exit;
      expect(run.lines).toEqual(["token="]);
    } finally {
      delete process.env.YARVIS_SIDECAR_TOKEN;
    }
  });

  it("skips a line too long to buffer, and counts it", async () => {
    // Just over the 4M-character line limit, then an ordinary line.
    const program = fakeClaude(
      "long",
      `head -c 4100000 /dev/zero | tr '\\0' 'x'; printf '\\nafter\\n'`,
    );
    const run = launch(program);
    const exit = await run.exit;
    expect(exit.skippedLines).toBe(1);
    expect(run.lines).toEqual(["after"]);
  });

  it("cancels the whole process group, so what the run started stops with it", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const controller = new AbortController();
    const run = launch(fakeClaude("cancel", `sleep 60 &\necho $! > "${pidFile}"\nwait`), {
      signal: controller.signal,
    });
    const grandchild = await readPid(pidFile);
    expect(isAlive(grandchild)).toBe(true);

    controller.abort();
    expect((await run.exit).aborted).toBe(true);
    await waitFor(() => !isAlive(grandchild));
  });

  it("finishes when Claude Code exits even if something it started holds the pipes", async () => {
    const pidFile = join(dir, "holder.pid");
    // The backgrounded sleep inherits stdout, so `close` would wait out its
    // minute unless the group is killed when the leader exits.
    const run = launch(fakeClaude("holder", `sleep 60 &\necho $! > "${pidFile}"\necho done`));
    const started = Date.now();
    expect((await run.exit).code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(run.lines).toEqual(["done"]);
    await waitFor(() => !isAlive(Number(readFileSync(pidFile, "utf8").trim())));
  });

  it("stops a run that outlives its timeout", async () => {
    const started = Date.now();
    const exit = await launch(fakeClaude("slow", "sleep 30"), { timeoutMs: 100 }).exit;
    expect(exit.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports the group it started", async () => {
    let spawned: number | undefined;
    await launch(fakeClaude("quick", "true"), { onSpawn: (pid) => (spawned = pid) }).exit;
    expect(spawned).toBeGreaterThan(0);
  });

  it("rejects when the program can't be started", async () => {
    await expect(launch(join(dir, "no-such-claude")).exit).rejects.toThrow();
  });
});

describe("cleaning up after a crashed sidecar", () => {
  it("kills a leftover group whose leader is the process it recorded", async () => {
    const pidFile = join(dir, "leftover.pid");
    // Not awaited: this stands in for a run whose sidecar died.
    const controller = new AbortController();
    const run = launch(fakeClaude("leftover", `echo $$ > "${pidFile}"; sleep 60`), {
      signal: controller.signal,
    });
    const pid = await readPid(pidFile);
    const started = await processStartTime(pid);
    expect(started).not.toBeNull();

    expect(await killLeftoverGroup(pid, "Mon Jan  1 00:00:00 2001")).toBe(false);
    expect(groupAlive(pid)).toBe(true);

    expect(await killLeftoverGroup(pid, started)).toBe(true);
    await waitFor(() => !groupAlive(pid));
    controller.abort();
    await run.exit;
  });

  it("leaves a pid alone when nothing is running under it", async () => {
    expect(await killLeftoverGroup(999_999, "whenever")).toBe(false);
  });
});
