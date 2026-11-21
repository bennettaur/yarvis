import type { UnlistenFn } from "@tauri-apps/api/event";
import { core } from "./core";
import { onAuthChange, openServerSocket, refusedByServer } from "./server";
import type { HarnessKind } from "./settings";

/**
 * Client for the PTY sessions the server owns. Sessions are keyed by a stable
 * id and live on the server, so a component can detach (unmount) and reattach
 * later without losing its shell, and several clients can watch one session.
 *
 * Output streams over one WebSocket per session (`/api/pty/{id}`). Each binary
 * frame is an 8-byte big-endian stream offset followed by the bytes. The
 * snapshot an attach returns and the frames after it carry offsets from the
 * same count, so a reattaching terminal can splice them exactly; see
 * {@link PtySnapshot}. A dropped socket reconnects from the last offset it saw.
 */

/** A session's captured output plus where that capture ends in its byte stream. */
export interface PtySnapshot {
  /** Raw bytes as a number array, to replay into the terminal. */
  scrollback: number[];
  /** Stream offset one past the last byte the capture accounts for. Exceeds
   * `scrollback.length` once the server has trimmed the capture to its cap. */
  endOffset: number;
}

/** A chunk of session output, tagged with where it starts in the byte stream. */
export interface PtyOutput {
  offset: number;
  bytes: Uint8Array;
}

/**
 * What the server sends just before a binary frame of catch-up bytes: on
 * attach (`attached`), and when this client fell behind and is caught up
 * again (`resync`). Only the end offset matters here, since every frame
 * carries its own start.
 */
interface AttachHeader {
  type: "attached" | "resync";
  endOffset: number;
}

const RECONNECT_MS = 1_000;

/** One session's socket and everyone listening to it. */
interface Connection {
  socket: WebSocket | null;
  output: Set<(chunk: PtyOutput) => void>;
  exit: Set<() => void>;
  /** Stream offset one past the last byte received, for a reconnect. */
  nextOffset: number | null;
  /** Settles the pending `attachPty` with the first catch-up frame. */
  pendingAttach: {
    resolve: (snapshot: PtySnapshot) => void;
    reject: (e: Error) => void;
    header: AttachHeader | null;
  } | null;
  exited: boolean;
  retry?: ReturnType<typeof setTimeout>;
  /** The size and folder sent with the auth message, and again on a reconnect. */
  attachArgs: { cols: number; rows: number; cwd?: string };
}

const connections = new Map<string, Connection>();

function connectionFor(id: string): Connection {
  let conn = connections.get(id);
  if (!conn) {
    conn = {
      socket: null,
      output: new Set(),
      exit: new Set(),
      nextOffset: null,
      pendingAttach: null,
      exited: false,
      attachArgs: { cols: 80, rows: 24 },
    };
    connections.set(id, conn);
  }
  return conn;
}

function readFrame(data: ArrayBuffer): PtyOutput {
  const view = new DataView(data);
  return { offset: Number(view.getBigUint64(0)), bytes: new Uint8Array(data, 8) };
}

function handleText(conn: Connection, text: string): void {
  let msg: { type?: string } & Partial<AttachHeader>;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.type === "attached" || msg.type === "resync") {
    // A resync's bytes go to the output listeners like any others; only the
    // first header after `attachPty` belongs to the snapshot it returns.
    if (conn.pendingAttach) conn.pendingAttach.header = msg as AttachHeader;
  } else if (msg.type === "exit") {
    conn.exited = true;
    for (const cb of conn.exit) cb();
  }
}

function handleBinary(conn: Connection, data: ArrayBuffer): void {
  const chunk = readFrame(data);
  conn.nextOffset = chunk.offset + chunk.bytes.length;
  const pending = conn.pendingAttach;
  if (pending?.header) {
    conn.pendingAttach = null;
    pending.resolve({
      scrollback: Array.from(chunk.bytes),
      endOffset: pending.header.endOffset,
    });
    return;
  }
  for (const cb of conn.output) cb(chunk);
}

async function openSocket(id: string, conn: Connection): Promise<void> {
  const args: Record<string, unknown> = { ...conn.attachArgs };
  if (conn.nextOffset !== null) args.offset = conn.nextOffset;
  const socket = await openServerSocket(`/api/pty/${encodeURIComponent(id)}`, args);
  if (!socket) {
    conn.pendingAttach?.reject(new Error("not signed in to the Yarvis server"));
    conn.pendingAttach = null;
    return;
  }
  conn.socket = socket;
  socket.addEventListener("message", (e) => {
    if (typeof e.data === "string") handleText(conn, e.data);
    else if (e.data instanceof ArrayBuffer) handleBinary(conn, e.data);
  });
  socket.addEventListener("close", (e) => {
    if (conn.socket !== socket) return;
    conn.socket = null;
    if (conn.pendingAttach) {
      conn.pendingAttach.reject(new Error(e.reason || "the terminal connection closed"));
      conn.pendingAttach = null;
      return;
    }
    // Reconnect while someone is still watching and the shell is alive. The
    // catch-up after a reconnect arrives as ordinary output from `nextOffset`.
    if (!conn.exited && conn.output.size > 0 && !refusedByServer(e.code)) {
      conn.retry = setTimeout(() => void openSocket(id, conn), RECONNECT_MS);
    }
  });
}

