/**
 * Stands in for yarvis-server's routes on the page's own origin, so the real
 * frontend runs in a plain browser with only a sidecar behind it.
 *
 * - `/api/core/{command}` is answered by the same handler as the Tauri mock.
 * - `/api/sidecar/*` goes to the real demo sidecar with its own token, which
 *   is what the server's proxy does.
 * - `/api/pty/{id}` and `/api/events` WebSockets are played in the page: the
 *   first by the scripted terminals, the second by whatever a flow emits.
 * - Sign-in and devices answer as one signed-in admin device.
 */

import type { FakeTerminals } from "./fakeShell";

type Handler = (cmd: string, args: Record<string, unknown>) => unknown;

interface Options {
  handleCommand: Handler;
  terminals: () => FakeTerminals;
  sidecarPort: number;
  sidecarToken: string;
}

const DEMO_DEVICE = {
  deviceId: "demo-device",
  name: "Demo browser",
  kind: "passkey",
  scopes: ["read", "chat", "approve", "admin"],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A WebSocket the page opens to the server, played in the page. */
class FakeServerSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeServerSocket.CONNECTING;
  binaryType = "arraybuffer";
  onMessage: (data: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(readonly url: string) {
    super();
    queueMicrotask(() => {
      this.readyState = FakeServerSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike): void {
    if (typeof data === "string") this.onMessage(data);
  }

  close(): void {
    if (this.readyState === FakeServerSocket.CLOSED) return;
    this.readyState = FakeServerSocket.CLOSED;
    this.onClose();
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "" }));
  }

  receive(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function outputFrame(offset: number, bytes: number[]): ArrayBuffer {
  const frame = new ArrayBuffer(8 + bytes.length);
  new DataView(frame).setBigUint64(0, BigInt(offset));
  new Uint8Array(frame, 8).set(bytes);
  return frame;
}

export function installServerMock({
  handleCommand,
  terminals,
  sidecarPort,
  sidecarToken,
}: Options) {
  const ptySockets = new Map<string, Set<FakeServerSocket>>();
  const eventSockets = new Set<FakeServerSocket>();
  let seq = 0;

  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
      return realFetch(input, init);
    }
    const path = url.pathname;
    if (path.startsWith("/api/sidecar/")) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${sidecarToken}`);
      const target = `http://127.0.0.1:${sidecarPort}${path.slice("/api/sidecar".length)}${url.search}`;
      return realFetch(target, { ...init, headers });
    }
    if (path.startsWith("/api/core/")) {
      const args = init?.body ? JSON.parse(String(init.body)) : {};
      try {
        const result = handleCommand(path.slice("/api/core/".length), args);
        return result === null || result === undefined
          ? new Response(null, { status: 204 })
          : json(result);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
    switch (path) {
      case "/api/auth/status":
        return json({ setupRequired: false, rpId: location.hostname, vault: "absent" });
      case "/api/devices/me":
        return json(DEMO_DEVICE);
      case "/api/devices":
        return json([DEMO_DEVICE]);
      case "/api/approvals":
        return json([]);
      default:
        return json({ error: "not found" }, 404);
    }
  }) as typeof fetch;

  const RealSocket = window.WebSocket;
  window.WebSocket = ((url: string | URL, protocols?: string | string[]) => {
    const parsed = new URL(String(url));
    if (parsed.host !== location.host) return new RealSocket(url, protocols);
    const socket = new FakeServerSocket(String(url));
    if (parsed.pathname === "/api/events") {
      eventSockets.add(socket);
      socket.onClose = () => eventSockets.delete(socket);
    } else if (parsed.pathname.startsWith("/api/pty/")) {
      const id = decodeURIComponent(parsed.pathname.slice("/api/pty/".length));
      socket.onMessage = (data) => {
        const msg = JSON.parse(data) as { type: string; data?: string };
        if (msg.type === "auth") {
          let set = ptySockets.get(id);
          if (!set) {
            set = new Set();
            ptySockets.set(id, set);
          }
          set.add(socket);
          const { scrollback, endOffset } = terminals().attach(id);
          const startOffset = endOffset - scrollback.length;
          socket.receive(
            JSON.stringify({
              type: "attached",
              mode: "snapshot",
              startOffset,
              endOffset,
              exit: null,
            }),
          );
          socket.receive(outputFrame(startOffset, scrollback));
        } else if (msg.type === "input" && msg.data !== undefined) {
          terminals().write(id, msg.data);
        }
      };
      socket.onClose = () => ptySockets.get(id)?.delete(socket);
    }
    return socket;
  }) as unknown as typeof WebSocket;
  Object.assign(window.WebSocket, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  });

  return {
    /** Sends a session's output to every socket attached to it. */
    emitPtyOutput(id: string, chunk: { offset: number; bytes: number[] }): void {
      for (const socket of ptySockets.get(id) ?? []) {
        socket.receive(outputFrame(chunk.offset, chunk.bytes));
      }
    },
    /** Sends an event on `/api/events`, as the server would (e.g. `alarm.fire`). */
    emitServerEvent(kind: string, data: unknown): void {
      seq += 1;
      const message = JSON.stringify({
        type: "event",
        seq,
        at: new Date().toISOString(),
        deviceId: null,
        kind,
        data,
      });
      for (const socket of eventSockets) socket.receive(message);
    },
  };
}
