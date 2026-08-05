/**
 * Client for the Rust core's control channel (`src-tauri/src/control.rs`).
 *
 * The core listens on a Unix domain socket whose path is injected as
 * `YARVIS_CORE_SOCK`; this is how the sidecar asks the core to do things only it
 * can — spawning/killing a Claude Code session in a workspace PTY. The wire
 * protocol is newline-delimited JSON: each request `{ id, method, params }` gets
 * one reply `{ id, ok, error? }`.
 */

import net from "node:net";

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
}

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket> | null = null;
let buffer = "";
let nextId = 1;
const pending = new Map<number, Pending>();

/** How long to wait for a reply before failing a request. */
const REQUEST_TIMEOUT_MS = 15_000;

function socketPath(): string {
  const path = process.env.YARVIS_CORE_SOCK;
  if (!path) {
    throw new Error("YARVIS_CORE_SOCK is not set; the core control channel is unavailable");
  }
  return path;
}

function onData(chunk: string): void {
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf("\n");
    if (!line.trim()) continue;
    let msg: { id?: number; ok?: boolean; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.id !== "number") continue;
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.ok) p.resolve();
    else p.reject(new Error(msg.error ?? "control request failed"));
  }
}

function onClose(): void {
  socket = null;
  buffer = "";
  const err = new Error("core control connection closed");
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

async function getSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;
  if (connecting) return connecting;
  connecting = new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ path: socketPath() });
    s.setEncoding("utf8");
    const onConnectError = (e: Error) => {
      connecting = null;
      reject(e);
    };
    s.once("error", onConnectError);
    s.once("connect", () => {
      s.removeListener("error", onConnectError);
      s.on("data", onData);
      s.on("close", onClose);
      s.on("error", (e) => console.error("[control] socket error:", e.message));
      socket = s;
      connecting = null;
      resolve(s);
    });
  });
  return connecting;
}

async function rpc(method: string, params: Record<string, unknown>): Promise<void> {
  const s = await getSocket();
  const id = nextId++;
  const payload = `${JSON.stringify({ id, method, params })}\n`;
  return await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`control RPC '${method}' timed out`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    s.write(payload, (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}

/** Asks the core to start an agent session in `cwd`, optionally with Remote
 *  Control enabled. */
export async function spawnClaudeSession(input: {
  workspaceId: string;
  cwd: string;
  name: string;
  remoteControl: boolean;
}): Promise<void> {
  await rpc("claude.spawn", {
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    name: input.name,
    remoteControl: input.remoteControl,
  });
}

/** Asks the core to kill a workspace's Claude session, if one is running. */
export async function killClaudeSession(workspaceId: string): Promise<void> {
  await rpc("claude.kill", { workspaceId });
}
