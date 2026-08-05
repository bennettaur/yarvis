import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { PtyOutput } from "../lib/pty";
import { renderToHtml } from "../test/render";

const encoder = new TextEncoder();
// Terminal queries an app emits: a Primary Device Attributes request (`ESC [ c`)
// and an OSC 11 background-color query (`ESC ] 11 ; ? ESC \`). xterm's parser
// answers each of these — a DA reply of `[?1;2c` and an OSC reply of `]11;rgb:…`
// — which is exactly what the bug leaked into the PTY on reattach.
const QUERY_BYTES = "\x1b[c\x1b]11;?\x1b\\";

// mock.module must register at top level, so the stubs record into module-scoped
// state that beforeEach resets between tests.
let scrollbackToReturn: number[] = [];
/** Stream offset the stubbed snapshot ends at. Defaults to covering exactly the
 * bytes it carries; set it higher to model a capture the core has trimmed. */
let endOffsetToReturn: number | null = null;
const writes: string[] = [];
let resizeCalls = 0;
let ptyOutput: ((chunk: PtyOutput) => void) | null = null;
/** Runs inside the attachPty stub, standing in for output the reader thread
 * captured after the snapshot was cloned but before the frontend flushed. */
let emitDuringAttach: (() => void) | null = null;

// A module mock replaces `lib/pty` for the whole test run, including files that
// only reach it transitively (e.g. the terminal tabs under WorkspacesPanel), so
// the real exports are spread back in — a partial stub makes those files fail to
// link on an export this file doesn't need.
const realPty = await import("../lib/pty");

mock.module("../lib/pty", () => ({
  ...realPty,
  attachPty: async () => {
    emitDuringAttach?.();
    return {
      scrollback: scrollbackToReturn,
      endOffset: endOffsetToReturn ?? scrollbackToReturn.length,
    };
  },
  writePty: async (_id: string, data: string) => {
    writes.push(data);
  },
  resizePty: async () => {
    resizeCalls += 1;
  },
  killPty: async () => {},
  onPtyOutput: async (_id: string, cb: (chunk: PtyOutput) => void) => {
    ptyOutput = cb;
    return () => {};
  },
  onPtyExit: async () => () => {},
}));

// Imported after the mock is registered so the component binds to the stubs.
const { default: TerminalPanel } = await import("./TerminalPanel");

/** Mounts and lets effects/async settle, but stays mounted so a test can drive
 * live PTY output or read what xterm rendered. `renderToHtml` unmounts before it
 * returns, which the reattach-then-input test below cannot use. */