/** Closes the socket without its close handler reconnecting, since it is no longer `conn.socket`. */
function dropSocket(conn: Connection): void {
  clearTimeout(conn.retry);
  const socket = conn.socket;
  conn.socket = null;
  socket?.close();
}

function release(id: string, conn: Connection): void {
  if (conn.output.size > 0 || conn.exit.size > 0) return;
  dropSocket(conn);
  connections.delete(id);
}

// A signed-out device closes its terminals; they attach again after sign-in.
onAuthChange((signedIn) => {
  if (signedIn) return;
  for (const conn of connections.values()) dropSocket(conn);
});

/** Attaches to session `id`, which the server spawns a shell for if it does
 * not yet exist. Returns the scrollback to replay and the offset it ends at.
 * `cwd` sets the working directory for a freshly spawned shell (ignored on
 * reattach). Subscribe with `onPtyOutput` first, so nothing after the
 * snapshot is missed. */
export const attachPty = (id: string, cols: number, rows: number, cwd?: string) => {
  const conn = connectionFor(id);
  conn.attachArgs = { cols, rows, cwd };
  conn.nextOffset = null;
  conn.exited = false;
  dropSocket(conn);
  return new Promise<PtySnapshot>((resolve, reject) => {
    conn.pendingAttach = { resolve, reject, header: null };
    void openSocket(id, conn);
  });
};

/** Sends user input to the session's shell, over the open socket when there is
 * one. The server sizes the PTY to whichever client typed last, so typing here
 * also makes this terminal's viewport the size the shell sees. */
export const writePty = async (id: string, data: string): Promise<void> => {
  const socket = connections.get(id)?.socket;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input", data }));
    return;
  }
  await core("pty_write", { id, data });
};

/** Resizes the session's PTY to match the terminal viewport. */
export const resizePty = async (id: string, cols: number, rows: number): Promise<void> => {
  const conn = connections.get(id);
  if (conn) conn.attachArgs = { ...conn.attachArgs, cols, rows };
  if (conn?.socket?.readyState === WebSocket.OPEN) {
    conn.socket.send(JSON.stringify({ type: "resize", cols, rows }));
    return;
  }
  await core("pty_resize", { id, cols, rows });
};

/** Terminates the session's shell and frees it. */
export const killPty = (id: string) => core("pty_kill", { id });

/** True if a live session exists for `id` (without spawning one). */
export const ptyExists = (id: string) => core<boolean>("pty_exists", { id });

/** Starts an agent session for a workspace, keyed `ws-claude:<workspaceId>`.
 * Resolves once the session is registered. `remoteControl` adds Claude Code's
 * `--remote-control`; the app doesn't set it, since a session started here opens
 * in a tab the user is looking at and can enable it from inside the session. */
export const startClaudeSession = (
  workspaceId: string,
  cwd: string,
  name: string,
  remoteControl: boolean,
  harness?: string,
) => core("pty_start_claude", { workspaceId, cwd, name, remoteControl, harness });

/** A harness a session can be started with, as the picker lists it. */
export interface HarnessSummary {
  id: string;
  name: string;
  kind: HarnessKind;
  command: string;
}

/** The agent a workspace surfaces: the default harness's tab title and base
 *  command, and every harness a session can be started with. */
export interface AgentConfig {
  name: string;
  command: string;
  harnesses: HarnessSummary[];
  defaultHarness: string;
}

/** The harness a live agent session runs, or null when none is running. */
export const getSessionHarness = (id: string) =>
  core<{ id: string; name: string } | null>("pty_session_harness", { id });

/** The default harness's name and command, plus every harness a session can be
 * started with (Settings → Repositories → Agent). */
export const getAgentConfig = () => core<AgentConfig>("get_agent_config");

/** True when a non-shell foreground process is running in the session — used to
 * decide whether closing should require confirmation. False for unknown
 * sessions and for platforms that can't report a foreground process group. */
export const isPtyBusy = (id: string) => core<boolean>("pty_is_busy", { id });

/** Subscribe to output chunks for a single session. */
export const onPtyOutput = async (
  id: string,
  cb: (chunk: PtyOutput) => void,
): Promise<UnlistenFn> => {
  const conn = connectionFor(id);
  conn.output.add(cb);
  return () => {
    conn.output.delete(cb);
    release(id, conn);
  };
};

/** Subscribe to the exit signal for a single session. */
export const onPtyExit = async (id: string, cb: () => void): Promise<UnlistenFn> => {
  const conn = connectionFor(id);
  conn.exit.add(cb);
  return () => {
    conn.exit.delete(cb);
    release(id, conn);
  };
};
