import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchStreaming } from "./process.ts";

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

describe("a streaming launch", () => {
  it("hands over stdout a line at a time, including a last line with no newline", async () => {
    const program = fakeClaude("lines", `printf 'one\\ntwo\\nthr'; sleep 0.05; printf 'ee'`);
    const lines: string[] = [];
    const exit = await launchStreaming({
      program,
      args: [],
      cwd: dir,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      onLine: (line) => lines.push(line),
    });
    expect(exit).toMatchObject({ code: 0, timedOut: false, aborted: false });
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("passes arguments as argv, never through a shell", async () => {
    const program = fakeClaude("args", `printf '%s\\n' "$@"`);
    const lines: string[] = [];
    await launchStreaming({
      program,
      args: ["-p", "hello; touch pwned"],
      cwd: dir,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(["-p", "hello; touch pwned"]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("keeps the sidecar's secrets out of the child's environment", async () => {
    process.env.YARVIS_SIDECAR_TOKEN = "should-not-leak";
    try {
      const program = fakeClaude("env", `echo "token=$YARVIS_SIDECAR_TOKEN"`);
      const lines: string[] = [];
      await launchStreaming({
        program,
        args: [],
        cwd: dir,
        signal: new AbortController().signal,
        timeoutMs: 5_000,
        onLine: (line) => lines.push(line),
      });
      expect(lines).toEqual(["token="]);
    } finally {
      delete process.env.YARVIS_SIDECAR_TOKEN;
    }
  });

  it("cancels the whole process group, so what the run started stops with it", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const program = fakeClaude("cancel", `sleep 60 &\necho $! > "${pidFile}"\necho started\nwait`);
    const controller = new AbortController();
    const exitPromise = launchStreaming({
      program,
      args: [],
      cwd: dir,
      signal: controller.signal,
      timeoutMs: 30_000,
      onLine: () => {},
    });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(isAlive(grandchild)).toBe(true);

    controller.abort();
    const exit = await exitPromise;
    expect(exit.aborted).toBe(true);
    await waitFor(() => !isAlive(grandchild));
  });

  it("stops a run that outlives its timeout", async () => {
    const program = fakeClaude("slow", "sleep 30");
    const started = Date.now();
    const exit = await launchStreaming({
      program,
      args: [],
      cwd: dir,
      signal: new AbortController().signal,
      timeoutMs: 100,
      onLine: () => {},
    });
    expect(exit.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects when the program can't be started", async () => {
    await expect(
      launchStreaming({
        program: join(dir, "no-such-claude"),
        args: [],
        cwd: dir,
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        onLine: () => {},
      }),
    ).rejects.toThrow();
  });
});
