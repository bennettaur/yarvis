import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns } from "../db/schema.ts";
import type { AgentRunEvent } from "./events.ts";
import {
  buildClaudeArgs,
  type ClaudeRunOptions,
  failInterruptedAgentRuns,
  getAgentRun,
  jsonSchemaArg,
  startClaudeRun,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const dir = mkdtempSync(join(tmpdir(), "yarvis-agent-runs-"));
const fixture = join(import.meta.dir, "fixtures", "subagent-structured-output.jsonl");

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: dir,
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };

beforeEach(async () => {
  await sql`TRUNCATE agent_runs`;
});

afterAll(async () => {
  await sql.end();
  rmSync(dir, { recursive: true, force: true });
});

/** Writes an executable shell script standing in for `claude`. */
function fakeClaude(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Replays a captured stream-json transcript, as the real CLI printed it. */
const replayFixture = fakeClaude("replay", `cat "${fixture}"`);

function options(overrides: Partial<ClaudeRunOptions<{ count: number }>> = {}) {
  return {
    kind: "test-kind",
    targetKey: "gh:o/r/1",
    cwd: dir,
    prompt: "count the files",
    allowedTools: ["Read"],
    timeoutMs: 10_000,
    ...overrides,
  };
}

/** Reads an SSE response to the end and returns its parsed events. */
async function readEvents(res: Response): Promise<AgentRunEvent[]> {
  const body = await res.text();
  return body
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data:".length)) as AgentRunEvent);
}

describe("the arguments a run is started with", () => {
  it("streams JSON, loads no MCP servers, no project settings and saves no session", () => {
    const args = buildClaudeArgs(options(), ["/plugins/yarvis-review"]);
    expect(args.slice(0, 2)).toEqual(["-p", "count the files"]);
    for (const flag of ["--verbose", "--strict-mcp-config", "--no-session-persistence"]) {
      expect(args).toContain(flag);
    }
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args.join(" ")).toContain("--setting-sources user");
    expect(args.join(" ")).toContain("--plugin-dir /plugins/yarvis-review");
    expect(args.join(" ")).toContain("--allowedTools Read");
  });

  it("sends a schema Claude Code accepts: zod's, without the draft it names", () => {
    const schema = JSON.parse(jsonSchemaArg(z.object({ count: z.number() })));
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.count.type).toBe("number");
  });
});

describe("a run", () => {
  it("records the validated structured output and the cost", async () => {
    const handle = await startClaudeRun(
      db,
      options({ outputSchema: z.object({ count: z.number() }) }),
      { program: replayFixture, instance: "test" },
    );
    const outcome = await handle.done;
    expect(outcome).toMatchObject({ status: "succeeded", output: { count: 2 }, error: null });

    const row = await getAgentRun(db, handle.id);
    expect(row).toMatchObject({
      status: "succeeded",
      result: { count: 2 },
      costUsd: 0.012149559999999998,
      sessionId: "e4aa03c0-b411-4d9f-9a54-fd1d3f9870af",
      kind: "test-kind",
      targetKey: "gh:o/r/1",
    });
    expect(row?.finishedAt).not.toBeNull();
    const events = row?.events as AgentRunEvent[];
    expect(events.at(-1)).toEqual({ type: "done", status: "succeeded", error: null });
    expect(events.some((event) => event.type === "subagent")).toBe(true);
  });

  it("fails when the answer doesn't match the schema", async () => {
    const handle = await startClaudeRun(
      db,
      options({ outputSchema: z.object({ count: z.string() }) as never }),
      { program: replayFixture, instance: "test" },
    );
    const outcome = await handle.done;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("did not match the expected shape");
  });

  it("fails with stderr when the process exits without a result", async () => {
    const program = fakeClaude("crash", "echo 'not logged in' >&2; exit 1");
    const handle = await startClaudeRun(db, options(), { program, instance: "test" });
    const outcome = await handle.done;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("not logged in");
  });

  it("refuses to start in a directory that isn't there, before recording anything", async () => {
    await expect(
      startClaudeRun(db, options({ cwd: "/definitely/not/here" }), {
        program: replayFixture,
        instance: "test",
      }),
    ).rejects.toThrow("no such directory");
    expect(await db.select().from(agentRuns)).toHaveLength(0);
  });
});

