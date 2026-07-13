import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../test/render";

// Scrollback the shell captured during the live session. It contains the app's
// original terminal queries — a Primary Device Attributes request (`ESC [ c`)
// and an OSC 11 background-color query (`ESC ] 11 ; ? ESC \`). xterm's parser
// answers each of these when it replays the snapshot; the answers are what the
// bug leaked into the PTY (e.g. `[?1;2c]11;rgb:...`).
const encoder = new TextEncoder();
const SCROLLBACK_WITH_QUERIES = Array.from(encoder.encode("hi\r\n\x1b[c\x1b]11;?\x1b\\"));

const writes: string[] = [];
let resizeCalls = 0;

mock.module("../lib/pty", () => ({
  attachPty: async () => SCROLLBACK_WITH_QUERIES,
  writePty: async (_id: string, data: string) => {
    writes.push(data);
  },
  resizePty: async () => {
    resizeCalls += 1;
  },
  killPty: async () => {},
  onPtyOutput: async () => () => {},
  onPtyExit: async () => () => {},
}));

// Imported after the mock is registered so the component binds to the stub.
const { default: TerminalPanel } = await import("./TerminalPanel");

describe("TerminalPanel scrollback replay", () => {
  it("does not leak xterm's query replies into the PTY", async () => {
    writes.length = 0;
    resizeCalls = 0;

    await renderToHtml(createElement(TerminalPanel, { sessionId: "tab:test" }));

    // resizePty runs immediately after the replay, so this confirms the attach
    // path actually executed and parsed the scrollback (rather than the mock
    // silently doing nothing).
    expect(resizeCalls).toBeGreaterThan(0);

    // The replay must not send the app's stale query answers back to the shell.
    const sent = writes.join("");
    expect(sent).not.toContain("[?1;2c");
    expect(sent).not.toContain("]11;rgb");
  });
});