async function mountSettled(
  element: ReactElement,
  settleMs = 120,
): Promise<{ screen: () => string; unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return {
    // xterm renders its rows into the DOM, so the text on screen is what the
    // user would see — the symptom these tests are about.
    screen: () => host.textContent ?? "",
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

beforeEach(() => {
  scrollbackToReturn = [];
  endOffsetToReturn = null;
  writes.length = 0;
  resizeCalls = 0;
  ptyOutput = null;
  emitDuringAttach = null;
});

describe("TerminalPanel scrollback replay", () => {
  it("does not leak xterm's query replies into the PTY during replay", async () => {
    scrollbackToReturn = Array.from(encoder.encode(`hi\r\n${QUERY_BYTES}`));

    await renderToHtml(createElement(TerminalPanel, { sessionId: "tab:replay" }));

    // resizePty runs immediately after the replay, confirming the attach path
    // actually executed and parsed the scrollback (rather than the mock silently
    // doing nothing).
    expect(resizeCalls).toBeGreaterThan(0);

    // The replay must not send the app's stale query answers back to the shell.
    const sent = writes.join("");
    expect(sent).not.toContain("[?1;2c");
    expect(sent).not.toContain("]11;rgb");
  });

  it("re-opens the gate so live query replies still reach the PTY after replay", async () => {
    scrollbackToReturn = Array.from(encoder.encode(`hi\r\n${QUERY_BYTES}`));

    const { unmount } = await mountSettled(
      createElement(TerminalPanel, { sessionId: "tab:reopen" }),
    );
    try {
      // Replay has settled; drop any replay-era writes so the assertion below
      // only sees what the *live* query produces.
      writes.length = 0;
      expect(ptyOutput).not.toBeNull();

      // The app re-queries after reattach; that arrives as live output, and its
      // reply must be forwarded — proving the gate did not stay shut and swallow
      // real terminal traffic (which would silently drop all subsequent input).
      ptyOutput?.({
        offset: scrollbackToReturn.length,
        bytes: encoder.encode("\x1b[c"),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(writes.join("")).toContain("[?1;2c");
    } finally {
      unmount();
    }
  });

  it("forwards the initial command on a fresh spawn without gating", async () => {
    scrollbackToReturn = []; // empty scrollback => fresh shell, not a reattach

    await renderToHtml(
      createElement(TerminalPanel, { sessionId: "tab:fresh", initialCommand: "echo hello" }),
    );

    // A fresh spawn is never gated, so the one-shot command reaches the PTY.
    expect(writes.join("")).toContain("echo hello\r");
  });
});

/** Encodes `text` as a snapshot and reports the offset the stream reaches, so a
 * test names the boundary once instead of hardcoding a fixture's byte length. */
function snapshotOf(text: string): number {
  scrollbackToReturn = Array.from(encoder.encode(text));
  return scrollbackToReturn.length;
}

// These assert on what xterm rendered rather than on bytes handed to it: the
// reported symptom is text missing from the screen, and a count of a marker's
// occurrences catches a chunk written twice as readily as one never written.
describe("TerminalPanel splices the snapshot and the live stream", () => {
  it("writes output captured after the snapshot rather than dropping it", async () => {
    const end = snapshotOf("REPLAYED\r\n");
    // Captured after the core cloned the snapshot but before the frontend
    // flushed, so it is in no snapshot and dropping it loses it for good. For an
    // idle Claude Code session this chunk is the repaint of its bottom UI.
    emitDuringAttach = () => ptyOutput?.({ offset: end, bytes: encoder.encode("LIVETAIL") });

    const { screen, unmount } = await mountSettled(
      createElement(TerminalPanel, { sessionId: "tab:after" }),
    );
    try {
      expect(screen()).toContain("REPLAYED");
      expect(screen()).toContain("LIVETAIL");
    } finally {
      unmount();
    }
  });

  it("writes output captured while a fresh shell was spawning", async () => {
    // Same window, other branch: a spawn has no snapshot to replay, and the
    // chunk in flight carries the shell's first prompt.
    snapshotOf("");
    emitDuringAttach = () => ptyOutput?.({ offset: 0, bytes: encoder.encode("FIRSTPROMPT") });

    const { screen, unmount } = await mountSettled(
      createElement(TerminalPanel, { sessionId: "tab:spawning" }),
    );
    try {
      expect(screen()).toContain("FIRSTPROMPT");
    } finally {
      unmount();
    }
  });

  it("skips output the snapshot already captured", async () => {
    // Captured before the snapshot but delivered to the webview after it, so the
    // replay and the chunk carry the same bytes and one of them must be dropped.
    const end = snapshotOf("REPLAYED\r\nDUPED");
    emitDuringAttach = () => ptyOutput?.({ offset: end - 5, bytes: encoder.encode("DUPED") });

    const { screen, unmount } = await mountSettled(
      createElement(TerminalPanel, { sessionId: "tab:dup" }),
    );
    try {
      // Present once, not twice — the replay put it there and the chunk did not.
      expect(screen().match(/DUPED/g)).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("skips a chunk inside scrollback the capture already trimmed away", async () => {
    // The capture hit its cap: it holds the tail of a stream that already reached
    // 1000 bytes, so offsets below that are accounted for even though the bytes
    // themselves are gone. Splicing on the byte count instead of the offset would
    // write this chunk again.
    snapshotOf("TRIMMED");
    endOffsetToReturn = 1000;
    emitDuringAttach = () => ptyOutput?.({ offset: 993, bytes: encoder.encode("TRIMMED") });

    const { screen, unmount } = await mountSettled(
      createElement(TerminalPanel, { sessionId: "tab:trimmed" }),
    );
    try {
      expect(screen().match(/TRIMMED/g)).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  it("writes only the tail of a chunk the snapshot partly captured", async () => {
    // The snapshot ends mid-chunk: "HALF" is already in the replay and must be
    // skipped, "TAIL" is new and must be written.
    const end = snapshotOf("REPLAYED\r\nHALF");
    emitDuringAttach = () => ptyOutput?.({ offset: end - 4, bytes: encoder.encode("HALFTAIL") });

    const { screen, unmount } = await mountSettled(
      createElement(TerminalPanel, { sessionId: "tab:partial" }),
    );
    try {
      expect(screen()).toContain("HALFTAIL");
      expect(screen().match(/HALF/g)).toHaveLength(1);
    } finally {
      unmount();
    }
  });
});