describe("the agent run routes", () => {
  it("cancels a live run", async () => {
    const program = fakeClaude("hang", 'echo \'{"type":"system","subtype":"init"}\'; sleep 30');
    const handle = await startClaudeRun(db, options(), { program, instance: "test" });
    const res = await app.request(`/api/agent-runs/${handle.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(202);
    const outcome = await handle.done;
    expect(outcome.status).toBe("cancelled");
    expect((await getAgentRun(db, handle.id))?.status).toBe("cancelled");

    const again = await app.request(`/api/agent-runs/${handle.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(again.status).toBe(409);
  });

  it("streams a live run from the start, ending with done", async () => {
    const program = fakeClaude("slow-replay", `sleep 0.3; cat "${fixture}"`);
    const handle = await startClaudeRun(db, options(), { program, instance: "test" });
    const res = await app.request(`/api/agent-runs/${handle.id}/events`, { headers: auth });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readEvents(res);
    expect(events[0]).toEqual({ type: "status", message: "Starting Claude Code" });
    expect(events.at(-1)).toEqual({ type: "done", status: "succeeded", error: null });
    expect(events.some((event) => event.type === "result")).toBe(true);
  });

  it("replays a finished run's stored events", async () => {
    const handle = await startClaudeRun(db, options(), {
      program: replayFixture,
      instance: "test",
    });
    await handle.done;
    const events = await readEvents(
      await app.request(`/api/agent-runs/${handle.id}/events`, { headers: auth }),
    );
    expect(events.at(-1)).toEqual({ type: "done", status: "succeeded", error: null });
  });

  it("reads one run and lists the latest by kind and target", async () => {
    const first = await startClaudeRun(db, options(), { program: replayFixture, instance: "test" });
    await first.done;
    const other = await startClaudeRun(db, options({ targetKey: "gh:o/r/2" }), {
      program: replayFixture,
      instance: "test",
    });
    await other.done;

    const one = await app.request(`/api/agent-runs/${first.id}`, { headers: auth });
    const body = (await one.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: first.id, status: "succeeded", live: false });
    expect(body.events).toBeUndefined();

    const list = await app.request("/api/agent-runs?kind=test-kind&target=gh:o/r/1", {
      headers: auth,
    });
    const runs = (await list.json()) as { id: string }[];
    expect(runs.map((run) => run.id)).toEqual([first.id]);
  });

  it("answers 404 for a run that doesn't exist and 400 for a malformed id", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await app.request(`/api/agent-runs/${missing}`, { headers: auth })).status).toBe(404);
    expect((await app.request(`/api/agent-runs/${missing}/events`, { headers: auth })).status).toBe(
      404,
    );
    expect((await app.request("/api/agent-runs/nope", { headers: auth })).status).toBe(400);
  });
});

describe("after a restart", () => {
  it("fails this instance's leftover running runs and leaves the rest alone", async () => {
    const before = new Date(Date.now() - 60_000);
    await db.insert(agentRuns).values([
      { kind: "k", targetKey: "t", status: "running", instance: "main", startedAt: before },
      { kind: "k", targetKey: "t", status: "running", instance: "other", startedAt: before },
      { kind: "k", targetKey: "t", status: "running", instance: "main" },
    ]);
    const failed = await failInterruptedAgentRuns(db, "main", new Date(Date.now() - 1_000));
    expect(failed).toBe(1);
    const rows = await db.select().from(agentRuns);
    expect(rows.filter((row) => row.status === "failed")).toHaveLength(1);
    expect(rows.find((row) => row.status === "failed")?.instance).toBe("main");
  });
});
