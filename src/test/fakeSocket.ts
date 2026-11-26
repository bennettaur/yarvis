/**
 * A stand-in for the browser's WebSocket, for testing clients of the server's
 * WebSocket routes. `installFakeSockets` swaps it in and points the page at an
 * http origin (the clients refuse to connect from `about:blank`); the function
 * it returns puts both back, for the suite's `afterAll`.
 */

export class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  /** Everything the client sent, text frames parsed as JSON. */
  readonly sent: unknown[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    sockets.push(this);
  }

  send(data: string | ArrayBufferLike): void {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }

  close(): void {
    this.serverClose(1000);
  }

  /** The server accepts the connection. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /** The server sends a JSON text frame. */
  sendJson(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  /** The server sends a PTY output frame: an 8-byte big-endian offset, then the bytes. */
  sendOutput(offset: number, text: string): void {
    const bytes = new TextEncoder().encode(text);
    const frame = new ArrayBuffer(8 + bytes.length);
    new DataView(frame).setBigUint64(0, BigInt(offset));
    new Uint8Array(frame, 8).set(bytes);
    this.dispatchEvent(new MessageEvent("message", { data: frame }));
  }

  /** The connection closes from the server's side, or drops. */
  serverClose(code: number, reason = ""): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    const event = new Event("close") as Event & { code: number; reason: string };
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
  }
}

let sockets: FakeSocket[] = [];

/** Every socket opened since the fakes were installed, oldest first. */
export const fakeSockets = (): FakeSocket[] => sockets;

export function installFakeSockets(): () => void {
  const realSocket = globalThis.WebSocket;
  const realUrl = window.location.href;
  sockets = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    "http://yarvis.test/",
  );
  return () => {
    globalThis.WebSocket = realSocket;
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(realUrl);
  };
}
