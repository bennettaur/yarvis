import { invalidatePrefix } from "./resourceCache";
import { onAuthChange, openServerSocket, refusedByServer } from "./server";

/**
 * The server's event stream (`/api/events`): alarms firing, approvals, devices,
 * the sidecar restarting. One WebSocket is shared by every subscriber. It
 * reconnects on its own and asks for what it missed with `since`.
 */

export interface ServerEvent<T = unknown> {
  seq: number;
  /** Milliseconds since the epoch. */
  at: number;
  deviceId: string | null;
  kind: string;
  data: T;
}

type Listener = (event: ServerEvent) => void;

/** How long to wait before reconnecting, doubling up to the cap. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const listeners = new Map<string, Set<Listener>>();
let socket: WebSocket | null = null;
let connecting = false;
let lastSeq: number | null = null;
let retryMs = RECONNECT_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function dispatch(event: ServerEvent): void {
  for (const key of [event.kind, "*"]) {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(event);
      } catch (e) {
        console.error(`[events] a ${event.kind} listener threw:`, e);
      }
    }
  }
}

/** Closes the socket without the close handler reconnecting, since it is no longer `socket`. */
function dropSocket(): void {
  const open = socket;
  socket = null;
  open?.close();
}

/**
 * The server fell too far behind to replay what this client missed. Whatever
 * the page shows may be stale, so every cached list reloads, and the next
 * connection starts from now.
 */
function handleLagged(): void {
  lastSeq = null;
  invalidatePrefix("");
}

function subscriberCount(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}

async function connect(): Promise<void> {
  if (socket || connecting) return;
  connecting = true;
  let next: WebSocket | null;
  try {
    next = await openServerSocket("/api/events", lastSeq === null ? {} : { since: lastSeq });
  } finally {
    connecting = false;
  }
  // No token or no server: wait for a sign-in rather than retrying blind.
  if (!next) return;
  if (subscriberCount() === 0) {
    next.close();
    return;
  }
  socket = next;
  next.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    let msg: { type?: string } & Partial<ServerEvent>;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "lagged") {
      handleLagged();
      return;
    }
    if (msg.type !== "event" || typeof msg.seq !== "number" || typeof msg.kind !== "string") {
      return;
    }
    retryMs = RECONNECT_MIN_MS;
    if (lastSeq !== null && msg.seq <= lastSeq) return;
    lastSeq = msg.seq;
    dispatch(msg as ServerEvent);
  });
  next.addEventListener("close", (e) => {
    if (socket !== next) return;
    socket = null;
    // After a 4401 sign-out, `restartEvents` reconnects on the next sign-in.
    if (refusedByServer(e.code) || subscriberCount() === 0) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void connect(), retryMs);
    retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
  });
}

/**
 * Calls `cb` for every event of `kind` (or of every kind, with `"*"`).
 * Returns a function that stops it. The socket opens on the first subscriber.
 */
export function onServerEvent<T = unknown>(
  kind: string,
  cb: (event: ServerEvent<T>) => void,
): () => void {
  let set = listeners.get(kind);
  if (!set) {
    set = new Set();
    listeners.set(kind, set);
  }
  const listener = cb as Listener;
  set.add(listener);
  void connect();
  return () => {
    set.delete(listener);
    if (subscriberCount() === 0) {
      clearTimeout(retryTimer);
      dropSocket();
    }
  };
}

/** Drops the current connection and opens a fresh one, after a sign-in. */
export function restartEvents(): void {
  dropSocket();
  clearTimeout(retryTimer);
  retryMs = RECONNECT_MIN_MS;
  if (subscriberCount() > 0) void connect();
}

// A signed-out device has no business holding the stream open, and the next
// sign-in starts from now rather than replaying another device's history.
onAuthChange((signedIn) => {
  if (signedIn) return;
  clearTimeout(retryTimer);
  dropSocket();
  lastSeq = null;
});
