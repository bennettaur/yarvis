import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { fakeSockets, installFakeSockets } from "../test/fakeSocket";
import { realPty } from "../test/ptyApi";
import { waitFor } from "../test/render";
import type { PtyOutput } from "./pty";
import { saveDeviceToken, signOut } from "./server";

const { attachPty, onPtyExit, onPtyOutput, resizePty, writePty } = realPty;

let restore: () => void;
beforeAll(() => {
  restore = installFakeSockets();
  saveDeviceToken("tok-pty");
});
afterAll(() => {
  signOut();
  restore();
});

const text = (chunk: PtyOutput) => new TextDecoder().decode(chunk.bytes);

describe("the PTY socket client", () => {
  it("attaches with the size and folder, then streams, takes input and reports exit", async () => {
    const output: PtyOutput[] = [];
    let exited = false;
    const unOutput = await onPtyOutput("tab:1", (c) => output.push(c));
    const unExit = await onPtyExit("tab:1", () => {
      exited = true;
    });

    const before = fakeSockets().length;
    const attached = attachPty("tab:1", 100, 30, "/work");
    await waitFor(() => fakeSockets().length === before + 1, "the socket");
    const socket = fakeSockets()[before];
    if (!socket) throw new Error("no socket");
    expect(socket.url).toBe("ws://yarvis.test/api/pty/tab%3A1");
    socket.open();
    expect(socket.sent[0]).toEqual({
      type: "auth",
      token: "tok-pty",
      cols: 100,
      rows: 30,
      cwd: "/work",
    });

    socket.sendJson({
      type: "attached",
      mode: "snapshot",
      startOffset: 5,
      endOffset: 10,
      exit: null,
    });
    socket.sendOutput(5, "hello");
    const snapshot = await attached;
    expect(new TextDecoder().decode(new Uint8Array(snapshot.scrollback))).toBe("hello");
    expect(snapshot.endOffset).toBe(10);

    socket.sendOutput(10, " world");
    expect(output.map((c) => [c.offset, text(c)])).toEqual([[10, " world"]]);

    await writePty("tab:1", "ls\r");
    await resizePty("tab:1", 120, 40);
    expect(socket.sent.slice(1)).toEqual([
      { type: "input", data: "ls\r" },
      { type: "resize", cols: 120, rows: 40 },
    ]);

    socket.sendJson({ type: "exit", code: 0 });
    expect(exited).toBe(true);
    unOutput();
    unExit();
    expect(socket.readyState).toBe(3);
  });

  it("reconnects from the last offset after a drop, at the latest size", async () => {
    const output: PtyOutput[] = [];
    const unOutput = await onPtyOutput("tab:2", (c) => output.push(c));
    const before = fakeSockets().length;
    const attached = attachPty("tab:2", 80, 24);
    await waitFor(() => fakeSockets().length === before + 1, "the socket");
    const first = fakeSockets()[before];
    if (!first) throw new Error("no socket");
    first.open();
    first.sendJson({
      type: "attached",
      mode: "snapshot",
      startOffset: 0,
      endOffset: 0,
      exit: null,
    });
    first.sendOutput(0, "");
    await attached;
    first.sendOutput(0, "abc");
    await resizePty("tab:2", 90, 20);
    first.serverClose(1006);

    await waitFor(() => fakeSockets().length === before + 2, "the reconnect", 3_000);
    const second = fakeSockets()[before + 1];
    if (!second) throw new Error("no socket");
    second.open();
    expect(second.sent[0]).toEqual({
      type: "auth",
      token: "tok-pty",
      cols: 90,
      rows: 20,
      offset: 3,
    });
    second.sendJson({ type: "attached", mode: "resume", startOffset: 3, endOffset: 5, exit: null });
    second.sendOutput(3, "de");
    expect(output.map(text)).toEqual(["abc", "de"]);
    unOutput();
  });

  it("rejects the attach when the server refuses it", async () => {
    const unOutput = await onPtyOutput("tab:3", () => {});
    const before = fakeSockets().length;
    const attached = attachPty("tab:3", 80, 24);
    await waitFor(() => fakeSockets().length === before + 1, "the socket");
    fakeSockets()[before]?.serverClose(4403, "missing scope");
    await expect(attached).rejects.toThrow("missing scope");
    unOutput();
  });
});
