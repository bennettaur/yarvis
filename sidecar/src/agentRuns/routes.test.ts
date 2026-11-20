import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import postgres from "postgres";
import { createApp } from "../app.ts";
import { getDb } from "../db/client.ts";
import { agentRuns } from "../db/schema.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import type { AgentRunEvent } from "./events.ts";
import { createAgentRunRoutes } from "./routes.ts";
import { startClaudeRun } from "./service.ts";
import { FIXTURES, fakeClaude, makeTempDir, runOptions, testConfig } from "./testSupport.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;
const dir = makeTempDir("yarvis-agent-run-routes-");
const config = testConfig(url, dir);
const fixture = join(FIXTURES, "subagent-structured-output.jsonl");
const replay = fakeClaude(dir, "replay", `cat "${fixture}"`);

let registry: RunRegistry<AgentRunEvent>;
let app: Hono;

beforeEach(async () => {
  registry = new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 });
  app = new Hono().route("/api/agent-runs", createAgentRunRoutes(config, registry));
  await sql`TRUNCATE agent_runs`;
});

afterAll(async () => {
  await sql.end();
  rmSync(dir, { recursive: true, force: true });
});

const start = (program: string, overrides = {}) =>
  startClaudeRun(db, runOptions(dir, overrides), { program, instance: "test", registry });

/** Reads an SSE response to the end and returns its parsed frames. */
async function json(res: Response | Promise<Response>): Promise<Record<string, unknown>> {
  return (await (await res).json()) as Record<string, unknown>;
}

async function readEvents(res: Response): Promise<AgentRunEvent[]> {
  const body = await res.text();
  return body
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data:".length)) as AgentRunEvent);
}

/** A fake that streams the fixture only once `release` is called. */
function gatedReplay(name: string) {
  const gate = join(dir, `${name}.release`);
  const program = fakeClaude(
    dir,
    name,
    `echo '{"type":"system","subtype":"init","model":"m"}'
while [ ! -f "${gate}" ]; do sleep 0.02; done
cat "${fixture}"`,
  );
  return { program, release: () => writeFileSync(gate, "") };
}

describe("following a run", () => {
  it("streams a live run as it happens, ending with done", async () => {
    const gated = gatedReplay("live");
    const handle = await start(gated.program);
    const res = await app.request(`/api/agent-runs/${handle.id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read the stream as it arrives: the init status shows up while the fake is
    // still blocked, which only a live stream can deliver.
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("Claude Code started")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before the run did");
      seen += decoder.decode(value);
    }
    expect(seen).not.toContain('"type":"done"');
    expect((await json(app.request(`/api/agent-runs/${handle.id}`))).live).toBe(true);

    gated.release();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    expect(seen).toContain('"type":"result"');
    expect(seen.trim().endsWith('{"type":"done","status":"succeeded"}')).toBe(true);
  });

  it("finds the row terminal by the time a viewer sees done", async () => {
    const gated = gatedReplay("terminal");
    const handle = await start(gated.program);
    const res = await app.request(`/api/agent-runs/${handle.id}/events`);
    gated.release();
    const events = await readEvents(res);
    expect(events.at(-1)).toEqual({ type: "done", status: "succeeded" });
    const run = await (await app.request(`/api/agent-runs/${handle.id}`)).json();
    expect(run).toMatchObject({ status: "succeeded", live: false });
  });

  it("replays a finished run's stored events", async () => {
    const handle = await start(replay);
    await handle.done;
    const events = await readEvents(await app.request(`/api/agent-runs/${handle.id}/events`));
    expect(events[0]).toEqual({ type: "status", message: "Starting Claude Code" });
    expect(events.at(-1)).toEqual({ type: "done", status: "succeeded" });
  });

  it("says so when the run belongs to another instance", async () => {
    const events: AgentRunEvent[] = [{ type: "status", message: "Starting Claude Code" }];
    const [row] = await db
      .insert(agentRuns)
      .values({ kind: "k", targetKey: "t", status: "running", instance: "other", events })
      .returning({ id: agentRuns.id });
    const streamed = await readEvents(await app.request(`/api/agent-runs/${row?.id}/events`));
    expect(streamed[0]).toEqual(events[0]);
    expect(streamed.at(-1)).toMatchObject({ type: "error" });
    expect(JSON.stringify(streamed.at(-1))).toContain("another Yarvis instance");
  });
});

describe("cancelling a run", () => {
  it("cancels a live run, and has nothing to cancel afterwards", async () => {
    const program = fakeClaude(dir, "hang", "sleep 30");
    const handle = await start(program);
    const res = await app.request(`/api/agent-runs/${handle.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(202);
    expect((await handle.done).status).toBe("cancelled");
    const again = await app.request(`/api/agent-runs/${handle.id}/cancel`, { method: "POST" });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toContain("already finished");
  });

  it("can't cancel another instance's run", async () => {
    const [row] = await db
      .insert(agentRuns)
      .values({ kind: "k", targetKey: "t", status: "running", instance: "other" })
      .returning({ id: agentRuns.id });
    const res = await app.request(`/api/agent-runs/${row?.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain("another Yarvis instance");
  });
});

describe("reading runs", () => {
  it("reads one run without its event log, and lists the latest by kind and target", async () => {
    const first = await start(replay);
    await first.done;
    const other = await start(replay, { targetKey: "gh:o/r/2" });
    await other.done;

    const body = (await (await app.request(`/api/agent-runs/${first.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ id: first.id, status: "succeeded", live: false });
    expect(body.events).toBeUndefined();
    expect(body.pid).toBeUndefined();

    const list = await app.request("/api/agent-runs?kind=test-kind&target=gh:o/r/1");
    const runs = (await list.json()) as Record<string, unknown>[];
    expect(runs.map((run) => run.id)).toEqual([first.id]);
    expect(runs[0]?.events).toBeUndefined();
  });

  it("answers 404 for an unknown run and 400 for a malformed id or query", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await app.request(`/api/agent-runs/${missing}`)).status).toBe(404);
    expect((await app.request(`/api/agent-runs/${missing}/events`)).status).toBe(404);
    expect(
      (await app.request(`/api/agent-runs/${missing}/cancel`, { method: "POST" })).status,
    ).toBe(404);
    expect((await app.request("/api/agent-runs/nope")).status).toBe(400);
    expect((await app.request("/api/agent-runs/nope/events")).status).toBe(400);
    expect((await app.request("/api/agent-runs?limit=0")).status).toBe(400);
  });

  it("answers 503 without a database", async () => {
    const noDb = new Hono().route(
      "/api/agent-runs",
      createAgentRunRoutes(testConfig(undefined, dir), registry),
    );
    expect((await noDb.request("/api/agent-runs")).status).toBe(503);
  });

  it("is mounted in the app behind the bearer token", async () => {
    const full = createApp(config);
    expect((await full.request("/api/agent-runs")).status).toBe(401);
    const res = await full.request("/api/agent-runs", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
  });
});
