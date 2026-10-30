import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { fakeClaude, makeTempDir, resultLine } from "../agentRuns/testSupport.ts";
import { getDb } from "../db/client.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import { filesInFolder, getClaudeTask, startClaudeTask } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const dir = makeTempDir("yarvis-claude-tasks-");
const config = { workspacesRoot: join(dir, "workspaces") };

let registry: RunRegistry<AgentRunEvent>;
const deps = (program: string) => ({ program, instance: "test", registry });

/** A fake `claude` that writes `files` into its working directory, then answers. */
function fakeWriting(name: string, files: string[], answer: Record<string, unknown>): string {
  const writes = files.map((file) => `echo made > "${file}"`).join("\n");
  const line = JSON.stringify(resultLine({ structured_output: answer }));
  return fakeClaude(dir, name, `${writes}\ncat <<'EOF'\n${line}\nEOF`);
}

async function attentionRows() {
  return sql<{ kind: string; title: string; body: string | null; nav_target: unknown }[]>`
    SELECT kind, title, body, nav_target FROM attention_items ORDER BY seq`;
}

beforeEach(async () => {
  registry = new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 });
  await sql`TRUNCATE agent_runs, attention_items RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("startClaudeTask", () => {
  it("runs in a fresh folder, keeps the files that exist, and tells the chat", async () => {
    const program = fakeWriting("writes-site", ["index.html"], {
      summary: "Built a one-page site.",
      files: [
        { path: "index.html", description: "The page" },
        { path: "missing.css", description: "Never written" },
      ],
    });
    const started = await startClaudeTask(
      db,
      config,
      { title: "Launch page", task: "Build a launch page", chatSessionId: null },
      deps(program),
    );
    expect(started.outputDir.startsWith(join(config.workspacesRoot, ".claude-tasks"))).toBe(true);

    const handle = await waitForFinish(started.runId);
    expect(handle.status).toBe("succeeded");
    expect(handle.summary).toBe("Built a one-page site.");
    expect(handle.files).toEqual([{ path: "index.html", description: "The page" }]);
    expect(handle.outputDir).toBe(started.outputDir);

    const items = await waitForAttention();
    expect(items[0]).toMatchObject({
      kind: "info",
      title: "Claude Code finished: Launch page",
      body: "Built a one-page site.",
      nav_target: { type: "chat" },
    });
  });

  it("raises an error item when the run fails", async () => {
    const program = fakeClaude(dir, "fails", "echo broken >&2\nexit 1");
    const started = await startClaudeTask(
      db,
      config,
      { title: "Brief", task: "Write a brief", chatSessionId: null },
      deps(program),
    );
    const finished = await waitForFinish(started.runId);
    expect(finished.status).toBe("failed");
    const items = await waitForAttention();
    expect(items[0]).toMatchObject({ kind: "error", title: "Claude Code task failed: Brief" });
  });
});

describe("getClaudeTask", () => {
  it("returns null for an id that is not a task", async () => {
    expect(await getClaudeTask(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("filesInFolder", () => {
  it("drops paths outside the folder, absolute paths and links that leave it", () => {
    const root = makeTempDir("yarvis-claude-task-files-");
    const outside = makeTempDir("yarvis-claude-task-outside-");
    writeFileSync(join(outside, "secret.txt"), "x");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "ok.md"), "x");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    const kept = filesInFolder(root, [
      { path: "sub/ok.md", description: "" },
      { path: "../secret.txt", description: "" },
      { path: join(outside, "secret.txt"), description: "" },
      { path: "link.txt", description: "" },
      { path: "sub", description: "" },
    ]);
    expect(kept.map((f) => f.path)).toEqual(["sub/ok.md"]);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

async function waitForFinish(runId: string) {
  for (let i = 0; i < 100; i++) {
    const found = await getClaudeTask(db, runId);
    if (found && found.status !== "running") return found;
    await Bun.sleep(50);
  }
  throw new Error("the run never finished");
}

async function waitForAttention() {
  for (let i = 0; i < 100; i++) {
    const rows = await attentionRows();
    if (rows.length > 0) return rows;
    await Bun.sleep(50);
  }
  throw new Error("no attention item was raised");
}
