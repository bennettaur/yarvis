import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnClaudeSession } from "./controlClient.ts";

/** A stand-in for the core's control socket that records each request and accepts it. */
const dir = mkdtempSync(join(tmpdir(), "yarvis-core-"));
const path = join(dir, "core.sock");
const requests: { method: string; params: Record<string, unknown> }[] = [];
const connections: net.Socket[] = [];
const core = net.createServer((conn) => {
  connections.push(conn);
  let buffer = "";
  conn.setEncoding("utf8");
  conn.on("data", (chunk: string) => {
    buffer += chunk;
    for (let idx = buffer.indexOf("\n"); idx >= 0; idx = buffer.indexOf("\n")) {
      const req = JSON.parse(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      requests.push({ method: req.method, params: req.params });
      conn.write(`${JSON.stringify({ id: req.id, ok: true })}\n`);
    }
  });
});
const previousSock = process.env.YARVIS_CORE_SOCK;

beforeAll(async () => {
  await new Promise<void>((resolve) => core.listen(path, resolve));
  process.env.YARVIS_CORE_SOCK = path;
});

afterAll(async () => {
  for (const conn of connections) conn.destroy();
  await new Promise((resolve) => core.close(resolve));
  rmSync(dir, { recursive: true, force: true });
  if (previousSock === undefined) delete process.env.YARVIS_CORE_SOCK;
  else process.env.YARVIS_CORE_SOCK = previousSock;
});

describe("spawnClaudeSession", () => {
  it("sends the session to resume under the key the core reads", async () => {
    // `SpawnParams` in src-tauri/src/control.rs reads `resume`; any other key
    // is dropped there, and every restart would start a fresh session instead.
    await spawnClaudeSession({
      workspaceId: "w1",
      cwd: "/tmp/ws",
      name: "ws",
      remoteControl: false,
      resumeSessionId: "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70",
    });

    expect(requests).toEqual([
      {
        method: "claude.spawn",
        params: {
          workspaceId: "w1",
          cwd: "/tmp/ws",
          name: "ws",
          remoteControl: false,
          resume: "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70",
        },
      },
    ]);
  });
});
